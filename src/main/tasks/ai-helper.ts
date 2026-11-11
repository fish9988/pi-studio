// AI 辅助服务：智能会话重命名（smartRenameTask）与输入框提示词优化（enhancePrompt）。
// 复用 omp 的 `-p --no-session --no-tools --no-lsp --no-pty` 无状态单次推理模式，直接共享用户已配置的全部模型与订阅凭据；
// 模型与思考强度由外壳设置（ShellState.helperModel / helperThinking）控制。
import { app } from "electron";
import { stripAnsi } from "../../shared/ansi.ts";
import type { HelperThinking, TaskId } from "../../shared/ipc.ts";
import { restoreDocument } from "../../shared/tsp/document.ts";
import { lastAnswerText } from "../../shared/tsp/last-answer.ts";
import { userMessages } from "../../shared/tsp/user-messages.ts";
import { runCommand } from "../git/exec.ts";
import { readyPiLaunch } from "../pi/runtime-singleton.ts";
import { resolveLocale } from "../settings/settings-store.ts";
import { getShellState } from "../window/window-state.ts";
import { chatsDir } from "./chats-dir.ts";
import { getTaskPool } from "./runtime.ts";

const HELPER_TIMEOUT_MS = 45_000;

function stripPromptNoise(raw: string): string {
  return raw
    .replace(/<supermemory>[\s\S]*?<\/supermemory>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[Image\s*#?\d*[^\]]*\]/gi, " ")
    .replace(/https?:\/\/[^\s)>\]]+/gi, " ")
    .replace(/[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|]+[\\/])*([^\s\\/:*?"<>|]+)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanGeneratedTitle(raw: string): string {
  const line =
    stripAnsi(raw)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? "";
  const cleaned = line
    .replace(/^(?:标题|Title)\s*[:：]\s*/i, "")
    .replace(/^[#*"'`「『【（(]+|[*"'`」』】）)。.！!？?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  return cleaned.length >= 2 && !/^[A-Za-z]$/.test(cleaned) ? cleaned : "";
}

export function fallbackSmartTitle(promptText: string, answerText: string, latestUserText = ""): string {
  const source =
    [promptText, latestUserText, answerText]
      .map(stripPromptNoise)
      .find((s) => s.length >= 2 && !/^[A-Za-z]$/.test(s)) ?? "";
  const cleaned = source
    .replace(/^[#>*\-\d.\s]+/, "")
    .replace(/^(?:请帮我|帮我|请问|我想|我希望|麻烦|能不能|如何|怎么|please\s+|help\s+me\s+|can\s+you\s+)/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const best =
    cleaned
      .split(/[，。！？；!?;|\r\n]+/)
      .map((s) => s.trim())
      .find((s) => s.length >= 2 && !/^[A-Za-z]$/.test(s)) ?? cleaned;
  return Array.from(best).slice(0, 24).join("").trim() || "会话主题总结";
}

function fallbackEnhancePrompt(raw: string, zh: boolean): string {
  const trimmed = raw.trim();
  if (zh) {
    return `${trimmed}\n\n请按以下要求执行：\n1. 先定位相关文件与根因，说明修改方案；\n2. 保持与现有代码风格和架构一致，避免引入冗余抽象；\n3. 完成后运行对应的构建或测试验证改动。`;
  }
  return `${trimmed}\n\nRequirements:\n1. Locate the relevant files and root cause before making changes.\n2. Follow existing codebase conventions with minimal, surgical edits.\n3. Verify the changes with the appropriate build or test checks.`;
}

async function runHelperLlm(options: {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  taskModel?: string | null;
}): Promise<string | null> {
  if (!app.isPackaged && (process.env["STUDIO_TEST_PI"] || process.env["STUDIO_TEST_OMP"])) {
    return null;
  }
  try {
    const launch = await readyPiLaunch();
    const shell = getShellState();
    const helperModel = shell.helperModel ?? "smol";
    const helperThinking: HelperThinking = shell.helperThinking ?? "off";

    const args: string[] = [
      ...launch.prefixArgs,
      "-p",
      "--no-session",
      "--no-tools",
      `--thinking=${helperThinking}`,
      `--system-prompt=${options.systemPrompt}`,
    ];

    const chosenSpec =
      helperModel !== "default" && helperModel !== "current" && helperModel !== "smol" && helperModel.includes("/")
        ? helperModel
        : (options.taskModel ?? null);

    if (chosenSpec && chosenSpec.includes("/")) {
      const slash = chosenSpec.indexOf("/");
      const provider = chosenSpec.slice(0, slash);
      const modelId = chosenSpec.slice(slash + 1);
      if (provider && modelId) {
        args.push("--provider", provider, "--model", modelId);
      }
    }

    args.push("--", options.userPrompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HELPER_TIMEOUT_MS);
    try {
      const result = await runCommand(launch.command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...launch.env },
        signal: controller.signal,
      });
      if (result.code !== 0) return null;
      const out = stripAnsi(result.stdout.toString("utf8")).trim();
      return out.length > 0 ? out : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export async function smartRenameTask(taskId: TaskId): Promise<string> {
  const pool = await getTaskPool();
  const snapshot = pool.getTspSnapshot(taskId);
  const doc = restoreDocument(snapshot.document);
  const users = userMessages(doc);
  const answer = lastAnswerText(doc) ?? "";
  const firstUser = users[0]?.text ?? pool.taskTitle(taskId);
  const latestUser = users.length > 1 ? (users[users.length - 1]?.text ?? "") : "";
  const taskState = pool.listTasks().find((t) => t.id === taskId);
  const taskModel = taskState?.model ? `${taskState.model.key.provider}/${taskState.model.key.modelId}` : null;
  const zh = resolveLocale() === "zh-CN";

  const systemPrompt = zh
    ? "你是一个会话标题生成器。请根据用户的提问与对话摘要，提炼出一个简短、精准的中文标题（6到16个字）。只输出标题文字本身，不要加引号、句号或任何解释。"
    : "You generate concise session titles. Given the conversation summary, output a short, specific title (3 to 7 words). Output ONLY the title text without quotes or punctuation.";

  const userPrompt = [
    `First message: ${stripPromptNoise(firstUser).slice(0, 400)}`,
    latestUser ? `Latest message: ${stripPromptNoise(latestUser).slice(0, 300)}` : "",
    answer ? `Assistant reply excerpt: ${stripPromptNoise(answer).slice(0, 400)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  let cwd = chatsDir();
  try {
    cwd = pool.taskCwd(taskId);
  } catch {
    // 保留默认目录
  }

  const generated = await runHelperLlm({ systemPrompt, userPrompt, cwd, taskModel });
  const title = (generated ? cleanGeneratedTitle(generated) : "") || fallbackSmartTitle(firstUser, answer, latestUser);
  await pool.renameTask(taskId, title);
  return title;
}

export async function enhancePrompt(text: string, taskId: TaskId | null): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const pool = await getTaskPool();
  const zh = resolveLocale() === "zh-CN";
  let cwd = chatsDir();
  let taskModel: string | null = null;
  let contextLine = "";

  if (taskId !== null) {
    try {
      cwd = pool.taskCwd(taskId);
      const taskState = pool.listTasks().find((t) => t.id === taskId);
      if (taskState?.model) taskModel = `${taskState.model.key.provider}/${taskState.model.key.modelId}`;
      const doc = restoreDocument(pool.getTspSnapshot(taskId).document);
      const users = userMessages(doc);
      if (users.length > 0) {
        contextLine = `\nRecent conversation topic: ${users[users.length - 1]!.text.slice(0, 240)}`;
      }
    } catch {
      // 保留默认上下文
    }
  }

  const systemPrompt = zh
    ? "你是一位资深软件工程提示词优化专家。请将用户输入的草稿重写为清晰、具体、结构化的编程 Agent 提示词。保持用户的原始意图与语言（中文或英文），补全必要的工程约束（如先定位代码、保持风格一致、验证结果），但不要虚构用户未提及的业务需求。只输出优化后的提示词正文，不要包含任何前缀、解释或代码块包裹。"
    : "You are an expert software engineering prompt optimizer. Rewrite the user's draft into a clear, specific, well-structured prompt for an AI coding agent. Preserve the user's original intent and language, clarify technical constraints and verification expectations, and output ONLY the improved prompt text with no preamble or wrapper.";

  const generated = await runHelperLlm({
    systemPrompt,
    userPrompt: `Draft prompt to enhance:\n${trimmed}${contextLine}`,
    cwd,
    taskModel,
  });

  if (generated) {
    return generated.replace(/^```[\w-]*\r?\n|\r?\n```$/g, "").trim() || trimmed;
  }
  return fallbackEnhancePrompt(trimmed, zh);
}
