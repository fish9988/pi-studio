#!/usr/bin/env node
// Deterministic Node ESM fake `pi` binary for unit & E2E tests.
// Supports `--version`, `update`, `install`/`remove`/`list`, `--export`, `-p`/`--print`, and `--mode rpc`.
// Never spawns a shell or touches real user home directories.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const VERSION = "1.5.2";

const MODELS = [
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 32768,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.04, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
];

const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const SAMPLE_COMMANDS = [
  {
    name: "review",
    description: "Review recent code changes",
    source: "skill",
    sourceInfo: { path: "/skills/review/SKILL.md", source: "local", scope: "project", origin: "top-level" },
  },
  {
    name: "explain",
    description: "Explain selected architecture",
    source: "prompt",
    sourceInfo: { path: "/prompts/explain.md", source: "local", scope: "user", origin: "top-level" },
  },
  {
    name: "deploy-check",
    description: "Run pre-deploy checklist",
    source: "extension",
    sourceInfo: { path: "/extensions/deploy.ts", source: "local", scope: "project", origin: "top-level" },
  },
];

function shortId() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

function parseCliArgs(argv) {
  const opts = {
    version: false,
    subcommand: null,
    subcommandArgs: [],
    print: false,
    mode: null,
    noSession: false,
    noTools: false,
    sessionFile: null,
    sessionDir: null,
    forkFrom: null,
    exportSource: null,
    exportOutput: null,
    provider: null,
    model: null,
    thinking: null,
    name: null,
    promptParts: [],
  };

  let i = 0;
  if (argv[0] === "update" || argv[0] === "install" || argv[0] === "remove" || argv[0] === "list") {
    opts.subcommand = argv[0];
    opts.subcommandArgs = argv.slice(1);
    return opts;
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      opts.promptParts.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--version" || arg === "-v") {
      opts.version = true;
      i += 1;
    } else if (arg === "-p" || arg === "--print") {
      opts.print = true;
      i += 1;
    } else if (arg === "--no-session") {
      opts.noSession = true;
      i += 1;
    } else if (arg === "--no-tools") {
      opts.noTools = true;
      i += 1;
    } else if (arg === "--mode" && i + 1 < argv.length) {
      opts.mode = argv[i + 1];
      i += 2;
    } else if (arg === "--session" && i + 1 < argv.length) {
      opts.sessionFile = argv[i + 1];
      i += 2;
    } else if (arg === "--session-dir" && i + 1 < argv.length) {
      opts.sessionDir = argv[i + 1];
      i += 2;
    } else if (arg === "--fork" && i + 1 < argv.length) {
      opts.forkFrom = argv[i + 1];
      i += 2;
    } else if (arg === "--export" && i + 1 < argv.length) {
      opts.exportSource = argv[i + 1];
      if (i + 2 < argv.length && !argv[i + 2].startsWith("-")) {
        opts.exportOutput = argv[i + 2];
        i += 3;
      } else {
        i += 2;
      }
    } else if (arg === "--provider" && i + 1 < argv.length) {
      opts.provider = argv[i + 1];
      i += 2;
    } else if (arg === "--model" && i + 1 < argv.length) {
      opts.model = argv[i + 1];
      i += 2;
    } else if (arg === "--thinking" && i + 1 < argv.length) {
      opts.thinking = argv[i + 1];
      i += 2;
    } else if (arg === "--name" && i + 1 < argv.length) {
      opts.name = argv[i + 1];
      i += 2;
    } else if (arg.startsWith("-")) {
      i += 1;
    } else {
      opts.promptParts.push(arg);
      i += 1;
    }
  }
  return opts;
}

