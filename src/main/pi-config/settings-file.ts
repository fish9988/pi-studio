// Pi 配置文件读写器：直接读写 `<agentDir>/settings.json`（全局）与 `<projectDir>/.pi/settings.json`（项目级）。
// 纯 Node JSON I/O（<1ms），通过 `writeFileAtomic` 原子写入，按文件路径串行排队，支持嵌套点路径键与项目级覆盖检测。
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelDefaults, OmpConfigItem, OmpConfigSnapshot, OmpConfigWriteResult } from "../../shared/ipc.ts";
import { PI_THINKING_LEVELS, type PiConfigScope } from "../../shared/pi-config-types.ts";
import {
  findPiSettingSchema,
  PI_SETTINGS_SCHEMA,
  PI_SETTINGS_TABS,
  type PiSettingSchemaEntry,
} from "../../shared/pi-settings-schema.ts";
import { isRecord } from "../../shared/type-guards.ts";
import { log } from "../log/log.ts";
import { writeFileAtomic } from "../tasks/atomic-write.ts";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const STRING_ARRAY_KEYS = new Set([
  "enabledModels",
  "defaultTools",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "npmCommand",
  "selfUpdateCommand",
]);
const THINKING_SET = new Set<string>(PI_THINKING_LEVELS);

/** 按规范化文件路径串行化读写修改，防止并发写入互相覆盖。 */
const fileQueues = new Map<string, Promise<unknown>>();

export function enqueueFileWrite<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prev = fileQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked = next.then(
    () => undefined,
    () => undefined,
  );
  fileQueues.set(key, tracked);
  void tracked.finally(() => {
    if (fileQueues.get(key) === tracked) fileQueues.delete(key);
  });
  return next;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function piSettingsFilePath(
  agentDir: string,
  scope: PiConfigScope = "global",
  projectDir?: string | null,
): string {
  if (scope === "project") {
    if (!projectDir || projectDir.trim() === "") {
      throw new Error("projectDir is required when scope is 'project'");
    }
    return path.join(projectDir, ".pi", "settings.json");
  }
  return path.join(agentDir, "settings.json");
}

function splitDotKey(key: string): string[] {
  const trimmed = key.trim();
  if (trimmed === "") throw new Error("Setting key must not be empty");
  const segments = trimmed.split(".");
  for (const segment of segments) {
    if (segment === "" || FORBIDDEN_SEGMENTS.has(segment)) {
      throw new Error(`Invalid setting key: "${key}"`);
    }
  }
  return segments;
}

/** 按点分路径读取嵌套字段（例如 `"retry.provider.timeoutMs"`）。 */
export function getNestedValue(root: Record<string, unknown>, key: string): unknown {
  const segments = splitDotKey(key);
  let cursor: unknown = root;
  for (const segment of segments) {
    if (!isRecord(cursor) || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** 按点分路径写入嵌套字段，保留所有同级和未知字段。 */
export function setNestedValue(root: Record<string, unknown>, key: string, value: unknown): void {
  const segments = splitDotKey(key);
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const existing = cursor[seg];
    if (isRecord(existing)) {
      const copy: Record<string, unknown> = { ...existing };
      cursor[seg] = copy;
      cursor = copy;
    } else {
      const created: Record<string, unknown> = {};
      cursor[seg] = created;
      cursor = created;
    }
  }
  cursor[segments[segments.length - 1]!] = value;
}

/** 按点分路径删除嵌套字段，并自底向上清理变为空对象的父级容器（如 `compaction: {}`）。 */
export function deleteNestedValue(root: Record<string, unknown>, key: string): boolean {
  const segments = splitDotKey(key);
  const chain: { parent: Record<string, unknown>; key: string }[] = [];
  let cursor: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (!isRecord(cursor) || !(seg in cursor)) return false;
    const child = cursor[seg];
    if (!isRecord(child)) return false;
    const childCopy: Record<string, unknown> = { ...child };
    cursor[seg] = childCopy;
    chain.push({ parent: cursor, key: seg });
    cursor = childCopy;
  }
  if (!isRecord(cursor)) return false;
  const leaf = segments[segments.length - 1]!;
  if (!(leaf in cursor)) return false;
  delete cursor[leaf];
  for (let i = chain.length - 1; i >= 0; i--) {
    const link = chain[i]!;
    const obj = link.parent[link.key];
    if (isRecord(obj) && Object.keys(obj).length === 0) {
      delete link.parent[link.key];
    } else {
      break;
    }
  }
  return true;
}

/**
 * 读取 JSON 配置文件为普通对象。
 * `strict = false`（只读快照）：文件不存在返回 `{}`，JSON 损坏记录警告并返回 `{}`；
 * `strict = true`（写入前）：文件不存在返回 `{ exists: false, data: {} }`，JSON 损坏直接抛错以防覆盖手写文件。
 */
export async function readPiSettingsObject(
  filePath: string,
  strict = false,
): Promise<{ exists: boolean; data: Record<string, unknown> }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { exists: false, data: {} };
    if (strict) throw error;
    log.warn("failed to read pi settings.json", { filePath, message: String(error) });
    return { exists: false, data: {} };
  }
  const trimmed = stripBom(raw).trim();
  if (trimmed === "") return { exists: true, data: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (strict) {
      throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    log.warn("invalid JSON in pi settings.json", { filePath, message: String(error) });
    return { exists: true, data: {} };
  }
  if (!isRecord(parsed)) {
    if (strict) throw new Error(`Expected JSON object root in ${filePath}`);
    log.warn("pi settings.json root is not an object", { filePath });
    return { exists: true, data: {} };
  }
  return { exists: true, data: { ...parsed } };
}

