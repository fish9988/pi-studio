// Pi 会话用量热力图与单会话请求追踪（取代 OMP 的 SQLite `stats.db`）：
// 1. `readPiUsageHeatmap`：递归扫描 `<agentDir>/sessions/**/*.jsonl`，按文件 `{ mtimeMs, size, days, models }`
//    增量缓存到 `<cacheFile>`（经 `writeFileAtomic` 落盘），二次读取耗时 <20ms；汇总近 365 天（本地时区）用量。
//    即使会话目录为空或尚未创建也返回 `hasDatabase: true`，使前端 `UsageCard.tsx` 直接渲染 Bento 看板。
// 2. `readPiSessionTrace`：直接解析会话 `.jsonl` 中的 assistant 消息、`toolCall` 块与后续 `toolResult` 消息。
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  SessionTrace,
  TraceRequest,
  TraceToolCall,
  UsageDay,
  UsageHeatmap,
  UsageModelDay,
} from "../../shared/ipc.ts";
import { finiteNumber, finiteOrZero, isRecord, nonEmptyString } from "../../shared/type-guards.ts";
import { log } from "../log/log.ts";
import { writeFileAtomic } from "../tasks/atomic-write.ts";

export const PI_HEATMAP_DAYS = 365;
export const PI_TRACE_LIMIT = 500;

const CACHE_VERSION = 1;

interface CachedDayTotals {
  requests: number;
  tokens: number;
  costUsd: number;
}

interface CachedModelDayTotals {
  date: string;
  provider: string;
  model: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

export interface PiCachedSessionFile {
  mtimeMs: number;
  size: number;
  days: Record<string, CachedDayTotals>;
  models: Record<string, CachedModelDayTotals>;
}

interface PiHeatmapCacheData {
  version: number;
  tzOffsetMin: number;
  files: Record<string, PiCachedSessionFile>;
}

interface InMemoryCacheSlot {
  diskMtimeMs: number | null;
  diskSize: number | null;
  data: PiHeatmapCacheData;
}

const memoryCaches = new Map<string, InMemoryCacheSlot>();
const cacheWriteQueues = new Map<string, Promise<unknown>>();

function enqueueCacheWrite(cacheFile: string, content: string): Promise<void> {
  const key = path.resolve(cacheFile);
  const prev = cacheWriteQueues.get(key) ?? Promise.resolve();
  const next = prev.then(
    () => writeFileAtomic(cacheFile, content, `pi-studio-${process.pid}`),
    () => writeFileAtomic(cacheFile, content, `pi-studio-${process.pid}`),
  );
  const tracked = next.then(
    () => undefined,
    () => undefined,
  );
  cacheWriteQueues.set(key, tracked);
  void tracked.finally(() => {
    if (cacheWriteQueues.get(key) === tracked) cacheWriteQueues.delete(key);
  });
  return next;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 格式化毫秒时间戳为本地时区 `YYYY-MM-DD`。 */
export function formatLocalDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseEntryTimestamp(entry: Record<string, unknown>, message: Record<string, unknown>): number {
  const msgTs = message["timestamp"];
  if (typeof msgTs === "number" && Number.isFinite(msgTs)) return msgTs;
  if (typeof msgTs === "string") {
    const parsed = Date.parse(msgTs);
    if (Number.isFinite(parsed)) return parsed;
  }
  const entryTs = entry["timestamp"];
  if (typeof entryTs === "number" && Number.isFinite(entryTs)) return entryTs;
  if (typeof entryTs === "string") {
    const parsed = Date.parse(entryTs);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function extractUsageMetrics(usage: Record<string, unknown>): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
} {
  const input = finiteOrZero(usage["input"]);
  const output = finiteOrZero(usage["output"]);
  const cacheRead = finiteOrZero(usage["cacheRead"]);
  const cacheWrite = finiteOrZero(usage["cacheWrite"]);
  const rawTotal = usage["totalTokens"];
  const totalTokens =
    typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : input + output + cacheRead + cacheWrite;
  const costField = usage["cost"];
  const costUsd = isRecord(costField) ? finiteOrZero(costField["total"]) : finiteOrZero(costField);
  return { input, output, cacheRead, cacheWrite, totalTokens, costUsd };
}

/** 解析单个会话 `.jsonl` 文本并聚合按天、按模型的用量。 */
export function aggregateSessionJsonl(rawText: string): Pick<PiCachedSessionFile, "days" | "models"> {
  const days: Record<string, CachedDayTotals> = {};
  const models: Record<string, CachedModelDayTotals> = {};
  const source = stripBom(rawText);
  if (source === "") return { days, models };

  let start = 0;
  while (start <= source.length) {
    let end = source.indexOf("\n", start);
    if (end === -1) end = source.length;
    const rawLine =
      end > start && source.charCodeAt(end - 1) === 13 ? source.slice(start, end - 1) : source.slice(start, end);
    start = end + 1;

    if (rawLine.length === 0 || !rawLine.includes('"usage"')) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    const usage = message["usage"];
    if (!isRecord(usage)) continue;

    const ts = parseEntryTimestamp(entry, message);
    if (!Number.isFinite(ts)) continue;

    const date = formatLocalDate(ts);
    const { totalTokens, costUsd } = extractUsageMetrics(usage);
    const provider = typeof message["provider"] === "string" ? message["provider"] : "";
    const model = typeof message["model"] === "string" && message["model"] !== "" ? message["model"] : "unknown";

    const dayAcc = days[date] ?? { requests: 0, tokens: 0, costUsd: 0 };
    dayAcc.requests += 1;
    dayAcc.tokens += totalTokens;
    dayAcc.costUsd += costUsd;
    days[date] = dayAcc;

    const modelKey = `${date}\n${provider}\n${model}`;
    const modelAcc = models[modelKey] ?? {
      date,
      provider,
      model,
      requests: 0,
      tokens: 0,
      costUsd: 0,
    };
    modelAcc.requests += 1;
    modelAcc.tokens += totalTokens;
    modelAcc.costUsd += costUsd;
    models[modelKey] = modelAcc;
  }

  return { days, models };
}

interface SessionFileStat {
  filePath: string;
  relKey: string;
  mtimeMs: number;
  size: number;
}

async function collectSessionJsonlFiles(rootDir: string, currentDir: string = rootDir): Promise<SessionFileStat[]> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    log.warn("failed to scan pi sessions dir", { currentDir, message: String(error) });
    return [];
  }

  const subdirs: string[] = [];
  const jsonlPaths: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      subdirs.push(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      jsonlPaths.push(fullPath);
    } else if (entry.isSymbolicLink()) {
      try {
        const st = await stat(fullPath);
        if (st.isDirectory()) subdirs.push(fullPath);
        else if (st.isFile() && entry.name.endsWith(".jsonl")) jsonlPaths.push(fullPath);
      } catch {
        // 忽略悬空符号链接
      }
    }
  }

