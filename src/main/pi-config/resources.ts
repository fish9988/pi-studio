// Pi 资源管理后端：
// 1. MCP 服务器（`<agentDir>/mcp.json` & `<projectDir>/.pi/mcp.json`，保留已有密钥）
// 2. 内置与自定义扩展（`settings.json` 的 `extensions` 数组，`builtin:*` 默认开启、`-builtin:*` 禁用）
// 3. Skills（`<agentDir>/skills`、`<projectDir>/.pi/skills`、`~/.agents/skills`、`<projectDir>/.agents/skills` + `-path` 禁用）
// 4. Prompt 模板（`<agentDir>/prompts/*.md` & `<projectDir>/.pi/prompts/*.md`）
// 5. 系统提示词文档（`AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`）与快捷键（`<agentDir>/keybindings.json`）
// 6. Pi 扩展包（`settings.json` 的 `packages` + 无 shell 的 `pi install` / `pi remove` / `pi update`）
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillCandidate, SkillEntry, SkillScope, SkillTarget } from "../../shared/omp-output/skills.ts";
import {
  PI_BUILTIN_EXTENSIONS,
  PI_MCP_EXPOSURES,
  PI_SYSTEM_DOC_KINDS,
  type PiBuiltinExtensionId,
  type PiBuiltinExtensionState,
  type PiConfigScope,
  type PiMcpExposure,
  type PiMcpServerItem,
  type PiMcpServerSaveInput,
  type PiPackageItem,
  type PiPromptTemplate,
  type PiResourcesSnapshot,
  type PiSystemDoc,
  type PiSystemDocKind,
} from "../../shared/pi-config-types.ts";
import { chordFromKbd, STUDIO_RESERVED } from "../../shared/tsp/forward-keys.ts";
import type { OmpKeybinding } from "../../shared/tsp/omp-keybindings.ts";
import { isRecord, nonEmptyString as str } from "../../shared/type-guards.ts";
import { log } from "../log/log.ts";
import { writeFileAtomic } from "../tasks/atomic-write.ts";
import { stripJsonComments } from "./auth-and-models.ts";
import {
  deleteNestedValue,
  enqueueFileWrite,
  mutatePiSettingsObject,
  piSettingsFilePath,
  readPiSettingsObject,
} from "./settings-file.ts";

