// 最小的 Pi RPC 替身，专门模拟 Pi 的「模型表在进程启动时读一次」：
// `catalog.json`（测试目录里）在进程启动时读进内存，`get_available_models` 永远回那一刻的快照，
// `set_model` 只认快照里的模型（不在快照里就回 `Model not found: provider/id`）。
// `spawns.log` 每起一个进程追加一行 pid：用来断言 Studio 有没有为了新模型重开旧会话的进程。
// 思考档位按 Pi 的 getSupportedThinkingLevels 算：xhigh / max 只在 thinkingLevelMap 里显式给了值才算。
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const dir = process.env["CATALOG_DIR"];
if (!dir) throw new Error("CATALOG_DIR is required");
// `get_available_models` 回话前先等一会儿：测试里要把「旧进程正在读，同时指纹变了要重起」这个窗口撑开。
const modelsDelayMs = Number(process.env["CATALOG_DELAY_MS"] ?? 0) || 0;
const snapshot = JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8"));
appendFileSync(path.join(dir, "spawns.log"), `${process.pid}\n`);

const PROVIDER = "probe";
const MODELS = (snapshot.models ?? [])
  // `hidden`: 服务进程（models.json）有、这个进程看不到的模型（模拟按需加载 / 网络发现）。
  .filter((model) => model.hidden !== true)
  .map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    api: "openai-completions",
    provider: PROVIDER,
    baseUrl: "http://127.0.0.1:9/v1",
    reasoning: model.reasoning === true,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 100_000,
    maxTokens: model.maxTokens ?? 8_192,
  }));

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function levelsOf(model) {
  if (model?.reasoning !== true) return ["off"];
  return LEVEL_ORDER.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

let activeModel = MODELS[0];
let thinkingLevel = levelsOf(activeModel).includes("medium") ? "medium" : (levelsOf(activeModel)[0] ?? "off");
const sessionId = randomUUID();

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(id, command, data) {
  send({ type: "response", id, command, success: true, ...(data === undefined ? {} : { data }) });
}

function fail(id, command, error) {
  send({ type: "response", id, command, success: false, error });
}

function handle(cmd) {
  switch (cmd.type) {
    case "get_state":
      respond(cmd.id, cmd.type, {
        model: activeModel,
        thinkingLevel,
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        sessionId,
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      });
      break;
    case "get_available_models":
      setTimeout(() => respond(cmd.id, cmd.type, { models: MODELS }), modelsDelayMs);
      break;
    case "get_available_thinking_levels":
      respond(cmd.id, cmd.type, { levels: levelsOf(activeModel) });
      break;
    case "get_session_stats":
      respond(cmd.id, cmd.type, {
        sessionId,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      });
      break;
    case "get_commands":
      respond(cmd.id, cmd.type, { commands: [] });
      break;
    case "set_model": {
      const found = MODELS.find((model) => model.provider === cmd.provider && model.id === cmd.modelId);
      if (!found) {
        fail(cmd.id, cmd.type, `Model not found: ${cmd.provider}/${cmd.modelId}`);
        break;
      }
      activeModel = found;
      const levels = levelsOf(activeModel);
      if (!levels.includes(thinkingLevel)) thinkingLevel = levels[0] ?? "off";
      respond(cmd.id, cmd.type, found);
      break;
    }
    case "set_thinking_level":
      if (!levelsOf(activeModel).includes(cmd.level)) {
        fail(cmd.id, cmd.type, `Invalid thinking level: ${String(cmd.level)}`);
        break;
      }
      thinkingLevel = cmd.level;
      send({ type: "thinking_level_changed", level: thinkingLevel });
      respond(cmd.id, cmd.type);
      break;
    default:
      respond(cmd.id, cmd.type, {});
      break;
  }
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.trim() !== "") {
      try {
        handle(JSON.parse(line));
      } catch {
        // 忽略坏行，和真实 Pi 的 RPC 一样跳过。
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