  const [fileStats, nestedLists] = await Promise.all([
    Promise.all(
      jsonlPaths.map(async (filePath): Promise<SessionFileStat | null> => {
        try {
          const st = await stat(filePath);
          return {
            filePath,
            relKey: path.relative(rootDir, filePath).split(path.sep).join("/"),
            mtimeMs: st.mtimeMs,
            size: st.size,
          };
        } catch {
          return null;
        }
      }),
    ),
    Promise.all(subdirs.map((sub) => collectSessionJsonlFiles(rootDir, sub))),
  ]);

  const out: SessionFileStat[] = [];
  for (const item of fileStats) {
    if (item !== null) out.push(item);
  }
  for (const nested of nestedLists) {
    out.push(...nested);
  }
  return out;
}

function isValidCachedSessionFile(raw: unknown): raw is PiCachedSessionFile {
  return (
    isRecord(raw) &&
    typeof raw["mtimeMs"] === "number" &&
    Number.isFinite(raw["mtimeMs"]) &&
    typeof raw["size"] === "number" &&
    Number.isFinite(raw["size"]) &&
    isRecord(raw["days"]) &&
    isRecord(raw["models"])
  );
}

async function loadCacheData(
  memoryKey: string,
  cacheFile: string | null,
  tzOffsetMin: number,
): Promise<PiHeatmapCacheData> {
  const empty = (): PiHeatmapCacheData => ({
    version: CACHE_VERSION,
    tzOffsetMin,
    files: {},
  });

  if (cacheFile === null) {
    const inMem = memoryCaches.get(memoryKey);
    if (inMem && inMem.data.version === CACHE_VERSION && inMem.data.tzOffsetMin === tzOffsetMin) {
      return inMem.data;
    }
    return empty();
  }

  let diskStat: { mtimeMs: number; size: number } | null = null;
  try {
    const st = await stat(cacheFile);
    diskStat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch (error) {
    if (!isNotFound(error)) {
      log.warn("failed to stat pi heatmap cache file", { cacheFile, message: String(error) });
    }
    memoryCaches.delete(memoryKey);
    return empty();
  }

  const inMem = memoryCaches.get(memoryKey);
  if (
    inMem &&
    inMem.diskMtimeMs === diskStat.mtimeMs &&
    inMem.diskSize === diskStat.size &&
    inMem.data.version === CACHE_VERSION &&
    inMem.data.tzOffsetMin === tzOffsetMin
  ) {
    return inMem.data;
  }

  try {
    const raw = await readFile(cacheFile, "utf8");
    const parsed: unknown = JSON.parse(stripBom(raw));
    if (
      !isRecord(parsed) ||
      parsed["version"] !== CACHE_VERSION ||
      parsed["tzOffsetMin"] !== tzOffsetMin ||
      !isRecord(parsed["files"])
    ) {
      return empty();
    }
    const validFiles: Record<string, PiCachedSessionFile> = {};
    for (const [k, v] of Object.entries(parsed["files"])) {
      if (isValidCachedSessionFile(v)) validFiles[k] = v;
    }
    const loaded: PiHeatmapCacheData = {
      version: CACHE_VERSION,
      tzOffsetMin,
      files: validFiles,
    };
    memoryCaches.set(memoryKey, {
      diskMtimeMs: diskStat.mtimeMs,
      diskSize: diskStat.size,
      data: loaded,
    });
    return loaded;
  } catch (error) {
    log.warn("failed to parse pi heatmap cache, rebuilding", {
      cacheFile,
      message: String(error),
    });
    return empty();
  }
}

export interface PiHeatmapOptions {
  /** 增量缓存文件路径；提供时经 `writeFileAtomic` 持久化。 */
  cacheFile?: string | null;
  /** 自定义会话根目录（默认 `<agentDir>/sessions`）。 */
  sessionDir?: string | null;
  /** 当前时间毫秒戳（单测可注入固定时间）。 */
  now?: number;
}

// 扫描 `<agentDir>/sessions` 下所有 `.jsonl` 计算近 365 天（含当天，本地时区）的请求数、Token 与花费热力图。
// 始终返回 `hasDatabase: true`，使空会话目录下也能正常展示 Bento 用量面板。
export async function readPiUsageHeatmap(
  agentDir: string,
  cacheFileOrOptions?: string | PiHeatmapOptions | null,
  nowArg?: number,
): Promise<UsageHeatmap> {
  const opts: PiHeatmapOptions =
    typeof cacheFileOrOptions === "string" || cacheFileOrOptions === null
      ? {
          cacheFile: cacheFileOrOptions,
          ...(nowArg !== undefined ? { now: nowArg } : {}),
        }
      : (cacheFileOrOptions ?? {});

  const now = opts.now ?? Date.now();
  const first = new Date(now);
  first.setDate(first.getDate() - (PI_HEATMAP_DAYS - 1));
  first.setHours(0, 0, 0, 0);
  const from = formatLocalDate(first.getTime());
  const to = formatLocalDate(now);
  const tzOffsetMin = new Date(now).getTimezoneOffset();

  const sessionsRoot =
    opts.sessionDir && opts.sessionDir.trim() !== ""
      ? path.resolve(opts.sessionDir)
      : path.resolve(agentDir, "sessions");
  const cacheFile = opts.cacheFile && opts.cacheFile.trim() !== "" ? path.resolve(opts.cacheFile) : null;
  const memoryKey = cacheFile ?? `mem:${sessionsRoot}`;

  const [sessionFiles, prevCache] = await Promise.all([
    collectSessionJsonlFiles(sessionsRoot),
    loadCacheData(memoryKey, cacheFile, tzOffsetMin),
  ]);

  const nextFiles: Record<string, PiCachedSessionFile> = {};
  const toParse: SessionFileStat[] = [];
  let dirty = false;

  for (const sf of sessionFiles) {
    const existing = prevCache.files[sf.relKey];
    if (existing && existing.mtimeMs === sf.mtimeMs && existing.size === sf.size) {
      nextFiles[sf.relKey] = existing;
    } else {
      toParse.push(sf);
      dirty = true;
    }
  }

  if (Object.keys(prevCache.files).length !== sessionFiles.length) {
    for (const oldKey of Object.keys(prevCache.files)) {
      if (!(oldKey in nextFiles) && !toParse.some((sf) => sf.relKey === oldKey)) {
        dirty = true;
        break;
      }
    }
  }

  if (toParse.length > 0) {
    // 批量并发读取变更的 .jsonl 文件（控制单批并发防止句柄峰值）
    const BATCH = 32;
    for (let i = 0; i < toParse.length; i += BATCH) {
      const slice = toParse.slice(i, i + BATCH);
      const parsedBatch = await Promise.all(
        slice.map(async (sf): Promise<[string, PiCachedSessionFile] | null> => {
          try {
            const raw = await readFile(sf.filePath, "utf8");
            const agg = aggregateSessionJsonl(raw);
            return [
              sf.relKey,
              {
                mtimeMs: sf.mtimeMs,
                size: sf.size,
                days: agg.days,
                models: agg.models,
              },
            ];
          } catch (error) {
            if (!isNotFound(error)) {
              log.warn("failed to read pi session jsonl for heatmap", {
                filePath: sf.filePath,
                message: String(error),
              });
            }
            return null;
          }
        }),
      );
      for (const pair of parsedBatch) {
        if (pair !== null) nextFiles[pair[0]] = pair[1];
      }
    }
  }

  const nextCache: PiHeatmapCacheData = {
    version: CACHE_VERSION,
    tzOffsetMin,
    files: nextFiles,
  };

  if (cacheFile !== null) {
    if (dirty) {
      try {
        const serialized = JSON.stringify(nextCache);
        await enqueueCacheWrite(cacheFile, serialized);
        const st = await stat(cacheFile).catch(() => null);
        memoryCaches.set(memoryKey, {
          diskMtimeMs: st?.mtimeMs ?? null,
          diskSize: st?.size ?? null,
          data: nextCache,
        });
      } catch (error) {
        log.warn("failed to persist pi heatmap cache", { cacheFile, message: String(error) });
      }
    }
  } else if (dirty) {
    memoryCaches.set(memoryKey, {
      diskMtimeMs: null,
      diskSize: null,
      data: nextCache,
    });
  }

  const byDay = new Map<string, UsageDay>();
  const byModelDay = new Map<string, UsageModelDay>();

  for (const fileEntry of Object.values(nextFiles)) {
    for (const [date, dayVal] of Object.entries(fileEntry.days)) {
      if (date < from || date > to) continue;
      const cur = byDay.get(date) ?? { date, requests: 0, tokens: 0, costUsd: 0 };
      cur.requests += dayVal.requests;
      cur.tokens += dayVal.tokens;
      cur.costUsd += dayVal.costUsd;
      byDay.set(date, cur);
    }
    for (const [modelKey, modelVal] of Object.entries(fileEntry.models)) {
      if (modelVal.date < from || modelVal.date > to) continue;
      const cur = byModelDay.get(modelKey) ?? {
        date: modelVal.date,
        model: modelVal.model,
        provider: modelVal.provider,
        requests: 0,
        tokens: 0,
        costUsd: 0,
      };
      cur.requests += modelVal.requests;
      cur.tokens += modelVal.tokens;
      cur.costUsd += modelVal.costUsd;
      byModelDay.set(modelKey, cur);
    }
  }

  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const models = [...byModelDay.values()].sort((a, b) => a.date.localeCompare(b.date) || b.tokens - a.tokens);

  return {
    from,
    to,
    days,
    models,
    hasDatabase: true,
  };
}

function measureResultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content as unknown[]) {
    if (typeof part === "string") {
      total += part.length;
    } else if (isRecord(part)) {
      if (typeof part["text"] === "string") total += part["text"].length;
      else total += JSON.stringify(part).length;
    }
  }
  return total;
}

