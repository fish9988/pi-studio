// 自定义模型与 Provider 的 IPC：读写 Pi 的 `~/.pi/agent/models.json`、一键拉取模型列表与能力补全。
// key 只进不出；日志只记 provider id 和结果，不记 key、不记 URL 里的查询串。
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { net, shell } from "electron";
import {
  isValidEnvName,
  limits,
  type CustomKeyInput,
  type CustomModelMeta,
  type CustomProviderInput,
  type FetchModelsOutcome,
  type ProviderOverrideInput,
} from "../../shared/custom-models.ts";
import type { HandlerGroup } from "../../shared/ipc.ts";
import { resolveAgentDir } from "../history/session-index.ts";
import { log } from "../log/log.ts";
import { envFilePath, envSourceOf, envValues, readEnvText } from "../omp-config/env-file.ts";
import { fetchModelList, resolveKeyToken } from "../omp-config/fetch-models.ts";
import { lookupCapabilities } from "../omp-config/model-catalog.ts";
import {
  deletePiCustomProvider,
  readPiModelsFile,
  readPiProviderKey,
  savePiCustomProvider,
  savePiProviderOverride,
} from "../pi-config/auth-and-models.ts";
import { reloadServiceModels } from "../service/default-model.ts";
import { IpcValidationError, parseBoolean, parseInteger, parseOneOf, parseRecord, parseString } from "./validate.ts";

function parseKey(value: unknown): CustomKeyInput {
  const record = parseRecord(value, "key");
  const kind = parseOneOf(record["kind"], "key.kind", ["keep", "none", "literal", "env"] as const);
  if (kind === "literal") return { kind, value: parseString(record["value"], "key.value", 4096, { allowEmpty: true }) };
  if (kind === "env") {
    const name = parseString(record["name"], "key.name", 128, { allowEmpty: true });
    const keyValue = record["value"];
    if (keyValue === undefined) return { kind, name };
    return { kind, name, value: parseString(keyValue, "key.value", 4096, { allowEmpty: true }) };
  }
  return { kind };
}

function nullable<T>(value: unknown, name: string, parse: (value: unknown, name: string) => T): T | null {
  return value === null ? null : parse(value, name);
}

function parseOverrideKey(value: unknown): ProviderOverrideInput["key"] {
  if (value === null) return null;
  const key = parseKey(value);
  if (key.kind !== "none") return key;
  throw new IpcValidationError("key.kind must be keep, literal or env");
}

function parseModels(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 1000) throw new IpcValidationError("models 必须是数组");
  return (value as unknown[]).map((item) => parseRecord(item, "model"));
}

function parseMeta(model: Record<string, unknown>): CustomModelMeta {
  return {
    reasoning: nullable(model["reasoning"], "model.reasoning", parseBoolean),
    images: nullable(model["images"], "model.images", parseBoolean),
    contextWindow: nullable(model["contextWindow"], "model.contextWindow", parseTokens),
    maxTokens: nullable(model["maxTokens"], "model.maxTokens", parseTokens),
  };
}

function parseTokens(value: unknown, name: string): number {
  return parseInteger(value, name, 1, limits.tokens);
}

function parseInput(value: unknown): CustomProviderInput {
  const record = parseRecord(value, "input");
  return {
    id: parseString(record["id"], "id", 200, { allowEmpty: true }),
    baseUrl: parseString(record["baseUrl"], "baseUrl", 4096, { allowEmpty: true }),
    api: parseString(record["api"], "api", 100, { allowEmpty: true }),
    key: parseKey(record["key"]),
    models: parseModels(record["models"]).map((model) => {
      const name = model["name"];
      const image = model["image"];
      return {
        id: parseString(model["id"], "model.id", 1000, { allowEmpty: true }),
        ...(name !== undefined && { name: parseString(name, "model.name", 1000, { allowEmpty: true }) }),
        ...parseMeta(model),
        ...(image !== undefined && { image: parseBoolean(image, "model.image") }),
      };
    }),
    ...(record["discovery"] !== undefined && { discovery: parseBoolean(record["discovery"], "discovery") }),
  };
}

function parseOverrideInput(value: unknown): ProviderOverrideInput {
  const record = parseRecord(value, "input");
  return {
    key: parseOverrideKey(record["key"]),
    models: parseModels(record["models"]).map((model) => ({
      id: parseString(model["id"], "model.id", 1000, { allowEmpty: true }),
      ...parseMeta(model),
    })),
  };
}