const BUILTIN_EXT_SET = new Set<string>(PI_BUILTIN_EXTENSIONS);
const MCP_EXPOSURE_SET = new Set<string>(PI_MCP_EXPOSURES);
const SYSTEM_DOC_SET = new Set<string>(PI_SYSTEM_DOC_KINDS);
const FOLDER_UNSAFE = /[/\\<>:"|?*]/;
const SKILL_FILE = "SKILL.md";

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function displaySkillPath(target: string, homeDir: string): string {
  if (!isInside(target, homeDir)) return target;
  const rel = path.relative(homeDir, target);
  return rel === "" ? "~" : `~/${toPosixPath(rel)}`;
}

// ============================================================================
// 1. MCP 服务器（`<agentDir>/mcp.json` & `<projectDir>/.pi/mcp.json`）
// ============================================================================

export function piMcpFilePath(agentDir: string, projectDir: string | null | undefined, scope: PiConfigScope): string {
  if (scope === "project") {
    if (!projectDir || projectDir.trim() === "") {
      throw new Error("projectDir is required when scope is 'project'");
    }
    return path.join(projectDir, ".pi", "mcp.json");
  }
  return path.join(agentDir, "mcp.json");
}

function normalizeMcpExposure(raw: unknown): PiMcpExposure {
  if (raw === "codemode-deferred") return "codemode";
  if (typeof raw === "string" && MCP_EXPOSURE_SET.has(raw)) return raw as PiMcpExposure;
  return "codemode";
}

function parseMcpServerItem(name: string, scope: PiConfigScope, raw: Record<string, unknown>): PiMcpServerItem {
  const url = str(raw["url"]);
  const rawType = str(raw["type"]);
  const transport: "stdio" | "http" =
    url !== null || rawType === "http" || rawType === "streamable-http" ? "http" : "stdio";
  const command = str(raw["command"]);
  const args = Array.isArray(raw["args"])
    ? (raw["args"] as unknown[]).filter((item): item is string => typeof item === "string")
    : undefined;
  const cwd = str(raw["cwd"]);
  const envKeys = isRecord(raw["env"]) ? Object.keys(raw["env"]) : [];
  const headerKeys = isRecord(raw["headers"]) ? Object.keys(raw["headers"]) : [];
  const enabled = raw["enabled"] !== false;
  const exposure = normalizeMcpExposure(raw["exposure"]);
  const timeout =
    typeof raw["timeout"] === "number" && Number.isFinite(raw["timeout"]) && raw["timeout"] > 0
      ? raw["timeout"]
      : undefined;
  const description = str(raw["description"]);

  return {
    name,
    scope,
    transport,
    ...(command !== null ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    envKeys,
    ...(cwd !== null ? { cwd } : {}),
    ...(url !== null ? { url } : {}),
    headerKeys,
    enabled,
    exposure,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(description !== null ? { description } : {}),
  };
}

async function readMcpRoot(
  filePath: string,
  strict = false,
): Promise<{ exists: boolean; root: Record<string, unknown> }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { exists: false, root: {} };
    if (strict) throw error;
    log.warn("failed to read pi mcp.json", { filePath, message: String(error) });
    return { exists: false, root: {} };
  }
  const cleaned = stripJsonComments(stripBom(raw)).trim();
  if (cleaned === "") return { exists: true, root: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    if (strict) {
      throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    log.warn("invalid JSON in pi mcp.json", { filePath, message: String(error) });
    return { exists: true, root: {} };
  }
  if (!isRecord(parsed)) {
    if (strict) throw new Error(`Expected JSON object root in ${filePath}`);
    return { exists: true, root: {} };
  }
  return { exists: true, root: { ...parsed } };
}

/** 列出全局与可选项目级的 MCP 服务器配置（只返回 envKeys / headerKeys，不暴露密钥值）。 */
export async function listPiMcpServers(agentDir: string, projectDir?: string | null): Promise<PiMcpServerItem[]> {
  const [{ root: globalRoot }, projectRes] = await Promise.all([
    readMcpRoot(piMcpFilePath(agentDir, null, "global"), false),
    projectDir && projectDir.trim() !== ""
      ? readMcpRoot(piMcpFilePath(agentDir, projectDir, "project"), false)
      : Promise.resolve(null),
  ]);

  const items: PiMcpServerItem[] = [];
  const collect = (root: Record<string, unknown>, scope: PiConfigScope) => {
    const servers = root["mcpServers"];
    if (!isRecord(servers)) return;
    for (const [name, raw] of Object.entries(servers)) {
      if (!isRecord(raw)) continue;
      items.push(parseMcpServerItem(name, scope, raw));
    }
  };

  collect(globalRoot, "global");
  if (projectRes !== null) collect(projectRes.root, "project");
  return items;
}

function mergeSecretMap(
  existingRaw: unknown,
  incoming: Record<string, string> | undefined,
  clear: boolean | undefined,
): Record<string, string> | undefined {
  const existing: Record<string, string> = {};
  if (!clear && isRecord(existingRaw)) {
    for (const [k, v] of Object.entries(existingRaw)) {
      if (typeof v === "string") existing[k] = v;
    }
  }
  if (incoming !== undefined) {
    for (const [k, v] of Object.entries(incoming)) {
      const trimmedKey = k.trim();
      if (trimmedKey === "") continue;
      existing[trimmedKey] = v;
    }
  }
  return Object.keys(existing).length > 0 ? existing : undefined;
}

/**
 * 新增或修改 MCP 服务器并原子写入目标 `mcp.json`。
 * 当 `input.env` / `input.headers` 省略或为空对象且未设 `clearEnv` / `clearHeaders` 时，完整保留磁盘上已有的密钥。
 */
export async function savePiMcpServer(
  agentDir: string,
  projectDir: string | null,
  input: PiMcpServerSaveInput,
): Promise<PiMcpServerItem> {
  const name = input.name.trim();
  if (name === "" || name.length > 128 || hasControlChars(name)) {
    throw new Error(`Invalid MCP server name: "${input.name}"`);
  }
  if (!MCP_EXPOSURE_SET.has(input.exposure)) {
    throw new Error(`Invalid MCP exposure: "${input.exposure}"`);
  }
  if (input.transport === "stdio") {
    const cmd = input.command?.trim() ?? "";
    if (cmd === "" || hasControlChars(cmd)) {
      throw new Error("MCP stdio server requires a non-empty command");
    }
  } else {
    const rawUrl = input.url?.trim() ?? "";
    let validHttpUrl = false;
    try {
      const parsed = new URL(rawUrl);
      validHttpUrl = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      validHttpUrl = false;
    }
    if (!validHttpUrl) {
      throw new Error("MCP HTTP server requires a valid http(s) URL");
    }
  }

  const filePath = piMcpFilePath(agentDir, projectDir, input.scope);
  return enqueueFileWrite(filePath, async () => {
    const { root } = await readMcpRoot(filePath, true);
    const rawServers = root["mcpServers"];
    if (rawServers !== undefined && rawServers !== null && !isRecord(rawServers)) {
      throw new Error(`Expected "mcpServers" to be an object in ${filePath}`);
    }
    const servers: Record<string, unknown> = isRecord(rawServers) ? { ...rawServers } : {};
    const prevName = input.previousName?.trim();
    const isRename = prevName !== undefined && prevName !== "" && prevName !== name;

    if (isRename && name in servers) {
      throw new Error(`MCP server "${name}" already exists`);
    }

    const baseRaw = isRename ? (servers[prevName] ?? servers[name]) : servers[name];
    const nextEntry: Record<string, unknown> = isRecord(baseRaw) ? { ...baseRaw } : {};

    if (input.transport === "stdio") {
      nextEntry["command"] = input.command!.trim();
      if (input.args && input.args.length > 0) {
        nextEntry["args"] = input.args.filter((a) => typeof a === "string");
      } else {
        delete nextEntry["args"];
      }
      if (input.cwd && input.cwd.trim() !== "") {
        nextEntry["cwd"] = input.cwd.trim();
      } else {
        delete nextEntry["cwd"];
      }
      delete nextEntry["url"];
      if (nextEntry["type"] === "http" || nextEntry["type"] === "streamable-http") {
        delete nextEntry["type"];
      }
    } else {
      nextEntry["url"] = input.url!.trim();
      delete nextEntry["command"];
      delete nextEntry["args"];
      delete nextEntry["cwd"];
      if (nextEntry["type"] === "stdio") {
        delete nextEntry["type"];
      }
    }

    const mergedEnv = mergeSecretMap(nextEntry["env"], input.env, input.clearEnv);
    if (mergedEnv !== undefined) nextEntry["env"] = mergedEnv;
    else delete nextEntry["env"];

    const mergedHeaders = mergeSecretMap(nextEntry["headers"], input.headers, input.clearHeaders);
    if (mergedHeaders !== undefined) nextEntry["headers"] = mergedHeaders;
    else delete nextEntry["headers"];

    if (input.enabled) delete nextEntry["enabled"];
    else nextEntry["enabled"] = false;

    nextEntry["exposure"] = input.exposure;

    if (typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0) {
      nextEntry["timeout"] = input.timeout;
    } else if (input.timeout !== undefined) {
      delete nextEntry["timeout"];
    }

    if (input.description !== undefined) {
      const desc = input.description.trim();
      if (desc !== "") nextEntry["description"] = desc;
      else delete nextEntry["description"];
    }

    if (isRename) delete servers[prevName];
    servers[name] = nextEntry;
    root["mcpServers"] = servers;

    await writeFileAtomic(filePath, `${JSON.stringify(root, null, 2)}\n`, `pi-studio-${process.pid}`);
    await chmod(filePath, 0o600).catch(() => undefined);
    return parseMcpServerItem(name, input.scope, nextEntry);
  });
}

/** 从指定作用域 `mcp.json` 中删除 MCP 服务器。 */
export async function deletePiMcpServer(
  agentDir: string,
  projectDir: string | null,
  scope: PiConfigScope,
  name: string,
): Promise<boolean> {
  const trimmed = name.trim();
  if (trimmed === "") return false;
  const filePath = piMcpFilePath(agentDir, projectDir, scope);
  return enqueueFileWrite(filePath, async () => {
    const { exists, root } = await readMcpRoot(filePath, true);
    if (!exists || !isRecord(root["mcpServers"]) || !(trimmed in root["mcpServers"])) {
      return false;
    }
    const servers: Record<string, unknown> = { ...root["mcpServers"] };
    delete servers[trimmed];
    root["mcpServers"] = servers;
    await writeFileAtomic(filePath, `${JSON.stringify(root, null, 2)}\n`, `pi-studio-${process.pid}`);
    await chmod(filePath, 0o600).catch(() => undefined);
    return true;
  });
}

/** 切换 MCP 服务器的启用状态（`enabled: false` 禁用；启用时移除 `enabled: false`）。 */
export async function setPiMcpServerEnabled(
  agentDir: string,
  projectDir: string | null,
  scope: PiConfigScope,
  name: string,
  enabled: boolean,
): Promise<PiMcpServerItem> {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("MCP server name must not be empty");
  const filePath = piMcpFilePath(agentDir, projectDir, scope);
  return enqueueFileWrite(filePath, async () => {
    const { root } = await readMcpRoot(filePath, true);
    const rawServers = root["mcpServers"];
    if (!isRecord(rawServers) || !isRecord(rawServers[trimmed])) {
      throw new Error(`MCP server "${trimmed}" not found in ${scope} mcp.json`);
    }
    const servers: Record<string, unknown> = { ...rawServers };
    const entry: Record<string, unknown> = { ...rawServers[trimmed] };
    if (enabled) delete entry["enabled"];
    else entry["enabled"] = false;
    servers[trimmed] = entry;
    root["mcpServers"] = servers;
    await writeFileAtomic(filePath, `${JSON.stringify(root, null, 2)}\n`, `pi-studio-${process.pid}`);
    await chmod(filePath, 0o600).catch(() => undefined);
    return parseMcpServerItem(trimmed, scope, entry);
  });
}

// ============================================================================
// 2. 内置与自定义扩展（`settings.json` 中的 `extensions` 数组）
// ============================================================================

function stringArrayFromSettings(obj: Record<string, unknown>, key: string): string[] {
  const raw = obj[key];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((item): item is string => typeof item === "string");
}

function isBuiltinExtensionToken(entry: string): boolean {
  const trimmed = entry.trim();
  const bare = trimmed.startsWith("+") || trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;
  return bare.startsWith("builtin:");
}

function applyBuiltinTokens(state: Map<PiBuiltinExtensionId, boolean>, entries: readonly string[]): void {
  for (const raw of entries) {
    const token = raw.trim();
    if (token.startsWith("-")) {
      const target = token.slice(1) as PiBuiltinExtensionId;
      if (BUILTIN_EXT_SET.has(target)) state.set(target, false);
    } else if (token.startsWith("+")) {
      const target = token.slice(1) as PiBuiltinExtensionId;
      if (BUILTIN_EXT_SET.has(target)) state.set(target, true);
    } else if (BUILTIN_EXT_SET.has(token)) {
      state.set(token as PiBuiltinExtensionId, true);
    }
  }
}

/** 读取 4 个内置扩展（`builtin:mcp` 等）的最终生效状态（默认开启，项目配置可覆盖全局）。 */
export async function listPiBuiltinExtensions(
  agentDir: string,
  projectDir?: string | null,
): Promise<PiBuiltinExtensionState[]> {
  const [{ data: globalObj }, projectRes] = await Promise.all([
    readPiSettingsObject(piSettingsFilePath(agentDir, "global"), false),
    projectDir && projectDir.trim() !== ""
      ? readPiSettingsObject(piSettingsFilePath(agentDir, "project", projectDir), false)
      : Promise.resolve(null),
  ]);

  const state = new Map<PiBuiltinExtensionId, boolean>(PI_BUILTIN_EXTENSIONS.map((id) => [id, true]));
  applyBuiltinTokens(state, stringArrayFromSettings(globalObj, "extensions"));
  if (projectRes !== null) {
    applyBuiltinTokens(state, stringArrayFromSettings(projectRes.data, "extensions"));
  }
  return PI_BUILTIN_EXTENSIONS.map((id) => ({ id, enabled: state.get(id) ?? true }));
}

/**
 * 启用或禁用 Pi 内置扩展：
 * - 禁用时向 `extensions` 写入 `"-builtin:<name>"`；
 * - 启用时移除 `"-builtin:<name>"`（项目级若需覆盖全局禁用则写入 `"+builtin:<name>"`）。
 */
export async function setPiBuiltinExtensionEnabled(
  agentDir: string,
  id: PiBuiltinExtensionId,
  enabled: boolean,
  scope: PiConfigScope = "global",
  projectDir?: string | null,
): Promise<PiBuiltinExtensionState[]> {
  if (!BUILTIN_EXT_SET.has(id)) {
    throw new Error(`Unknown built-in extension: "${id}"`);
  }

  let globalDisabled = false;
  if (scope === "project") {
    const { data: globalObj } = await readPiSettingsObject(piSettingsFilePath(agentDir, "global"), false);
    const globalState = new Map<PiBuiltinExtensionId, boolean>([[id, true]]);
    applyBuiltinTokens(globalState, stringArrayFromSettings(globalObj, "extensions"));
    globalDisabled = !(globalState.get(id) ?? true);
  }

  await mutatePiSettingsObject(agentDir, scope, projectDir, (data) => {
    const current = stringArrayFromSettings(data, "extensions");
    const filtered = current.filter((entry) => {
      const t = entry.trim();
      return t !== id && t !== `+${id}` && t !== `-${id}`;
    });
    if (!enabled) {
      filtered.push(`-${id}`);
    } else if (scope === "project" && globalDisabled) {
      filtered.push(`+${id}`);
    }
    if (filtered.length === 0) {
      deleteNestedValue(data, "extensions");
    } else {
      data["extensions"] = filtered;
    }
    return { write: true, result: undefined };
  });

  return listPiBuiltinExtensions(agentDir, projectDir);
}

/** 列出 `settings.json` 中配置的非内置自定义扩展路径。 */
export async function listPiCustomExtensions(agentDir: string, projectDir?: string | null): Promise<string[]> {
  const [{ data: globalObj }, projectRes] = await Promise.all([
    readPiSettingsObject(piSettingsFilePath(agentDir, "global"), false),
    projectDir && projectDir.trim() !== ""
      ? readPiSettingsObject(piSettingsFilePath(agentDir, "project", projectDir), false)
      : Promise.resolve(null),
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  const collect = (entries: readonly string[]) => {
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (trimmed === "" || isBuiltinExtensionToken(trimmed)) continue;
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
  };
  collect(stringArrayFromSettings(globalObj, "extensions"));
  if (projectRes !== null) collect(stringArrayFromSettings(projectRes.data, "extensions"));
  return out;
}

/** 向 `settings.json` 的 `extensions` 数组添加自定义扩展路径。 */
export async function addPiCustomExtension(
  agentDir: string,
  extensionPath: string,
  scope: PiConfigScope = "global",
  projectDir?: string | null,
): Promise<string[]> {
  const trimmed = extensionPath.trim();
  if (trimmed === "" || hasControlChars(trimmed) || isBuiltinExtensionToken(trimmed)) {
    throw new Error(`Invalid custom extension path: "${extensionPath}"`);
  }
  await mutatePiSettingsObject(agentDir, scope, projectDir, (data) => {
    const current = stringArrayFromSettings(data, "extensions");
    if (current.includes(trimmed)) return { write: false, result: undefined };
    data["extensions"] = [...current, trimmed];
    return { write: true, result: undefined };
  });
  return listPiCustomExtensions(agentDir, projectDir);
}

/** 从 `settings.json` 的 `extensions` 数组移除自定义扩展路径。 */
export async function removePiCustomExtension(
  agentDir: string,
  extensionPath: string,
  scope: PiConfigScope = "global",
  projectDir?: string | null,
): Promise<string[]> {
  const trimmed = extensionPath.trim();
  await mutatePiSettingsObject(agentDir, scope, projectDir, (data, exists) => {
    if (!exists) return { write: false, result: undefined };
    const current = stringArrayFromSettings(data, "extensions");
    const next = current.filter((item) => item.trim() !== trimmed);
    if (next.length === current.length) return { write: false, result: undefined };
    if (next.length === 0) deleteNestedValue(data, "extensions");
    else data["extensions"] = next;
    return { write: true, result: undefined };
  });
  return listPiCustomExtensions(agentDir, projectDir);
}

// ============================================================================
// 3. Skills（`skills/` 目录扫描、frontmatter 解析、`-path` 启停与文件夹增删）
// ============================================================================

export class PiSkillInputError extends Error {
  override name = "SkillInputError";
}

export interface PiSkillPlaces {
  agentDir: string;
  projectDir?: string | null;
  homeDir?: string;
}

function extractFrontmatterAndBody(raw: string): { meta: Record<string, unknown>; body: string } {
  const clean = stripBom(raw);
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(clean);
  if (match === null) return { meta: {}, body: clean };
  const body = clean.slice(match[0].length);
  try {
    const parsed: unknown = parseYaml(match[1] ?? "");
    return { meta: isRecord(parsed) ? parsed : {}, body };
  } catch {
    return { meta: {}, body };
  }
}

interface DiscoveredSkill {
  name: string;
  description: string;
  scope: SkillScope;
  provider: string;
  shared: boolean;
  filePath: string;
  folderPath: string;
  removable: boolean;
}

async function scanSkillRoot(
  rootDir: string,
  scope: SkillScope,
  provider: "pi" | "agents",
  allowDirectMd: boolean,
): Promise<DiscoveredSkill[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    log.warn("failed to read skills root", { rootDir, message: String(error) });
    return [];
  }

  const out: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(rootDir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = await stat(fullPath);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }

    if (isDir) {
      const skillFile = path.join(fullPath, SKILL_FILE);
      let raw: string;
      try {
        raw = await readFile(skillFile, "utf8");
      } catch {
        continue;
      }
      const { meta, body } = extractFrontmatterAndBody(raw);
      const name = str(meta["name"])?.trim() || entry.name;
      const fmDesc = str(meta["description"])?.trim() ?? "";
      const fallbackLine = body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== "" && !line.startsWith("#"));
      const description = fmDesc || fallbackLine || "";
      out.push({
        name,
        description,
        scope,
        provider,
        shared: provider === "agents",
        filePath: skillFile,
        folderPath: fullPath,
        removable: true,
      });
    } else if (allowDirectMd && isFile && entry.name.endsWith(".md")) {
      let raw: string;
      try {
        raw = await readFile(fullPath, "utf8");
      } catch {
        continue;
      }
      const { meta, body } = extractFrontmatterAndBody(raw);
      const defaultName = entry.name.slice(0, -3);
      const name = str(meta["name"])?.trim() || defaultName;
      const fmDesc = str(meta["description"])?.trim() ?? "";
      const fallbackLine = body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== "" && !line.startsWith("#"));
      out.push({
        name,
        description: fmDesc || fallbackLine || "",
        scope,
        provider,
        shared: false,
        filePath: fullPath,
        folderPath: rootDir,
        removable: false,
      });
    }
  }
  return out;
}

