// 会话上下文占用与压缩后构成估算：
// Pi（及 dsh-compact 插件）在触发上下文压缩后、下一轮 LLM 真正返回 usage 之前，
// `get_session_stats` 的 `contextUsage` 会返回 `{ tokens: null, percent: null }`；
// 同时未启动 RPC 进程而从历史文件恢复会话时也需要立刻给出真实的上下文圆环与构成明细。
// 这里读取当前活跃分支，按最新压缩点（compaction 条目的 summary + firstKeptEntryId 保留段）或最新有效助手 usage 计算准确的上下文占用。
import { readFile, stat } from "node:fs/promises";
import { isRecord } from "../../shared/type-guards.ts";

export interface SessionBranchTokenBreakdown {
  /** 最新有效上下文总占用（含系统提示词与工具基线）；空会话为 0。 */
  estimatedTotalTokens: number;
  /** 是否存在精确的模型侧 usage（压缩后若尚无新回复则为 false，走投影估算）。 */
  exactUsage: boolean;
  /** 当前分支是否存在生效中的上下文压缩条目（如 dsh-compact / /compact）。 */
  hasCompaction: boolean;
  /** 最近一次压缩前的 token 数（若有）。 */
  compactionTokensBefore: number | null;
  userTokens: number;
  assistantTokens: number;
  thinkingTokens: number;
  toolCallTokens: number;
  toolOutputTokens: number;
  compactionTokens: number;
}

export function estTextTokens(text: string): number {
  return text.length > 0 ? Math.max(1, Math.ceil(text.length / 3.6)) : 0;
}

function extractUsageContextTokens(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  if (typeof usage["totalTokens"] === "number" && Number.isFinite(usage["totalTokens"]) && usage["totalTokens"] > 0) {
    return usage["totalTokens"];
  }
  const input = typeof usage["input"] === "number" ? usage["input"] : 0;
  const output = typeof usage["output"] === "number" ? usage["output"] : 0;
  const cacheRead = typeof usage["cacheRead"] === "number" ? usage["cacheRead"] : 0;
  const cacheWrite = typeof usage["cacheWrite"] === "number" ? usage["cacheWrite"] : 0;
  const sum = input + output + cacheRead + cacheWrite;
  return Number.isFinite(sum) && sum > 0 ? sum : 0;
}

function accumulateMessagePartTokens(
  msg: Record<string, unknown>,
  acc: {
    userTokens: number;
    assistantTokens: number;
    thinkingTokens: number;
    toolCallTokens: number;
    toolOutputTokens: number;
    compactionTokens: number;
  },
): void {
  const role = msg["role"];
  const content = msg["content"];
  if (role === "user") {
    if (typeof content === "string") {
      acc.userTokens += estTextTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part["type"] === "text" && typeof part["text"] === "string") acc.userTokens += estTextTokens(part["text"]);
        else if (part["type"] === "image") acc.userTokens += 850;
      }
    }
  } else if (role === "assistant" && Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part["type"] === "text" && typeof part["text"] === "string") {
        acc.assistantTokens += estTextTokens(part["text"]);
      } else if (part["type"] === "thinking" && typeof part["thinking"] === "string") {
        acc.thinkingTokens += estTextTokens(part["thinking"]);
      } else if (part["type"] === "toolCall") {
        const name = typeof part["name"] === "string" ? part["name"] : "";
        acc.toolCallTokens += 16 + estTextTokens(name) + estTextTokens(JSON.stringify(part["arguments"] ?? {}));
      }
    }
  } else if (role === "toolResult" && Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part["type"] === "text" && typeof part["text"] === "string") {
        acc.toolOutputTokens += estTextTokens(part["text"]);
      } else if (part["type"] === "image") {
        acc.toolOutputTokens += 850;
      }
    }
  } else if (role === "bashExecution") {
    if (msg["excludeFromContext"] !== true) {
      const cmd = typeof msg["command"] === "string" ? msg["command"] : "";
      const out = typeof msg["output"] === "string" ? msg["output"] : "";
      acc.toolOutputTokens += estTextTokens(cmd) + estTextTokens(out);
    }
  } else if (role === "compactionSummary" || role === "branchSummary") {
    const summary = typeof msg["summary"] === "string" ? msg["summary"] : "";
    acc.compactionTokens += estTextTokens(summary);
  } else if (role === "custom") {
    if (typeof content === "string") {
      acc.userTokens += estTextTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") {
          acc.userTokens += estTextTokens(part["text"]);
        }
      }
    }
  }
}

const branchTokenCache = new Map<
  string,
  { size: number; mtimeMs: number; baseline: number; value: SessionBranchTokenBreakdown }
>();