/** 串行化读取-修改-原子写入指定作用域的 `settings.json`。回调返回 `false` 时跳过落盘。 */
export function mutatePiSettingsObject<T>(
  agentDir: string,
  scope: PiConfigScope,
  projectDir: string | null | undefined,
  mutator: (
    data: Record<string, unknown>,
    exists: boolean,
  ) => { write: boolean; result: T } | Promise<{ write: boolean; result: T }>,
): Promise<T> {
  const filePath = piSettingsFilePath(agentDir, scope, projectDir);
  return enqueueFileWrite(filePath, async () => {
    const { exists, data } = await readPiSettingsObject(filePath, true);
    const { write, result } = await mutator(data, exists);
    if (write) {
      const serialized = `${JSON.stringify(data, null, 2)}\n`;
      await writeFileAtomic(filePath, serialized, `pi-studio-${process.pid}`);
    }
    return result;
  });
}

function maskSettingValue(key: string, value: unknown): { value: unknown; redacted: boolean } {
  if (key === "httpProxy" && typeof value === "string" && value.includes("@")) {
    try {
      const parsed = new URL(value);
      if (parsed.password !== "" || parsed.username !== "") {
        if (parsed.password !== "") parsed.password = "***";
        return { value: parsed.toString(), redacted: true };
      }
    } catch {
      // 非标准 URL 保持原样
    }
  }
  return { value: value === undefined ? null : structuredClone(value), redacted: false };
}