function expandLeadingTilde(p: string, homeDir: string): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homeDir, p.slice(2));
  return p;
}

function normalizePatternForCompare(rawPattern: string, homeDir: string): string {
  const expanded = expandLeadingTilde(rawPattern.trim(), homeDir);
  const stripped = expanded.startsWith("./") || expanded.startsWith(".\\") ? expanded.slice(2) : expanded;
  return toPosixPath(stripped).replace(/\/+$/, "");
}

function skillMatchesPattern(skill: DiscoveredSkill, rawPattern: string, baseDir: string, homeDir: string): boolean {
  const norm = normalizePatternForCompare(rawPattern, homeDir);
  if (norm === "") return false;
  const filePosix = toPosixPath(skill.filePath);
  const folderPosix = toPosixPath(skill.folderPath);
  const relFile = toPosixPath(path.relative(baseDir, skill.filePath));
  const relFolder = toPosixPath(path.relative(baseDir, skill.folderPath));
  const folderBase = path.basename(skill.folderPath);
  return (
    norm === skill.name ||
    norm === folderBase ||
    norm === relFolder ||
    norm === relFile ||
    norm === folderPosix ||
    norm === filePosix ||
    norm === `skills/${skill.name}` ||
    norm === `skills/${folderBase}`
  );
}

