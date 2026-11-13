// AI 辅助服务：智能会话重命名（smartRenameTask）与输入框提示词优化（enhancePrompt）。
// 复用 pi 的 `-p --no-session --no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes --no-context-files` 无状态单次推理模式，
// 直接共享用户已配置的全部模型与订阅凭据；模型与思考强度由外壳设置（ShellState.helperModel / helperThinking）控制。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { stripAnsi } from "../../shared/ansi.ts";
import type { DraftAttachmentsPayload, HelperThinking, TaskId } from "../../shared/ipc.ts";
import { composerFilePath } from "../files/composer-files.ts";
import { restoreDocument } from "../../shared/tsp/document.ts";
import { lastAnswerText } from "../../shared/tsp/last-answer.ts";
import { userMessages } from "../../shared/tsp/user-messages.ts";
import { isRecord } from "../../shared/type-guards.ts";
import { runCommand } from "../git/exec.ts";
import { readyPiLaunch } from "../pi/runtime-singleton.ts";
import { resolveLocale } from "../settings/settings-store.ts";
import { feedSessionText, type SessionFileEntry } from "../tsp/session-file-reader.ts";
import { getShellState } from "../window/window-state.ts";
import { chatsDir } from "./chats-dir.ts";
import { getTaskPool } from "./runtime.ts";

const HELPER_TIMEOUT_MS = 30_000;

const GREETING_PATTERN =
  /^(?:hello|hi|hey|yo|sup|hola|bonjour|你好[呀啊吗]?|您好|嗨|哈喽|早上好|下午好|晚上好|早安|晚安|在吗|在不在|有人吗|测试(?:一下)?|test(?:ing)?|ping|[?？!！.。…~～1]+)$/i;