function validateAgainstSchema(entry: PiSettingSchemaEntry, value: unknown): void {
  switch (entry.type) {
    case "boolean":
      if (typeof value !== "boolean") {
        throw new Error(`Setting "${entry.key}" expects a boolean`);
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Setting "${entry.key}" expects a non-negative finite number`);
      }
      return;
    case "string":
      if (typeof value !== "string") {
        throw new Error(`Setting "${entry.key}" expects a string`);
      }
      return;
    case "enum":
      if (typeof value !== "string" || !entry.options || !entry.options.includes(value)) {
        throw new Error(`Setting "${entry.key}" expects one of: ${(entry.options ?? []).join(", ")}`);
      }
      return;
    case "array":
      if (!Array.isArray(value)) {
        throw new Error(`Setting "${entry.key}" expects an array`);
      }
      if (entry.key === "packages") {
        const ok = value.every(
          (item) =>
            typeof item === "string" ||
            (isRecord(item) && typeof item["source"] === "string" && item["source"].trim() !== ""),
        );
        if (!ok) {
          throw new Error(`Setting "packages" expects string sources or { source: string } objects`);
        }
      } else if (STRING_ARRAY_KEYS.has(entry.key)) {
        if (!value.every((item) => typeof item === "string")) {
          throw new Error(`Setting "${entry.key}" expects an array of strings`);
        }
      }
      return;
    case "record":
      if (!isRecord(value)) {
        throw new Error(`Setting "${entry.key}" expects a JSON object`);
      }
      return;
  }
}

export interface PiConfigSnapshot extends OmpConfigSnapshot {
  /** 当前项目 `.pi/settings.json` 中显式覆盖了全局配置的键名列表。 */
  projectOverrides: string[];
}

/**
 * 读取 Pi 设置快照（兼容 `OmpConfigSnapshot` 契约，并附带项目覆盖检测 `projectOverrides`）。
 */
export async function readPiConfigSnapshot(
  agentDir: string,
  piVersion: string,
  projectDir?: string | null,
): Promise<PiConfigSnapshot> {
  const globalPath = piSettingsFilePath(agentDir, "global");
  const [{ data: globalObj }, projectResult] = await Promise.all([
    readPiSettingsObject(globalPath, false),
    projectDir && projectDir.trim() !== ""
      ? readPiSettingsObject(piSettingsFilePath(agentDir, "project", projectDir), false)
      : Promise.resolve(null),
  ]);
  const projectObj = projectResult?.data ?? null;
  const projectOverrides: string[] = [];

  const items: OmpConfigItem[] = PI_SETTINGS_SCHEMA.map((entry) => {
    const globalVal = getNestedValue(globalObj, entry.key);
    const projectVal = !entry.globalOnly && projectObj !== null ? getNestedValue(projectObj, entry.key) : undefined;
    if (projectVal !== undefined) {
      projectOverrides.push(entry.key);
    }
    const rawEffective = projectVal !== undefined ? projectVal : globalVal;
    const hasValue = rawEffective !== undefined;
    const masked = hasValue
      ? maskSettingValue(entry.key, rawEffective)
      : {
          value: entry.hasDefault ? structuredClone(entry.defaultValue) : null,
          redacted: false,
        };
    return {
      key: entry.key,
      tab: entry.tab,
      type: entry.type,
      description: entry.descZh,
      options: entry.options ? [...entry.options] : null,
      value: masked.value,
      hasValue,
      redacted: masked.redacted,
      defaultValue: entry.hasDefault ? structuredClone(entry.defaultValue) : null,
      hasDefault: entry.hasDefault,
    };
  });

  return {
    ompVersion: piVersion,
    tabs: [...PI_SETTINGS_TABS],
    items,
    projectOverrides,
  };
}

/**
 * 修改单项 Pi 设置：支持嵌套点路径键，校验 `PI_SETTINGS_SCHEMA`（同时允许自定义键），原子写入。
 * 若写入全局设置且当前项目 `.pi/settings.json` 覆盖了同一键，返回 `overriddenBy: "project"`。
 */
export async function setPiSetting(
  agentDir: string,
  key: string,
  valueJson: string,
  scope: PiConfigScope = "global",
  projectDir?: string | null,
): Promise<OmpConfigWriteResult> {
  splitDotKey(key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson);
  } catch (error) {
    throw new Error(`Invalid JSON value for "${key}": ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (parsed === undefined) {
    throw new Error(`Setting "${key}" value cannot be undefined`);
  }

  const schema = findPiSettingSchema(key);
  if (schema) {
    if (schema.globalOnly && scope === "project") {
      throw new Error(`Setting "${key}" can only be configured in global settings.json`);
    }
    validateAgainstSchema(schema, parsed);
  }

  await mutatePiSettingsObject(agentDir, scope, projectDir, (data) => {
    setNestedValue(data, key, parsed);
    return { write: true, result: undefined };
  });

  if (scope === "global" && !schema?.globalOnly && projectDir && projectDir.trim() !== "") {
    const { data: projectObj } = await readPiSettingsObject(piSettingsFilePath(agentDir, "project", projectDir), false);
    const projectVal = getNestedValue(projectObj, key);
    if (projectVal !== undefined) {
      const maskedProject = maskSettingValue(key, projectVal);
      return {
        key,
        value: maskedProject.value,
        hasValue: true,
        redacted: maskedProject.redacted,
        overriddenBy: "project",
      };
    }
  }

  const masked = maskSettingValue(key, parsed);
  return {
    key,
    value: masked.value,
    hasValue: true,
    redacted: masked.redacted,
  };
}

/**
 * 重置单项 Pi 设置：删除目标键并自动清理变空的嵌套父对象（如 `compaction: {}`），原子写入。
 */
export async function resetPiSetting(
  agentDir: string,
  key: string,
  scope: PiConfigScope = "global",
  projectDir?: string | null,
): Promise<OmpConfigWriteResult> {
  splitDotKey(key);
  const schema = findPiSettingSchema(key);
  if (schema?.globalOnly && scope === "project") {
    throw new Error(`Setting "${key}" can only be reset in global settings.json`);
  }

  await mutatePiSettingsObject(agentDir, scope, projectDir, (data, exists) => {
    if (!exists) return { write: false, result: undefined };
    const deleted = deleteNestedValue(data, key);
    return { write: deleted, result: undefined };
  });

  const [{ data: globalObj }, projectResult] = await Promise.all([
    readPiSettingsObject(piSettingsFilePath(agentDir, "global"), false),
    !schema?.globalOnly && projectDir && projectDir.trim() !== ""
      ? readPiSettingsObject(piSettingsFilePath(agentDir, "project", projectDir), false)
      : Promise.resolve(null),
  ]);

  const projectVal = projectResult ? getNestedValue(projectResult.data, key) : undefined;
  const globalVal = getNestedValue(globalObj, key);

  if (projectVal !== undefined) {
    const masked = maskSettingValue(key, projectVal);
    return {
      key,
      value: masked.value,
      hasValue: true,
      redacted: masked.redacted,
      ...(scope === "global" ? { overriddenBy: "project" } : {}),
    };
  }

  if (globalVal !== undefined) {
    const masked = maskSettingValue(key, globalVal);
    return {
      key,
      value: masked.value,
      hasValue: true,
      redacted: masked.redacted,
    };
  }

  return {
    key,
    value: schema?.hasDefault ? structuredClone(schema.defaultValue) : null,
    hasValue: false,
    redacted: false,
  };
}

function nonEmptyTrimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 从全局与可选项目 `settings.json` 解析启动默认模型与默认思考强度。
 * 项目设置优先于全局设置；`defaultProvider` + `defaultModel` 组合为 `provider/modelId`。
 */
export async function readModelDefaultsFromPiSettings(
  agentDir: string,
  projectDir?: string | null,
): Promise<ModelDefaults> {
  const [{ data: globalObj }, projectResult] = await Promise.all([
    readPiSettingsObject(piSettingsFilePath(agentDir, "global"), false),
    projectDir && projectDir.trim() !== ""
      ? readPiSettingsObject(piSettingsFilePath(agentDir, "project", projectDir), false)
      : Promise.resolve(null),
  ]);
  const projectObj = projectResult?.data ?? null;

  const provider =
    (projectObj ? nonEmptyTrimmed(projectObj["defaultProvider"]) : null) ??
    nonEmptyTrimmed(globalObj["defaultProvider"]);
  const modelId =
    (projectObj ? nonEmptyTrimmed(projectObj["defaultModel"]) : null) ?? nonEmptyTrimmed(globalObj["defaultModel"]);
  const rawThinking =
    (projectObj ? nonEmptyTrimmed(projectObj["defaultThinkingLevel"]) : null) ??
    nonEmptyTrimmed(globalObj["defaultThinkingLevel"]);

  let model: string | null = null;
  if (provider && modelId) {
    model = modelId.startsWith(`${provider}/`) ? modelId : `${provider}/${modelId}`;
  } else if (modelId) {
    model = modelId;
  }

  const thinkingLevel = rawThinking && THINKING_SET.has(rawThinking) ? rawThinking : null;
  return { model, thinkingLevel };
}

/**
 * 原子更新 `defaultProvider`、`defaultModel` 和可选 `defaultThinkingLevel`（`model === null` 时清除默认模型）。
 */
export async function writeModelDefaultsToPiSettings(
  agentDir: string,
  model: { provider: string; modelId: string } | null,
  thinkingLevel?: string | null,
  scope: PiConfigScope = "global",
  projectDir?: string | null,
): Promise<void> {
  if (thinkingLevel !== undefined && thinkingLevel !== null && !THINKING_SET.has(thinkingLevel)) {
    throw new Error(`Invalid thinking level: "${thinkingLevel}"`);
  }
  await mutatePiSettingsObject(agentDir, scope, projectDir, (data) => {
    if (model === null) {
      deleteNestedValue(data, "defaultProvider");
      deleteNestedValue(data, "defaultModel");
    } else {
      setNestedValue(data, "defaultProvider", model.provider);
      setNestedValue(data, "defaultModel", model.modelId);
    }
    if (thinkingLevel !== undefined) {
      if (thinkingLevel === null) deleteNestedValue(data, "defaultThinkingLevel");
      else setNestedValue(data, "defaultThinkingLevel", thinkingLevel);
    }
    return { write: true, result: undefined };
  });
}