function isSkillDisabledBySettings(
  skill: DiscoveredSkill,
  globalPatterns: readonly string[],
  globalBaseDir: string,
  projectPatterns: readonly string[],
  projectBaseDir: string | null,
  homeDir: string,
): boolean {
  let enabled = true;
  const apply = (patterns: readonly string[], baseDir: string) => {
    for (const raw of patterns) {
      const trimmed = raw.trim();
      if (trimmed.startsWith("-") || trimmed.startsWith("!")) {
        if (skillMatchesPattern(skill, trimmed.slice(1), baseDir, homeDir)) {
          enabled = false;
        }
      } else if (trimmed.startsWith("+")) {
        if (skillMatchesPattern(skill, trimmed.slice(1), baseDir, homeDir)) {
          enabled = true;
        }
      }
    }
  };
  apply(globalPatterns, globalBaseDir);
  if (projectBaseDir !== null) apply(projectPatterns, projectBaseDir);
  return !enabled;
}

async function discoverAllSkills(
  agentDir: string,
  projectDir?: string | null,
  homeDir: string = os.homedir(),
): Promise<DiscoveredSkill[]> {
  const tasks: Promise<DiscoveredSkill[]>[] = [
    scanSkillRoot(path.join(agentDir, "skills"), "user", "pi", true),
    scanSkillRoot(path.join(homeDir, ".agents", "skills"), "user", "agents", false),
  ];
  if (projectDir && projectDir.trim() !== "") {
    tasks.push(scanSkillRoot(path.join(projectDir, ".pi", "skills"), "project", "pi", true));
    tasks.push(scanSkillRoot(path.join(projectDir, ".agents", "skills"), "project", "agents", false));
  }
  const groups = await Promise.all(tasks);
  return groups.flat();
}