export function stripPromptNoise(raw: string): string {
  return raw
    .replace(/<supermemory>[\s\S]*?<\/supermemory>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[(?:Image|Paste|File)\s*#?\d*[^\]]*\]/gi, " ")
    .replace(/https?:\/\/[^\s)>\]]+/gi, " ")
    .replace(/[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|]+[\\/])*([^\s\\/:*?"<>|]+)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isTrivialGreeting(raw: string): boolean {
  const cleaned = stripPromptNoise(raw)
    .replace(/^[#>*\-\s]+|[!！?？.。，,~～\s]+$/g, "")
    .trim();
  if (cleaned.length === 0) return true;
  return GREETING_PATTERN.test(cleaned);
}

export function cleanGeneratedTitle(raw: string): string {
  const lines = stripAnsi(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("```"));
  const line = lines[lines.length - 1] ?? lines[0] ?? "";
  const cleaned = line
    .replace(/^(?:标题|会话标题|Title|Session Title)\s*[:：]\s*/i, "")
    .replace(/^[#*"'`「『【（(]+|[*"'`」』】）)。.！!？?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  return cleaned.length >= 2 && !/^[A-Za-z]$/.test(cleaned) && !isTrivialGreeting(cleaned) ? cleaned : "";
}

function cleanTitleClause(raw: string): string {
  return raw
    .replace(/^[#>*\-\d.\s]+/, "")
    .replace(
      /^(?:请帮我|帮我|请问|我想|我希望|麻烦|能不能|如何|怎么|好的[，,。！!]?\s*|已为您|我已经|当然(?:可以)?[，,。！!]?\s*|下面(?:是|为您)|please\s+|help\s+me\s+|can\s+you\s+|i\s+have\s+|i've\s+)/i,
      "",
    )
    .replace(/^(?:\d+[.、]\s*)+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fallbackSmartTitle(
  promptText: string,
  answerText: string,
  latestUserText = "",
  currentTitle = "",
): string {
  const curNorm = currentTitle.trim();
  const rawCandidates = [promptText, latestUserText, answerText]
    .map(stripPromptNoise)
    .filter((s) => s.length >= 2 && !/^[A-Za-z]$/.test(s));
  const nonGreeting = rawCandidates.filter((s) => !isTrivialGreeting(s));
  const candidates = nonGreeting.length > 0 ? nonGreeting : rawCandidates;

  const allClauses: string[] = [];
  for (const candidate of candidates) {
    const cleaned = cleanTitleClause(candidate);
    const parts = cleaned
      .split(/[，。！？；!?;|\r\n]+/)
      .map((s) => cleanTitleClause(s))
      .filter((s) => s.length >= 2 && !/^[A-Za-z]$/.test(s) && !isTrivialGreeting(s));
    if (parts.length > 0) {
      allClauses.push(...parts);
    } else if (cleaned.length >= 2 && !/^[A-Za-z]$/.test(cleaned)) {
      allClauses.push(cleaned);
    }
  }

  const slice20 = (s: string) => Array.from(s).slice(0, 20).join("").trim();
  const distinct = allClauses.find((s) => slice20(s) !== curNorm && s !== curNorm);
  const best = distinct ?? allClauses[0] ?? cleanTitleClause(candidates[0] ?? "");
  return slice20(best) || "会话主题总结";
}

async function readSessionTranscriptFallback(sessionFile: string | null): Promise<{
  users: string[];
  assistants: string[];
  lastModel: string | null;
}> {
  if (sessionFile === null || sessionFile === "") return { users: [], assistants: [], lastModel: null };
  try {
    const raw = await readFile(sessionFile, "utf8");
    const entries: SessionFileEntry[] = [];
    feedSessionText(raw, [{ entry: (e) => entries.push(e), reset: () => (entries.length = 0) }]);
    const users: string[] = [];
    const assistants: string[] = [];
    let lastModel: string | null = null;
    for (const entry of entries) {
      if (
        entry["type"] === "model_change" &&
        typeof entry["provider"] === "string" &&
        typeof entry["modelId"] === "string"
      ) {
        lastModel = `${entry["provider"]}/${entry["modelId"]}`;
        continue;
      }
      if (entry["type"] !== "message" || !isRecord(entry["message"])) continue;
      const msg = entry["message"];
      const role = msg["role"];
      if (role === "assistant" && typeof msg["provider"] === "string" && typeof msg["model"] === "string") {
        lastModel = `${msg["provider"]}/${msg["model"]}`;
      }
      const content = msg["content"];
      const extract = (): string => {
        if (typeof content === "string") return content.trim();
        if (!Array.isArray(content)) return "";
        const parts: string[] = [];
        for (const block of content) {
          if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
            parts.push(block["text"]);
          }
        }
        return parts.join("\n").trim();
      };
      if (role === "user") {
        const t = extract();
        if (t !== "") users.push(t);
      } else if (role === "assistant") {
        const t = extract();
        if (t !== "") assistants.push(t);
      }
    }
    return { users, assistants, lastModel };
  } catch {
    return { users: [], assistants: [], lastModel: null };
  }
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
  attachFiles?: readonly string[];
}): Promise<string | null> {
  if (!app.isPackaged && (process.env["STUDIO_TEST_PI"] || process.env["STUDIO_TEST_OMP"])) {
    return null;
  }
  try {
    const launch = await readyPiLaunch();
    const shell = getShellState();
    const helperModel = shell.helperModel ?? "smol";
    const helperThinking: HelperThinking = shell.helperThinking ?? "off";

    const invokeOnce = async (spec: string | null, thinking: HelperThinking): Promise<string | null> => {
      const args: string[] = [
        ...launch.prefixArgs,
        "-p",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--thinking",
        thinking,
        "--system-prompt",
        options.systemPrompt,
      ];

      if (spec && spec.includes("/")) {
        const slash = spec.indexOf("/");
        const provider = spec.slice(0, slash);
        const modelId = spec.slice(slash + 1);
        if (provider && modelId) {
          args.push("--provider", provider, "--model", modelId);
        }
      }

      const attachArgs = (options.attachFiles ?? []).map((p) => `@${p}`);
      args.push("--", ...attachArgs, options.userPrompt);

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
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    const chosenSpec =
      helperModel !== "default" && helperModel !== "current" && helperModel !== "smol" && helperModel.includes("/")
        ? helperModel
        : (options.taskModel ?? null);

    const primary = await invokeOnce(chosenSpec, helperThinking);
    if (primary !== null) return primary;

    const fallbackSpec = options.taskModel ?? null;
    if (fallbackSpec !== chosenSpec || helperThinking !== "off") {
      return await invokeOnce(fallbackSpec, "off");
    }
    return null;
  } catch {
    return null;
  }
}

export async function smartRenameTask(taskId: TaskId): Promise<string> {
  const pool = await getTaskPool();
  const currentTitle = pool.taskTitle(taskId);
  const snapshot = pool.getTspSnapshot(taskId);
  const doc = restoreDocument(snapshot.document);
  let users = userMessages(doc).map((u) => u.text);
  let answer = lastAnswerText(doc) ?? "";
  const taskState = pool.listTasks().find((t) => t.id === taskId);
  let taskModel = taskState?.model ? `${taskState.model.key.provider}/${taskState.model.key.modelId}` : null;

  if (answer === "" || taskModel === null || users.every((u) => isTrivialGreeting(u))) {
    let sessionFile: string | null = null;
    try {
      sessionFile = pool.sessionFileOf(taskId);
    } catch {
      sessionFile = null;
    }
    const disk = await readSessionTranscriptFallback(sessionFile);
    if (users.every((u) => isTrivialGreeting(u)) && disk.users.length > 0) {
      users = disk.users;
    }
    if (answer === "" && disk.assistants.length > 0) {
      answer = disk.assistants[disk.assistants.length - 1] ?? "";
    }
    if (taskModel === null && disk.lastModel !== null) {
      taskModel = disk.lastModel;
    }
  }

  const substantiveUsers = users.filter((u) => !isTrivialGreeting(u));
  const firstUser = substantiveUsers[0] ?? users[0] ?? currentTitle;
  const latestUser =
    substantiveUsers.length > 1
      ? (substantiveUsers[substantiveUsers.length - 1] ?? "")
      : users.length > 1
        ? (users[users.length - 1] ?? "")
        : "";
  const zh = resolveLocale() === "zh-CN";

  const systemPrompt = zh
    ? "你是一个会话标题生成器。请根据用户的提问与对话摘要，提炼出一个简短、精准的中文标题（6到16个字）。忽略开头的寒暄（如hello/你好），聚焦核心技术或业务问题。只输出标题文字本身，不要加引号、句号或任何解释。"
    : "You generate concise session titles. Given the conversation summary, ignore initial greetings and output a short, specific title (3 to 7 words). Output ONLY the title text without quotes or punctuation.";

  const userPrompt = [
    `First substantive message: ${stripPromptNoise(firstUser).slice(0, 400)}`,
    latestUser && latestUser !== firstUser ? `Latest message: ${stripPromptNoise(latestUser).slice(0, 300)}` : "",
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
  const title =
    (generated ? cleanGeneratedTitle(generated) : "") ||
    fallbackSmartTitle(firstUser, answer, latestUser, currentTitle);
  await pool.renameTask(taskId, title);
  return title;
}

function imageExt(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

export async function enhancePrompt(input: string | DraftAttachmentsPayload, taskId: TaskId | null): Promise<string> {
  const payload: DraftAttachmentsPayload = typeof input === "string" ? { text: input } : input;
  const trimmed = payload.text.trim();
  const images = payload.images ?? [];
  const fileIds = payload.fileIds ?? [];
  if (!trimmed && images.length === 0 && fileIds.length === 0) return payload.text;

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

  let tempDir: string | null = null;
  const attachFiles: string[] = [];
  const resolvedFiles: string[] = [];

  try {
    if (images.length > 0) {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-enhance-"));
      for (const [idx, img] of images.entries()) {
        const filePath = path.join(tempDir, `image-${idx + 1}.${imageExt(img.mimeType)}`);
        await writeFile(filePath, Buffer.from(img.data, "base64"));
        attachFiles.push(filePath);
      }
    }
    for (const id of fileIds) {
      const p = composerFilePath(id);
      if (p) {
        resolvedFiles.push(path.basename(p));
        attachFiles.push(p);
      }
    }

    const attachmentNote =
      images.length > 0 || resolvedFiles.length > 0
        ? zh
          ? `\n附加附件说明：共有 ${images.length} 张图片${resolvedFiles.length > 0 ? `，以及文件：${resolvedFiles.join("、")}` : ""}。请结合图片/文件里的真实内容来精准优化提示词；如草稿里已有 [Image #N…] 或 [File #N…] 占位符请尽量原样保留，不要自行编造未附加的文件。`
          : `\nAttached context: ${images.length} image(s)${resolvedFiles.length > 0 ? ` and file(s): ${resolvedFiles.join(", ")}` : ""}. Use the attached visual/file context to make the prompt precise, preserve any existing [Image #N...] or [File #N...] tokens, and do not invent unattached files.`
        : "";

    const systemPrompt = zh
      ? "你是一位资深软件工程提示词优化专家。请结合用户的文字草稿与随附的图片/文件内容，将提示词重写为清晰、具体、结构化的编程 Agent 提示词。保持用户的原始意图与语言（中文或英文），补全必要的工程约束（如先定位代码、保持风格一致、验证结果），但不要虚构用户未提及的业务需求。只输出优化后的提示词正文，不要包含任何前缀、解释或代码块包裹。"
      : "You are an expert software engineering prompt optimizer. Given the user's draft and any attached images or files, rewrite the draft into a clear, specific, well-structured prompt for an AI coding agent. Preserve the user's original intent and language, clarify technical constraints and verification expectations, and output ONLY the improved prompt text with no preamble or wrapper.";

    const draftBody =
      trimmed !== ""
        ? trimmed
        : zh
          ? "请结合附加图片或文件给出清晰的具体需求与排查/修改要求。"
          : "Analyze the attached images/files and carry out the required engineering task clearly.";

    const generated = await runHelperLlm({
      systemPrompt,
      userPrompt: `Draft prompt to enhance:\n${draftBody}${attachmentNote}${contextLine}`,
      cwd,
      taskModel,
      attachFiles,
    });

    if (generated) {
      return generated.replace(/^```[\w-]*\r?\n|\r?\n```$/g, "").trim() || trimmed || draftBody;
    }
    return fallbackEnhancePrompt(trimmed || draftBody, zh);
  } finally {
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