async function fetchProviderModels(value: unknown): Promise<FetchModelsOutcome> {
  const record = parseRecord(value, "request");
  const baseUrl = parseString(record["baseUrl"], "baseUrl", 4096, { allowEmpty: true });
  const api = parseString(record["api"], "api", 100, { allowEmpty: true });
  const key = parseKey(record["key"]);
  const providerId = record["providerId"] === undefined ? null : parseString(record["providerId"], "providerId", 200);

  let raw: string | null = null;
  if (key.kind === "literal") raw = key.value.trim() === "" || /\p{Cc}/u.test(key.value) ? null : key.value;
  else if (key.kind === "env" && key.value !== undefined && key.value !== "")
    raw = /\p{Cc}/u.test(key.value) ? null : key.value;
  else if (key.kind === "env") raw = key.name;
  else if (key.kind === "keep" && providerId !== null) raw = await readPiProviderKey(resolveAgentDir(), providerId);
  if ((key.kind === "literal" || key.kind === "env") && raw === null) return { ok: false, code: "invalid-key" };

  let token: string | null = null;
  if (raw !== null) {
    const fromProcess = Object.entries(process.env).filter(([, v]) => v !== undefined && v !== "");
    const env = { ...envValues(await readEnvText(resolveAgentDir())), ...Object.fromEntries(fromProcess) };
    token = resolveKeyToken(raw, env);
    if (token === null) return { ok: false, code: "command-key" };
  }
  const outcome = await fetchModelList((url, init) => net.fetch(url, init), { baseUrl, api, token });
  log.info(
    `custom provider ${providerId ?? "(new)"}: fetch models ${outcome.ok ? `ok (${outcome.models.length})` : outcome.code}`,
  );
  return outcome;
}

export const customModelHandlers: HandlerGroup<
  | "listCustomProviders"
  | "saveCustomProvider"
  | "deleteCustomProvider"
  | "saveProviderOverride"
  | "fetchProviderModels"
  | "lookupModelCapabilities"
  | "refreshModels"
  | "openModelsFile"
  | "openEnvFile"
  | "envKeySource"
> = {
  listCustomProviders: () => readPiModelsFile(resolveAgentDir()),
  saveCustomProvider: async (mode, input) => {
    const outcome = await savePiCustomProvider(
      resolveAgentDir(),
      parseInput(input),
      parseOneOf(mode, "mode", ["add", "edit"] as const),
    );
    log.info(`custom provider ${mode}: ${outcome.ok ? "saved" : outcome.code}`);
    if (outcome.ok) await reloadServiceModels();
    return outcome;
  },
  deleteCustomProvider: async (providerId) => {
    const outcome = await deletePiCustomProvider(resolveAgentDir(), parseString(providerId, "providerId", 200));
    log.info(`custom provider delete: ${outcome.ok ? "deleted" : outcome.code}`);
    if (outcome.ok) await reloadServiceModels();
    return outcome;
  },
  saveProviderOverride: async (providerId, input) => {
    const parsed = parseOverrideInput(input);
    const outcome = await savePiProviderOverride(resolveAgentDir(), parseString(providerId, "providerId", 200), parsed);
    log.info(
      `custom provider override: key ${parsed.key?.kind ?? "clear"}, ${parsed.models.length} model(s): ${outcome.ok ? "saved" : outcome.code}`,
    );
    if (outcome.ok) await reloadServiceModels();
    return outcome;
  },
  fetchProviderModels,
  lookupModelCapabilities: async (ids) => {
    if (!Array.isArray(ids) || ids.length > 3000) throw new IpcValidationError("ids 必须是数组");
    const parsed = (ids as unknown[]).map((id) => parseString(id, "id", limits.modelId));
    return lookupCapabilities((url, init) => net.fetch(url, init), parsed);
  },
  refreshModels: async () => {
    await reloadServiceModels();
  },
  openModelsFile: async () => {
    const agentDir = resolveAgentDir();
    await mkdir(agentDir, { recursive: true });
    const info = await readPiModelsFile(agentDir);
    await openInShell(info.exists ? info.path : path.dirname(info.path));
  },
  openEnvFile: async () => {
    const agentDir = resolveAgentDir();
    await mkdir(agentDir, { recursive: true });
    const file = envFilePath(agentDir);
    await openInShell(existsSync(file) ? file : path.dirname(file));
  },
  envKeySource: async (name) => {
    const parsed = parseString(name, "name", limits.envName, { allowEmpty: true });
    if (!isValidEnvName(parsed)) return "missing";
    return envSourceOf(await readEnvText(resolveAgentDir()))(parsed);
  },
};

async function openInShell(target: string): Promise<void> {
  if (!existsSync(target)) throw new Error("the pi agent directory does not exist yet");
  const failure = await shell.openPath(target);
  if (failure !== "") throw new Error(failure);
}