/**
 * 扫描 `<agentDir>/skills`、`<projectDir>/.pi/skills`、`~/.agents/skills`、`<projectDir>/.agents/skills`，
 * 结合 `settings.json` 的 `skills` 数组 `-path` 规则返回兼容 `SkillEntry[]` 的列表。
 */
export async function listPiSkills(
  agentDir: string,
  projectDir?: string | null,
  homeDir: string = os.homedir(),
): Promise<SkillEntry[]> {
  const [discovered, { data: globalObj }, projectRes] = await Promise.all([
    discoverAllSkills(agentDir, projectDir, homeDir),
    readPiSettingsObject(piSettingsFilePath(agentDir, "global"), false),
    projectDir && projectDir.trim() !== ""
      ? readPiSettingsObject(piSettingsFilePath(agentDir, "project", projectDir), false)
      : Promise.resolve(null),
  ]);

  const globalSkills = stringArrayFromSettings(globalObj, "skills");
  const projectSkills = projectRes ? stringArrayFromSettings(projectRes.data, "skills") : [];
  const projectBaseDir = projectDir && projectDir.trim() !== "" ? path.join(projectDir, ".pi") : null;

  const entries: SkillEntry[] = discovered.map((skill) => {
    const disabled = isSkillDisabledBySettings(skill, globalSkills, agentDir, projectSkills, projectBaseDir, homeDir);
    return {
      name: skill.name,
      ...(skill.description !== "" ? { description: skill.description } : {}),
      scope: skill.scope,
      provider: skill.provider,
      plugin: false,
      disabled,
      toggleable: true,
      removable: skill.removable,
      folder: displaySkillPath(skill.folderPath, homeDir),
      shared: skill.shared,
    };
  });

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function canonicalExclusionPath(skill: DiscoveredSkill, baseDir: string): string {
  const targetPath = path.basename(skill.filePath) === SKILL_FILE ? skill.folderPath : skill.filePath;
  if (isInside(targetPath, baseDir)) {
    return toPosixPath(path.relative(baseDir, targetPath));
  }
  return toPosixPath(targetPath);
}

/**
 * 启用或停用指定 Skill（通过更新 `settings.json` `skills` 数组中的 `-path` 规则）。
 * `skillNameOrPath` 可以传 Skill 的 `name`、相对路径（如 `skills/my-skill`）或绝对路径。
 */
export async function setPiSkillEnabled(
  agentDir: string,
  skillNameOrPath: string,
  enabled: boolean,
  options?: { scope?: PiConfigScope; projectDir?: string | null; homeDir?: string },
): Promise<void> {
  const trimmed = skillNameOrPath.trim();
  if (trimmed === "" || trimmed.length > 512 || hasControlChars(trimmed)) {
    throw new PiSkillInputError("skill name or path is invalid");
  }
  const scope = options?.scope ?? "global";
  const projectDir = options?.projectDir ?? null;
  const homeDir = options?.homeDir ?? os.homedir();
  const baseDir = scope === "project" ? path.join(projectDir ?? "", ".pi") : agentDir;

  const discovered = await discoverAllSkills(agentDir, projectDir, homeDir);
  const matched = discovered.filter((skill) => skillMatchesPattern(skill, trimmed, baseDir, homeDir));

  const exclusionTokens =
    matched.length > 0
      ? [...new Set(matched.map((s) => `-${canonicalExclusionPath(s, baseDir)}`))]
      : [`-${trimmed.replace(/^[-+!]/, "")}`];

  await mutatePiSettingsObject(agentDir, scope, projectDir, (data) => {
    const current = stringArrayFromSettings(data, "skills");
    const filtered = current.filter((entry) => {
      const t = entry.trim();
      if (!t.startsWith("-") && !t.startsWith("+") && !t.startsWith("!")) return true;
      const body = t.slice(1);
      if (matched.length > 0) {
        return !matched.some((skill) => skillMatchesPattern(skill, body, baseDir, homeDir));
      }
      return (
        normalizePatternForCompare(body, homeDir) !== normalizePatternForCompare(trimmed.replace(/^[-+!]/, ""), homeDir)
      );
    });

    if (!enabled) {
      for (const token of exclusionTokens) {
        if (!filtered.includes(token)) filtered.push(token);
      }
    }

    if (filtered.length === 0) deleteNestedValue(data, "skills");
    else data["skills"] = filtered;
    return { write: true, result: undefined };
  });
}

/** 校验外部 Skill 源文件夹（必须含 `SKILL.md` 且 frontmatter 具备合法 `name` 与 `description`）。 */
export async function readPiSkillFolder(folder: string): Promise<{ name: string; description: string }> {
  let st;
  try {
    st = await stat(folder);
  } catch {
    throw new PiSkillInputError("not a folder");
  }
  if (!st.isDirectory()) throw new PiSkillInputError("not a folder");

  let text: string;
  try {
    text = await readFile(path.join(folder, SKILL_FILE), "utf8");
  } catch {
    throw new PiSkillInputError(`no ${SKILL_FILE} in the folder`);
  }
  const { meta } = extractFrontmatterAndBody(text);
  const name = typeof meta["name"] === "string" ? meta["name"].trim() : "";
  const description = typeof meta["description"] === "string" ? meta["description"].trim() : "";
  if (name === "") throw new PiSkillInputError(`${SKILL_FILE} frontmatter has no name`);
  if (description === "") throw new PiSkillInputError(`${SKILL_FILE} frontmatter has no description`);
  if (
    FOLDER_UNSAFE.test(name) ||
    hasControlChars(name) ||
    name === "." ||
    name === ".." ||
    /[. ]$/.test(name) ||
    name.length > 100
  ) {
    throw new PiSkillInputError(`skill name "${name}" is not a valid folder name`);
  }
  return { name, description };
}

export function piSkillsTargetRoot(target: SkillTarget, scope: SkillScope, places: PiSkillPlaces): string {
  const homeDir = places.homeDir ?? os.homedir();
  if (scope === "project") {
    if (!places.projectDir || places.projectDir.trim() === "") {
      throw new PiSkillInputError("projectDir is required for project-scoped skills");
    }
    return path.join(places.projectDir, target === "shared" ? ".agents" : ".pi", "skills");
  }
  return target === "shared" ? path.join(homeDir, ".agents", "skills") : path.join(places.agentDir, "skills");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** 将包含 `SKILL.md` 的源文件夹复制到目标 Pi / `.agents` skills 目录。 */
export async function addPiSkillFolder(
  sourceFolder: string,
  target: SkillTarget,
  scope: SkillScope,
  places: PiSkillPlaces,
): Promise<{ name: string; folder: string }> {
  const { name } = await readPiSkillFolder(sourceFolder);
  const root = piSkillsTargetRoot(target, scope, places);
  const dest = path.join(root, name);
  if (await pathExists(dest)) {
    throw new PiSkillInputError(`a skill folder named "${name}" already exists in the target`);
  }
  if (isInside(dest, sourceFolder)) {
    throw new PiSkillInputError("the target is inside the folder being added");
  }
  await mkdir(root, { recursive: true });
  await cp(sourceFolder, dest, { recursive: true, errorOnExist: true, force: false });
  return { name, folder: displaySkillPath(dest, places.homeDir ?? os.homedir()) };
}

/** 删除指定名称与层级的 Skill 文件夹（支持注入回收站回调 `trash`，未传时直接递归移除）。 */
export async function removePiSkillFolder(
  name: string,
  scope: SkillScope,
  places: PiSkillPlaces,
  trash?: (folder: string) => Promise<void>,
): Promise<string> {
  const trimmed = name.trim();
  if (trimmed === "" || hasControlChars(trimmed)) {
    throw new PiSkillInputError("skill name is invalid");
  }
  const homeDir = places.homeDir ?? os.homedir();
  const discovered = await discoverAllSkills(places.agentDir, places.projectDir, homeDir);
  const match = discovered.find((skill) => skill.name === trimmed && skill.scope === scope);
  if (!match) {
    throw new PiSkillInputError(`skill "${trimmed}" not found in ${scope} scope`);
  }
  if (!match.removable) {
    throw new PiSkillInputError(`skill "${trimmed}" cannot be removed as a folder`);
  }
  if (scope === "project" && (!places.projectDir || !isInside(match.folderPath, places.projectDir))) {
    throw new PiSkillInputError(`project skill "${trimmed}" is outside project directory`);
  }
  if (trash) {
    await trash(match.folderPath);
  } else {
    await rm(match.folderPath, { recursive: true, force: false });
  }
  return match.folderPath;
}

/** 兼容 `SkillPicker`（两步校验选择 + token 确认复制）的 Pi Skill 选择器。 */
export class PiSkillPicker {
  #pending: { token: string; folder: string; name: string } | null = null;

  async pick(folder: string): Promise<SkillCandidate> {
    this.#pending = null;
    const { name, description } = await readPiSkillFolder(folder);
    const token = randomUUID();
    this.#pending = { token, folder, name };
    return { token, folderName: path.basename(folder), name, description };
  }

  async add(token: string, target: SkillTarget, places: PiSkillPlaces): Promise<{ name: string; folder: string }> {
    const pending = this.#pending;
    if (pending === null || pending.token !== token) {
      throw new PiSkillInputError("no folder is selected");
    }
    const current = await readPiSkillFolder(pending.folder);
    if (current.name !== pending.name) {
      throw new PiSkillInputError("the skill changed after it was selected");
    }
    const scope: SkillScope = places.projectDir ? "project" : "user";
    const result = await addPiSkillFolder(pending.folder, target, scope, places);
    this.#pending = null;
    return result;
  }
}

// ============================================================================
// 4. Prompt 模板（`<agentDir>/prompts/*.md` & `<projectDir>/.pi/prompts/*.md`）
// ============================================================================

async function scanPromptsDir(dir: string, scope: PiConfigScope): Promise<PiPromptTemplate[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    log.warn("failed to read pi prompts dir", { dir, message: String(error) });
    return [];
  }

  const templates: PiPromptTemplate[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
    const fullPath = path.join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = (await stat(fullPath)).isFile();
      } catch {
        continue;
      }
    }
    if (!isFile) continue;
    let raw: string;
    try {
      raw = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = extractFrontmatterAndBody(raw);
    let description = typeof meta["description"] === "string" ? meta["description"].trim() : "";
    if (description === "") {
      const firstLine = body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== "");
      if (firstLine) {
        description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
      }
    }
    templates.push({
      name: entry.name.slice(0, -3),
      scope,
      description,
      fileName: entry.name,
    });
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name));
}

