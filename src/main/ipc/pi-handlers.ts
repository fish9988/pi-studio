// Pi 1.5+ 专属配置、凭据、MCP、内置/自定义扩展、包管理与系统提示词文档 IPC handlers。
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { shell } from "electron";
import type { HandlerGroup, ProjectId } from "../../shared/ipc.ts";
import {
  PI_BUILTIN_EXTENSIONS,
  PI_MCP_EXPOSURES,
  PI_SYSTEM_DOC_KINDS,
  type PiConfigFileKind,
  type PiConfigScope,
  type PiMcpServerSaveInput,
} from "../../shared/pi-config-types.ts";
import { mergeNpmSearchWithCurated } from "../../shared/pi-plugin-catalog.ts";
import { resolveAgentDir } from "../history/session-index.ts";
import {
  deleteNestedValue,
  deletePiMcpServer,
  listPiProviderStatuses,
  mutatePiSettingsObject,
  readPiResourcesSnapshot,
  readPiSystemDoc,
  runPiPackageCommand,
  savePiMcpServer,
  savePiSystemDoc,
  setPiBuiltinExtensionEnabled,
  setPiMcpServerEnabled,
} from "../pi-config/index.ts";
import { readyPiLaunch } from "../pi/runtime-singleton.ts";
import { listModelOptions, reloadServiceModels } from "../service/default-model.ts";
import { startupCache } from "../service/startup-cache-instance.ts";
import { getTaskPool } from "../tasks/runtime.ts";
import { emitEvent } from "./events.ts";
import {
  IpcValidationError,
  parseBoolean,
  parseInteger,
  parseOneOf,
  parseProjectId,
  parseRecord,
  parseString,
} from "./validate.ts";

const SCOPES = ["global", "project"] as const;
const CONFIG_FILES: readonly PiConfigFileKind[] = [
  "settings.json",
  "models.json",
  "mcp.json",
  "keybindings.json",
  "auth.json",
];

async function resolveOptionalProjectDir(projectId: unknown, scope?: PiConfigScope): Promise<string | null> {
  if (projectId === null || projectId === undefined) {
    if (scope === "project") {
      throw new IpcValidationError("projectId is required when scope is 'project'");
    }
    return null;
  }
  const id: ProjectId = parseProjectId(projectId);
  return (await getTaskPool()).projectPath(id);
}

function parseOptionalStringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = parseRecord(value, label);
  const entries = Object.entries(record);
  if (entries.length > 128) throw new IpcValidationError(`${label} has too many entries`);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = parseString(k, `${label}.key`, 256);
    out[key] = parseString(v, `${label}.${key}`, 8192, { allowEmpty: true });
  }
  return out;
}

