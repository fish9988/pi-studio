// Pure state & protocol converter bridging Pi session JSONL / RPC events ↔ TSP Document frames.
// Produces canonical `omp.*` TSP node shapes so `TspView`, `MainFlow`, `ComposerTop`, and
// shared `src/shared/tsp/*` selectors render Pi conversations with 100% visual & behavioral fidelity.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { classifyAssistantText, PROCESS_HEAD_TEXT } from "../../shared/assistant-text-kind.ts";
import { applyMessage, createDocument, type TspDocMessage, type TspDocument } from "../../shared/tsp/document.ts";
import type { TspDiffHunk, TspEvent, TspNode, TspOp, TspProps } from "../../shared/tsp/tsp.generated.ts";
import { isRecord } from "../../shared/type-guards.ts";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiAssistantMessageEvent,
  PiContentBlock,
  PiExtensionUiRequestEvent,
  PiExtensionUiResponsePayload,
  PiImageContent,
  PiRpcEvent,
  PiTextContent,
  PiThinkingContent,
  PiToolCallContent,
  PiToolResultMessage,
  PiUsage,
} from "./pi-rpc-client.ts";

export const PI_SURFACE_ID = "s:1";

export interface PiTspBlobRecord {
  id: string;
  mime: string;
  bytes: Uint8Array;
  base64: string;
}

export type BridgeActionResult =
  | { kind: "extension_ui_response"; response: PiExtensionUiResponsePayload }
  | { kind: "interrupt" }
  | { kind: "rewind"; cardId: string; entryId?: string | undefined }
  | null;

interface LiveThinkingState {
  wrapperId: string;
  sectionId: string;
  headId: string;
  bodyId: string;
  startedAtMs: number;
  hasToolsAfter: boolean;
}

interface LiveTextState {
  containerId: string;
  mdId: string;
}

interface LiveToolState {
  nodeId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** 流式阶段累计的参数 JSON 文本（RPC 线上事件不带 partial，只能靠 `toolcall_delta` 的文本拼）。 */
  argsJson: string;
  /** 已经写进节点的目标，避免重复 op。 */
  target?: string | undefined;
  startedAtMs?: number | undefined;
  outputId: string | null;
  streamedOutput: string;
}

interface ActiveDialogState {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor";
  cardId: string;
  options: string[];
  selectedIndex: number;
  listId: string | null;
  optionIds: string[];
  inputId: string | null;
  draftText: string;
  cursor: number;
}

export interface HydrateSessionOptions {
  /** Override active leaf entry ID (`null` = empty root before first message). */
  leafId?: string | null | undefined;
}

export interface SessionHydrationMeta {
  sessionId: string | null;
  sessionName: string | null;
  cwd: string | null;
  leafId: string | null;
  labels: ReadonlyMap<string, string>;
}

// ───────── Diff & Formatting Helpers ─────────

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse an existing unified diff string into `TspDiffHunk[]` + `+A −R` counts. */
export function parseUnifiedDiffHunks(diffText: string): {
  hunks: TspDiffHunk[];
  added: number;
  removed: number;
} {
  const rawLines = diffText.replace(/\r\n/g, "\n").split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  const hunks: TspDiffHunk[] = [];
  let current: { oldStart: number; newStart: number; lines: string[] } | null = null;
  let added = 0;
  let removed = 0;

  const flush = (): void => {
    if (current !== null && current.lines.length > 0) {
      hunks.push({
        oldStart: current.oldStart,
        newStart: current.newStart,
        lines: current.lines,
      });
    }
    current = null;
  };

  for (const line of rawLines) {
    const match = HUNK_HEADER_RE.exec(line);
    if (match !== null) {
      flush();
      current = {
        oldStart: Number(match[1] ?? "1"),
        newStart: Number(match[2] ?? "1"),
        lines: [],
      };
      continue;
    }
    if (/^(?:diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) {
      continue;
    }
    if (current === null) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        current = { oldStart: 1, newStart: 1, lines: [] };
      } else {
        continue;
      }
    }
    current.lines.push(line);
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  flush();

  return { hunks, added, removed };
}

/**
 * Compute unified diff hunks (with up to 3 lines of context) between `oldText` and `newText`.
 * Uses LCS dynamic programming for moderate blocks and fast prefix/suffix trimming for large files.
 */
export function computeTextDiffHunks(
  oldText: string,
  newText: string,
  contextLines = 3,
): { hunks: TspDiffHunk[]; added: number; removed: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length === 0 && b.length === 0) {
    return { hunks: [], added: 0, removed: 0 };
  }

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  if (midA.length === 0 && midB.length === 0) {
    return { hunks: [], added: 0, removed: 0 };
  }

  type EditOp = { kind: "ctx" | "del" | "add"; line: string; oldLine: number; newLine: number };
  const ops: EditOp[] = [];

  for (let i = 0; i < prefix; i += 1) {
    ops.push({ kind: "ctx", line: a[i]!, oldLine: i + 1, newLine: i + 1 });
  }

  const dpLimit = 600;
  if (midA.length <= dpLimit && midB.length <= dpLimit && midA.length * midB.length <= 160_000) {
    const m = midA.length;
    const n = midB.length;
    const cols = n + 1;
    const dp = new Int32Array((m + 1) * cols);
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        if (midA[i] === midB[j]) {
          dp[i * cols + j] = (dp[(i + 1) * cols + (j + 1)] ?? 0) + 1;
        } else {
          const down = dp[(i + 1) * cols + j] ?? 0;
          const right = dp[i * cols + (j + 1)] ?? 0;
          dp[i * cols + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    let oldNo = prefix + 1;
    let newNo = prefix + 1;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: "ctx", line: midA[i]!, oldLine: oldNo++, newLine: newNo++ });
        i += 1;
        j += 1;
      } else if ((dp[(i + 1) * cols + j] ?? 0) >= (dp[i * cols + (j + 1)] ?? 0)) {
        ops.push({ kind: "del", line: midA[i]!, oldLine: oldNo++, newLine: newNo });
        i += 1;
      } else {
        ops.push({ kind: "add", line: midB[j]!, oldLine: oldNo, newLine: newNo++ });
        j += 1;
      }
    }
    while (i < m) {
      ops.push({ kind: "del", line: midA[i]!, oldLine: oldNo++, newLine: newNo });
      i += 1;
    }
    while (j < n) {
      ops.push({ kind: "add", line: midB[j]!, oldLine: oldNo, newLine: newNo++ });
      j += 1;
    }
  } else {
    let oldNo = prefix + 1;
    let newNo = prefix + 1;
    for (const line of midA) {
      ops.push({ kind: "del", line, oldLine: oldNo++, newLine: newNo });
    }
    for (const line of midB) {
      ops.push({ kind: "add", line, oldLine: oldNo, newLine: newNo++ });
    }
  }

  for (let i = 0; i < suffix; i += 1) {
    const idxA = a.length - suffix + i;
    const idxB = b.length - suffix + i;
    ops.push({ kind: "ctx", line: a[idxA]!, oldLine: idxA + 1, newLine: idxB + 1 });
  }

  let added = 0;
  let removed = 0;
  const changeIndices: number[] = [];
  for (let idx = 0; idx < ops.length; idx += 1) {
    const op = ops[idx]!;
    if (op.kind === "add") {
      added += 1;
      changeIndices.push(idx);
    } else if (op.kind === "del") {
      removed += 1;
      changeIndices.push(idx);
    }
  }

  if (changeIndices.length === 0) {
    return { hunks: [], added: 0, removed: 0 };
  }

  const ranges: { start: number; end: number }[] = [];
  for (const ci of changeIndices) {
    const start = Math.max(0, ci - contextLines);
    const end = Math.min(ops.length - 1, ci + contextLines);
    const prev = ranges[ranges.length - 1];
    if (prev !== undefined && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const hunks: TspDiffHunk[] = ranges.map((range) => {
    const first = ops[range.start]!;
    const lines: string[] = [];
    for (let k = range.start; k <= range.end; k += 1) {
      const op = ops[k]!;
      if (op.kind === "add") lines.push(`+${op.line}`);
      else if (op.kind === "del") lines.push(`-${op.line}`);
      else lines.push(` ${op.line}`);
    }
    return {
      oldStart: Math.max(1, first.oldLine),
      newStart: Math.max(1, first.newLine),
      lines,
    };
  });

  return { hunks, added, removed };
}

function formatCompactCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

function shortenModelLabel(model: string): string {
  const slashIdx = model.lastIndexOf("/");
  const base = slashIdx >= 0 ? model.slice(slashIdx + 1) : model;
  return base.replace(/-\d{8}$/, "");
}

/** 压缩 HUD 文案：Pi 会带触发原因（threshold / overflow / manual），写清楚比一律一句好认。 */
function compactionHudLabel(reason: string): string {
  return reason === "threshold" || reason === "overflow" || reason === "manual"
    ? `Compacting context (${reason})…`
    : "Compacting context…";
}

/** 耗时脚注：`1.4s` / `12s`，不到 10 秒保留一位小数。 */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function formatClockTime(ts: number | undefined): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatUsageFooter(
  usage: PiUsage | undefined,
  model?: string,
  timestamp?: number,
  elapsedMs?: number,
): string | null {
  const duration = typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? formatElapsed(elapsedMs) : "";
  if (usage === undefined && (model === undefined || model === "") && duration === "") return null;
  const parts: string[] = [];
  if (duration !== "") {
    parts.push(duration);
  }
  if (usage !== undefined) {
    const totalTokens =
      usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (totalTokens > 0) {
      parts.push(`${formatCompactCount(totalTokens)} tok`);
    }
  }
  if (typeof model === "string" && model !== "") {
    parts.push(shortenModelLabel(model));
  }
  const clock = formatClockTime(timestamp);
  if (clock !== null) {
    parts.push(clock);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function extractContentTextAndImages(content: string | readonly PiContentBlock[] | undefined): {
  text: string;
  images: PiImageContent[];
} {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (!Array.isArray(content)) {
    return { text: "", images: [] };
  }
  const textParts: string[] = [];
  const images: PiImageContent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      textParts.push(block["text"]);
    } else if (
      block["type"] === "image" &&
      typeof block["data"] === "string" &&
      typeof block["mimeType"] === "string"
    ) {
      images.push({
        type: "image",
        data: block["data"],
        mimeType: block["mimeType"],
      });
    }
  }
  return { text: textParts.join("\n"), images };
}

/** 从流式事件携带的 partial 里取第 index 个内容块（拿不到返回 undefined）。 */
function partialContentBlock(partial: PiAssistantMessage | undefined, index: number): PiTextContent | undefined {
  const blocks = partial?.content;
  if (!Array.isArray(blocks)) return undefined;
  const block = blocks[index];
  if (!isRecord(block) || block["type"] !== "text") return undefined;
  return block as unknown as PiTextContent;
}

/** 从 partial 里取第 index 个工具调用块（id / 名字 / 已累计的参数）。 */
function toolCallMeta(
  partial: PiAssistantMessage | undefined,
  index: number,
): { id?: string | undefined; toolName?: string | undefined; arguments?: unknown } | undefined {
  const blocks = partial?.content;
  if (!Array.isArray(blocks)) return undefined;
  const block = blocks[index];
  if (!isRecord(block) || block["type"] !== "toolCall") return undefined;
  return {
    id: typeof block["id"] === "string" ? block["id"] : undefined,
    toolName: typeof block["name"] === "string" ? block["name"] : undefined,
    arguments: block["arguments"],
  };
}

/**
 * 把流式阶段拿到的参数归一成对象。
 * 线上 `toolcall_*` 事件是按 provider 逐步拼的：`partial` 里可能是对象，也可能只是一段还在写的 JSON 文本，
 * 半截 JSON 解析失败就返回 {}，绝不抛异常。
 */
function coerceToolArgs(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") return toolArgsFromJsonText(value);
  return {};
}

/** 从（可能不完整的）参数 JSON 文本里拿参数：整段能解析就用它，否则只掠已经闭合的字符串字段。 */
function toolArgsFromJsonText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : {};
  } catch {
    const args: Record<string, unknown> = {};
    for (const match of trimmed.matchAll(/"([A-Za-z_$][\w$]*)"\s*:\s*"((?:[^"\\\n]|\\.)*)"/g)) {
      const key = match[1];
      const literal = match[2];
      if (key === undefined || literal === undefined) continue;
      try {
        args[key] = JSON.parse(`"${literal}"`);
      } catch {
        // 半截转义（末尾一个孤立的 `\`）解析不了，跳过这一条。
      }
    }
    return args;
  }
}

/** `path` / `file_path` 两个参数名（不同 provider 叫法不同）。 */
function pathArgOf(args: Readonly<Record<string, unknown>>): string {
  if (typeof args["path"] === "string") return args["path"];
  if (typeof args["file_path"] === "string") return args["file_path"];
  return "";
}