/** 扫描全局 `<agentDir>/prompts/*.md` 与项目 `<projectDir>/.pi/prompts/*.md` 提示词模板。 */
export async function listPiPromptTemplates(agentDir: string, projectDir?: string | null): Promise<PiPromptTemplate[]> {
  const [globalPrompts, projectPrompts] = await Promise.all([
    scanPromptsDir(path.join(agentDir, "prompts"), "global"),
    projectDir && projectDir.trim() !== ""
      ? scanPromptsDir(path.join(projectDir, ".pi", "prompts"), "project")
      : Promise.resolve([]),
  ]);
  return [...globalPrompts, ...projectPrompts];
}

// ============================================================================
// 5. 系统提示词文档（`AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`）与快捷键（`keybindings.json`）
// ============================================================================

export function piSystemDocPath(
  agentDir: string,
  projectDir: string | null | undefined,
  scope: PiConfigScope,
  kind: PiSystemDocKind,
): string {
  if (!SYSTEM_DOC_SET.has(kind)) {
    throw new Error(`Invalid system doc kind: "${kind}"`);
  }
  if (scope === "project") {
    if (!projectDir || projectDir.trim() === "") {
      throw new Error("projectDir is required when scope is 'project'");
    }
    // Pi 1.5.2 约定：上下文文件 `AGENTS.md` 在项目根目录，`SYSTEM.md` / `APPEND_SYSTEM.md` 在 `.pi/` 下。
    return kind === "AGENTS.md" ? path.join(projectDir, "AGENTS.md") : path.join(projectDir, ".pi", kind);
  }
  return path.join(agentDir, kind);
}