function parseMcpSaveInput(value: unknown): PiMcpServerSaveInput {
  const raw = parseRecord(value, "input");
  const scope = parseOneOf(raw["scope"], "input.scope", SCOPES);
  const projectId =
    raw["projectId"] === null || raw["projectId"] === undefined ? null : parseProjectId(raw["projectId"]);
  if (scope === "project" && projectId === null) {
    throw new IpcValidationError("projectId is required for project MCP server");
  }
  const transport = parseOneOf(raw["transport"], "input.transport", ["stdio", "http"] as const);
  const name = parseString(raw["name"], "input.name", 128);
  const previousName =
    raw["previousName"] === undefined
      ? undefined
      : parseString(raw["previousName"], "input.previousName", 128, { allowEmpty: true });
  const command =
    raw["command"] === undefined ? undefined : parseString(raw["command"], "input.command", 4096, { allowEmpty: true });
  const url = raw["url"] === undefined ? undefined : parseString(raw["url"], "input.url", 4096, { allowEmpty: true });
  const cwd = raw["cwd"] === undefined ? undefined : parseString(raw["cwd"], "input.cwd", 4096, { allowEmpty: true });
  const description =
    raw["description"] === undefined
      ? undefined
      : parseString(raw["description"], "input.description", 1024, { allowEmpty: true });

  let args: string[] | undefined;
  if (raw["args"] !== undefined) {
    if (!Array.isArray(raw["args"]) || raw["args"].length > 128) {
      throw new IpcValidationError("input.args must be an array of at most 128 strings");
    }
    args = (raw["args"] as unknown[]).map((item) => parseString(item, "input.args[]", 4096, { allowEmpty: true }));
  }

  const env = parseOptionalStringMap(raw["env"], "input.env");
  const headers = parseOptionalStringMap(raw["headers"], "input.headers");
  const clearEnv = raw["clearEnv"] === undefined ? undefined : parseBoolean(raw["clearEnv"], "input.clearEnv");
  const clearHeaders =
    raw["clearHeaders"] === undefined ? undefined : parseBoolean(raw["clearHeaders"], "input.clearHeaders");
  const enabled = parseBoolean(raw["enabled"], "input.enabled");
  const exposure = parseOneOf(raw["exposure"], "input.exposure", PI_MCP_EXPOSURES);
  const timeout =
    raw["timeout"] === undefined ? undefined : parseInteger(raw["timeout"], "input.timeout", 1, 3_600_000);

  return {
    scope,
    projectId,
    name,
    transport,
    enabled,
    exposure,
    ...(previousName !== undefined ? { previousName } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(clearEnv !== undefined ? { clearEnv } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(clearHeaders !== undefined ? { clearHeaders } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function isBuiltinExtensionToken(entry: string): boolean {
  const trimmed = entry.trim();
  const bare = trimmed.startsWith("+") || trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;
  return bare.startsWith("builtin:");
}

export const piHandlers: HandlerGroup<
  | "listPiProviderStatuses"
  | "getPiResources"
  | "savePiMcpServer"
  | "deletePiMcpServer"
  | "setPiMcpServerEnabled"
  | "setPiBuiltinExtensionEnabled"
  | "setPiCustomExtensions"
  | "runPiPackageAction"
  | "getPiSystemDoc"
  | "savePiSystemDoc"
  | "openPiConfigFile"
  | "searchPiPlugins"
> = {
  listPiProviderStatuses: async () => {
    const models = await listModelOptions(false).catch(() => startupCache().models());
    return listPiProviderStatuses(
      resolveAgentDir(),
      models.map((m) => ({ provider: m.key.provider })),
    );
  },

  getPiResources: async (projectId) => {
    const projectDir = await resolveOptionalProjectDir(projectId);
    return readPiResourcesSnapshot(resolveAgentDir(), projectDir);
  },

  savePiMcpServer: async (input) => {
    const parsed = parseMcpSaveInput(input);
    const projectDir = await resolveOptionalProjectDir(parsed.projectId, parsed.scope);
    await savePiMcpServer(resolveAgentDir(), projectDir, parsed);
  },

  deletePiMcpServer: async (scope, name, projectId) => {
    const parsedScope = parseOneOf(scope, "scope", SCOPES);
    const parsedName = parseString(name, "name", 128);
    const projectDir = await resolveOptionalProjectDir(projectId, parsedScope);
    await deletePiMcpServer(resolveAgentDir(), projectDir, parsedScope, parsedName);
  },

  setPiMcpServerEnabled: async (scope, name, enabled, projectId) => {
    const parsedScope = parseOneOf(scope, "scope", SCOPES);
    const parsedName = parseString(name, "name", 128);
    const parsedEnabled = parseBoolean(enabled, "enabled");
    const projectDir = await resolveOptionalProjectDir(projectId, parsedScope);
    await setPiMcpServerEnabled(resolveAgentDir(), projectDir, parsedScope, parsedName, parsedEnabled);
  },

  setPiBuiltinExtensionEnabled: async (id, enabled) => {
    const parsedId = parseOneOf(id, "id", PI_BUILTIN_EXTENSIONS);
    const parsedEnabled = parseBoolean(enabled, "enabled");
    await setPiBuiltinExtensionEnabled(resolveAgentDir(), parsedId, parsedEnabled, "global", null);
    await reloadServiceModels();
    emitEvent("ompConfigChanged", { key: "extensions" });
  },

  setPiCustomExtensions: async (paths) => {
    if (!Array.isArray(paths) || paths.length > 256) {
      throw new IpcValidationError("paths must be an array of at most 256 strings");
    }
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of paths as unknown[]) {
      const item = parseString(raw, "paths[]", 2048).trim();
      if (item === "" || isBuiltinExtensionToken(item)) continue;
      if (!seen.has(item)) {
        seen.add(item);
        cleaned.push(item);
      }
    }
    await mutatePiSettingsObject(resolveAgentDir(), "global", null, (data) => {
      const existing = Array.isArray(data["extensions"])
        ? (data["extensions"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const builtinTokens = existing.filter((x) => isBuiltinExtensionToken(x));
      const merged = [...builtinTokens, ...cleaned];
      if (merged.length === 0) deleteNestedValue(data, "extensions");
      else data["extensions"] = merged;
      return { write: true, result: undefined };
    });
    await reloadServiceModels();
    emitEvent("ompConfigChanged", { key: "extensions" });
  },

  runPiPackageAction: async (op, source, scope, projectId) => {
    const parsedOp = parseOneOf(op, "op", ["install", "remove", "update"] as const);
    const parsedScope = parseOneOf(scope, "scope", SCOPES);
    const parsedSource =
      source === null || source === undefined ? null : parseString(source, "source", 1024, { allowEmpty: true });
    const projectDir = await resolveOptionalProjectDir(projectId, parsedScope);
    const launch = await readyPiLaunch();
    const res = await runPiPackageCommand(
      {
        command: launch.command,
        args: launch.prefixArgs,
        env: { ...process.env, ...launch.env },
        agentDir: resolveAgentDir(),
      },
      parsedOp,
      parsedSource,
      parsedScope,
      projectDir,
    );
    await reloadServiceModels();
    emitEvent("ompConfigChanged", { key: "packages" });
    return { output: `${res.stdout}\n${res.stderr}`.trim() };
  },

  getPiSystemDoc: async (scope, kind, projectId) => {
    const parsedScope = parseOneOf(scope, "scope", SCOPES);
    const parsedKind = parseOneOf(kind, "kind", PI_SYSTEM_DOC_KINDS);
    const projectDir = await resolveOptionalProjectDir(projectId, parsedScope);
    return readPiSystemDoc(resolveAgentDir(), projectDir, parsedScope, parsedKind);
  },

  savePiSystemDoc: async (scope, kind, content, projectId) => {
    const parsedScope = parseOneOf(scope, "scope", SCOPES);
    const parsedKind = parseOneOf(kind, "kind", PI_SYSTEM_DOC_KINDS);
    const parsedContent = parseString(content, "content", 512 * 1024, { allowEmpty: true });
    const projectDir = await resolveOptionalProjectDir(projectId, parsedScope);
    await savePiSystemDoc(resolveAgentDir(), projectDir, parsedScope, parsedKind, parsedContent);
  },

  openPiConfigFile: async (kind) => {
    const parsedKind = parseOneOf(kind, "kind", CONFIG_FILES);
    const agentDir = resolveAgentDir();
    await mkdir(agentDir, { recursive: true });
    const filePath = path.join(agentDir, parsedKind);
    const target = existsSync(filePath) ? filePath : agentDir;
    const failure = await shell.openPath(target);
    if (failure !== "") throw new Error(failure);
  },

  searchPiPlugins: async (query) => {
    const q = query === undefined || query === null ? "" : parseString(query, "query", 200, { allowEmpty: true });
    const searchText = ["keywords:pi-package", q.trim()].filter(Boolean).join(" ");
    const params = new URLSearchParams({ text: searchText, size: "48" });
    const url = `https://registry.npmjs.org/-/v1/search?${params.toString()}`;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) return mergeNpmSearchWithCurated(null, q);
      const json: unknown = await response.json();
      return mergeNpmSearchWithCurated(json, q);
    } catch {
      return mergeNpmSearchWithCurated(null, q);
    }
  },
};