/** 命令类工具卡头上那一行：描述 > 首行注释 > 第一条实质命令行。 */
function bashCommandTarget(command: string, args: Readonly<Record<string, unknown>>): string {
  const descArg =
    typeof args["description"] === "string" && args["description"].trim() !== ""
      ? args["description"].trim()
      : typeof args["summary"] === "string" && args["summary"].trim() !== ""
        ? args["summary"].trim()
        : undefined;
  const lines = command
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const commentLine = lines.find((l) => /^#\s*\S/.test(l));
  return (
    descArg ??
    (commentLine !== undefined
      ? commentLine.replace(/^#+\s*/, "")
      : (lines.find(
          (l) =>
            !/^(?:Set-Location|cd|pushd|\$ErrorActionPreference\s*=|\$[A-Za-z_]\w*\s*=|export\s+\w+=)/i.test(l) &&
            !l.startsWith("#"),
        ) ??
        lines[0] ??
        command))
  );
}

function capitalizeToolTitle(name: string): string {
  switch (name) {
    case "bash":
      return "Bash";
    case "powershell":
      return "PowerShell";
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
    case "grep":
      return "Grep";
    case "find":
      return "Find";
    case "ls":
      return "List";
    case "codemode":
      return "Codemode";
    case "subagent":
      return "Subagent";
    case "tool_search":
      return "Tool Search";
    default:
      return name.charAt(0).toUpperCase() + name.slice(1);
  }
}

function workingLabelForTool(toolName: string, args: Readonly<Record<string, unknown>>): string {
  const pathArg =
    typeof args["path"] === "string"
      ? args["path"]
      : typeof args["file_path"] === "string"
        ? args["file_path"]
        : undefined;
  const cmdArg = typeof args["command"] === "string" ? (args["command"].trim().split(/\r?\n/)[0] ?? "") : undefined;

  if ((toolName === "bash" || toolName === "powershell") && cmdArg !== undefined && cmdArg !== "") {
    const shortCmd = cmdArg.length > 64 ? `${cmdArg.slice(0, 61)}…` : cmdArg;
    return `Running ${toolName}: ${shortCmd}`;
  }
  if (toolName === "edit" && pathArg !== undefined) return `Editing ${pathArg}`;
  if (toolName === "write" && pathArg !== undefined) return `Writing ${pathArg}`;
  if (toolName === "read" && pathArg !== undefined) return `Reading ${pathArg}`;
  if (pathArg !== undefined) return `${capitalizeToolTitle(toolName)}: ${pathArg}`;
  return `Running ${toolName}…`;
}

// ───────── `subagent` 工具（Pi 扩展） ─────────
//
// Pi 的 subagent 扩展把结构化结果放在 toolResult.details 里，这是唯一的数据源（子代理跑 `--no-session`，不落盘）：
//   { mode: "single" | "parallel" | "chain", isError, results: SingleResult[] }
// 流式 tool_execution_update 的 partialResult.details 形状相同（parallel / chain 边跑边给 results），
// 所以运行中也能从 details 还原右侧「Subagent」面板要的 `agent` 节点；拿不到 details 时退回 args 推断。

export type PiSubagentStatus = "pending" | "running" | "done" | "failed" | "aborted";

/** details 里单条子代理结果，只留面板与详情用得到的字段。 */
export interface PiSubagentOutcome {
  /** details 里的原始 agent 名（`scout`）。 */
  agent: string;
  /** `user` / `project` / `unknown`。 */
  agentSource: string;
  task: string;
  status: PiSubagentStatus;
  model?: string | undefined;
  errorMessage?: string | undefined;
  /** chain 模式里的第几步（1 起）。 */
  step?: number | undefined;
  /** messages 里 assistant 发起的 toolCall 个数。 */
  tools: number;
  /** `usage.turns`。 */
  requests?: number | undefined;
  /** `usage.contextTokens`。 */
  tokens?: number | undefined;
  cost?: number | undefined;
  messages: readonly unknown[];
}

export interface PiSubagentRun {
  mode: "single" | "parallel" | "chain";
  results: PiSubagentOutcome[];
  /** true = 来自 details（含流式 partial）；false = 只有 args 推断。 */
  fromDetails: boolean;
}

/** 桥接层缓存的子代理记录（任务运行器按名字取详情用）。 */
export interface PiSubagentRecord {
  messages: unknown[] | null;
  output: string | null;
  model?: string;
}

/** 缓存的 messages 上限：够看完整轨迹，又不至于把内存吃穿。 */
const SUBAGENT_DETAILS_MAX_BYTES = 8 * 1024 * 1024;

/** Pi 的 ChildStatus → TSP 的 agent 状态（TSP 那一套没有 cancelled，中止叫 aborted）。 */
const SUBAGENT_STATUS: Readonly<Record<string, PiSubagentStatus>> = {
  pending: "pending",
  running: "running",
  completed: "done",
  failed: "failed",
  aborted: "aborted",
};

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 子代理名同时是面板的去重键：只留字母数字和 `_ . -`（同 shared/tsp/agent-hub.ts 的 isAgentName）。 */
function sanitizeSubagentName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/[.][.]+/g, ".")
    .replace(/^[.-]+/, "")
    .slice(0, 96);
  return cleaned;
}