/** 读取全局或项目级 `AGENTS.md` / `SYSTEM.md` / `APPEND_SYSTEM.md`。 */
export async function readPiSystemDoc(
  agentDir: string,
  projectDir: string | null,
  scope: PiConfigScope,
  kind: PiSystemDocKind,
): Promise<PiSystemDoc> {
  const filePath = piSystemDocPath(agentDir, projectDir, scope, kind);
  try {
    const raw = await readFile(filePath, "utf8");
    return { kind, scope, exists: true, content: stripBom(raw) };
  } catch (error) {
    if (isNotFound(error)) return { kind, scope, exists: false, content: "" };
    throw error;
  }
}

/**
 * 保存全局或项目级 `AGENTS.md` / `SYSTEM.md` / `APPEND_SYSTEM.md`。
 * 当用户清空内容（`content.trim() === ""`）时自动移除对应文件，避免空的 `SYSTEM.md` 覆盖掉 Pi 内置系统提示词。
 */
export async function savePiSystemDoc(
  agentDir: string,
  projectDir: string | null,
  scope: PiConfigScope,
  kind: PiSystemDocKind,
  content: string,
): Promise<PiSystemDoc> {
  const filePath = piSystemDocPath(agentDir, projectDir, scope, kind);
  return enqueueFileWrite(filePath, async () => {
    if (content.trim() === "") {
      await unlink(filePath).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
      return { kind, scope, exists: false, content: "" };
    }
    await writeFileAtomic(filePath, content, `pi-studio-${process.pid}`);
    return { kind, scope, exists: true, content };
  });
}

interface PiDefaultKeyAction {
  action: string;
  defaults: readonly string[];
  win32Defaults?: readonly string[];
}

const PI_KEY_ACTIONS: readonly PiDefaultKeyAction[] = [
  { action: "app.thinking.cycle", defaults: ["shift+tab"] },
  { action: "app.thinking.toggle", defaults: ["ctrl+t"] },
  { action: "app.model.cycleForward", defaults: ["ctrl+p"] },
  {
    action: "app.model.cycleBackward",
    defaults: ["shift+ctrl+p"],
    win32Defaults: ["shift+ctrl+p", "alt+p"],
  },
  { action: "app.model.select", defaults: ["ctrl+l"] },
  { action: "app.tools.expand", defaults: ["ctrl+o"] },
  { action: "app.editor.external", defaults: ["ctrl+g"] },
  {
    action: "app.message.followUp",
    defaults: ["alt+enter"],
    win32Defaults: ["alt+enter", "ctrl+q"],
  },
  {
    action: "app.message.dequeue",
    defaults: ["alt+up"],
    win32Defaults: ["alt+up", "alt+q"],
  },
];

function isForwardableChord(chord: string): boolean {
  const parts = chord.split("+");
  if (parts.includes("ctrl") || parts.includes("alt")) return true;
  return chord === "shift+tab" || /^f\d{1,2}$/.test(parts[parts.length - 1]!);
}

function validKeyList(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return null;
}

/** 将用户 `keybindings.json` 对象与 Pi 1.5.2 默认键位合并，过滤出可转发给 Pi 且不与 Studio 冲突的快捷键。 */
export function resolvePiKeybindings(user: unknown, platform: NodeJS.Platform = process.platform): OmpKeybinding[] {
  const record = isRecord(user) ? user : {};
  const handled = new Set<string>();
  const out: OmpKeybinding[] = [];

  const emitAction = (action: string, rawKeys: readonly string[]) => {
    const chords = [
      ...new Set(
        rawKeys.flatMap((key) => {
          const chord = chordFromKbd([key]);
          return chord !== null && isForwardableChord(chord) && !STUDIO_RESERVED.has(chord) ? [chord] : [];
        }),
      ),
    ];
    if (chords.length > 0) out.push({ action, chords });
  };

  for (const def of PI_KEY_ACTIONS) {
    handled.add(def.action);
    const platformDefaults = platform === "win32" && def.win32Defaults ? def.win32Defaults : def.defaults;
    const keys = validKeyList(record[def.action]) ?? platformDefaults;
    emitAction(def.action, keys);
  }

  // 同时支持用户在 keybindings.json 中为无默认快捷键的 `app.*` 动作（如 `app.session.new`）绑定的键
  for (const [action, rawVal] of Object.entries(record)) {
    if (handled.has(action) || !action.startsWith("app.")) continue;
    const keys = validKeyList(rawVal);
    if (keys !== null) emitAction(action, keys);
  }

  return out;
}