export async function analyzeSessionBranchTokens(
  sessionFile: string | null,
  systemBaselineTokens = 2700,
): Promise<SessionBranchTokenBreakdown | null> {
  if (sessionFile === null || sessionFile === "") return null;
  let fileStat: { size: number; mtimeMs: number };
  try {
    const st = await stat(sessionFile);
    fileStat = { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }

  const cached = branchTokenCache.get(sessionFile);
  if (
    cached !== undefined &&
    cached.size === fileStat.size &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.baseline === systemBaselineTokens
  ) {
    return cached.value;
  }

  let content: string;
  try {
    content = await readFile(sessionFile, "utf8");
  } catch {
    return null;
  }

  const byId = new Map<string, Record<string, unknown>>();
  let leafId: string | null = null;
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const type = parsed["type"];
    if (type === "session" || type === "title") continue;
    const id = parsed["id"];
    if (typeof id === "string" && id !== "") {
      byId.set(id, parsed);
      leafId = id;
    }
  }

  if (leafId === null) {
    return {
      estimatedTotalTokens: 0,
      exactUsage: false,
      hasCompaction: false,
      compactionTokensBefore: null,
      userTokens: 0,
      assistantTokens: 0,
      thinkingTokens: 0,
      toolCallTokens: 0,
      toolOutputTokens: 0,
      compactionTokens: 0,
    };
  }

  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const entry = byId.get(cursor);
    if (entry === undefined) break;
    branch.push(entry);
    cursor = typeof entry["parentId"] === "string" ? entry["parentId"] : null;
  }
  branch.reverse();

  // 定位当前分支最后一个上下文压缩点（dsh-compact 或 /compact 写入的 type: "compaction"）
  let latestCompactionIdx = -1;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    if (branch[i]!["type"] === "compaction") {
      latestCompactionIdx = i;
      break;
    }
  }

  const acc = {
    userTokens: 0,
    assistantTokens: 0,
    thinkingTokens: 0,
    toolCallTokens: 0,
    toolOutputTokens: 0,
    compactionTokens: 0,
  };

  let hasCompaction = false;
  let compactionTokensBefore: number | null = null;
  let startIdx = 0;

  if (latestCompactionIdx >= 0) {
    hasCompaction = true;
    const comp = branch[latestCompactionIdx]!;
    const summary = typeof comp["summary"] === "string" ? comp["summary"] : "";
    acc.compactionTokens += estTextTokens(summary);
    if (typeof comp["tokensBefore"] === "number" && Number.isFinite(comp["tokensBefore"])) {
      compactionTokensBefore = comp["tokensBefore"];
    }
    const firstKeptId = typeof comp["firstKeptEntryId"] === "string" ? comp["firstKeptEntryId"] : "";
    const keptIdx = firstKeptId !== "" ? branch.findIndex((e) => e["id"] === firstKeptId) : -1;
    startIdx = keptIdx >= 0 ? keptIdx : latestCompactionIdx + 1;
  }

  // 统计投影上下文中保留的消息条目
  for (let i = startIdx; i < branch.length; i += 1) {
    if (i === latestCompactionIdx) continue;
    const entry = branch[i]!;
    const type = entry["type"];
    if (type === "message" && isRecord(entry["message"])) {
      accumulateMessagePartTokens(entry["message"], acc);
    } else if (type === "branch_summary" && typeof entry["summary"] === "string") {
      acc.compactionTokens += estTextTokens(entry["summary"]);
    } else if (type === "custom_message" && typeof entry["content"] === "string") {
      acc.userTokens += estTextTokens(entry["content"]);
    }
  }

  // 查找最新一次有效助手回复的精确 usage（必须位于最近一次压缩之后才可信，压缩前的旧 usage 反映的是压缩前窗口）
  let exactTokens = 0;
  const searchFrom = latestCompactionIdx >= 0 ? latestCompactionIdx + 1 : 0;
  for (let i = branch.length - 1; i >= searchFrom; i -= 1) {
    const entry = branch[i]!;
    if (entry["type"] !== "message" || !isRecord(entry["message"])) continue;
    const msg = entry["message"];
    if (msg["role"] !== "assistant") continue;
    if (msg["stopReason"] === "aborted" || msg["stopReason"] === "error") continue;
    const tok = extractUsageContextTokens(msg["usage"]);
    if (tok > 0) {
      exactTokens = tok;
      break;
    }
  }

  const messageSum =
    acc.userTokens +
    acc.assistantTokens +
    acc.thinkingTokens +
    acc.toolCallTokens +
    acc.toolOutputTokens +
    acc.compactionTokens;

  const estimatedTotalTokens = exactTokens > 0 ? exactTokens : messageSum > 0 ? systemBaselineTokens + messageSum : 0;

  const result: SessionBranchTokenBreakdown = {
    estimatedTotalTokens,
    exactUsage: exactTokens > 0,
    hasCompaction,
    compactionTokensBefore,
    ...acc,
  };
  if (branchTokenCache.size > 24) {
    const oldest = branchTokenCache.keys().next().value;
    if (oldest !== undefined) branchTokenCache.delete(oldest);
  }
  branchTokenCache.set(sessionFile, {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    baseline: systemBaselineTokens,
    value: result,
  });
  return result;
}