/** 同一次工具调用里重名的子代理追加 `-1`、`-2`（面板按名字去重，名字必须唯一）。 */
function subagentNodeNames(results: readonly PiSubagentOutcome[]): string[] {
  const used = new Map<string, number>();
  return results.map((result, index) => {
    const base = sanitizeSubagentName(result.agent) || `agent-${index + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  });
}

function countAssistantToolCalls(messages: readonly unknown[]): number {
  let count = 0;
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isRecord(block) && block["type"] === "toolCall") count += 1;
    }
  }
  return count;
}

/** 最后一条 assistant 文本（子代理的最终答复）。 */
function finalAssistantText(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    const content = message["content"];
    if (typeof content === "string") {
      if (content !== "") return content;
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") parts.push(block["text"]);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return null;
}

/** 按字节上限从头部丢消息（越新的越重要），不超过 8MB。 */
function trimSubagentMessages(messages: readonly unknown[]): unknown[] {
  const all = [...messages];
  if (all.length <= 200) return all;
  let bytes = 0;
  let start = all.length;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(all[index]) ?? "", "utf8");
    } catch {
      size = 0;
    }
    // 至少留最后一条，哪怕它自己就超了。
    if (bytes + size > SUBAGENT_DETAILS_MAX_BYTES && start !== all.length) break;
    bytes += size;
    start = index;
  }
  return all.slice(start);
}

function subagentOutcomeOf(
  raw: Readonly<Record<string, unknown>>,
  fallbackStatus: PiSubagentStatus,
): PiSubagentOutcome {
  const messages = Array.isArray(raw["messages"]) ? (raw["messages"] as readonly unknown[]) : [];
  const usage = isRecord(raw["usage"]) ? raw["usage"] : {};
  const step = numberOrUndefined(raw["step"]);
  const rawStatus = typeof raw["status"] === "string" ? (SUBAGENT_STATUS[raw["status"]] ?? null) : null;
  const agent = typeof raw["agent"] === "string" ? raw["agent"].trim() : "";
  return {
    agent: agent !== "" ? agent : "agent",
    agentSource: typeof raw["agentSource"] === "string" ? raw["agentSource"] : "unknown",
    task: typeof raw["task"] === "string" ? raw["task"] : "",
    status: rawStatus ?? fallbackStatus,
    model: typeof raw["model"] === "string" && raw["model"] !== "" ? raw["model"] : undefined,
    errorMessage:
      typeof raw["errorMessage"] === "string" && raw["errorMessage"].trim() !== ""
        ? raw["errorMessage"].trim()
        : undefined,
    step: step !== undefined && step > 0 ? step : undefined,
    tools: countAssistantToolCalls(messages),
    requests: numberOrUndefined(usage["turns"]),
    tokens: numberOrUndefined(usage["contextTokens"]),
    cost: numberOrUndefined(usage["cost"]),
    messages,
  };
}

function subagentModeOf(value: unknown, fallback: PiSubagentRun["mode"]): PiSubagentRun["mode"] {
  return value === "single" || value === "parallel" || value === "chain" ? value : fallback;
}

/** details → 结构化结果；没有 details（或 results 不是数组）返回 null。 */
export function parseSubagentDetails(details: Readonly<Record<string, unknown>> | undefined): PiSubagentRun | null {
  if (details === undefined) return null;
  const rawResults = details["results"];
  if (!Array.isArray(rawResults)) return null;
  const results: PiSubagentOutcome[] = [];
  for (const raw of rawResults) {
    if (isRecord(raw)) results.push(subagentOutcomeOf(raw, "running"));
  }
  const mode = subagentModeOf(details["mode"], "single");
  return { mode, results, fromDetails: results.length > 0 };
}

/** args 推断（subagent 的 single / parallel / chain 三种入参）。 */
function subagentRunFromArgs(args: Readonly<Record<string, unknown>>): PiSubagentRun {
  const entry = (raw: unknown): PiSubagentOutcome | null => {
    if (!isRecord(raw)) return null;
    return {
      agent: typeof raw["agent"] === "string" ? raw["agent"].trim() : "",
      agentSource: "unknown",
      task: typeof raw["task"] === "string" ? raw["task"] : "",
      status: "pending",
      tools: 0,
      messages: [],
    };
  };
  const collect = (key: string): PiSubagentOutcome[] => {
    const raw = args[key];
    if (!Array.isArray(raw)) return [];
    const out: PiSubagentOutcome[] = [];
    for (const item of raw) {
      const parsed = entry(item);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  };
  const tasks = collect("tasks");
  if (tasks.length > 0) return { mode: "parallel", results: tasks, fromDetails: false };
  const chain = collect("chain");
  if (chain.length > 0) {
    return {
      mode: "chain",
      results: chain.map((result, index) => ({ ...result, step: index + 1 })),
      fromDetails: false,
    };
  }
  const single = entry({ agent: args["agent"], task: args["task"] });
  if (single !== null && (single.agent !== "" || single.task !== "")) {
    return { mode: "single", results: [single], fromDetails: false };
  }
  return { mode: "single", results: [], fromDetails: false };
}

/** 工具卡的终态 → 推断出来的子代理状态（避免卡结束后面板里还挂着「运行中」）。 */
function subagentStatusFromTool(status: "pending" | "running" | "done" | "error" | "cancelled"): PiSubagentStatus {
  switch (status) {
    case "error":
      return "failed";
    case "cancelled":
      return "aborted";
    case "done":
      return "done";
    case "pending":
      return "pending";
    default:
      return "running";
  }
}

/** details 优先，拿不到（或还没开始）就用 args 推断；推断出来的状态跟随工具卡。 */
export function resolveSubagentRun(
  args: Readonly<Record<string, unknown>>,
  details: Readonly<Record<string, unknown>> | undefined,
  toolStatus: "pending" | "running" | "done" | "error" | "cancelled",
): PiSubagentRun {
  const fromDetails = parseSubagentDetails(details);
  const inferred = subagentRunFromArgs(args);
  if (fromDetails !== null && fromDetails.results.length > 0) {
    // details 里的 mode 才可靠（args 同时给了 tasks 与 chain 时扩展会报错，也走这里）。
    return { mode: fromDetails.mode, results: fromDetails.results, fromDetails: true };
  }
  const status = subagentStatusFromTool(toolStatus);
  return {
    mode: fromDetails?.mode ?? inferred.mode,
    results: inferred.results.map((result) => ({ ...result, status })),
    fromDetails: false,
  };
}

// ───────── Bridge Class ─────────

export class PiTspBridge {
  private readonly doc: TspDocument = createDocument();
  private readonly blobs = new Map<string, PiTspBlobRecord>();
  private readonly frameListeners = new Set<(messages: TspDocMessage[], firstSeq: number) => void>();
  private readonly notifyListeners = new Set<
    (info: { message: string; level: "info" | "warning" | "error" }) => void
  >();
  private readonly editorPrefillListeners = new Set<(text: string) => void>();
  private readonly titleListeners = new Set<(title: string) => void>();
  private readonly touchedPathListeners = new Set<(targetPath: string, toolName: string) => void>();

  private frameCounter = 0;
  private seqCounter = 0;
  private idCounter = 0;

  private hudActive = false;
  /** 扩展调 `setWidget` 写在 `dock.widget` 里的文本行；表空时文档里没有 `dock.widget` 节点。 */
  private readonly widgets = new Map<string, { lines: string[]; placement?: string | undefined }>();
  /** 当前轮开始的时间（`turn_start`）；没在跑时为 null，耗时脚注靠它算。 */
  private turnStartedAtMs: number | null = null;
  private liveThinking = new Map<number, LiveThinkingState>();
  private liveText = new Map<number, LiveTextState>();
  /** 流式时已经折成过程段的 text 块下标，`message_end` 不再重复生成。 */
  private liveProcessIndexes = new Set<number>();
  /** 流式时换成过程段的容器 id，`message_end` 不能当空正文容器删掉。 */
  private liveProcessContainers = new Set<string>();
  private liveTools = new Map<string, LiveToolState>();
  /** `toolcall_delta` 只带 contentIndex：记下它对应的工具调用 id，才能在没收到 start 时也接上。 */
  private liveToolIndexes = new Map<number, string>();
  /** 最近一次 `subagent` 运行的结果记录：面板名 → messages / 最终输出 / 模型（同名保留最新）。 */
  private readonly subagentRecords = new Map<string, PiSubagentRecord>();
  private lastStreamAssistantId: string | null = null;
  private pendingOptimisticUsers: string[] = [];
  private activeDialog: ActiveDialogState | null = null;
  private lastHydrationMeta: SessionHydrationMeta = {
    sessionId: null,
    sessionName: null,
    cwd: null,
    leafId: null,
    labels: new Map(),
  };

  constructor(title = "pi") {
    this.initSurface(title);
  }

  get document(): TspDocument {
    return this.doc;
  }

  get seq(): number {
    return this.seqCounter;
  }

  get frameNumber(): number {
    return this.frameCounter;
  }

  get hydrationMeta(): SessionHydrationMeta {
    return this.lastHydrationMeta;
  }

  get hasActiveDialog(): boolean {
    return this.activeDialog !== null;
  }

  /**
   * 上面板里那个子代理的原始记录（Pi 的 subagent 扩展不落盘，只能从最近一次 details 里取）。
   * 名字是面板显示名（重名时带 `-1`、`-2` 后缀）；没跑过为 null。
   */
  getSubagentRecord(name: string): PiSubagentRecord | null {
    const record = this.subagentRecords.get(name);
    return record === undefined ? null : { ...record };
  }

  onFrames(listener: (messages: TspDocMessage[], firstSeq: number) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  onNotify(listener: (info: { message: string; level: "info" | "warning" | "error" }) => void): () => void {
    this.notifyListeners.add(listener);
    return () => {
      this.notifyListeners.delete(listener);
    };
  }

  onEditorPrefill(listener: (text: string) => void): () => void {
    this.editorPrefillListeners.add(listener);
    return () => {
      this.editorPrefillListeners.delete(listener);
    };
  }

  onTitleChange(listener: (title: string) => void): () => void {
    this.titleListeners.add(listener);
    return () => {
      this.titleListeners.delete(listener);
    };
  }

  onTouchedPath(listener: (targetPath: string, toolName: string) => void): () => void {
    this.touchedPathListeners.add(listener);
    return () => {
      this.touchedPathListeners.delete(listener);
    };
  }

  getBlob(id: string): PiTspBlobRecord | null {
    return this.blobs.get(id) ?? null;
  }

  // ───────── Surface Initialization & Frame Emission ─────────

  private initSurface(title: string): TspDocMessage[] {
    const openMsg: TspDocMessage = {
      verb: "o",
      body: {
        id: PI_SURFACE_ID,
        mode: "inline",
        title,
        role: "omp.session",
      },
    };
    applyMessage(this.doc, openMsg);
    this.seqCounter += 1;

    const initOps: TspOp[] = [
      ["add", "main", PI_SURFACE_ID, null, { id: "main", k: "col", p: { gap: "md" } }],
      [
        "add",
        "dock",
        PI_SURFACE_ID,
        null,
        {
          id: "dock",
          k: "col",
          p: { gap: "xs" },
          c: [
            { id: "dock.hud", k: "col", p: { gap: "xs" } },
            { id: "dock.dialog", k: "col", p: { gap: "xs" } },
          ],
        },
      ],
      ["add", "layer", PI_SURFACE_ID, null, { id: "layer", k: "col" }],
    ];

    const initFrame: TspDocMessage = {
      verb: "f",
      body: {
        sf: PI_SURFACE_ID,
        s: ++this.frameCounter,
        ops: initOps,
      },
    };
    applyMessage(this.doc, initFrame);
    this.seqCounter += 1;
    return [openMsg, initFrame];
  }

  private nextId(prefix: string): string {
    return `${prefix}_${++this.idCounter}`;
  }

  private emitBlob(image: PiImageContent): { blobId: string; msg: TspDocMessage | null } {
    const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
    const blobId = createHash("sha256").update(bytes).digest("hex");
    if (this.blobs.has(blobId) && this.doc.blobs.has(blobId)) {
      return { blobId, msg: null };
    }
    this.blobs.set(blobId, {
      id: blobId,
      mime: image.mimeType,
      bytes,
      base64: image.data,
    });
    const msg: TspDocMessage = {
      verb: "b",
      id: blobId,
      mime: image.mimeType,
      data: image.data,
    };
    return { blobId, msg };
  }

  private emitOps(ops: TspOp[], preMessages: TspDocMessage[] = []): TspDocMessage[] {
    const out: TspDocMessage[] = [];
    for (const pre of preMessages) {
      applyMessage(this.doc, pre);
      out.push(pre);
    }
    if (ops.length > 0) {
      const frame: TspDocMessage = {
        verb: "f",
        body: {
          sf: PI_SURFACE_ID,
          s: ++this.frameCounter,
          ops,
        },
      };
      applyMessage(this.doc, frame);
      out.push(frame);
    }
    if (out.length > 0) {
      const firstSeq = this.seqCounter + 1;
      this.seqCounter += out.length;
      for (const listener of this.frameListeners) {
        listener(out, firstSeq);
      }
    }
    return out;
  }

  private nodeExists(id: string): boolean {
    return this.doc.surfaces.get(PI_SURFACE_ID)?.nodes.has(id) === true;
  }

  private appendClearChildrenOps(ops: TspOp[], containerId: string): void {
    const children = this.doc.surfaces.get(PI_SURFACE_ID)?.nodes.get(containerId)?.c;
    if (children === undefined || children.length === 0) return;
    for (const childId of children) {
      ops.push(["del", childId]);
    }
  }

  private appendReplaceNodeOps(ops: TspOp[], nodeId: string, newNode: TspNode, fallbackParent = "main"): void {
    const surface = this.doc.surfaces.get(PI_SURFACE_ID);
    const existing = surface?.nodes.get(nodeId);
    if (existing !== undefined && existing.parent !== null && surface !== undefined) {
      const siblings = surface.nodes.get(existing.parent)?.c ?? [];
      const idx = siblings.indexOf(nodeId);
      const before = idx >= 0 && idx + 1 < siblings.length ? (siblings[idx + 1] ?? null) : null;
      ops.push(["del", nodeId], ["add", nodeId, existing.parent, before, newNode]);
      return;
    }
    ops.push(["add", nodeId, fallbackParent, null, newNode]);
  }

  // ───────── Node Builders ─────────

  private buildUserCardNode(params: {
    cardId: string;
    text: string;
    images: readonly PiImageContent[];
    entryId?: string | undefined;
    timestamp?: number | undefined;
    blobMessagesOut: TspDocMessage[];
  }): TspNode {
    const { cardId, text, images, entryId, blobMessagesOut } = params;
    const cardChildren: TspNode[] = [];

    if (text !== "" || images.length === 0) {
      cardChildren.push({
        id: `${cardId}/md`,
        k: "md",
        p: { text },
      });
    }

    if (text !== "" && this.touchedPathListeners.size > 0) {
      const pathMatches = text.match(/[A-Za-z]:[\\/][^\s"'<>|*?:]+/g);
      if (pathMatches !== null) {
        for (const matchedPath of pathMatches) {
          for (const listener of this.touchedPathListeners) {
            listener(matchedPath, "prompt");
          }
        }
      }
    }

    if (images.length > 0) {
      const imageNodes: TspNode[] = images.map((img, idx) => {
        const { blobId, msg } = this.emitBlob(img);
        if (msg !== null) blobMessagesOut.push(msg);
        return {
          id: `${cardId}/img.${idx}`,
          k: "image",
          p: {
            blob: blobId,
            alt: `Image ${idx + 1}`,
            max: { h: "16lines" },
          },
        };
      });
      cardChildren.push({
        id: `${cardId}/images`,
        k: "row",
        p: {
          role: "omp.user.images",
          gap: "xs",
          wrap: true,
        },
        c: imageNodes,
      });
    }

    return {
      id: cardId,
      k: "card",
      p: {
        role: "omp.user",
        tone: "user",
        ...(entryId !== undefined && entryId !== "" ? { key: entryId } : {}),
      },
      c: cardChildren,
    };
  }

  private buildThinkingSectionNode(params: {
    sectionId: string;
    thinkingText: string;
    live: boolean;
    durationSec?: number | undefined;
    /** 换掉默认标题（过程旁白用 `Commentary`，不再是 “Thought”）。 */
    headText?: string | undefined;
    /** 折叠态默认值；漏出来的思维/旁白一律折叠。 */
    collapsed?: boolean | undefined;
  }): { section: TspNode; headId: string; bodyId: string } {
    const { sectionId, thinkingText, live, durationSec, headText } = params;
    const headId = `${sectionId}/head`;
    const bodyId = `${sectionId}/body`;

    const label =
      headText ??
      (live
        ? "Thinking…"
        : durationSec !== undefined && durationSec > 0
          ? `Thought for ${durationSec.toFixed(1)}s`
          : "Thought");

    const headNode: TspNode = live
      ? { id: headId, k: "shimmer", p: { text: label } }
      : { id: headId, k: "text", p: { text: label } };

    const section: TspNode = {
      id: sectionId,
      k: "section",
      p: {
        role: live ? "omp.thinking.live" : "omp.thinking",
        collapsible: true,
        collapsed: params.collapsed ?? !live,
        head: headId,
        ...(!live && durationSec !== undefined && durationSec > 0 ? { took: Math.round(durationSec * 1000) } : {}),
      },
      c: [
        headNode,
        {
          id: bodyId,
          k: "md",
          p: {
            role: "omp.thinking.body",
            text: thinkingText,
            ...(live ? { stream: true } : {}),
          },
        },
      ],
    };

    return { section, headId, bodyId };
  }

  /** 把漏进正文通道的过程/思维包成一个可折叠段落（和思考段同样被 MainFlow 收进过程组）。 */
  private buildProcessSectionNode(text: string): { wrapper: TspNode; wrapperId: string; sectionId: string } {
    const wrapperId = this.nextId("asst_th");
    const sectionId = `${wrapperId}/sec`;
    const { section } = this.buildThinkingSectionNode({
      sectionId,
      thinkingText: text,
      live: false,
      headText: text.trim() === "" ? "Thought" : PROCESS_HEAD_TEXT,
      collapsed: true,
    });
    const wrapper: TspNode = {
      id: wrapperId,
      k: "col",
      p: { role: "omp.assistant", gap: "sm" },
      c: [section],
    };
    return { wrapper, wrapperId, sectionId };
  }

  /**
   * 工具卡"目标"（命令首行 / 文件路径 / 搜索词）的提取规则：流式增量更新与整卡重建共用。
   * 拿不到目标时返回 null（卡片就只显示工具名）。
   */
  private toolTargetProps(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): { target: string; targetKind: NonNullable<TspProps<"tool">["targetKind"]> } | null {
    if (toolName === "bash" || toolName === "powershell") {
      const command = typeof args["command"] === "string" ? args["command"] : "";
      if (command.trim() === "") return null;
      return { target: bashCommandTarget(command, args).slice(0, 120), targetKind: "command" };
    }
    const pathArg = pathArgOf(args);
    if (toolName === "edit" || toolName === "write" || toolName === "read") {
      return pathArg !== "" ? { target: pathArg, targetKind: "path" } : null;
    }
    // 子代理的目标由 `agent` 行决定，不在这里猜。
    if (toolName === "subagent") return null;

    const queriesList = Array.isArray(args["queries"])
      ? (args["queries"] as unknown[]).filter((q): q is string => typeof q === "string" && q.trim() !== "")
      : [];
    const urlsList = Array.isArray(args["urls"])
      ? (args["urls"] as unknown[]).filter((u): u is string => typeof u === "string" && u.trim() !== "")
      : [];
    const targetCandidate =
      pathArg !== ""
        ? pathArg
        : typeof args["pattern"] === "string"
          ? args["pattern"]
          : typeof args["query"] === "string"
            ? args["query"]
            : queriesList.length > 0
              ? queriesList.slice(0, 2).join(" · ")
              : typeof args["url"] === "string"
                ? args["url"]
                : urlsList.length > 0
                  ? urlsList[0]
                  : typeof args["claim"] === "string"
                    ? args["claim"]
                    : typeof args["tool"] === "string"
                      ? args["tool"]
                      : typeof args["search"] === "string"
                        ? args["search"]
                        : typeof args["server"] === "string"
                          ? args["server"]
                          : typeof args["memory"] === "string"
                            ? args["memory"]
                            : typeof args["findText"] === "string"
                              ? args["findText"]
                              : undefined;
    if (targetCandidate === undefined || targetCandidate === "") return null;
    if (pathArg !== "") return { target: targetCandidate, targetKind: "path" };
    if (typeof args["pattern"] === "string" || typeof args["query"] === "string" || queriesList.length > 0) {
      return { target: targetCandidate, targetKind: "query" };
    }
    return { target: targetCandidate, targetKind: "text" };
  }

  private buildToolNode(params: {
    nodeId: string;
    toolCallId: string;
    toolName: string;
    args: Readonly<Record<string, unknown>>;
    status: "pending" | "running" | "done" | "error" | "cancelled";
    outputText: string;
    images?: readonly PiImageContent[] | undefined;
    details?: Readonly<Record<string, unknown>> | undefined;
    durationMs?: number | undefined;
    exitCode?: number | undefined;
    /** 工具开始的时间（`subagent` 的 agent 节点据此算运行时长）。 */
    startedAtMs?: number | undefined;
    blobMessagesOut: TspDocMessage[];
  }): { node: TspNode; outputId: string | null } {
    const {
      nodeId,
      toolCallId,
      toolName,
      args,
      status,
      outputText,
      images = [],
      details,
      durationMs,
      exitCode,
      startedAtMs,
      blobMessagesOut,
    } = params;

    const title = capitalizeToolTitle(toolName);
    const props: TspProps<"tool"> = {
      role: `omp.tool.${toolName}`,
      key: toolCallId,
      name: toolName,
      title,
      status,
      frame: "card",
      collapsible: true,
      collapsed: true,
      preview: "children",
    };

    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
      props.took = Math.round(durationMs);
    }
    // 未完成时给时间轴起点，渲染层自己每 100ms 递增；完成时只留 `took`。
    if (status === "pending" || status === "running") {
      props.age = 0;
    }

    const children: TspNode[] = [];
    let outputId: string | null = null;

    if (toolName === "bash" || toolName === "powershell") {
      const command = typeof args["command"] === "string" ? args["command"] : "";
      if (command !== "") {
        props.command = command;
        const target = this.toolTargetProps(toolName, args);
        if (target !== null) {
          props.target = target.target;
          props.targetKind = target.targetKind;
        }
      }
      const inferredExit =
        typeof exitCode === "number"
          ? exitCode
          : typeof details?.["exitCode"] === "number"
            ? (details["exitCode"] as number)
            : (() => {
                const m = /(?:Command exited with code|exited with code|exit code:?)\s*(\d+)/i.exec(outputText);
                return m ? Number(m[1]) : undefined;
              })();
      if (typeof inferredExit === "number" && Number.isFinite(inferredExit) && inferredExit !== 0) {
        props.exit = inferredExit;
      }
      const lang = toolName === "powershell" ? "powershell" : "bash";
      const outId = `${nodeId}/out`;
      outputId = outId;
      children.push({
        id: `${nodeId}/run`,
        k: "col",
        p: { role: "omp.run", gap: "xs" },
        c: [
          {
            id: `${nodeId}/cmd`,
            k: "code",
            p: {
              role: "omp.tool.bash.command",
              lang,
              text: command,
            },
          },
          {
            id: outId,
            k: "ansi",
            p: {
              role: "omp.tool.bash.output",
              text: outputText,
              preview: { lines: 6 },
            },
          },
        ],
      });
    } else if (toolName === "edit" || toolName === "write" || toolName === "read") {
      const targetPath = pathArgOf(args);
      const target = this.toolTargetProps(toolName, args);
      if (target !== null) {
        props.target = target.target;
        props.targetKind = target.targetKind;
      }

      if (toolName === "edit") {
        let diffInfo: { hunks: TspDiffHunk[]; added: number; removed: number } | null = null;
        if (details !== undefined && typeof details["diff"] === "string" && details["diff"].trim() !== "") {
          diffInfo = parseUnifiedDiffHunks(details["diff"]);
        } else {
          const oldText =
            typeof args["oldText"] === "string"
              ? args["oldText"]
              : typeof args["old_str"] === "string"
                ? args["old_str"]
                : undefined;
          const newText =
            typeof args["newText"] === "string"
              ? args["newText"]
              : typeof args["new_str"] === "string"
                ? args["new_str"]
                : undefined;
          if (oldText !== undefined && newText !== undefined) {
            diffInfo = computeTextDiffHunks(oldText, newText);
          } else if (Array.isArray(args["edits"])) {
            const combinedHunks: TspDiffHunk[] = [];
            let totalAdd = 0;
            let totalRem = 0;
            for (const editItem of args["edits"]) {
              if (
                isRecord(editItem) &&
                typeof editItem["oldText"] === "string" &&
                typeof editItem["newText"] === "string"
              ) {
                const sub = computeTextDiffHunks(editItem["oldText"], editItem["newText"]);
                combinedHunks.push(...sub.hunks);
                totalAdd += sub.added;
                totalRem += sub.removed;
              }
            }
            if (combinedHunks.length > 0 || totalAdd > 0 || totalRem > 0) {
              diffInfo = { hunks: combinedHunks, added: totalAdd, removed: totalRem };
            }
          }
        }

        if (diffInfo !== null && (diffInfo.hunks.length > 0 || diffInfo.added > 0 || diffInfo.removed > 0)) {
          props.meta = [`+${diffInfo.added} −${diffInfo.removed}`];
          children.push({
            id: `${nodeId}/diff`,
            k: "diff",
            p: {
              path: targetPath,
              hunks: diffInfo.hunks,
            },
          });
        }
        if (status === "error" && outputText !== "") {
          const outId = `${nodeId}/out`;
          outputId = outId;
          children.push({
            id: outId,
            k: "ansi",
            p: { text: outputText, preview: { lines: 6 } },
          });
        }
      } else if (toolName === "write") {
        const content = typeof args["content"] === "string" ? args["content"] : undefined;
        if (content !== undefined) {
          const lines = splitLines(content);
          const addedCount = lines.length === 0 && content.length > 0 ? 1 : lines.length;
          props.meta = [`+${addedCount} −0`];
          const hunkLines = (lines.length > 0 ? lines : [content]).map((l) => `+${l}`);
          children.push({
            id: `${nodeId}/diff`,
            k: "diff",
            p: {
              path: targetPath,
              hunks: [{ oldStart: 1, newStart: 1, lines: hunkLines }],
            },
          });
        }
        if (status === "error" && outputText !== "") {
          const outId = `${nodeId}/out`;
          outputId = outId;
          children.push({
            id: outId,
            k: "ansi",
            p: { text: outputText, preview: { lines: 6 } },
          });
        }
      } else {
        // read
        const isPureImageNotice = images.length > 0 && /^Read image file\b/i.test(outputText.trim());
        if (isPureImageNotice) {
          const mimeBadge = images[0]?.mimeType.replace(/^image\//i, "").toUpperCase();
          if (mimeBadge) props.meta = [mimeBadge];
        } else {
          const lineCount = splitLines(outputText).length;
          if (lineCount > 0) {
            props.meta = [`${lineCount} lines`];
          }
          const outId = `${nodeId}/code`;
          outputId = outId;
          children.push({
            id: outId,
            k: "code",
            p: {
              text: outputText,
              preview: { lines: 6 },
            },
          });
        }
      }
    } else if (toolName === "subagent") {
      // 子代理：把 details / args 变成 `agent` 节点（右侧 Subagent 面板读的就是它们），
      // 原始输出文本留在最后的 ansi 节点里。
      const run = resolveSubagentRun(args, details, status);
      const built = this.buildSubagentAgentNodes({ nodeId, run, startedAtMs });
      if (built.length > 0) {
        children.push(...built.map((agent) => agent.node));
        const names = built.map((agent) => agent.name);
        props.target = names.join(", ").slice(0, 120);
        props.targetKind = "text";
        if (run.mode !== "single") props.meta = [`${names.length} agents`];
      }
      if (status === "error") props.note = "failed";
      else if (status === "cancelled") props.note = "cancelled";
      if (outputText.trim() !== "") {
        const outId = `${nodeId}/out`;
        outputId = outId;
        children.push({
          id: outId,
          k: "ansi",
          p: {
            role: "omp.tool.subagent.output",
            text: outputText,
            preview: { lines: 6 },
          },
        });
      }
    } else {
      const target = this.toolTargetProps(toolName, args);
      if (target !== null) {
        props.target = target.target;
        props.targetKind = target.targetKind;
      }
      const outId = `${nodeId}/out`;
      outputId = outId;
      children.push({
        id: outId,
        k: "ansi",
        p: {
          text: outputText,
          preview: { lines: 6 },
        },
      });
    }

    if (props.targetKind === "path" && typeof props.target === "string" && props.target !== "") {
      for (const listener of this.touchedPathListeners) {
        listener(props.target, toolName);
      }
    } else if (toolName === "bash" || toolName === "powershell") {
      const command = typeof args["command"] === "string" ? args["command"] : "";
      const cdMatch =
        /(?:^|[;\n&|])\s*(?:Set-Location(?:\s+-(?:LiteralPath|Path))?|cd(?:\s+\/d)?|pushd|git\s+-C)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(
          command,
        );
      const dirArg = cdMatch?.[1] ?? cdMatch?.[2] ?? cdMatch?.[3];
      if (dirArg !== undefined && dirArg !== "") {
        for (const listener of this.touchedPathListeners) {
          listener(dirArg, toolName);
        }
      }
    }

    images.forEach((img, idx) => {
      const { blobId, msg } = this.emitBlob(img);
      if (msg !== null) blobMessagesOut.push(msg);
      children.push({
        id: `${nodeId}/img.${idx}`,
        k: "image",
        p: {
          blob: blobId,
          alt: `${toolName} image ${idx + 1}`,
          max: { h: "16lines" },
        },
      });
    });

    return {
      node: {
        id: nodeId,
        k: "tool",
        p: props,
        c: children,
      },
      outputId,
    };
  }

  // ───────── `subagent` 节点与记录 ─────────

  /**
   * 一次 `subagent` 工具调用的 `agent` 子节点：id 固定为 `<工具节点>:agent:<序号>`，
   * 后续 update 只 set 不重建，面板不会重复出现同一行。
   */
  private buildSubagentAgentNodes(params: {
    nodeId: string;
    run: PiSubagentRun;
    startedAtMs?: number | undefined;
  }): { node: TspNode; name: string }[] {
    const { nodeId, run, startedAtMs } = params;
    if (run.results.length === 0) return [];
    if (run.fromDetails) this.rememberSubagentRecords(run);

    const names = subagentNodeNames(run.results);
    const now = Date.now();
    return run.results.map((result, index) => {
      const name = names[index] ?? `agent-${index + 1}`;
      const id = `${nodeId}:agent:${index}`;
      return { node: this.buildSubagentAgentNode({ id, name, result, run, now, startedAtMs }), name };
    });
  }

  private buildSubagentAgentNode(params: {
    id: string;
    name: string;
    result: PiSubagentOutcome;
    run: PiSubagentRun;
    now: number;
    startedAtMs?: number | undefined;
  }): TspNode {
    const { id, name, result, run, now, startedAtMs } = params;
    const props = this.subagentAgentProps({ name, result, run, now, startedAtMs });
    const children: TspNode[] = [];
    if (result.errorMessage !== undefined) {
      children.push({ id: `${id}/err`, k: "md", p: { role: "omp.agent.error", text: result.errorMessage } });
    }
    return { id, k: "agent", p: props, ...(children.length > 0 ? { c: children } : {}) };
  }

  /** `agent` 节点的 props（props 合并语义是 set 覆盖，所以这里列全所有可能出现的键）。 */
  private subagentAgentProps(params: {
    name: string;
    result: PiSubagentOutcome;
    run: PiSubagentRun;
    now: number;
    startedAtMs?: number | undefined;
  }): TspProps<"agent"> {
    const { name, result, run, now, startedAtMs } = params;
    const active = result.status === "running" || result.status === "pending";
    const stats: NonNullable<TspProps<"agent">["stats"]> = {};
    if (result.tools > 0) stats.tools = result.tools;
    if (result.requests !== undefined && result.requests > 0) stats.requests = result.requests;
    if (result.tokens !== undefined && result.tokens > 0) stats.tokens = result.tokens;
    if (result.cost !== undefined && result.cost > 0) stats.cost = result.cost;
    if (active && startedAtMs !== undefined) stats.age = Math.max(0, now - startedAtMs);

    const badges: { text: string }[] = [];
    if (run.mode !== "single") badges.push({ text: run.mode });
    if (result.step !== undefined) badges.push({ text: `step ${result.step}` });

    return {
      name,
      status: result.status,
      agent: result.agentSource,
      task: result.task,
      ...(result.model !== undefined ? { model: result.model } : {}),
      ...(Object.keys(stats).length > 0 ? { stats } : {}),
      ...(badges.length > 0 ? { badges } : {}),
    };
  }

  /** 缓存最近一次的 messages / 最终输出 / 模型（同名保留最新；Pi 不落盘，这是详情页唯一来源）。 */
  private rememberSubagentRecords(run: PiSubagentRun): void {
    const names = subagentNodeNames(run.results);
    run.results.forEach((result, index) => {
      const name = names[index];
      if (name === undefined) return;
      const record: PiSubagentRecord = {
        messages: trimSubagentMessages(result.messages),
        output: finalAssistantText(result.messages),
        ...(result.model !== undefined ? { model: result.model } : {}),
      };
      this.subagentRecords.set(name, record);
    });
  }

  /**
   * 流式 update 时只动 `agent` 子节点（set / add / del），不重建整张工具卡：
   * 细节很多时整体重建会按块闪烁，而 set 只是改 props。
   */
  private appendSubagentUpdateOps(
    ops: TspOp[],
    params: {
      nodeId: string;
      run: PiSubagentRun;
      startedAtMs?: number | undefined;
    },
  ): void {
    const { nodeId, run, startedAtMs } = params;
    if (run.results.length === 0) return;
    if (run.fromDetails) this.rememberSubagentRecords(run);

    const names = subagentNodeNames(run.results);
    const now = Date.now();
    const outId = `${nodeId}/out`;
    const before = this.nodeExists(outId) ? outId : null;

    run.results.forEach((result, index) => {
      const name = names[index] ?? `agent-${index + 1}`;
      const id = `${nodeId}:agent:${index}`;
      const errId = `${id}/err`;
      const props = this.subagentAgentProps({ name, result, run, now, startedAtMs });
      if (!this.nodeExists(id)) {
        ops.push(["add", id, nodeId, before, this.buildSubagentAgentNode({ id, name, result, run, now, startedAtMs })]);
        return;
      }
      ops.push([
        "set",
        id,
        {
          ...props,
          // 没有的键显式置 null：set 是合并语义，不置 null 旧值会留着。
          model: props.model ?? null,
          badges: props.badges ?? null,
          stats: props.stats ?? null,
        },
      ]);
      if (result.errorMessage === undefined) {
        if (this.nodeExists(errId)) ops.push(["del", errId]);
      } else if (this.nodeExists(errId)) {
        ops.push(["set", errId, { text: result.errorMessage }]);
      } else {
        ops.push([
          "add",
          errId,
          id,
          null,
          { id: errId, k: "md", p: { role: "omp.agent.error", text: result.errorMessage } },
        ]);
      }
    });
  }

  private buildUsageRowNode(rowId: string, usageText: string): TspNode {
    return {
      id: rowId,
      k: "row",
      p: {
        role: "omp.turn.usage",
        gap: "xs",
        align: "center",
      },
      c: [
        { id: `${rowId}/icon`, k: "icon", p: { name: "time", tone: "muted" } },
        { id: `${rowId}/text`, k: "text", p: { spans: [{ t: usageText, s: "muted" }] } },
      ],
    };
  }

  private buildErrorCardNode(cardId: string, errorMessageText: string): TspNode {
    return {
      id: cardId,
      k: "card",
      p: {
        role: "omp.error",
        tone: "error",
      },
      c: [
        {
          id: `${cardId}/head`,
          k: "row",
          p: { gap: "xs", align: "center" },
          c: [
            { id: `${cardId}/icon`, k: "icon", p: { name: "error", tone: "error" } },
            { id: `${cardId}/title`, k: "text", p: { spans: [{ t: "Error", s: "error strong" }] } },
          ],
        },
        {
          id: `${cardId}/body`,
          k: "md",
          p: { role: "omp.error.body", text: errorMessageText },
        },
      ],
    };
  }

  private buildCompactionSectionNode(
    sectionId: string,
    summary: string,
    tokensBefore?: number | undefined,
    tokensAfter?: number | undefined,
  ): TspNode {
    const headId = `${sectionId}/head`;
    const afterLabel =
      typeof tokensAfter === "number" && tokensAfter > 0 ? ` → ${formatCompactCount(tokensAfter)}` : "";
    const label =
      typeof tokensBefore === "number" && tokensBefore > 0
        ? `Compacted context · ${formatCompactCount(tokensBefore)}${afterLabel} tokens`
        : "Compacted context";
    return {
      id: sectionId,
      k: "section",
      p: {
        role: "omp.compaction",
        collapsible: true,
        collapsed: true,
        head: headId,
      },
      c: [
        {
          id: headId,
          k: "row",
          p: { gap: "xs", align: "center" },
          c: [
            { id: `${headId}/icon`, k: "icon", p: { name: "compress", tone: "muted" } },
            { id: `${headId}/text`, k: "text", p: { spans: [{ t: label, s: "muted" }] } },
          ],
        },
        {
          id: `${sectionId}/body`,
          k: "md",
          p: { role: "omp.compaction.body", text: summary || "(Empty summary)" },
        },
      ],
    };
  }

  private buildBranchSummarySectionNode(sectionId: string, summary: string): TspNode {
    const headId = `${sectionId}/head`;
    return {
      id: sectionId,
      k: "section",
      p: {
        role: "omp.branch_summary",
        collapsible: true,
        collapsed: true,
        head: headId,
      },
      c: [
        {
          id: headId,
          k: "row",
          p: { gap: "xs", align: "center" },
          c: [
            { id: `${headId}/icon`, k: "icon", p: { name: "branch", tone: "muted" } },
            { id: `${headId}/text`, k: "text", p: { spans: [{ t: "Branch summary", s: "muted" }] } },
          ],
        },
        {
          id: `${sectionId}/body`,
          k: "md",
          p: { role: "omp.branch_summary.body", text: summary || "(Empty branch summary)" },
        },
      ],
    };
  }

  // ───────── Optimistic User Prompt Helper ─────────

  appendOptimisticUserMessage(text: string, images: readonly PiImageContent[] = [], entryId?: string): TspDocMessage[] {
    this.pendingOptimisticUsers.push(text.trim());
    const blobMessages: TspDocMessage[] = [];
    const cardId = this.nextId("user");
    const card = this.buildUserCardNode({
      cardId,
      text,
      images,
      entryId,
      timestamp: Date.now(),
      blobMessagesOut: blobMessages,
    });
    return this.emitOps([["add", cardId, "main", null, card]], blobMessages);
  }

  // ───────── Session File & Message History Hydration ─────────

  async hydrateFromSessionFile(sessionFile: string, options?: HydrateSessionOptions): Promise<TspDocMessage[]> {
    let content: string;
    try {
      content = await readFile(sessionFile, "utf8");
    } catch {
      return [];
    }
    return this.hydrateFromSessionJsonl(content, options);
  }

  hydrateFromSessionJsonl(jsonlContent: string, options?: HydrateSessionOptions): TspDocMessage[] {
    const rawLines = jsonlContent.split("\n");
    const entries: Record<string, unknown>[] = [];
    let header: Record<string, unknown> | null = null;

    for (let raw of rawLines) {
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      if (raw.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || typeof parsed["type"] !== "string") continue;
        if (parsed["type"] === "session" && header === null) {
          header = parsed;
        } else {
          entries.push(parsed);
        }
      } catch {
        // Ignore malformed/partial trailing JSONL line.
      }
    }

    const sessionId = typeof header?.["id"] === "string" ? header["id"] : null;
    const cwd = typeof header?.["cwd"] === "string" ? header["cwd"] : null;
    let sessionName: string | null = null;
    const labels = new Map<string, string>();

    const hasTreeIds = entries.some((e) => typeof e["id"] === "string");
    let activeEntries: Record<string, unknown>[] = [];
    let resolvedLeafId: string | null = null;

    if (!hasTreeIds) {
      activeEntries = entries;
    } else {
      const byId = new Map<string, Record<string, unknown>>();
      let lastTreeEntryId: string | null = null;
      for (const entry of entries) {
        const id = typeof entry["id"] === "string" ? entry["id"] : null;
        if (id !== null) {
          byId.set(id, entry);
          lastTreeEntryId = id;
        }
        if (entry["type"] === "session_info" && typeof entry["name"] === "string") {
          const trimmedName = entry["name"].trim();
          sessionName = trimmedName !== "" ? trimmedName : null;
        } else if (entry["type"] === "label" && typeof entry["targetId"] === "string") {
          const lbl = typeof entry["label"] === "string" ? entry["label"].trim() : "";
          if (lbl !== "") labels.set(entry["targetId"], lbl);
          else labels.delete(entry["targetId"]);
        }
      }

      if (options?.leafId === null) {
        resolvedLeafId = null;
        activeEntries = [];
      } else {
        const candidateLeaf =
          options?.leafId !== undefined && byId.has(options.leafId) ? options.leafId : lastTreeEntryId;
        resolvedLeafId = candidateLeaf;
        if (candidateLeaf !== null) {
          const chain: Record<string, unknown>[] = [];
          const visited = new Set<string>();
          let curId: string | null = candidateLeaf;
          while (curId !== null && !visited.has(curId)) {
            visited.add(curId);
            const node = byId.get(curId);
            if (node === undefined) break;
            chain.push(node);
            curId = typeof node["parentId"] === "string" ? node["parentId"] : null;
          }
          chain.reverse();
          activeEntries = chain;
        }
      }
    }

    this.lastHydrationMeta = {
      sessionId,
      sessionName,
      cwd,
      leafId: resolvedLeafId,
      labels,
    };

    if (sessionName !== null) {
      for (const listener of this.titleListeners) {
        listener(sessionName);
      }
    }

    return this.renderHydratedBranch(activeEntries);
  }

  hydrateFromMessages(messages: readonly PiAgentMessage[]): TspDocMessage[] {
    const syntheticEntries: Record<string, unknown>[] = messages.map((message, index) => ({
      type: "message",
      id: `msg_${index + 1}`,
      parentId: index === 0 ? null : `msg_${index}`,
      message,
    }));
    return this.renderHydratedBranch(syntheticEntries);
  }

  private renderHydratedBranch(branchEntries: readonly Record<string, unknown>[]): TspDocMessage[] {
    this.resetStreamingState();

    // Index toolResult messages by toolCallId so assistant toolCalls pair cleanly.
    const toolResults = new Map<string, PiToolResultMessage>();
    for (const entry of branchEntries) {
      if (entry["type"] === "message" && isRecord(entry["message"])) {
        const msg = entry["message"] as unknown as PiAgentMessage;
        if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
          toolResults.set(msg.toolCallId, msg);
        }
      }
    }

    const blobMessages: TspDocMessage[] = [];
    const ops: TspOp[] = [];
    this.appendClearChildrenOps(ops, "main");
    this.appendClearChildrenOps(ops, "dock.hud");
    this.appendClearChildrenOps(ops, "dock.dialog");
    // `dock.widget` / `dock.queue` 是扩展与排队队列临时挂进去的：重放前清干净，没挂过就不发 op。
    if (this.widgets.size > 0) this.widgets.clear();
    for (const dockChild of ["dock.widget", "dock.queue"]) {
      if (this.nodeExists(dockChild)) ops.push(["del", dockChild]);
    }

    const consumedToolResults = new Set<string>();

    for (const entry of branchEntries) {
      const entryType = entry["type"];
      const entryId = typeof entry["id"] === "string" ? entry["id"] : undefined;

      if (entryType === "compaction") {
        const secId = this.nextId("compact");
        const summary = typeof entry["summary"] === "string" ? entry["summary"] : "";
        const tokensBefore = typeof entry["tokensBefore"] === "number" ? entry["tokensBefore"] : undefined;
        ops.push(["add", secId, "main", null, this.buildCompactionSectionNode(secId, summary, tokensBefore)]);
        continue;
      }

      if (entryType === "branch_summary") {
        const secId = this.nextId("branch");
        const summary = typeof entry["summary"] === "string" ? entry["summary"] : "";
        ops.push(["add", secId, "main", null, this.buildBranchSummarySectionNode(secId, summary)]);
        continue;
      }

      if (entryType === "custom_message") {
        if (entry["display"] === false) continue;
        const { text } = extractContentTextAndImages(
          entry["content"] as string | readonly PiContentBlock[] | undefined,
        );
        if (text.trim() !== "") {
          const cardId = this.nextId("custom");
          ops.push([
            "add",
            cardId,
            "main",
            null,
            {
              id: cardId,
              k: "card",
              p: { role: "omp.custom" },
              c: [{ id: `${cardId}/md`, k: "md", p: { text } }],
            },
          ]);
        }
        continue;
      }

      if (entryType !== "message" || !isRecord(entry["message"])) {
        continue;
      }

      const msg = entry["message"] as unknown as PiAgentMessage;

      if (msg.role === "user") {
        const { text, images } = extractContentTextAndImages(msg.content);
        const cardId = this.nextId("user");
        const card = this.buildUserCardNode({
          cardId,
          text,
          images,
          entryId,
          timestamp: msg.timestamp,
          blobMessagesOut: blobMessages,
        });
        ops.push(["add", cardId, "main", null, card]);
      } else if (msg.role === "assistant") {
        this.appendHydratedAssistantMessage(msg, toolResults, consumedToolResults, ops, blobMessages);
      } else if (msg.role === "toolResult") {
        if (consumedToolResults.has(msg.toolCallId)) continue;
        consumedToolResults.add(msg.toolCallId);
        const { text, images } = extractContentTextAndImages(msg.content);
        const nodeId = this.nextId("tool");
        const { node } = this.buildToolNode({
          nodeId,
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          args: {},
          status: msg.isError === true ? "error" : "done",
          outputText: text,
          images,
          details: msg.details,
          blobMessagesOut: blobMessages,
        });
        ops.push(["add", nodeId, "main", null, node]);
      } else if (msg.role === "bashExecution") {
        const nodeId = this.nextId("bash");
        const isError = typeof msg.exitCode === "number" && msg.exitCode !== 0;
        const { node } = this.buildToolNode({
          nodeId,
          toolCallId: nodeId,
          toolName: "bash",
          args: { command: msg.command },
          status: msg.cancelled === true ? "cancelled" : isError ? "error" : "done",
          outputText: msg.output ?? "",
          exitCode: typeof msg.exitCode === "number" ? msg.exitCode : undefined,
          blobMessagesOut: blobMessages,
        });
        ops.push(["add", nodeId, "main", null, node]);
      } else if (msg.role === "compactionSummary") {
        const secId = this.nextId("compact");
        ops.push([
          "add",
          secId,
          "main",
          null,
          this.buildCompactionSectionNode(secId, msg.summary ?? "", msg.tokensBefore),
        ]);
      } else if (msg.role === "branchSummary") {
        const secId = this.nextId("branch");
        ops.push(["add", secId, "main", null, this.buildBranchSummarySectionNode(secId, msg.summary ?? "")]);
      } else if (msg.role === "custom" && msg.display !== false) {
        const { text } = extractContentTextAndImages(msg.content);
        if (text.trim() !== "") {
          const cardId = this.nextId("custom");
          ops.push([
            "add",
            cardId,
            "main",
            null,
            {
              id: cardId,
              k: "card",
              p: { role: "omp.custom" },
              c: [{ id: `${cardId}/md`, k: "md", p: { text } }],
            },
          ]);
        }
      }
    }

    return this.emitOps(ops, blobMessages);
  }

  private appendHydratedAssistantMessage(
    msg: PiAssistantMessage,
    toolResults: ReadonlyMap<string, PiToolResultMessage>,
    consumedToolResults: Set<string>,
    ops: TspOp[],
    blobMessages: TspDocMessage[],
  ): void {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const textPieces: string[] = [];

    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block["type"] === "thinking") {
        const tb = block as unknown as PiThinkingContent;
        const rawThinking = typeof tb.thinking === "string" ? tb.thinking : "";
        if (rawThinking.trim() === "" && tb.redacted !== true) continue;
        const wrapId = this.nextId("asst_th");
        const secId = `${wrapId}/sec`;
        const { section } = this.buildThinkingSectionNode({
          sectionId: secId,
          thinkingText: rawThinking.trim() !== "" ? rawThinking : "(Redacted thinking)",
          live: false,
        });
        ops.push([
          "add",
          wrapId,
          "main",
          null,
          {
            id: wrapId,
            k: "col",
            p: { role: "omp.assistant", gap: "sm" },
            c: [section],
          },
        ]);
      } else if (block["type"] === "toolCall") {
        const tc = block as unknown as PiToolCallContent;
        const paired = toolResults.get(tc.id);
        if (paired !== undefined) consumedToolResults.add(tc.id);
        const extracted = paired !== undefined ? extractContentTextAndImages(paired.content) : { text: "", images: [] };
        const durationMs =
          typeof msg.timestamp === "number" &&
          typeof paired?.timestamp === "number" &&
          paired.timestamp >= msg.timestamp
            ? paired.timestamp - msg.timestamp
            : undefined;
        const nodeId = this.nextId("tool");
        const { node } = this.buildToolNode({
          nodeId,
          toolCallId: tc.id,
          toolName: tc.name,
          args: isRecord(tc.arguments) ? tc.arguments : {},
          status: paired?.isError === true ? "error" : "done",
          outputText: extracted.text,
          images: extracted.images,
          details: paired?.details,
          durationMs,
          blobMessagesOut: blobMessages,
        });
        ops.push(["add", nodeId, "main", null, node]);
      } else if (block["type"] === "text") {
        const tx = block as unknown as PiTextContent;
        if (typeof tx.text === "string" && tx.text.trim() !== "") {
          // 思维/旁白漏在正文通道里时，回到过程区折叠显示，不冒充答案。
          const classified = classifyAssistantText(tx.text, tx.textSignature);
          if (classified.kind === "process") {
            const { wrapper, wrapperId } = this.buildProcessSectionNode(classified.reasoning);
            ops.push(["add", wrapperId, "main", null, wrapper]);
            if (classified.answer !== "") textPieces.push(classified.answer);
          } else {
            textPieces.push(tx.text);
          }
        }
      }
    }

    const answerText = textPieces.join("\n\n");
    const isErrorStop = msg.stopReason === "error" && typeof msg.errorMessage === "string" && msg.errorMessage !== "";
    const usageSummary = !isErrorStop
      ? formatUsageFooter(msg.usage, msg.model, msg.timestamp, this.elapsedTurnMs())
      : null;

    if (answerText !== "" || isErrorStop || (usageSummary !== null && blocks.every((b) => b.type !== "toolCall"))) {
      const colId = this.nextId("asst");
      const children: TspNode[] = [];
      if (answerText !== "") {
        children.push({
          id: `${colId}/md`,
          k: "md",
          p: { text: answerText },
        });
      }
      if (isErrorStop && msg.errorMessage !== undefined) {
        children.push(this.buildErrorCardNode(`${colId}/err`, msg.errorMessage));
      } else if (usageSummary !== null && answerText !== "") {
        children.push(this.buildUsageRowNode(`${colId}/usage`, usageSummary));
      }
      if (children.length > 0) {
        ops.push([
          "add",
          colId,
          "main",
          null,
          {
            id: colId,
            k: "col",
            p: { role: "omp.assistant", gap: "sm" },
            c: children,
          },
        ]);
      }
    }
  }

  // ───────── Live Streaming RPC Event Handler ─────────

  /** 给界面发一条通知（不写进消息流）。 */
  private notify(message: string, level: "info" | "warning" | "error"): void {
    for (const listener of this.notifyListeners) {
      listener({ message, level });
    }
  }

  /** 当前轮已经跑了多久（毫秒）；没在跑时返回 undefined，脚注就不带耗时。 */
  private elapsedTurnMs(): number | undefined {
    if (this.turnStartedAtMs === null) return undefined;
    const elapsed = Date.now() - this.turnStartedAtMs;
    return elapsed > 0 ? elapsed : undefined;
  }

  /** `queue_update`：真有排队内容时挂上 `dock.queue`，两边都空就摧掉（空队列时文档结构不变）。 */
  private applyQueueUpdate(steering: readonly string[], followUp: readonly string[]): TspDocMessage[] {
    const nodeId = "dock.queue";
    const lines = [...steering.map((text) => `[Steering] ${text}`), ...followUp.map((text) => `[Queued] ${text}`)];
    const ops: TspOp[] = [];
    if (lines.length === 0) {
      if (this.nodeExists(nodeId)) ops.push(["del", nodeId]);
      return this.emitOps(ops);
    }
    const node: TspNode = {
      id: nodeId,
      k: "col",
      p: { role: "omp.queue", gap: "xs" },
      c: lines.map((line, index) => ({
        id: `${nodeId}/${index}`,
        k: "text",
        p: { role: "omp.queue.item", spans: [{ t: line, s: "muted" }] },
      })),
    };
    if (this.nodeExists(nodeId)) this.appendReplaceNodeOps(ops, nodeId, node, "dock");
    else ops.push(["add", nodeId, "dock", null, node]);
    return this.emitOps(ops);
  }

  /** 把 `setWidget` 收到的文本行渲染到 `dock.widget`；一个 widget 都没时节点不存在，文档树不变。 */
  private renderWidgets(): TspDocMessage[] {
    const nodeId = "dock.widget";
    const children: TspNode[] = [];
    for (const [, widget] of this.widgets) {
      for (const line of widget.lines) {
        children.push({
          id: `${nodeId}/${children.length}`,
          k: "text",
          p: { role: "omp.widget.line", spans: [{ t: line, s: "muted" }] },
        });
      }
    }
    if (children.length === 0) {
      this.widgets.clear();
      return this.nodeExists(nodeId) ? this.emitOps([["del", nodeId]]) : [];
    }
    const node: TspNode = { id: nodeId, k: "col", p: { role: "omp.widget", gap: "xs" }, c: children };
    const ops: TspOp[] = [];
    if (this.nodeExists(nodeId)) this.appendReplaceNodeOps(ops, nodeId, node, "dock");
    else ops.push(["add", nodeId, "dock", null, node]);
    return this.emitOps(ops);
  }

  handleRpcEvent(event: PiRpcEvent): TspDocMessage[] {
    switch (event.type) {
      case "agent_start":
        return this.ensureWorkingHud("Working…");

      case "turn_start":
        this.liveThinking.clear();
        this.liveText.clear();
        this.liveProcessIndexes.clear();
        this.liveProcessContainers.clear();
        this.lastStreamAssistantId = null;
        this.turnStartedAtMs = Date.now();
        return this.ensureWorkingHud("Working…");

      case "message_start":
        return this.handleMessageStart(event.message);

      case "message_update":
        return this.handleMessageUpdate(event.assistantMessageEvent);

      case "tool_execution_start":
        return this.handleToolExecutionStart(event.toolCallId, event.toolName, event.args);

      case "tool_execution_update":
        return this.handleToolExecutionUpdate(event.toolCallId, event.toolName, event.args, event.partialResult);

      case "tool_execution_end":
        return this.handleToolExecutionEnd(
          event.toolCallId,
          event.toolName,
          event.result,
          event.isError,
          event.durationMs,
        );

      case "message_end":
        return this.handleMessageEnd(event.message);

      case "compaction_start":
        return this.ensureWorkingHud(compactionHudLabel(event.reason));

      case "compaction_end": {
        const ops: TspOp[] = [];
        const errorText = typeof event.errorMessage === "string" ? event.errorMessage.trim() : "";
        const result = event.result;
        if (event.aborted) {
          // 用户/中断取消：消息流不插节点，只提醒一句。
          this.notify("Compaction cancelled", "info");
        } else if (errorText !== "") {
          const colId = this.nextId("compact_err");
          ops.push([
            "add",
            colId,
            "main",
            null,
            {
              id: colId,
              k: "col",
              p: { role: "omp.assistant", gap: "sm" },
              c: [this.buildErrorCardNode(`${colId}/err`, errorText)],
            },
          ]);
        } else if (result !== undefined && result !== null) {
          const secId = this.nextId("compact");
          ops.push([
            "add",
            secId,
            "main",
            null,
            this.buildCompactionSectionNode(secId, result.summary, result.tokensBefore, result.estimatedTokensAfter),
          ]);
        } else {
          this.notify("Compaction finished without a summary", "warning");
        }
        if (!event.willRetry) {
          this.appendClearHudOps(ops);
        }
        return this.emitOps(ops);
      }

      case "queue_update": {
        const steering = Array.isArray(event.steering)
          ? event.steering.filter((item): item is string => typeof item === "string")
          : [];
        const followUp = Array.isArray(event.followUp)
          ? event.followUp.filter((item): item is string => typeof item === "string")
          : [];
        return this.applyQueueUpdate(steering, followUp);
      }

      case "extension_error": {
        const file = typeof event.extensionPath === "string" ? event.extensionPath.trim() : "";
        const errText = typeof event.error === "string" && event.error.trim() !== "" ? event.error : "unknown error";
        const name = file === "" ? "unknown extension" : basename(file);
        // 扩展报错不进消息流，只温和提醒，不打断对话。
        this.notify(`Extension error (${name}): ${errText}`, "error");
        return [];
      }

      case "auto_retry_start":
        return this.ensureWorkingHud(`Retrying (${event.attempt}/${event.maxAttempts})…`);

      case "auto_retry_end":
        if (!event.success && typeof event.finalError === "string" && event.finalError !== "") {
          const colId = this.nextId("asst_err");
          const ops: TspOp[] = [
            [
              "add",
              colId,
              "main",
              null,
              {
                id: colId,
                k: "col",
                p: { role: "omp.assistant", gap: "sm" },
                c: [this.buildErrorCardNode(`${colId}/err`, event.finalError)],
              },
            ],
          ];
          this.appendClearHudOps(ops);
          return this.emitOps(ops);
        }
        return [];

      case "extension_ui_request":
        return this.handleExtensionUiRequest(event);

      case "session_info_changed":
        if (typeof event.name === "string" && event.name.trim() !== "") {
          for (const listener of this.titleListeners) {
            listener(event.name.trim());
          }
        }
        return [];

      case "agent_end":
        if (event.willRetry === true) {
          return [];
        }
        this.turnStartedAtMs = null;
        return this.clearWorkingHud();

      case "agent_settled": {
        this.liveThinking.clear();
        this.liveText.clear();
        this.liveProcessIndexes.clear();
        this.liveProcessContainers.clear();
        this.lastStreamAssistantId = null;
        this.turnStartedAtMs = null;
        return this.clearWorkingHud();
      }

      default:
        return [];
    }
  }

  private ensureWorkingHud(label: string): TspDocMessage[] {
    const ops: TspOp[] = [];
    this.appendWorkingHudOps(ops, label);
    return this.emitOps(ops);
  }

  private appendWorkingHudOps(ops: TspOp[], label: string): void {
    const activityId = "dock.hud.activity";
    const labelId = "dock.hud.working.label";
    if (!this.hudActive || !this.nodeExists(activityId)) {
      this.hudActive = true;
      this.appendClearChildrenOps(ops, "dock.hud");
      ops.push([
        "add",
        activityId,
        "dock.hud",
        null,
        {
          id: activityId,
          k: "col",
          p: { role: "omp.hud.activity", gap: "xs" },
          c: [
            {
              id: "dock.hud.working",
              k: "row",
              p: { role: "omp.working", gap: "xs", align: "center" },
              c: [
                { id: "dock.hud.working.spin", k: "spinner", p: { tone: "accent" } },
                {
                  id: labelId,
                  k: "shimmer",
                  p: { role: "omp.working.label", spans: [{ t: label, s: "muted" }] },
                },
                { id: "dock.hud.working.elapsed", k: "elapsed", p: { age: 0 } },
                {
                  id: "dock.hud.working.stop",
                  k: "row",
                  p: { role: "omp.working.stop", actions: { click: "interrupt" } },
                  c: [{ id: "dock.hud.working.stop.t", k: "text", p: { text: "Stop" } }],
                },
              ],
            },
          ],
        },
      ]);
    } else if (this.nodeExists(labelId)) {
      ops.push(["set", labelId, { spans: [{ t: label, s: "muted" }] }]);
    }
  }

  private clearWorkingHud(): TspDocMessage[] {
    const ops: TspOp[] = [];
    this.appendClearHudOps(ops);
    return this.emitOps(ops);
  }

  private appendClearHudOps(ops: TspOp[]): void {
    if (this.hudActive || (this.doc.surfaces.get(PI_SURFACE_ID)?.nodes.get("dock.hud")?.c.length ?? 0) > 0) {
      this.hudActive = false;
      this.appendClearChildrenOps(ops, "dock.hud");
    }
  }

  private handleMessageStart(message: PiAgentMessage): TspDocMessage[] {
    if (message.role === "user") {
      const { text, images } = extractContentTextAndImages(message.content);
      const trimmed = text.trim();
      const optIdx = this.pendingOptimisticUsers.indexOf(trimmed);
      if (optIdx !== -1) {
        this.pendingOptimisticUsers.splice(optIdx, 1);
        return [];
      }
      // Also deduplicate if the very last node in `main` is already an `omp.user` card with identical text.
      const surface = this.doc.surfaces.get(PI_SURFACE_ID);
      const mainNode = surface?.nodes.get("main");
      const lastMainChildId = mainNode?.c[mainNode.c.length - 1];
      if (lastMainChildId !== undefined && surface !== undefined) {
        const lastNode = surface.nodes.get(lastMainChildId);
        if (lastNode?.k === "card" && lastNode.p["role"] === "omp.user") {
          for (const cid of lastNode.c) {
            const cnode = surface.nodes.get(cid);
            if (cnode?.k === "md" && typeof cnode.p["text"] === "string" && cnode.p["text"].trim() === trimmed) {
              return [];
            }
          }
        }
      }

      const blobMessages: TspDocMessage[] = [];
      const cardId = this.nextId("user");
      const card = this.buildUserCardNode({
        cardId,
        text,
        images,
        timestamp: message.timestamp ?? Date.now(),
        blobMessagesOut: blobMessages,
      });
      return this.emitOps([["add", cardId, "main", null, card]], blobMessages);
    }

    if (message.role === "assistant") {
      this.liveThinking.clear();
      this.liveText.clear();
      this.liveProcessIndexes.clear();
      this.liveProcessContainers.clear();
      this.liveToolIndexes.clear();
      this.lastStreamAssistantId = null;
    }
    return [];
  }

  private handleMessageUpdate(sub: PiAssistantMessageEvent): TspDocMessage[] {
    const ops: TspOp[] = [];

    switch (sub.type) {
      case "thinking_start": {
        const wrapId = this.nextId("asst_th");
        const secId = `${wrapId}/sec`;
        const { section, headId, bodyId } = this.buildThinkingSectionNode({
          sectionId: secId,
          thinkingText: "",
          live: true,
        });
        this.liveThinking.set(sub.contentIndex, {
          wrapperId: wrapId,
          sectionId: secId,
          headId,
          bodyId,
          startedAtMs: Date.now(),
          hasToolsAfter: false,
        });
        this.appendWorkingHudOps(ops, "Thinking…");
        ops.push([
          "add",
          wrapId,
          "main",
          null,
          {
            id: wrapId,
            k: "col",
            p: { role: "omp.assistant", gap: "sm" },
            c: [section],
          },
        ]);
        return this.emitOps(ops);
      }

      case "thinking_delta": {
        let state = this.liveThinking.get(sub.contentIndex);
        if (state === undefined) {
          this.handleMessageUpdate({ type: "thinking_start", contentIndex: sub.contentIndex });
          state = this.liveThinking.get(sub.contentIndex);
        }
        if (state !== undefined && sub.delta !== "") {
          ops.push(["text", state.bodyId, "append", sub.delta]);
        }
        return this.emitOps(ops);
      }

      case "thinking_end": {
        const state = this.liveThinking.get(sub.contentIndex);
        if (state !== undefined) {
          const durationSec = Math.max(0.1, (Date.now() - state.startedAtMs) / 1000);
          this.appendReplaceNodeOps(
            ops,
            state.headId,
            { id: state.headId, k: "text", p: { text: `Thought for ${durationSec.toFixed(1)}s` } },
            state.sectionId,
          );
          ops.push(
            ["set", state.sectionId, { role: "omp.thinking", collapsed: true, took: Math.round(durationSec * 1000) }],
            [
              "set",
              state.bodyId,
              {
                stream: null,
                ...(typeof sub.content === "string" && sub.content !== "" ? { text: sub.content } : {}),
              },
            ],
          );
          this.liveThinking.delete(sub.contentIndex);
        }
        return this.emitOps(ops);
      }

      case "toolcall_start": {
        const meta = toolCallMeta(sub.partial, sub.contentIndex);
        const tcId = sub.id ?? meta?.id ?? `tc_${sub.contentIndex}`;
        const tcName = sub.toolName ?? meta?.toolName ?? "tool";
        this.liveToolIndexes.set(sub.contentIndex, tcId);
        for (const th of this.liveThinking.values()) {
          th.hasToolsAfter = true;
        }
        if (!this.liveTools.has(tcId)) {
          const initialArgs = coerceToolArgs(meta?.arguments);
          const nodeId = this.nextId("tool");
          const target = this.toolTargetProps(tcName, initialArgs);
          const { node, outputId } = this.buildToolNode({
            nodeId,
            toolCallId: tcId,
            toolName: tcName,
            args: initialArgs,
            status: "pending",
            outputText: "",
            blobMessagesOut: [],
          });
          this.liveTools.set(tcId, {
            nodeId,
            toolCallId: tcId,
            toolName: tcName,
            args: initialArgs,
            argsJson: typeof meta?.arguments === "string" ? meta.arguments : "",
            target: target?.target,
            startedAtMs: Date.now(),
            outputId,
            streamedOutput: "",
          });
          this.appendWorkingHudOps(
            ops,
            target !== null ? workingLabelForTool(tcName, initialArgs) : `Preparing ${tcName}…`,
          );
          ops.push(["add", nodeId, "main", null, node]);
        }
        return this.emitOps(ops);
      }

      case "toolcall_delta": {
        const meta = toolCallMeta(sub.partial, sub.contentIndex);
        const tcId = this.liveToolIndexes.get(sub.contentIndex) ?? meta?.id ?? `tc_${sub.contentIndex}`;
        let state = this.liveTools.get(tcId);
        if (state === undefined) {
          // delta 可能先于 start 到达（或 start 缺失）：先补一次懒创建，不然这次调用的卡片会丢。
          this.handleMessageUpdate({
            type: "toolcall_start",
            contentIndex: sub.contentIndex,
            id: tcId,
            toolName: meta?.toolName ?? "tool",
          });
          state = this.liveTools.get(tcId);
        }
        if (state === undefined) return [];
        if (sub.delta !== "") state.argsJson += sub.delta;
        // RPC 线上事件不带 partial（pi 的 toJsonEvent 把快照剥掉了），参数只能靠累计的 JSON 文本拼；
        // 同进程 partial 里已有对象时以它为准（更完整）。
        const args: Record<string, unknown> = {
          ...toolArgsFromJsonText(state.argsJson),
          ...coerceToolArgs(meta?.arguments),
        };
        if (Object.keys(args).length === 0) return [];
        state.args = args;
        const target = this.toolTargetProps(state.toolName, args);
        // 目标没变化就不发 op：列表不重建，用户展开状态也不会丢。
        if (target === null || target.target === state.target) return [];
        state.target = target.target;
        if (this.nodeExists(state.nodeId)) {
          ops.push(["set", state.nodeId, { target: target.target, targetKind: target.targetKind }]);
        }
        this.appendWorkingHudOps(ops, workingLabelForTool(state.toolName, args));
        return this.emitOps(ops);
      }

      case "toolcall_end": {
        const tc = sub.toolCall;
        const existing = this.liveTools.get(tc.id);
        const args = coerceToolArgs(tc.arguments);
        if (existing !== undefined) {
          existing.toolName = tc.name;
          existing.args = args;
          existing.target = this.toolTargetProps(tc.name, args)?.target;
          const blobMsgs: TspDocMessage[] = [];
          const { node, outputId } = this.buildToolNode({
            nodeId: existing.nodeId,
            toolCallId: tc.id,
            toolName: tc.name,
            args,
            status: "pending",
            outputText: existing.streamedOutput,
            startedAtMs: existing.startedAtMs,
            blobMessagesOut: blobMsgs,
          });
          existing.outputId = outputId;
          this.appendReplaceNodeOps(ops, existing.nodeId, node);
          return this.emitOps(ops, blobMsgs);
        }
        return [];
      }

      case "text_start": {
        const colId = this.nextId("asst");
        const mdId = `${colId}/md`;
        this.liveText.set(sub.contentIndex, { containerId: colId, mdId });
        this.lastStreamAssistantId = colId;
        this.appendWorkingHudOps(ops, "Writing response…");
        ops.push([
          "add",
          colId,
          "main",
          null,
          {
            id: colId,
            k: "col",
            p: { role: "omp.assistant", gap: "sm" },
            c: [
              {
                id: mdId,
                k: "md",
                p: { text: "", stream: true },
              },
            ],
          },
        ]);
        return this.emitOps(ops);
      }

      case "text_delta": {
        let state = this.liveText.get(sub.contentIndex);
        if (state === undefined) {
          this.handleMessageUpdate({ type: "text_start", contentIndex: sub.contentIndex });
          state = this.liveText.get(sub.contentIndex);
        }
        if (state !== undefined && sub.delta !== "") {
          ops.push(["text", state.mdId, "append", sub.delta]);
        }
        return this.emitOps(ops);
      }

      case "text_end": {
        const state = this.liveText.get(sub.contentIndex);
        if (state !== undefined) {
          const block = partialContentBlock(sub.partial, sub.contentIndex);
          const finalText =
            typeof sub.content === "string" && sub.content !== ""
              ? sub.content
              : typeof block?.text === "string"
                ? block.text
                : "";
          // 正文通道里冒出来的思维/旁白（DeepSeek 类通道常见）：整块换成折叠的过程段。
          const classified = classifyAssistantText(finalText, block?.textSignature);
          if (classified.kind === "process") {
            const { wrapper, wrapperId } = this.buildProcessSectionNode(classified.reasoning);
            if (classified.answer !== "") {
              (wrapper.c as TspNode[]).push({ id: `${wrapperId}/md`, k: "md", p: { text: classified.answer } });
            }
            ops.push(["add", wrapperId, "main", state.containerId, wrapper], ["del", state.containerId]);
            this.lastStreamAssistantId = wrapperId;
            this.liveProcessIndexes.add(sub.contentIndex);
            this.liveProcessContainers.add(wrapperId);
          } else {
            ops.push([
              "set",
              state.mdId,
              {
                stream: null,
                ...(finalText !== "" ? { text: finalText } : {}),
              },
            ]);
          }
          this.liveText.delete(sub.contentIndex);
        }
        return this.emitOps(ops);
      }

      default:
        return [];
    }
  }

  private handleToolExecutionStart(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): TspDocMessage[] {
    const ops: TspOp[] = [];
    const blobMsgs: TspDocMessage[] = [];
    this.appendWorkingHudOps(ops, workingLabelForTool(toolName, args));

    const existing = this.liveTools.get(toolCallId);
    if (existing !== undefined) {
      existing.toolName = toolName;
      existing.args = args;
      // 保留 `toolcall_start` 的时间：参数流式生成的那几十秒也要算进耗时。
      existing.startedAtMs ??= Date.now();
      const { node, outputId } = this.buildToolNode({
        nodeId: existing.nodeId,
        toolCallId,
        toolName,
        args,
        status: "running",
        outputText: existing.streamedOutput,
        startedAtMs: existing.startedAtMs,
        blobMessagesOut: blobMsgs,
      });
      existing.outputId = outputId;
      this.appendReplaceNodeOps(ops, existing.nodeId, node);
    } else {
      const nodeId = this.nextId("tool");
      const { node, outputId } = this.buildToolNode({
        nodeId,
        toolCallId,
        toolName,
        args,
        status: "running",
        outputText: "",
        blobMessagesOut: blobMsgs,
      });
      this.liveTools.set(toolCallId, {
        nodeId,
        toolCallId,
        toolName,
        args,
        argsJson: "",
        target: this.toolTargetProps(toolName, args)?.target,
        startedAtMs: Date.now(),
        outputId,
        streamedOutput: "",
      });
      ops.push(["add", nodeId, "main", null, node]);
    }

    return this.emitOps(ops, blobMsgs);
  }

  private handleToolExecutionUpdate(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    partialResult: {
      content?: (PiTextContent | PiImageContent)[] | undefined;
      details?: Record<string, unknown> | undefined;
    },
  ): TspDocMessage[] {
    let existing = this.liveTools.get(toolCallId);
    if (existing === undefined) {
      this.handleToolExecutionStart(toolCallId, toolName, args);
      existing = this.liveTools.get(toolCallId);
    }
    if (existing === undefined) return [];

    const { text } = extractContentTextAndImages(partialResult.content);
    existing.streamedOutput = text;

    if (toolName === "subagent") {
      // 子代理面板要边跑边看：details 里带着各子代理的实时状态，只 set 那些 `agent` 节点，不重建整张卡。
      const outputId = existing.outputId !== null && this.nodeExists(existing.outputId) ? existing.outputId : null;
      const ops: TspOp[] = [];
      if (outputId === null) {
        if (text.trim() !== "") {
          // 开始时没文本就没有 /out 节点：补一个，之后走 set（不重建卡片，agent 行不会丢）。
          const outId = `${existing.nodeId}/out`;
          existing.outputId = outId;
          ops.push([
            "add",
            outId,
            existing.nodeId,
            null,
            { id: outId, k: "ansi", p: { role: "omp.tool.subagent.output", text, preview: { lines: 6 } } },
          ]);
        }
      } else {
        ops.push(["set", outputId, { text }]);
      }
      if (this.nodeExists(existing.nodeId)) {
        const run = resolveSubagentRun(args, partialResult.details, "running");
        this.appendSubagentUpdateOps(ops, { nodeId: existing.nodeId, run, startedAtMs: existing.startedAtMs });
      }
      return this.emitOps(ops);
    }

    if (existing.outputId !== null && this.nodeExists(existing.outputId)) {
      return this.emitOps([["set", existing.outputId, { text }]]);
    }
    return [];
  }

  private handleToolExecutionEnd(
    toolCallId: string,
    toolName: string,
    result: { content?: (PiTextContent | PiImageContent)[] | undefined; details?: Record<string, unknown> | undefined },
    isError: boolean,
    durationMs?: number,
  ): TspDocMessage[] {
    const existing = this.liveTools.get(toolCallId);
    const { text, images } = extractContentTextAndImages(result.content);
    const blobMsgs: TspDocMessage[] = [];
    const ops: TspOp[] = [];

    const tookMs =
      durationMs ??
      (existing !== undefined ? Math.max(0, Date.now() - (existing.startedAtMs ?? Date.now())) : undefined);
    const nodeId = existing?.nodeId ?? this.nextId("tool");
    const args = existing?.args ?? {};

    const { node } = this.buildToolNode({
      nodeId,
      toolCallId,
      toolName,
      args,
      status: isError ? "error" : "done",
      outputText: text,
      images,
      details: result.details,
      durationMs: tookMs,
      startedAtMs: existing?.startedAtMs,
      blobMessagesOut: blobMsgs,
    });

    if (existing !== undefined && this.nodeExists(nodeId)) {
      this.appendReplaceNodeOps(ops, nodeId, node);
    } else {
      ops.push(["add", nodeId, "main", null, node]);
    }
    this.liveTools.delete(toolCallId);
    this.appendWorkingHudOps(ops, "Working…");

    return this.emitOps(ops, blobMsgs);
  }

  private handleMessageEnd(message: PiAgentMessage): TspDocMessage[] {
    if (message.role !== "assistant") return [];

    const ops: TspOp[] = [];
    // Finalize any unclosed live thinking or text blocks.
    for (const [, th] of this.liveThinking) {
      this.appendReplaceNodeOps(ops, th.headId, { id: th.headId, k: "text", p: { text: "Thought" } }, th.sectionId);
      ops.push(["set", th.sectionId, { role: "omp.thinking", collapsed: true }], ["set", th.bodyId, { stream: null }]);
    }
    this.liveThinking.clear();

    for (const [, tx] of this.liveText) {
      ops.push(["set", tx.mdId, { stream: null }]);
    }
    this.liveText.clear();

    const isErrorStop =
      message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.trim() !== "";

    if (isErrorStop && message.errorMessage !== undefined) {
      const targetContainer = this.lastStreamAssistantId;
      if (targetContainer !== null && this.nodeExists(targetContainer)) {
        const errId = `${targetContainer}/err`;
        ops.push(["add", errId, targetContainer, null, this.buildErrorCardNode(errId, message.errorMessage)]);
      } else {
        const colId = this.nextId("asst_err");
        ops.push([
          "add",
          colId,
          "main",
          null,
          {
            id: colId,
            k: "col",
            p: { role: "omp.assistant", gap: "sm" },
            c: [this.buildErrorCardNode(`${colId}/err`, message.errorMessage)],
          },
        ]);
      }
      this.lastStreamAssistantId = null;
      return this.emitOps(ops);
    }

    const hasToolCalls =
      message.stopReason === "toolUse" ||
      (Array.isArray(message.content) && message.content.some((b) => isRecord(b) && b["type"] === "toolCall"));
    const bodyPieces: string[] = [];
    const processPieces: string[] = [];
    if (Array.isArray(message.content)) {
      message.content.forEach((b, index) => {
        if (!isRecord(b) || b["type"] !== "text" || typeof b["text"] !== "string") return;
        if (b["text"].trim() === "") return;
        // 流式阶段（text_end）已经折过的块：不再重复生成一份。
        if (this.liveProcessIndexes.has(index)) return;
        const classified = classifyAssistantText(
          b["text"],
          typeof b["textSignature"] === "string" ? b["textSignature"] : undefined,
        );
        if (classified.kind === "process") {
          processPieces.push(classified.reasoning);
          if (classified.answer !== "") bodyPieces.push(classified.answer);
        } else {
          bodyPieces.push(b["text"]);
        }
      });
    }
    const textBlocks = bodyPieces;
    for (const processText of processPieces) {
      const { wrapper, wrapperId } = this.buildProcessSectionNode(processText);
      ops.push(["add", wrapperId, "main", null, wrapper]);
    }

    // If an assistant message arrived without prior `text_start` deltas (e.g. direct one-shot message_end), ensure text is present.
    let containerId = this.lastStreamAssistantId;
    if (containerId !== null && textBlocks.length === 0) {
      if (this.nodeExists(containerId) && !this.liveProcessContainers.has(containerId)) {
        ops.push(["del", containerId]);
        containerId = null;
      }
    } else if (containerId === null && textBlocks.length > 0) {
      containerId = this.nextId("asst");
      ops.push([
        "add",
        containerId,
        "main",
        null,
        {
          id: containerId,
          k: "col",
          p: { role: "omp.assistant", gap: "sm" },
          c: [{ id: `${containerId}/md`, k: "md", p: { text: textBlocks.join("\n\n") } }],
        },
      ]);
    }

    const usageSummary = !hasToolCalls
      ? formatUsageFooter(message.usage, message.model, message.timestamp ?? Date.now(), this.elapsedTurnMs())
      : null;
    if (usageSummary !== null && containerId !== null) {
      const usageRowId = `${containerId}/usage`;
      ops.push(["add", usageRowId, containerId, null, this.buildUsageRowNode(usageRowId, usageSummary)]);
    }

    this.liveProcessIndexes.clear();
    this.liveProcessContainers.clear();
    this.lastStreamAssistantId = null;
    return this.emitOps(ops);
  }

  // ───────── Extension UI Requests (`dock.dialog`) & TSP Event Resolution ─────────

  private handleExtensionUiRequest(req: PiExtensionUiRequestEvent): TspDocMessage[] {
    switch (req.method) {
      case "select":
        return this.openSelectDialog(req);
      case "confirm":
        return this.openConfirmDialog(req);
      case "input":
        return this.openInputDialog(req, "input");
      case "editor":
        return this.openInputDialog(req, "editor");
      case "notify": {
        const level = req.notifyType ?? "info";
        if (typeof req.message === "string" && req.message !== "") {
          this.notify(req.message, level);
        }
        return [];
      }
      case "setWidget": {
        const key = typeof req.widgetKey === "string" && req.widgetKey !== "" ? req.widgetKey : "widget";
        const lines = Array.isArray(req.widgetLines)
          ? req.widgetLines.filter((line): line is string => typeof line === "string")
          : [];
        if (lines.length === 0) this.widgets.delete(key);
        else this.widgets.set(key, { lines, placement: req.widgetPlacement });
        return this.renderWidgets();
      }
      case "setStatus": {
        if (typeof req.statusText === "string" && req.statusText.trim() !== "" && this.hudActive) {
          return this.ensureWorkingHud(req.statusText.trim());
        }
        return [];
      }
      case "setTitle": {
        if (typeof req.title === "string" && req.title.trim() !== "") {
          for (const listener of this.titleListeners) {
            listener(req.title.trim());
          }
        }
        return [];
      }
      case "set_editor_text": {
        if (typeof req.text === "string") {
          for (const listener of this.editorPrefillListeners) {
            listener(req.text);
          }
        }
        return [];
      }
      default:
        return [];
    }
  }

  private openSelectDialog(req: PiExtensionUiRequestEvent): TspDocMessage[] {
    const options = Array.isArray(req.options) ? req.options.map(String) : [];
    const cardId = `dlg_${req.id}`;
    const listId = `${cardId}/list`;
    const optionIds = options.map((_, i) => `${cardId}/opt.${i}`);
    const firstOptId = optionIds[0] ?? null;

    this.activeDialog = {
      requestId: req.id,
      method: "select",
      cardId,
      options,
      selectedIndex: 0,
      listId,
      optionIds,
      inputId: null,
      draftText: "",
      cursor: 0,
    };

    const askChildren: TspNode[] = [
      {
        id: `${cardId}/title`,
        k: "text",
        p: {
          role: "omp.ask.question",
          spans: [{ t: req.title ?? "Select an option", s: "strong" }],
        },
      },
    ];
    if (typeof req.message === "string" && req.message !== "") {
      askChildren.push({
        id: `${cardId}/msg`,
        k: "text",
        p: { spans: [{ t: req.message, s: "muted" }] },
      });
    }
    askChildren.push(
      {
        id: listId,
        k: "list",
        p: {
          role: "omp.ask.options",
          ...(firstOptId !== null ? { selected: firstOptId } : {}),
          max: { lines: 10 },
        },
        c: options.map((opt, idx) => ({
          id: optionIds[idx]!,
          k: "item",
          p: {
            role: "omp.ask.option",
            label: opt,
          },
        })),
      },
      {
        id: `${cardId}/btns`,
        k: "row",
        p: { gap: "sm", justify: "end" },
        c: [
          {
            id: `${cardId}/cancel`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "cancel" } },
            c: [
              { id: `${cardId}/cancel.t`, k: "text", p: { text: "Cancel" } },
              { id: `${cardId}/cancel.k`, k: "kbd", p: { keys: ["Esc"] } },
            ],
          },
          {
            id: `${cardId}/submit`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "submit" } },
            c: [
              { id: `${cardId}/submit.t`, k: "text", p: { text: "Select" } },
              { id: `${cardId}/submit.k`, k: "kbd", p: { keys: ["Enter"] } },
            ],
          },
        ],
      },
    );

    const card: TspNode = {
      id: cardId,
      k: "card",
      p: {
        role: "omp.editor.ask",
      },
      c: [
        {
          id: `${cardId}/ask`,
          k: "col",
          p: { role: "omp.ask", gap: "sm" },
          c: askChildren,
        },
      ],
    };

    const ops: TspOp[] = [];
    this.appendClearChildrenOps(ops, "dock.dialog");
    ops.push(["add", cardId, "dock.dialog", null, card], ["focus", listId]);
    return this.emitOps(ops);
  }

  private openConfirmDialog(req: PiExtensionUiRequestEvent): TspDocMessage[] {
    const cardId = `dlg_${req.id}`;
    const listId = `${cardId}/list`;
    const approveId = `${cardId}/approve`;
    const denyId = `${cardId}/deny`;

    this.activeDialog = {
      requestId: req.id,
      method: "confirm",
      cardId,
      options: ["Approve", "Deny"],
      selectedIndex: 0,
      listId,
      optionIds: [approveId, denyId],
      inputId: null,
      draftText: "",
      cursor: 0,
    };

    const children: TspNode[] = [
      {
        id: `${cardId}/title`,
        k: "text",
        p: {
          role: "omp.approval.title",
          spans: [{ t: req.title ?? "Confirm action", s: "strong" }],
        },
      },
    ];
    if (typeof req.message === "string" && req.message !== "") {
      children.push({
        id: `${cardId}/msg`,
        k: "text",
        p: { text: req.message },
      });
    }
    children.push(
      {
        id: listId,
        k: "list",
        p: { selected: approveId },
        c: [
          {
            id: approveId,
            k: "item",
            p: { label: "Confirm", detail: "Approve and continue" },
          },
          {
            id: denyId,
            k: "item",
            p: { label: "Cancel", detail: "Decline this action" },
          },
        ],
      },
      {
        id: `${cardId}/btns`,
        k: "row",
        p: { gap: "sm", justify: "end" },
        c: [
          {
            id: `${cardId}/btn.deny`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "deny" } },
            c: [{ id: `${cardId}/btn.deny.t`, k: "text", p: { text: "Deny" } }],
          },
          {
            id: `${cardId}/btn.approve`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "approve" } },
            c: [{ id: `${cardId}/btn.approve.t`, k: "text", p: { text: "Approve" } }],
          },
        ],
      },
    );

    const card: TspNode = {
      id: cardId,
      k: "card",
      p: {
        role: "omp.editor.ask.approval",
      },
      c: [
        {
          id: `${cardId}/body`,
          k: "col",
          p: { gap: "sm" },
          c: children,
        },
      ],
    };

    const ops: TspOp[] = [];
    this.appendClearChildrenOps(ops, "dock.dialog");
    ops.push(["add", cardId, "dock.dialog", null, card], ["focus", listId]);
    return this.emitOps(ops);
  }

  private openInputDialog(req: PiExtensionUiRequestEvent, method: "input" | "editor"): TspDocMessage[] {
    const cardId = `dlg_${req.id}`;
    const inputId = `${cardId}/input`;
    const initial = req.prefill ?? "";

    this.activeDialog = {
      requestId: req.id,
      method,
      cardId,
      options: [],
      selectedIndex: 0,
      listId: null,
      optionIds: [],
      inputId,
      draftText: initial,
      cursor: initial.length,
    };

    const askChildren: TspNode[] = [
      {
        id: `${cardId}/title`,
        k: "text",
        p: {
          role: "omp.ask.question",
          spans: [{ t: req.title ?? (method === "editor" ? "Edit text" : "Input required"), s: "strong" }],
        },
      },
    ];
    if (typeof req.message === "string" && req.message !== "") {
      askChildren.push({
        id: `${cardId}/msg`,
        k: "text",
        p: { spans: [{ t: req.message, s: "muted" }] },
      });
    }
    askChildren.push(
      {
        id: inputId,
        k: method === "editor" ? "editor" : "input",
        p: {
          text: initial,
          cursor: initial.length,
          placeholder: req.placeholder ?? "",
          ...(method === "editor" ? { maxLines: 12 } : {}),
        },
      },
      {
        id: `${cardId}/btns`,
        k: "row",
        p: { gap: "sm", justify: "end" },
        c: [
          {
            id: `${cardId}/cancel`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "cancel" } },
            c: [
              { id: `${cardId}/cancel.t`, k: "text", p: { text: "Cancel" } },
              { id: `${cardId}/cancel.k`, k: "kbd", p: { keys: ["Esc"] } },
            ],
          },
          {
            id: `${cardId}/submit`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "submit" } },
            c: [
              { id: `${cardId}/submit.t`, k: "text", p: { text: "Submit" } },
              {
                id: `${cardId}/submit.k`,
                k: "kbd",
                p: { keys: method === "editor" ? ["Ctrl", "Enter"] : ["Enter"] },
              },
            ],
          },
        ],
      },
    );

    const card: TspNode = {
      id: cardId,
      k: "card",
      p: {
        role: "omp.editor.ask",
      },
      c: [
        {
          id: `${cardId}/ask`,
          k: "col",
          p: { role: "omp.ask", gap: "sm" },
          c: askChildren,
        },
      ],
    };

    const ops: TspOp[] = [];
    this.appendClearChildrenOps(ops, "dock.dialog");
    ops.push(["add", cardId, "dock.dialog", null, card], ["focus", inputId]);
    return this.emitOps(ops);
  }

  private closeActiveDialog(): void {
    this.activeDialog = null;
    const ops: TspOp[] = [];
    this.appendClearChildrenOps(ops, "dock.dialog");
    ops.push(["focus", null]);
    this.emitOps(ops);
  }

  /**
   * Resolve a renderer-originated `TspEvent` against active `dock.dialog` or surface actions.
   * Returns an `extension_ui_response` payload when an extension dialog completes!
   */
  handleTspEvent(event: TspEvent): PiExtensionUiResponsePayload | null {
    const detailed = this.handleTspEventDetailed(event);
    return detailed?.kind === "extension_ui_response" ? detailed.response : null;
  }

  handleTspEventDetailed(event: TspEvent): BridgeActionResult {
    if (event.ev === "action") {
      if (event.act === "interrupt") {
        return { kind: "interrupt" };
      }
      if (event.act === "rewind") {
        const cardId = event.id.split("/")[0] ?? event.id;
        const cardNode = this.doc.surfaces.get(PI_SURFACE_ID)?.nodes.get(cardId);
        const entryId = typeof cardNode?.p["key"] === "string" ? cardNode.p["key"] : undefined;
        return { kind: "rewind", cardId, entryId };
      }
    }

    const dlg = this.activeDialog;
    if (dlg === null) {
      if (event.ev === "focus") {
        this.emitOps([["focus", event.id]]);
      }
      return null;
    }

    if (event.ev === "focus") {
      this.emitOps([["focus", event.id]]);
      return null;
    }

    if (event.ev === "edit" && dlg.inputId !== null && event.id === dlg.inputId) {
      const from = Math.max(0, Math.min(dlg.draftText.length, event.from));
      const to = Math.max(from, Math.min(dlg.draftText.length, event.to));
      dlg.draftText = `${dlg.draftText.slice(0, from)}${event.text}${dlg.draftText.slice(to)}`;
      dlg.cursor = Math.max(0, Math.min(dlg.draftText.length, event.cursor));
      this.emitOps([
        [
          "set",
          dlg.inputId,
          {
            text: dlg.draftText,
            cursor: dlg.cursor,
            anchor: null,
          },
        ],
      ]);
      return null;
    }

    if (event.ev === "select" || event.ev === "activate") {
      const idx = dlg.optionIds.indexOf(event.item);
      if (idx !== -1) {
        dlg.selectedIndex = idx;
        if (dlg.method === "select") {
          const chosen = dlg.options[idx];
          if (chosen !== undefined) {
            const reqId = dlg.requestId;
            this.closeActiveDialog();
            return { kind: "extension_ui_response", response: { id: reqId, value: chosen } };
          }
        } else if (dlg.method === "confirm") {
          const reqId = dlg.requestId;
          const confirmed = idx === 0;
          this.closeActiveDialog();
          return { kind: "extension_ui_response", response: { id: reqId, confirmed } };
        }
      }
      return null;
    }

    if (event.ev === "send") {
      const reqId = dlg.requestId;
      if (dlg.method === "input" || dlg.method === "editor" || dlg.method === "select") {
        this.closeActiveDialog();
        return { kind: "extension_ui_response", response: { id: reqId, value: event.text } };
      }
      if (dlg.method === "confirm") {
        this.closeActiveDialog();
        return { kind: "extension_ui_response", response: { id: reqId, confirmed: false } };
      }
    }

    if (event.ev === "action") {
      const reqId = dlg.requestId;
      switch (event.act) {
        case "cancel":
          this.closeActiveDialog();
          return { kind: "extension_ui_response", response: { id: reqId, cancelled: true } };

        case "approve":
        case "confirm":
          this.closeActiveDialog();
          return { kind: "extension_ui_response", response: { id: reqId, confirmed: true } };

        case "deny":
        case "reject":
          this.closeActiveDialog();
          return { kind: "extension_ui_response", response: { id: reqId, confirmed: false } };

        case "submit": {
          if (dlg.method === "confirm") {
            const confirmed = dlg.selectedIndex === 0;
            this.closeActiveDialog();
            return { kind: "extension_ui_response", response: { id: reqId, confirmed } };
          }
          if (dlg.method === "select") {
            const chosen = dlg.options[dlg.selectedIndex] ?? dlg.options[0];
            this.closeActiveDialog();
            return chosen !== undefined
              ? { kind: "extension_ui_response", response: { id: reqId, value: chosen } }
              : { kind: "extension_ui_response", response: { id: reqId, cancelled: true } };
          }
          const value = dlg.draftText;
          this.closeActiveDialog();
          return { kind: "extension_ui_response", response: { id: reqId, value } };
        }

        default:
          return null;
      }
    }

    return null;
  }

  /**
   * Handle terminal key sequences sent by `AskGateCol`, `List`, or `Editor` (`ctx.keys(data)`).
   */
  handleTspKeys(data: string): PiExtensionUiResponsePayload | null {
    const dlg = this.activeDialog;
    if (dlg === null || data === "") return null;

    // Escape cancels any active dialog.
    if (data === "\x1b") {
      const reqId = dlg.requestId;
      this.closeActiveDialog();
      return { id: reqId, cancelled: true };
    }

    // Ctrl+Enter (`\x1b[13;5u` or `\x1b\r`) submits/approves any dialog.
    if (data === "\x1b[13;5u" || data === "\x1b[13;2u") {
      const reqId = dlg.requestId;
      if (dlg.method === "confirm") {
        this.closeActiveDialog();
        return { id: reqId, confirmed: true };
      }
      if (dlg.method === "select") {
        const chosen = dlg.options[dlg.selectedIndex] ?? dlg.options[0];
        this.closeActiveDialog();
        return chosen !== undefined ? { id: reqId, value: chosen } : { id: reqId, cancelled: true };
      }
      const value = dlg.draftText;
      this.closeActiveDialog();
      return { id: reqId, value };
    }

    if (dlg.method === "select" || dlg.method === "confirm") {
      if (data === "\x1b[A" && dlg.optionIds.length > 0) {
        dlg.selectedIndex = (dlg.selectedIndex - 1 + dlg.optionIds.length) % dlg.optionIds.length;
        if (dlg.listId !== null) {
          this.emitOps([["set", dlg.listId, { selected: dlg.optionIds[dlg.selectedIndex] }]]);
        }
        return null;
      }
      if (data === "\x1b[B" && dlg.optionIds.length > 0) {
        dlg.selectedIndex = (dlg.selectedIndex + 1) % dlg.optionIds.length;
        if (dlg.listId !== null) {
          this.emitOps([["set", dlg.listId, { selected: dlg.optionIds[dlg.selectedIndex] }]]);
        }
        return null;
      }
      if (data === "\r" || data === "\n") {
        const reqId = dlg.requestId;
        if (dlg.method === "confirm") {
          const confirmed = dlg.selectedIndex === 0;
          this.closeActiveDialog();
          return { id: reqId, confirmed };
        }
        const chosen = dlg.options[dlg.selectedIndex] ?? dlg.options[0];
        this.closeActiveDialog();
        return chosen !== undefined ? { id: reqId, value: chosen } : { id: reqId, cancelled: true };
      }
      return null;
    }

    // `input` / `editor` keystroke handling
    if (dlg.inputId === null) return null;

    if ((data === "\r" || data === "\n") && dlg.method === "input") {
      const reqId = dlg.requestId;
      const value = dlg.draftText;
      this.closeActiveDialog();
      return { id: reqId, value };
    }

    // Bracketed paste: `\x1b[200~...\x1b[201~`
    let textToInsert: string | null = null;
    if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
      textToInsert = data.slice(6, -6);
    } else if (data === "\x7f" || data === "\b") {
      if (dlg.cursor > 0) {
        dlg.draftText = `${dlg.draftText.slice(0, dlg.cursor - 1)}${dlg.draftText.slice(dlg.cursor)}`;
        dlg.cursor -= 1;
        this.emitOps([["set", dlg.inputId, { text: dlg.draftText, cursor: dlg.cursor }]]);
      }
      return null;
    } else if ((data === "\r" || data === "\n") && dlg.method === "editor") {
      textToInsert = "\n";
    } else if (!data.startsWith("\x1b") && data >= " ") {
      textToInsert = data;
    }

    if (textToInsert !== null && textToInsert !== "") {
      const sanitized = dlg.method === "input" ? textToInsert.replace(/[\r\n]+/g, " ") : textToInsert;
      dlg.draftText = `${dlg.draftText.slice(0, dlg.cursor)}${sanitized}${dlg.draftText.slice(dlg.cursor)}`;
      dlg.cursor += sanitized.length;
      this.emitOps([["set", dlg.inputId, { text: dlg.draftText, cursor: dlg.cursor }]]);
    }
    return null;
  }

  private resetStreamingState(): void {
    this.hudActive = false;
    this.liveThinking.clear();
    this.liveText.clear();
    this.liveProcessIndexes.clear();
    this.liveProcessContainers.clear();
    this.liveTools.clear();
    this.liveToolIndexes.clear();
    this.subagentRecords.clear();
    this.lastStreamAssistantId = null;
    this.pendingOptimisticUsers = [];
    this.activeDialog = null;
    this.widgets.clear();
    this.turnStartedAtMs = null;
  }
}