async function readStdinAll() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeHtmlExport(sourcePath, outputPath) {
  const resolvedOut = outputPath ?? `${sourcePath ?? "session"}.html`;
  mkdirSync(path.dirname(path.resolve(resolvedOut)), { recursive: true });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pi Session Export</title></head><body><h1>Pi Session Export</h1></body></html>\n`;
  writeFileSync(resolvedOut, html, "utf8");
  return path.resolve(resolvedOut);
}

function extractMsgText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPrintMode(opts) {
  let prompt = opts.promptParts.join(" ").trim();
  if (!prompt) {
    prompt = (await readStdinAll()).trim();
  }
  const lower = prompt.toLowerCase();
  if (lower.includes("commit") || lower.includes("diff")) {
    process.stdout.write("chore: update project files\n");
  } else if (lower.includes("title") || lower.includes("summarize")) {
    process.stdout.write("Session Summary\n");
  } else {
    process.stdout.write("Fake Pi side-question response.\n");
  }
}

function runRpcServer(opts) {
  const cwd = process.cwd();
  let activeModel = MODELS[0];
  if (opts.model) {
    let prov = opts.provider;
    let modId = opts.model;
    if (!prov && modId.includes("/")) {
      const slashIdx = modId.indexOf("/");
      prov = modId.slice(0, slashIdx);
      modId = modId.slice(slashIdx + 1);
    }
    const found = MODELS.find((m) => (prov ? m.provider === prov && m.id === modId : m.id === modId));
    if (found) activeModel = found;
  }

  let thinkingLevel = opts.thinking && REASONING_LEVELS.includes(opts.thinking) ? opts.thinking : "medium";
  if (!activeModel.reasoning) thinkingLevel = "off";

  let autoCompactionEnabled = true;
  let steeringMode = "one-at-a-time";
  let followUpMode = "one-at-a-time";
  let isStreaming = false;
  let isCompacting = false;
  let abortCurrentRun = false;

  let sessionId = randomUUID();
  let sessionName = opts.name ?? undefined;
  let sessionFile = undefined;
  let entries = [];
  let leafId = null;

  let steeringQueue = [];
  let followUpQueue = [];
  const pendingUiResolvers = new Map();

  let useCrlf = false;

  function sendJson(obj) {
    const eol = useCrlf ? "\r\n" : "\n";
    process.stdout.write(`${JSON.stringify(obj)}${eol}`);
  }

  function sendResponse(id, command, success, data, error) {
    const payload = { type: "response", command, success };
    if (id !== undefined) payload.id = id;
    if (success && data !== undefined) payload.data = data;
    if (!success) payload.error = error ?? `Command ${command} failed`;
    sendJson(payload);
  }

  function ensureSessionDir() {
    if (opts.sessionDir) {
      mkdirSync(opts.sessionDir, { recursive: true });
      return opts.sessionDir;
    }
    const agentDir = process.env["PI_CODING_AGENT_DIR"];
    if (agentDir && agentDir.trim() !== "") {
      const bucket = `--${cwd.replace(/[^0-9A-Za-z\u4e00-\u9fa5_-]+/g, "-").replace(/^-+|-+$/g, "") || "cwd"}--`;
      const dir = path.join(agentDir.trim(), "sessions", bucket);
      mkdirSync(dir, { recursive: true });
      return dir;
    }
    const dir = path.join(os.tmpdir(), "fake-pi-sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function createFreshSessionFile(parentSession) {
    const dir = ensureSessionDir();
    sessionId = randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}_${sessionId}.jsonl`);
    const header = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
      ...(parentSession ? { parentSession } : {}),
    };
    writeFileSync(file, `${JSON.stringify(header)}\n`, "utf8");
    sessionFile = file;
    entries = [];
    leafId = null;
  }

  function loadSessionFromDisk(filePath) {
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
    const loadedEntries = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "session") {
          sessionId = parsed.id ?? randomUUID();
        } else {
          loadedEntries.push(parsed);
          if (typeof parsed.id === "string") {
            leafId = parsed.id;
          }
          if (parsed.type === "session_info" && typeof parsed.name === "string") {
            sessionName = parsed.name;
          }
        }
      } catch {
        // Ignore malformed lines
      }
    }
    sessionFile = filePath;
    entries = loadedEntries;
  }

  function appendEntry(entry) {
    const full = {
      id: shortId(),
      parentId: leafId,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    entries.push(full);
    leafId = full.id;
    if (!opts.noSession && sessionFile) {
      appendFileSync(sessionFile, `${JSON.stringify(full)}\n`, "utf8");
    }
    return full;
  }

  // Initialize session state on startup
  if (!opts.noSession) {
    if (opts.forkFrom && existsSync(opts.forkFrom)) {
      loadSessionFromDisk(opts.forkFrom);
      const copied = [...entries];
      const copiedLeaf = leafId;
      createFreshSessionFile(opts.forkFrom);
      for (const item of copied) {
        entries.push(item);
        appendFileSync(sessionFile, `${JSON.stringify(item)}\n`, "utf8");
      }
      leafId = copiedLeaf;
    } else if (opts.sessionFile && existsSync(opts.sessionFile)) {
      loadSessionFromDisk(opts.sessionFile);
    } else if (opts.sessionFile) {
      mkdirSync(path.dirname(path.resolve(opts.sessionFile)), { recursive: true });
      sessionFile = path.resolve(opts.sessionFile);
      const header = {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd,
      };
      writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
    } else {
      createFreshSessionFile();
    }

    if (sessionName && !entries.some((e) => e.type === "session_info" && e.name === sessionName)) {
      appendEntry({ type: "session_info", name: sessionName });
    }
  }

  function getActiveBranchEntries() {
    if (entries.length === 0 || leafId === null) return [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const chain = [];
    const seen = new Set();
    let cur = leafId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const item = byId.get(cur);
      if (!item) break;
      chain.push(item);
      cur = item.parentId ?? null;
    }
    chain.reverse();
    return chain;
  }

  function getActiveMessages() {
    return getActiveBranchEntries()
      .filter((e) => e.type === "message" && e.message)
      .map((e) => e.message);
  }

  function computeStats() {
    const msgs = getActiveMessages();
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;

    for (const m of msgs) {
      if (m.role === "user") userMessages += 1;
      else if (m.role === "assistant") {
        assistantMessages += 1;
        if (Array.isArray(m.content)) {
          toolCalls += m.content.filter((b) => b.type === "toolCall").length;
        }
        if (m.usage) {
          input += m.usage.input ?? 0;
          output += m.usage.output ?? 0;
          cacheRead += m.usage.cacheRead ?? 0;
          cacheWrite += m.usage.cacheWrite ?? 0;
          cost += m.usage.cost?.total ?? 0;
        }
      } else if (m.role === "toolResult") {
        toolResults += 1;
      }
    }
    const total = input + output + cacheRead + cacheWrite;
    const contextWindow = activeModel.contextWindow ?? 200000;
    const percent = contextWindow > 0 ? Math.min(100, Number(((total / contextWindow) * 100).toFixed(2))) : 0;

    return {
      sessionFile,
      sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: msgs.length,
      tokens: { input, output, cacheRead, cacheWrite, total },
      cost,
      contextUsage: {
        tokens: total,
        contextWindow,
        percent,
      },
    };
  }

  function emitQueueUpdate() {
    sendJson({
      type: "queue_update",
      steering: [...steeringQueue],
      followUp: [...followUpQueue],
    });
  }

  function waitForExtensionUiResponse(reqId) {
    return new Promise((resolve) => {
      pendingUiResolvers.set(reqId, resolve);
    });
  }

  async function executeTurn(promptText, images = []) {
    if (promptText.includes("[crlf]")) {
      useCrlf = true;
    }

    const userContent = [{ type: "text", text: promptText }];
    for (const img of images) {
      if (img && img.type === "image") {
        userContent.push(img);
      }
    }
    const userMsg = {
      role: "user",
      content: userContent,
      timestamp: Date.now(),
    };
    appendEntry({ type: "message", message: userMsg });

    sendJson({ type: "turn_start" });
    sendJson({ type: "message_start", message: userMsg });
    sendJson({ type: "message_end", message: userMsg });

    const assistantContent = [];
    const partialAssistant = {
      role: "assistant",
      content: assistantContent,
      api: activeModel.api,
      provider: activeModel.provider,
      model: activeModel.id,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    sendJson({ type: "message_start", message: partialAssistant });

    let contentIdx = 0;

    // 1. Optional thinking stream when thinkingLevel !== "off"
    if (thinkingLevel !== "off") {
      const thought = `Analyzing prompt (${thinkingLevel}): ${promptText.slice(0, 48)}`;
      sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: { type: "thinking_start", contentIndex: contentIdx },
      });
      sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: contentIdx, delta: thought },
      });
      sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: { type: "thinking_end", contentIndex: contentIdx, content: thought },
      });
      assistantContent.push({ type: "thinking", thinking: thought });
      contentIdx += 1;
    }

    // 2. Optional extension UI request trigger
    let uiNote = "";
    const lowerPrompt = promptText.toLowerCase();
    if (promptText.includes("[ask") || promptText.includes("[confirm]")) {
      const reqId = `ui_${shortId()}`;
      if (promptText.includes("[ask:select]")) {
        sendJson({
          type: "extension_ui_request",
          id: reqId,
          method: "select",
          title: "Pick target",
          options: ["Option A", "Option B"],
        });
      } else if (promptText.includes("[ask:input]")) {
        sendJson({
          type: "extension_ui_request",
          id: reqId,
          method: "input",
          title: "Enter name",
          placeholder: "Type here",
        });
      } else if (promptText.includes("[ask:editor]")) {
        sendJson({
          type: "extension_ui_request",
          id: reqId,
          method: "editor",
          title: "Edit note",
          prefill: "initial",
        });
      } else {
        sendJson({
          type: "extension_ui_request",
          id: reqId,
          method: "confirm",
          title: "Confirm action",
          message: "Proceed?",
        });
      }

      const uiResp = await waitForExtensionUiResponse(reqId);
      if (abortCurrentRun) {
        return finishAbortedTurn(partialAssistant, assistantContent);
      }
      if (uiResp.cancelled) {
        uiNote = " [UI cancelled]";
      } else if (typeof uiResp.confirmed === "boolean") {
        uiNote = uiResp.confirmed ? " [UI confirmed]" : " [UI denied]";
      } else if (typeof uiResp.value === "string") {
        uiNote = ` [UI value: ${uiResp.value}]`;
      }
    }

    // 3. Optional tool execution trigger
    const toolResultsForTurn = [];
    if (
      promptText.includes("[tool]") ||
      promptText.includes("[edit]") ||
      promptText.includes("[bash]") ||
      lowerPrompt.includes("read file")
    ) {
      const toolCallId = `call_${shortId()}`;
      let toolName = "read";
      let args = { path: "README.md" };
      let partialOut = "# Project\n";
      let finalOut = "# Project\nLine 2\n";

      if (promptText.includes("[edit]")) {
        toolName = "edit";
        args = {
          path: "src/app.ts",
          oldText: "const a = 1;\n",
          newText: "const a = 2;\nconst b = 3;\n",
        };
        partialOut = "Applying edit...";
        finalOut = "Updated src/app.ts";
      } else if (promptText.includes("[bash]")) {
        toolName = "bash";
        args = { command: "echo hello" };
        partialOut = "hel";
        finalOut = "hello\n";
      }

      const toolCallBlock = { type: "toolCall", id: toolCallId, name: toolName, arguments: args };
      sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: contentIdx, id: toolCallId, toolName },
      });
      sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: { type: "toolcall_end", contentIndex: contentIdx, toolCall: toolCallBlock },
      });
      assistantContent.push(toolCallBlock);
      contentIdx += 1;

      sendJson({
        type: "tool_execution_start",
        toolCallId,
        toolName,
        args,
      });
      sendJson({
        type: "tool_execution_update",
        toolCallId,
        toolName,
        args,
        partialResult: { content: [{ type: "text", text: partialOut }], details: {} },
      });
      sendJson({
        type: "tool_execution_end",
        toolCallId,
        toolName,
        result: { content: [{ type: "text", text: finalOut }], details: {} },
        isError: false,
        durationMs: 42,
      });

      const trMsg = {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: finalOut }],
        isError: false,
        timestamp: Date.now(),
      };
      appendEntry({ type: "message", message: trMsg });
      toolResultsForTurn.push(trMsg);
    }

    // 4. Error trigger
    if (promptText.includes("[error]")) {
      const errAsst = {
        ...partialAssistant,
        content: assistantContent,
        stopReason: "error",
        errorMessage: "Simulated model error",
        usage: {
          input: 20,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 25,
          cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
        },
        timestamp: Date.now(),
      };
      appendEntry({ type: "message", message: errAsst });
      sendJson({ type: "message_end", message: errAsst });
      sendJson({ type: "turn_end", message: errAsst, toolResults: toolResultsForTurn });
      return [userMsg, ...toolResultsForTurn, errAsst];
    }

    // 5. Slow streaming or normal text streaming
    let replyText = `Fake Pi reply to: ${promptText}${uiNote}`;
    if (promptText.includes("[unicode]")) {
      replyText += " \u2028line-sep\u2029para-sep";
    }

    sendJson({
      type: "message_update",
      message: partialAssistant,
      assistantMessageEvent: { type: "text_start", contentIndex: contentIdx },
    });

    if (promptText.includes("[slow]")) {
      let accumulated = "";
      for (let step = 1; step <= 10; step += 1) {
        if (abortCurrentRun) {
          assistantContent.push({ type: "text", text: accumulated });
          return finishAbortedTurn(partialAssistant, assistantContent, toolResultsForTurn);
        }
        const chunk = `chunk-${step} `;
        accumulated += chunk;
        sendJson({
          type: "message_update",
          message: partialAssistant,
          assistantMessageEvent: { type: "text_delta", contentIndex: contentIdx, delta: chunk },
        });
        await sleep(200);
      }
      replyText = accumulated.trim();
    } else {
      const mid = Math.max(1, Math.floor(replyText.length / 2));
      const d1 = replyText.slice(0, mid);
      const d2 = replyText.slice(mid);
      sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: { type: "text_delta", contentIndex: contentIdx, delta: d1 },
      });
      if (d2) {
        sendJson({
          type: "message_update",
          message: partialAssistant,
          assistantMessageEvent: { type: "text_delta", contentIndex: contentIdx, delta: d2 },
        });
      }
    }

    sendJson({
      type: "message_update",
      message: partialAssistant,
      assistantMessageEvent: { type: "text_end", contentIndex: contentIdx, content: replyText },
    });
    assistantContent.push({ type: "text", text: replyText });

    const finalAsst = {
      ...partialAssistant,
      content: assistantContent,
      stopReason: "stop",
      usage: {
        input: 220,
        output: 80,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 300,
        cost: { input: 0.00066, output: 0.0012, cacheRead: 0, cacheWrite: 0, total: 0.00186 },
      },
      timestamp: Date.now(),
    };
    appendEntry({ type: "message", message: finalAsst });
    sendJson({ type: "message_end", message: finalAsst });
    sendJson({ type: "turn_end", message: finalAsst, toolResults: toolResultsForTurn });
    return [userMsg, ...toolResultsForTurn, finalAsst];
  }

  function finishAbortedTurn(partialAssistant, assistantContent, toolResultsForTurn = []) {
    const abortedAsst = {
      ...partialAssistant,
      content: assistantContent,
      stopReason: "aborted",
      usage: {
        input: 30,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 40,
        cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
      },
      timestamp: Date.now(),
    };
    appendEntry({ type: "message", message: abortedAsst });
    sendJson({ type: "message_end", message: abortedAsst });
    sendJson({ type: "turn_end", message: abortedAsst, toolResults: toolResultsForTurn });
    return [abortedAsst];
  }

  async function runAgentLoop(initialPrompt, initialImages) {
    isStreaming = true;
    abortCurrentRun = false;
    sendJson({ type: "agent_start" });

    const runMessages = [];
    const isAborted = () => abortCurrentRun;
    try {
      const firstMsgs = await executeTurn(initialPrompt, initialImages);
      runMessages.push(...firstMsgs);

      while (!isAborted() && (steeringQueue.length > 0 || followUpQueue.length > 0)) {
        const nextPrompt = steeringQueue.length > 0 ? steeringQueue.shift() : followUpQueue.shift();
        emitQueueUpdate();
        if (nextPrompt !== undefined) {
          const nextMsgs = await executeTurn(nextPrompt, []);
          runMessages.push(...nextMsgs);
        }
      }
    } finally {
      const wasAborted = abortCurrentRun;
      isStreaming = false;
      abortCurrentRun = false;
      sendJson({ type: "agent_end", messages: runMessages });
      sendJson({ type: "agent_settled", aborted: wasAborted });
    }
  }

  function buildTreeNodes() {
    const byParent = new Map();
    for (const e of entries) {
      const pid = e.parentId ?? null;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(e);
    }
    const toNode = (e) => ({
      entry: e,
      children: (byParent.get(e.id) ?? []).map(toNode),
    });
    return (byParent.get(null) ?? []).map(toNode);
  }

  function handleCommand(cmd) {
    const { id, type } = cmd;

    switch (type) {
      case "get_state": {
        const activeMsgs = getActiveMessages();
        sendResponse(id, type, true, {
          model: activeModel,
          thinkingLevel,
          isStreaming,
          isCompacting,
          steeringMode,
          followUpMode,
          sessionFile,
          sessionId,
          ...(sessionName !== undefined ? { sessionName } : {}),
          autoCompactionEnabled,
          messageCount: activeMsgs.length,
          pendingMessageCount: steeringQueue.length + followUpQueue.length,
        });
        break;
      }

      case "get_messages": {
        sendResponse(id, type, true, { messages: getActiveMessages() });
        break;
      }

      case "get_available_models": {
        sendResponse(id, type, true, { models: MODELS });
        break;
      }

      case "get_available_thinking_levels": {
        const prov = cmd.provider ?? activeModel.provider;
        const modId = cmd.modelId ?? activeModel.id;
        const target = MODELS.find((m) => m.provider === prov && m.id === modId) ?? activeModel;
        const levels = target.reasoning ? REASONING_LEVELS : ["off"];
        sendResponse(id, type, true, {
          provider: target.provider,
          modelId: target.id,
          levels,
        });
        break;
      }

      case "set_model": {
        const found = MODELS.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
        if (!found) {
          sendResponse(id, type, false, undefined, `Unknown model ${String(cmd.provider)}/${String(cmd.modelId)}`);
          return;
        }
        activeModel = found;
        if (!activeModel.reasoning && thinkingLevel !== "off") {
          thinkingLevel = "off";
          sendJson({ type: "thinking_level_changed", level: "off" });
        }
        sendResponse(id, type, true, activeModel);
        break;
      }

      case "cycle_model": {
        const idx = MODELS.findIndex((m) => m.provider === activeModel.provider && m.id === activeModel.id);
        const step = cmd.direction === "backward" ? -1 : 1;
        const nextIdx = ((idx < 0 ? 0 : idx) + step + MODELS.length) % MODELS.length;
        activeModel = MODELS[nextIdx];
        if (!activeModel.reasoning) thinkingLevel = "off";
        sendResponse(id, type, true, {
          model: activeModel,
          thinkingLevel,
          isScoped: false,
        });
        break;
      }

      case "set_thinking_level": {
        const requested = String(cmd.level ?? "off");
        if (!REASONING_LEVELS.includes(requested)) {
          sendResponse(id, type, false, undefined, `Invalid thinking level: ${requested}`);
          return;
        }
        thinkingLevel = activeModel.reasoning ? requested : "off";
        sendJson({ type: "thinking_level_changed", level: thinkingLevel });
        sendResponse(id, type, true);
        break;
      }

      case "cycle_thinking_level": {
        const levels = activeModel.reasoning ? REASONING_LEVELS : ["off"];
        const curIdx = levels.indexOf(thinkingLevel);
        thinkingLevel = levels[(curIdx + 1) % levels.length];
        sendJson({ type: "thinking_level_changed", level: thinkingLevel });
        sendResponse(id, type, true, { level: thinkingLevel });
        break;
      }

      case "get_commands": {
        sendResponse(id, type, true, { commands: SAMPLE_COMMANDS });
        break;
      }

      case "get_session_stats": {
        sendResponse(id, type, true, computeStats());
        break;
      }

      case "set_session_name": {
        const nextName = String(cmd.name ?? "").trim();
        sessionName = nextName !== "" ? nextName : undefined;
        appendEntry({ type: "session_info", name: nextName });
        sendJson({ type: "session_info_changed", ...(sessionName ? { name: sessionName } : {}) });
        sendResponse(id, type, true, {});
        break;
      }

      case "set_auto_compaction": {
        autoCompactionEnabled = Boolean(cmd.enabled);
        sendResponse(id, type, true, {});
        break;
      }

      case "set_steering_mode": {
        steeringMode = cmd.mode === "all" ? "all" : "one-at-a-time";
        sendResponse(id, type, true, {});
        break;
      }

      case "set_follow_up_mode": {
        followUpMode = cmd.mode === "all" ? "all" : "one-at-a-time";
        sendResponse(id, type, true, {});
        break;
      }

      case "compact": {
        isCompacting = true;
        sendJson({ type: "compaction_start", reason: "manual" });
        const summary = cmd.customInstructions
          ? `Compacted context (${String(cmd.customInstructions)})`
          : "Compacted earlier conversation context.";
        const firstKeptEntryId = leafId ?? shortId();
        const tokensBefore = Math.max(1024, computeStats().tokens.total);
        appendEntry({
          type: "compaction",
          summary,
          firstKeptEntryId,
          tokensBefore,
        });
        isCompacting = false;
        const result = { summary, firstKeptEntryId, tokensBefore };
        sendJson({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
        sendResponse(id, type, true, result);
        break;
      }

      case "new_session": {
        if (!opts.noSession) {
          createFreshSessionFile(cmd.parentSession);
        } else {
          sessionId = randomUUID();
          entries = [];
          leafId = null;
        }
        sessionName = undefined;
        sendResponse(id, type, true, { cancelled: false });
        break;
      }

      case "switch_session": {
        const targetPath = String(cmd.sessionPath ?? "");
        if (!targetPath) {
          sendResponse(id, type, false, undefined, "sessionPath is required");
          return;
        }
        if (existsSync(targetPath)) {
          loadSessionFromDisk(targetPath);
        } else {
          mkdirSync(path.dirname(path.resolve(targetPath)), { recursive: true });
          sessionFile = path.resolve(targetPath);
          sessionId = randomUUID();
          entries = [];
          leafId = null;
          const header = {
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd,
          };
          writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
        }
        sendResponse(id, type, true, { cancelled: false });
        break;
      }

      case "fork": {
        const targetId = String(cmd.entryId ?? "");
        const byId = new Map(entries.map((e) => [e.id, e]));
        const targetEntry = byId.get(targetId);
        if (!targetEntry || targetEntry.type !== "message" || targetEntry.message?.role !== "user") {
          sendResponse(id, type, false, undefined, `Invalid fork entryId: ${targetId}`);
          return;
        }
        const selectedText = extractMsgText(targetEntry.message.content);
        // Keep ancestors strictly BEFORE targetEntry so user can re-edit/re-submit from that point!
        const kept = [];
        let cur = targetEntry.parentId ?? null;
        while (cur) {
          const item = byId.get(cur);
          if (!item) break;
          kept.push(item);
          cur = item.parentId ?? null;
        }
        kept.reverse();

        const oldFile = sessionFile;
        if (!opts.noSession) {
          createFreshSessionFile(oldFile);
          for (const k of kept) {
            entries.push(k);
            appendFileSync(sessionFile, `${JSON.stringify(k)}\n`, "utf8");
          }
        } else {
          entries = [...kept];
        }
        leafId = kept.length > 0 ? kept[kept.length - 1].id : null;
        sendResponse(id, type, true, { text: selectedText, cancelled: false });
        break;
      }

      case "clone": {
        const snapshotEntries = getActiveBranchEntries();
        const oldFile = sessionFile;
        if (!opts.noSession) {
          createFreshSessionFile(oldFile);
          for (const k of snapshotEntries) {
            entries.push(k);
            appendFileSync(sessionFile, `${JSON.stringify(k)}\n`, "utf8");
          }
        }
        leafId = snapshotEntries.length > 0 ? snapshotEntries[snapshotEntries.length - 1].id : null;
        sendResponse(id, type, true, { cancelled: false });
        break;
      }

      case "get_fork_messages": {
        const userForks = getActiveBranchEntries()
          .filter((e) => e.type === "message" && e.message?.role === "user")
          .map((e) => ({
            entryId: e.id,
            text: extractMsgText(e.message.content),
          }));
        sendResponse(id, type, true, { messages: userForks });
        break;
      }

      case "get_tree": {
        sendResponse(id, type, true, { tree: buildTreeNodes(), leafId });
        break;
      }

      case "get_entries": {
        sendResponse(id, type, true, { entries });
        break;
      }

      case "get_last_assistant_text": {
        const msgs = getActiveMessages();
        let lastText = null;
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          if (msgs[i].role === "assistant") {
            lastText = extractMsgText(msgs[i].content);
            break;
          }
        }
        sendResponse(id, type, true, { text: lastText });
        break;
      }

      case "export_html": {
        const defaultOut = path.join(ensureSessionDir(), `export_${sessionId}.html`);
        const outPath = writeHtmlExport(sessionFile, cmd.outputPath ?? defaultOut);
        sendResponse(id, type, true, { path: outPath });
        break;
      }

      case "bash": {
        const commandStr = String(cmd.command ?? "");
        sendResponse(id, type, true, {
          output: `simulated: ${commandStr}\n`,
          exitCode: 0,
          cancelled: false,
          truncated: false,
        });
        break;
      }

      case "abort_bash": {
        sendResponse(id, type, true, {});
        break;
      }

      case "steer": {
        const msg = String(cmd.message ?? "");
        if (isStreaming) {
          steeringQueue.push(msg);
          emitQueueUpdate();
          sendResponse(id, type, true, {});
        } else {
          sendResponse(id, type, true, {});
          void runAgentLoop(msg, cmd.images ?? []);
        }
        break;
      }

      case "follow_up": {
        const msg = String(cmd.message ?? "");
        if (isStreaming) {
          followUpQueue.push(msg);
          emitQueueUpdate();
          sendResponse(id, type, true, {});
        } else {
          sendResponse(id, type, true, {});
          void runAgentLoop(msg, cmd.images ?? []);
        }
        break;
      }

      case "clear_queue": {
        const cleared = {
          steering: [...steeringQueue],
          followUp: [...followUpQueue],
        };
        steeringQueue = [];
        followUpQueue = [];
        emitQueueUpdate();
        sendResponse(id, type, true, cleared);
        break;
      }

      case "abort": {
        abortCurrentRun = true;
        for (const [reqId, resolver] of pendingUiResolvers) {
          pendingUiResolvers.delete(reqId);
          resolver({ id: reqId, cancelled: true });
        }
        sendResponse(id, type, true, {});
        break;
      }

      case "extension_ui_response": {
        const resolver = pendingUiResolvers.get(cmd.id);
        if (resolver) {
          pendingUiResolvers.delete(cmd.id);
          resolver(cmd);
        }
        break;
      }

      case "prompt": {
        const messageText = String(cmd.message ?? "");
        const images = Array.isArray(cmd.images) ? cmd.images : [];
        if (isStreaming) {
          const behavior = cmd.streamingBehavior;
          if (behavior === "steer") {
            steeringQueue.push(messageText);
            emitQueueUpdate();
            sendResponse(id, type, true, { disposition: "steer" });
          } else if (behavior === "followUp") {
            followUpQueue.push(messageText);
            emitQueueUpdate();
            sendResponse(id, type, true, { disposition: "followUp" });
          } else {
            sendResponse(id, type, false, undefined, "Agent is currently streaming; specify streamingBehavior");
          }
          return;
        }
        sendResponse(id, type, true, { disposition: "started" });
        void runAgentLoop(messageText, images);
        break;
      }

      default: {
        sendResponse(id, type ?? "unknown", false, undefined, `Unknown RPC command: ${String(type)}`);
        break;
      }
    }
  }

  // Strict LF (`\n`) stdin framing — never splits on U+2028 / U+2029!
  const decoder = new StringDecoder("utf8");
  let stdinBuf = "";

  process.stdin.on("data", (chunk) => {
    stdinBuf += decoder.write(chunk);
    let nl = stdinBuf.indexOf("\n");
    while (nl !== -1) {
      let line = stdinBuf.slice(0, nl);
      stdinBuf = stdinBuf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() !== "") {
        try {
          const parsed = JSON.parse(line);
          handleCommand(parsed);
        } catch (err) {
          sendResponse(undefined, "parse", false, undefined, `Invalid JSON: ${err.message}`);
        }
      }
      nl = stdinBuf.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  if (opts.subcommand === "update") {
    process.stdout.write(`Updated @earendil-works/pi-coding-agent to ${VERSION}\n`);
    process.exit(0);
  }

  if (opts.subcommand === "install") {
    const pkg = opts.subcommandArgs[0] ?? "package";
    process.stdout.write(`Installed ${pkg}\n`);
    process.exit(0);
  }

  if (opts.subcommand === "remove") {
    const pkg = opts.subcommandArgs[0] ?? "package";
    process.stdout.write(`Removed ${pkg}\n`);
    process.exit(0);
  }

  if (opts.subcommand === "list") {
    process.stdout.write(`@earendil-works/pi-coding-agent@${VERSION} (installed)\n`);
    process.exit(0);
  }

  if (opts.exportSource) {
    const outPath = writeHtmlExport(opts.exportSource, opts.exportOutput);
    process.stdout.write(`Exported session to ${outPath}\n`);
    process.exit(0);
  }

  if (opts.mode === "rpc") {
    runRpcServer(opts);
    return;
  }

  if (opts.print) {
    await runPrintMode(opts);
    process.exit(0);
  }

  process.stdout.write(`pi ${VERSION}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