interface RawTraceDraft {
  entryId: string;
  timestamp: number;
  model: string;
  provider: string;
  agentType: string;
  stopReason: string;
  errorMessage: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number;
  durationMs: number | null;
  ttftMs: number | null;
  serviceTier: string | null;
  toolCalls: { id: string; name: string; argsChars: number }[];
}

/**
 * 直接从 Pi 会话 `.jsonl` 文件读取最近 `limit`（默认 500）条模型请求与对应的工具调用详情（从新到旧排列）。
 */
export async function readPiSessionTrace(
  sessionFile: string | null,
  limit: number = PI_TRACE_LIMIT,
): Promise<SessionTrace> {
  if (sessionFile === null || sessionFile.trim() === "") {
    return { hasDatabase: true, requests: [], truncated: false };
  }

  let raw: string;
  try {
    raw = await readFile(sessionFile, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { hasDatabase: true, requests: [], truncated: false };
    throw error;
  }

  const drafts: RawTraceDraft[] = [];
  const toolResults = new Map<string, { isError: boolean | null; resultChars: number }>();
  const lines = stripBom(raw).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isRecord(message)) continue;
    const role = message["role"];

    if (role === "toolResult") {
      const callId = nonEmptyString(message["toolCallId"]);
      if (callId !== null) {
        toolResults.set(callId, {
          isError: typeof message["isError"] === "boolean" ? message["isError"] : null,
          resultChars: measureResultChars(message["content"]),
        });
      }
      continue;
    }

    if (role !== "assistant") continue;

    const usage = isRecord(message["usage"]) ? message["usage"] : {};
    const metrics = extractUsageMetrics(usage);
    const ts = parseEntryTimestamp(entry, message);

    const toolCalls: { id: string; name: string; argsChars: number }[] = [];
    if (Array.isArray(message["content"])) {
      for (const block of message["content"] as unknown[]) {
        if (!isRecord(block) || block["type"] !== "toolCall") continue;
        const id = typeof block["id"] === "string" ? block["id"] : "";
        const name = typeof block["name"] === "string" ? block["name"] : "";
        const args = block["arguments"];
        const argsChars = args === undefined ? 0 : typeof args === "string" ? args.length : JSON.stringify(args).length;
        toolCalls.push({ id, name, argsChars });
      }
    }

    drafts.push({
      entryId: nonEmptyString(entry["id"]) ?? String(i + 1),
      timestamp: Number.isFinite(ts) ? ts : 0,
      model: typeof message["model"] === "string" ? message["model"] : "",
      provider: typeof message["provider"] === "string" ? message["provider"] : "",
      agentType: nonEmptyString(message["agentType"]) ?? "main",
      stopReason: typeof message["stopReason"] === "string" ? message["stopReason"] : "",
      errorMessage: nonEmptyString(message["errorMessage"]),
      input: metrics.input,
      output: metrics.output,
      cacheRead: metrics.cacheRead,
      cacheWrite: metrics.cacheWrite,
      total: metrics.totalTokens,
      costUsd: metrics.costUsd,
      durationMs:
        finiteNumber(message["durationMs"]) ?? finiteNumber(message["duration"]) ?? finiteNumber(usage["durationMs"]),
      ttftMs: finiteNumber(message["ttftMs"]) ?? finiteNumber(message["ttft"]) ?? finiteNumber(usage["ttftMs"]),
      serviceTier: nonEmptyString(message["serviceTier"]) ?? nonEmptyString(usage["serviceTier"]),
      toolCalls,
    });
  }

  const maxItems = Math.max(0, Math.floor(limit));
  const truncated = drafts.length > maxItems;
  const newestFirst = drafts.toReversed();
  const kept = truncated ? newestFirst.slice(0, maxItems) : newestFirst;

  const requests: TraceRequest[] = kept.map((draft) => {
    const tools: TraceToolCall[] = draft.toolCalls.map((tc) => {
      const matched = tc.id !== "" ? toolResults.get(tc.id) : undefined;
      return {
        name: tc.name,
        isError: matched ? matched.isError : null,
        argsChars: tc.argsChars,
        resultChars: matched ? matched.resultChars : null,
      };
    });
    return {
      entryId: draft.entryId,
      timestamp: draft.timestamp,
      model: draft.model,
      provider: draft.provider,
      agentType: draft.agentType,
      stopReason: draft.stopReason,
      errorMessage: draft.errorMessage,
      input: draft.input,
      output: draft.output,
      cacheRead: draft.cacheRead,
      cacheWrite: draft.cacheWrite,
      total: draft.total,
      costUsd: draft.costUsd,
      durationMs: draft.durationMs,
      ttftMs: draft.ttftMs,
      serviceTier: draft.serviceTier,
      tools,
    };
  });

  return {
    hasDatabase: true,
    requests,
    truncated,
  };
}