/** 读取 `<agentDir>/keybindings.json` 并合并 Pi 1.5.2 默认快捷键。 */
export async function readPiKeybindings(
  agentDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<OmpKeybinding[]> {
  const filePath = path.join(agentDir, "keybindings.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return resolvePiKeybindings(null, platform);
    log.warn("failed to read pi keybindings.json", { filePath, message: String(error) });
    return resolvePiKeybindings(null, platform);
  }
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(stripBom(raw)));
    return resolvePiKeybindings(parsed, platform);
  } catch (error) {
    log.warn("failed to parse pi keybindings.json", { filePath, message: String(error) });
    return resolvePiKeybindings(null, platform);
  }
}

// ============================================================================
// 6. Pi 扩展包（`settings.json` `packages` 列表 + CLI `pi install` / `remove` / `update`）
// ============================================================================

export function classifyPiPackageKind(source: string): "npm" | "git" | "local" {
  const trimmed = source.trim();
  if (trimmed.startsWith("npm:")) return "npm";
  if (
    trimmed.startsWith("git:") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("git@")
  ) {
    return "git";
  }
  return "local";
}

function parsePackagesArray(raw: unknown, scope: PiConfigScope): PiPackageItem[] {
  if (!Array.isArray(raw)) return [];
  const items: PiPackageItem[] = [];
  for (const entry of raw as unknown[]) {
    let source: string | null = null;
    if (typeof entry === "string") {
      source = entry.trim();
    } else if (isRecord(entry) && typeof entry["source"] === "string") {
      source = entry["source"].trim();
    }
    if (source !== null && source !== "") {
      items.push({
        source,
        scope,
        kind: classifyPiPackageKind(source),
      });
    }
  }
  return items;
}

/** 从全局与可选项目 `settings.json` 解析 `packages` 声明列表（同时支持字符串与 `{ source }` 对象）。 */
export async function listPiPackages(agentDir: string, projectDir?: string | null): Promise<PiPackageItem[]> {
  const [{ data: globalObj }, projectRes] = await Promise.all([
    readPiSettingsObject(piSettingsFilePath(agentDir, "global"), false),
    projectDir && projectDir.trim() !== ""
      ? readPiSettingsObject(piSettingsFilePath(agentDir, "project", projectDir), false)
      : Promise.resolve(null),
  ]);

  const out = parsePackagesArray(globalObj["packages"], "global");
  if (projectRes !== null) {
    out.push(...parsePackagesArray(projectRes.data["packages"], "project"));
  }
  return out;
}

export type PiCliLaunch =
  | string
  | {
      command: string;
      args?: readonly string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      agentDir?: string;
      timeoutMs?: number;
    };

export interface PiPackageCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 构造 `pi install` / `pi remove` / `pi update` 的安全参数数组（防止 `-` 选项注入）。 */
export function buildPiPackageCommandArgs(
  op: "install" | "remove" | "update",
  source: string | null,
  scope: PiConfigScope,
): string[] {
  const trimmedSource = source !== null ? source.trim() : null;
  if (trimmedSource !== null && trimmedSource !== "") {
    if (trimmedSource.startsWith("-") || hasControlChars(trimmedSource)) {
      throw new Error(`Invalid package source: "${source}"`);
    }
  }

  if (op === "install" || op === "remove") {
    if (!trimmedSource) {
      throw new Error(`Package source is required for "pi ${op}"`);
    }
    return [op, trimmedSource, ...(scope === "project" ? ["-l", "--approve"] : [])];
  }

  // `pi update` 无目标参数时会自更新 Pi 本体；更新全部已安装包需传 `--extensions`。
  if (trimmedSource) {
    return ["update", trimmedSource, ...(scope === "project" ? ["--approve"] : [])];
  }
  return ["update", "--extensions", ...(scope === "project" ? ["--approve"] : [])];
}

/**
 * 调用 Pi CLI 执行包管理操作（`install` / `remove` / `update`），严格不经过 shell，参数以数组传递。
 */
export async function runPiPackageCommand(
  launch: PiCliLaunch,
  op: "install" | "remove" | "update",
  source: string | null,
  scope: PiConfigScope,
  projectDir: string | null,
): Promise<PiPackageCommandResult> {
  if (scope === "project" && (!projectDir || projectDir.trim() === "")) {
    throw new Error("projectDir is required when running a project-scoped package command");
  }
  const pkgArgs = buildPiPackageCommandArgs(op, source, scope);
  const normalized = typeof launch === "string" ? { command: launch } : launch;
  const fullArgs = [...(normalized.args ?? []), ...pkgArgs];
  const cwd =
    scope === "project"
      ? projectDir!
      : (normalized.cwd ?? (projectDir && projectDir.trim() !== "" ? projectDir : os.tmpdir()));
  const env: NodeJS.ProcessEnv = {
    ...(normalized.env ?? process.env),
    ...(normalized.agentDir ? { PI_CODING_AGENT_DIR: normalized.agentDir } : {}),
  };
  const timeoutMs = normalized.timeoutMs ?? 120_000;

  return new Promise<PiPackageCommandResult>((resolve, reject) => {
    const child = spawn(normalized.command, fullArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`pi ${op} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
        reject(new Error(`pi ${op} failed (${exitCode}): ${detail}`));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/** 聚合读取 Pi 资源面板快照（`PiResourcesSnapshot`）。 */
export async function readPiResourcesSnapshot(
  agentDir: string,
  projectDir?: string | null,
): Promise<PiResourcesSnapshot> {
  const [packages, builtinExtensions, customExtensions, mcpServers, prompts, globalSettings, projectSettings] =
    await Promise.all([
      listPiPackages(agentDir, projectDir),
      listPiBuiltinExtensions(agentDir, projectDir),
      listPiCustomExtensions(agentDir, projectDir),
      listPiMcpServers(agentDir, projectDir),
      listPiPromptTemplates(agentDir, projectDir),
      readPiSettingsObject(piSettingsFilePath(agentDir, "global"), false),
      projectDir && projectDir.trim() !== ""
        ? readPiSettingsObject(piSettingsFilePath(agentDir, "project", projectDir), false)
        : Promise.resolve(null),
    ]);

  const rawSkillCmds = projectSettings?.data["enableSkillCommands"] ?? globalSettings.data["enableSkillCommands"];
  const enableSkillCommands = typeof rawSkillCmds === "boolean" ? rawSkillCmds : true;

  return {
    packages,
    builtinExtensions,
    customExtensions,
    mcpServers,
    prompts,
    enableSkillCommands,
  };
}
