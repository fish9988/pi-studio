// Pi 凭据管理（`<agentDir>/auth.json` + `.env` / 系统环境变量）与自定义模型配置（`<agentDir>/models.json`）。
// 安全准则：严禁在返回值或日志中暴露任何明文 API Key、OAuth access/refresh token；`auth.json` 统一按 `0o600` 权限原子落盘。
import { chmod, copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultDiscoveryType,
  imageModelField,
  isKnownApi,
  isValidEnvName,
  isValidLiteralKey,
  isValidModelId,
  isValidModelName,
  isValidProviderId,
  isValidTokenCount,
  limits,
  normalizeBaseUrl,
  unusedEnvName,
  type CustomKeyState,
  type CustomModelMeta,
  type CustomModelsErrorCode,
  type CustomModelsFileInfo,
  type CustomModelsOutcome,
  type CustomProviderInfo,
  type CustomProviderInput,
  type EnvSource,
  type ProviderOverrideInput,
} from "../../shared/custom-models.ts";
import type { LoginProvider, LogoutAccount } from "../../shared/omp-wire/rpc-wire.generated.ts";
import type { PiProviderAuthStatus } from "../../shared/pi-config-types.ts";
import { findPiBuiltinProvider, PI_BUILTIN_PROVIDERS } from "../../shared/pi-settings-schema.ts";
import { keyEnvProviderIds, providerKeyEnv, type ProviderKeyEnv } from "../../shared/provider-keys.ts";
import { stripBom } from "../../shared/strip-bom.ts";
import { isRecord, nonEmptyString as str } from "../../shared/type-guards.ts";
import { log } from "../log/log.ts";
import { envFilePath, envSourceOf, readEnvText, removeEnvLine, setEnvLine } from "../omp-config/env-file.ts";
import { renameWithRetry, writeFileAtomic } from "../tasks/atomic-write.ts";
import { enqueueFileWrite } from "./settings-file.ts";

const ENV_LIKE_KEY = /^[A-Z][A-Z0-9_]*$/;
const DOLLAR_ENV_RE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;

let secretTmpSeq = 0;

/** 剥除 JSONC 中的 `//` 行注释与 `/* ... * /` 块注释（保留字符串字面量原样）。 */
export function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n" && input[i] !== "\r") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** 以 `0o600` 权限写临时文件后经 `renameWithRetry` 原子覆盖目标凭据文件。 */
async function writeSecretFileAtomic(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${targetPath}.pi-studio-${process.pid}-${++secretTmpSeq}.tmp`;
  try {
    await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(tmpPath, 0o600).catch(() => undefined);
    await renameWithRetry(tmpPath, targetPath);
    await chmod(targetPath, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

// ============================================================================
// 第一部分：凭据存储（`<agentDir>/auth.json` + `.env` / 进程环境变量检测）
// ============================================================================

export function piAuthFilePath(agentDir: string): string {
  return path.join(agentDir, "auth.json");
}

interface ParsedAuthEntry {
  authType: "oauth" | "api_key";
  accountHint: string | null;
  detail: string;
}

function parseAuthCredential(raw: unknown): ParsedAuthEntry | null {
  if (!isRecord(raw)) return null;
  const type = raw["type"];
  if (type === "oauth") {
    const hasToken = str(raw["access"]) !== null || str(raw["refresh"]) !== null;
    if (!hasToken) return null;
    const hint = str(raw["email"]) ?? str(raw["accountId"]) ?? str(raw["projectId"]) ?? null;
    const enterpriseUrl = str(raw["enterpriseUrl"]);
    const expires = typeof raw["expires"] === "number" && Number.isFinite(raw["expires"]) ? raw["expires"] : null;
    const expiredTag = expires !== null && expires <= Date.now() ? "OAuth (refreshable)" : "OAuth";
    return {
      authType: "oauth",
      accountHint: hint,
      detail: enterpriseUrl ? `${expiredTag} · ${enterpriseUrl}` : expiredTag,
    };
  }
  if (type === "api_key") {
    const key = str(raw["key"]);
    const hasEnvMap = isRecord(raw["env"]) && Object.keys(raw["env"]).length > 0;
    if (key === null && !hasEnvMap) return null;
    const isCommand = key !== null && key.startsWith("!");
    return {
      authType: "api_key",
      accountHint: isCommand ? "command" : null,
      detail: isCommand ? "Command (!)" : "API Key",
    };
  }
  return null;
}

async function readAuthObject(
  agentDir: string,
  strict = false,
): Promise<{ exists: boolean; data: Record<string, unknown> }> {
  const file = piAuthFilePath(agentDir);
  const raw = await readIfExists(file);
  if (raw === null) return { exists: false, data: {} };
  const trimmed = stripJsonComments(stripBom(raw)).trim();
  if (trimmed === "") return { exists: true, data: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (strict) {
      throw new Error(`Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    log.warn("invalid JSON in pi auth.json", { file, message: String(error) });
    return { exists: true, data: {} };
  }
  if (!isRecord(parsed)) {
    if (strict) throw new Error(`Expected JSON object root in ${file}`);
    log.warn("pi auth.json root is not an object", { file });
    return { exists: true, data: {} };
  }
  return { exists: true, data: { ...parsed } };
}

function findActiveEnvVar(envVars: readonly string[], sourceOf: (name: string) => EnvSource): string | null {
  for (const name of envVars) {
    if (sourceOf(name) !== "missing") return name;
  }
  return null;
}

/**
 * 列出 Pi 所有内置提供商（及 `auth.json` 中额外登录的提供商）的认证状态与模型计数。
 * 绝不返回明文密钥或 OAuth token。
 */
export async function listPiProviderStatuses(
  agentDir: string,
  availableModels?: readonly { provider: string }[],
): Promise<PiProviderAuthStatus[]> {
  const [{ data: authObj }, envText] = await Promise.all([readAuthObject(agentDir, false), readEnvText(agentDir)]);
  const sourceOf = envSourceOf(envText);

  const modelCounts = new Map<string, number>();
  for (const model of availableModels ?? []) {
    if (typeof model.provider === "string" && model.provider !== "") {
      modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
    }
  }

  const seenIds = new Set<string>();
  const statuses: PiProviderAuthStatus[] = [];

  for (const meta of PI_BUILTIN_PROVIDERS) {
    seenIds.add(meta.id);
    const cred = parseAuthCredential(authObj[meta.id]);
    statuses.push({
      id: meta.id,
      name: meta.name,
      supportsOAuth: meta.supportsOAuth,
      acceptsApiKey: meta.acceptsApiKey,
      envVars: [...meta.envVars],
      activeEnvVar: findActiveEnvVar(meta.envVars, sourceOf),
      authType: cred?.authType ?? null,
      accountHint: cred?.accountHint ?? null,
      modelCount: modelCounts.get(meta.id) ?? 0,
    });
  }

  // 包含扩展或自定义提供商写入 auth.json 的凭据状态
  for (const [providerId, rawCred] of Object.entries(authObj)) {
    if (seenIds.has(providerId)) continue;
    const cred = parseAuthCredential(rawCred);
    if (cred === null) continue;
    statuses.push({
      id: providerId,
      name: providerId,
      supportsOAuth: cred.authType === "oauth",
      acceptsApiKey: true,
      envVars: [],
      activeEnvVar: null,
      authType: cred.authType,
      accountHint: cred.accountHint,
      modelCount: modelCounts.get(providerId) ?? 0,
    });
  }

  return statuses;
}

/**
 * 列出支持 OAuth 登录的提供商（兼容 `ipc.ts` 的 `LoginProvider[]`）。
 */
export async function listPiLoginProviders(agentDir: string): Promise<LoginProvider[]> {
  const statuses = await listPiProviderStatuses(agentDir);
  return statuses
    .filter((status) => status.supportsOAuth)
    .map((status) => ({
      id: status.id,
      name: status.name,
      available: true,
      authenticated: status.authType !== null || status.activeEnvVar !== null,
    }));
}

/**
 * 列出 `auth.json` 中已保存的账号/凭据条目（可按 `providerId` 过滤，兼容 `LogoutAccount[]`）。
 */
export async function listPiAccounts(agentDir: string, providerId?: string): Promise<LogoutAccount[]> {
  const { data: authObj } = await readAuthObject(agentDir, false);
  const accounts: LogoutAccount[] = [];
  let nextId = 1;
  for (const [id, raw] of Object.entries(authObj)) {
    if (providerId !== undefined && id !== providerId) continue;
    const cred = parseAuthCredential(raw);
    if (cred === null) continue;
    const meta = findPiBuiltinProvider(id);
    const displayName = meta?.name ?? id;
    accounts.push({
      credentialId: nextId++,
      provider: id,
      label: cred.accountHint && cred.authType === "oauth" ? cred.accountHint : displayName,
      detail: cred.detail,
      type: cred.authType,
      active: true,
    });
  }
  return accounts;
}

function isValidAuthKey(value: string): boolean {
  if (value.length === 0 || value.length > limits.key) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  if (value.startsWith("!")) return value.slice(1).trim().length > 0;
  return isValidLiteralKey(value);
}

/**
 * 将提供商 API Key 原子写入 `<agentDir>/auth.json`（保留其余提供商凭据，文件权限 `0o600`）。
 */
export async function savePiApiKey(agentDir: string, providerId: string, key: string): Promise<void> {
  const id = providerId.trim();
  if (!isValidProviderId(id)) {
    throw new Error(`Invalid provider ID: "${providerId}"`);
  }
  const trimmedKey = key.trim();
  if (!isValidAuthKey(trimmedKey)) {
    throw new Error(`Invalid API key for provider "${id}"`);
  }
  const file = piAuthFilePath(agentDir);
  await enqueueFileWrite(file, async () => {
    const { data } = await readAuthObject(agentDir, true);
    const existing = data[id];
    const preservedEnv = isRecord(existing) && isRecord(existing["env"]) ? existing["env"] : undefined;
    data[id] = {
      type: "api_key",
      key: trimmedKey,
      ...(preservedEnv !== undefined ? { env: preservedEnv } : {}),
    };
    await writeSecretFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    log.info("saved pi provider api_key credential", { provider: id });
  });
}

/**
 * 从 `<agentDir>/auth.json` 原子移除指定提供商的凭据（退出登录 / 删除 Key）。
 */
export async function removePiCredential(agentDir: string, providerId: string): Promise<boolean> {
  const id = providerId.trim();
  if (id === "") throw new Error("providerId must not be empty");
  const file = piAuthFilePath(agentDir);
  return enqueueFileWrite(file, async () => {
    const { exists, data } = await readAuthObject(agentDir, true);
    if (!exists || !(id in data)) return false;
    delete data[id];
    await writeSecretFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    log.info("removed pi provider credential", { provider: id });
    return true;
  });
}

/**
 * 检测内置提供商环境变量来源（`system` / `env-file` / `missing`），不返回变量值。
 */
export async function readPiApiKeyEnvSources(agentDir: string): Promise<Record<string, ProviderKeyEnv>> {
  const envText = await readEnvText(agentDir);
  const sourceOf = envSourceOf(envText);
  const out: Record<string, ProviderKeyEnv> = {};

  for (const meta of PI_BUILTIN_PROVIDERS) {
    if (meta.envVars.length === 0) continue;
    let matched: ProviderKeyEnv | null = null;
    for (const envName of meta.envVars) {
      const source = sourceOf(envName);
      if (source !== "missing") {
        matched = { name: envName, source };
        break;
      }
    }
    out[meta.id] = matched ?? { name: meta.envVars[0]!, source: "missing" };
  }

  for (const legacyId of keyEnvProviderIds()) {
    if (!(legacyId in out)) {
      const legacyEnv = providerKeyEnv(legacyId, sourceOf);
      if (legacyEnv !== null) out[legacyId] = legacyEnv;
    }
  }

  return out;
}

// ============================================================================
// 第二部分：自定义模型配置（`<agentDir>/models.json` + `.env` 同步，100% 兼容 `custom-models.ts`）
// ============================================================================

type SourceOf = (name: string) => EnvSource;
export type ParseResult = { ok: true; providers: CustomProviderInfo[] } | { ok: false; code: CustomModelsErrorCode };
type Edit = { ok: true; text: string } | { ok: false; code: CustomModelsErrorCode };

const fail = (code: CustomModelsErrorCode): { ok: false; code: CustomModelsErrorCode } => ({
  ok: false,
  code,
});

export function piModelsFilePath(agentDir: string): string {
  return path.join(agentDir, "models.json");
}

function normalizeInputEnvName(rawName: string): string {
  const dollar = DOLLAR_ENV_RE.exec(rawName);
  if (dollar) return (dollar[1] ?? dollar[2])!;
  return rawName;
}

/** 解析 `models.json` 中的 `apiKey` 字段状态：支持 Pi 原生 `$VAR` / `${VAR}` 以及裸大写环境变量名。 */
function keyStateOf(entry: Record<string, unknown>, sourceOf: SourceOf): CustomKeyState {
  const key = entry["apiKey"];
  if (typeof key !== "string" || key === "") return { kind: "none" };
  if (key.startsWith("!")) return { kind: "command" };
  const dollarMatch = DOLLAR_ENV_RE.exec(key);
  if (dollarMatch) {
    const name = (dollarMatch[1] ?? dollarMatch[2])!;
    return { kind: "env", name, source: sourceOf(name) };
  }
  if (!isValidEnvName(key)) return { kind: "literal" };
  const source = sourceOf(key);
  return ENV_LIKE_KEY.test(key) || source !== "missing" ? { kind: "env", name: key, source } : { kind: "literal" };
}

function metaOf(entry: Record<string, unknown>): CustomModelMeta {
  const reasoning = entry["reasoning"];
  const input = entry["input"];
  const contextWindow = entry["contextWindow"];
  const maxTokens = entry["maxTokens"];
  return {
    reasoning: typeof reasoning === "boolean" ? reasoning : null,
    images: Array.isArray(input) ? input.includes("image") : null,
    contextWindow: isValidTokenCount(contextWindow) ? contextWindow : null,
    maxTokens: isValidTokenCount(maxTokens) ? maxTokens : null,
  };
}

function isImageModel(entry: Record<string, unknown>): boolean {
  return entry["api"] === "openai-images" || entry["kind"] === "image" || entry["type"] === "image";
}

function modelEntries(value: unknown): CustomProviderInfo["models"] {
  if (!Array.isArray(value)) return [];
  const out: CustomProviderInfo["models"] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item)) continue;
    const id = str(item["id"]);
    if (id !== null) {
      out.push({ id, name: str(item["name"]), ...metaOf(item), image: isImageModel(item) });
    }
  }
  return out;
}

const hasMeta = (meta: CustomModelMeta): boolean =>
  meta.reasoning !== null || meta.images !== null || meta.contextWindow !== null || meta.maxTokens !== null;

function overrideEntries(value: unknown): ({ id: string } & CustomModelMeta)[] {
  if (!isRecord(value)) return [];
  const out: ({ id: string } & CustomModelMeta)[] = [];
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const meta = metaOf(raw);
    if (hasMeta(meta)) out.push({ id, ...meta });
  }
  return out;
}

function parseRootObject(text: string | null): { ok: true; root: Record<string, unknown> } | { ok: false } {
  if (text === null || text.trim() === "") return { ok: true, root: {} };
  const cleaned = stripJsonComments(stripBom(text)).trim();
  if (cleaned === "") return { ok: true, root: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false };
  }
  if (!isRecord(parsed)) return { ok: false };
  return { ok: true, root: { ...parsed } };
}

/** 从 `models.json` 文本解析自定义提供商列表（不含密钥内容）。 */
export function parsePiProviders(text: string | null, sourceOf: SourceOf): ParseResult {
  const rootRes = parseRootObject(text);
  if (!rootRes.ok) return fail("unreadable-file");
  const providersRaw = rootRes.root["providers"];
  if (providersRaw === undefined || providersRaw === null) return { ok: true, providers: [] };
  if (!isRecord(providersRaw)) return fail("unreadable-file");

  const out: CustomProviderInfo[] = [];
  for (const [id, raw] of Object.entries(providersRaw)) {
    const entry = isRecord(raw) ? raw : {};
    out.push({
      id,
      baseUrl: str(entry["baseUrl"]),
      api: str(entry["api"]),
      key: keyStateOf(entry, sourceOf),
      models: modelEntries(entry["models"]),
      discovery: isRecord(entry["discovery"]),
      overrides: overrideEntries(entry["modelOverrides"]),
      // Pi 1.5.2 不会对自定义 anthropic-messages 做 OAuth cch 改写。
      oauthShaping: false,
    });
  }
  return { ok: true, providers: out };
}

/**
 * 提取 `models.json` 中某个提供商的 `apiKey` 供主进程拉取模型目录使用（不经 IPC 暴露）。
 * 若写为 `$ENV_NAME` 或 `${ENV_NAME}`，返回裸变量名 `ENV_NAME` 以便 `resolveKeyToken` 从环境解析。
 */
export function piProviderKeyValue(text: string | null, providerId: string): string | null {
  const rootRes = parseRootObject(text);
  if (!rootRes.ok) return null;
  const providers = rootRes.root["providers"];
  if (!isRecord(providers)) return null;
  const provider = providers[providerId];
  if (!isRecord(provider)) return null;
  const value = provider["apiKey"];
  if (typeof value !== "string" || value === "") return null;
  const dollar = DOLLAR_ENV_RE.exec(value);
  return dollar ? (dollar[1] ?? dollar[2])! : value;
}

function isMetaValid(meta: CustomModelMeta): boolean {
  const flag = (v: unknown) => v === null || typeof v === "boolean";
  const count = (v: unknown) => v === null || isValidTokenCount(v);
  return flag(meta.reasoning) && flag(meta.images) && count(meta.contextWindow) && count(meta.maxTokens);
}

function isValidEnvKey(key: { name: string; value?: string }): boolean {
  const normalized = normalizeInputEnvName(key.name);
  return isValidEnvName(normalized) && (key.value === undefined || key.value === "" || isValidLiteralKey(key.value));
}

function validateInput(input: CustomProviderInput, mode: "add" | "edit"): CustomModelsErrorCode | null {
  if (!isValidProviderId(input.id)) return "invalid-id";
  if (normalizeBaseUrl(input.baseUrl) === null) return "invalid-url";
  if (!isKnownApi(input.api)) return "invalid-api";
  const key = input.key;
  if (key.kind === "literal" && !isValidLiteralKey(key.value)) return "invalid-key";
  if (key.kind === "env" && !isValidEnvKey(key)) return "invalid-key";
  if (key.kind === "keep" && mode === "add") return "invalid-key";
  if (input.models.length > limits.models) return "invalid-models";
  const seen = new Set<string>();
  for (const model of input.models) {
    if (!isValidModelId(model.id) || seen.has(model.id)) return "invalid-models";
    if (model.name !== undefined && !isValidModelName(model.name)) return "invalid-models";
    if (!isMetaValid(model)) return "invalid-models";
    if (model.image !== undefined && typeof model.image !== "boolean") return "invalid-models";
    seen.add(model.id);
  }
  return null;
}

function applyKindToObj(node: Record<string, unknown>, image: boolean | undefined, api: string): boolean {
  if (image === undefined || image === isImageModel(node)) return true;
  if (!image) {
    if (node["api"] === "openai-images") delete node["api"];
    if (node["kind"] === "image") delete node["kind"];
    if (node["type"] === "image") delete node["type"];
    return true;
  }
  const field = imageModelField(api);
  if (field === null) return false;
  node[field.key] = field.value;
  return true;
}

function applyMetaToObj(node: Record<string, unknown>, meta: CustomModelMeta): void {
  const current = metaOf(node);
  const put = (key: string, value: unknown) => {
    if (value === null) delete node[key];
    else node[key] = value;
  };
  if (meta.reasoning !== current.reasoning) put("reasoning", meta.reasoning);
  if (meta.images !== current.images) {
    put("input", meta.images === null ? null : meta.images ? ["text", "image"] : ["text"]);
  }
  if (meta.contextWindow !== current.contextWindow) put("contextWindow", meta.contextWindow);
  if (meta.maxTokens !== current.maxTokens) put("maxTokens", meta.maxTokens);
}

function applyModelsToObj(provider: Record<string, unknown>, input: CustomProviderInput): CustomModelsErrorCode | null {
  const existingModels = Array.isArray(provider["models"]) ? (provider["models"] as unknown[]) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of existingModels) {
    if (!isRecord(item)) continue;
    const id = item["id"];
    if (typeof id === "string") byId.set(id, { ...item });
  }
  const next: Record<string, unknown>[] = [];
  for (const model of input.models) {
    const node: Record<string, unknown> = byId.get(model.id) ?? { id: model.id };
    if (model.name !== undefined) node["name"] = model.name;
    if (!applyKindToObj(node, model.image, input.api)) return "invalid-api";
    applyMetaToObj(node, model);
    next.push(node);
  }
  if (next.length === 0) {
    delete provider["models"];
  } else {
    provider["models"] = next;
  }
  return null;
}

function serializeModelsRoot(root: Record<string, unknown>, original: string | null): string {
  const eol = original !== null && original.includes("\r\n") ? "\r\n" : "\n";
  const json = `${JSON.stringify(root, null, 2)}\n`;
  return eol === "\r\n" ? json.replace(/\r?\n/g, "\r\n") : json;
}

/** 在 `models.json` 文本上新增或编辑一个自定义提供商（保留 `$schema`、其余提供商与未知字段）。 */
export function applyPiProvider(text: string | null, input: CustomProviderInput, mode: "add" | "edit"): Edit {
  const invalid = validateInput(input, mode);
  if (invalid !== null) return fail(invalid);

  const rootRes = parseRootObject(text);
  if (!rootRes.ok) return fail("unreadable-file");
  const root = rootRes.root;
  const rawProviders = root["providers"];
  if (rawProviders !== undefined && rawProviders !== null && !isRecord(rawProviders)) {
    return fail("unreadable-file");
  }
  const providers: Record<string, unknown> = isRecord(rawProviders) ? { ...rawProviders } : {};
  root["providers"] = providers;

  const existing = providers[input.id];
  if (mode === "add" && existing !== undefined) return fail("exists");
  if (mode === "edit" && existing === undefined) return fail("not-found");
  if (existing !== undefined && !isRecord(existing)) return fail("unreadable-file");

  const provider: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};

  if (input.discovery === false) {
    delete provider["discovery"];
  } else if (input.discovery === true && !("discovery" in provider)) {
    const type = defaultDiscoveryType(input.api);
    if (type === null) return fail("invalid-api");
    provider["discovery"] = { type };
  }
  if (input.models.length === 0 && !("discovery" in provider)) return fail("needs-model");

  provider["baseUrl"] = normalizeBaseUrl(input.baseUrl);
  const key = input.key;
  if (key.kind === "literal") {
    provider["apiKey"] = key.value;
  } else if (key.kind === "env") {
    const envName = normalizeInputEnvName(key.name);
    provider["apiKey"] = `$${envName}`;
  } else if (key.kind === "none") {
    delete provider["apiKey"];
    if (provider["authHeader"] === true) delete provider["authHeader"];
  }
  provider["api"] = input.api;

  const modelsErr = applyModelsToObj(provider, input);
  if (modelsErr !== null) return fail(modelsErr);

  providers[input.id] = provider;
  return { ok: true, text: serializeModelsRoot(root, text) };
}

/** 从 `models.json` 文本中移除一个提供商。 */
export function removePiProvider(text: string | null, id: string): Edit {
  if (!isValidProviderId(id)) return fail("invalid-id");
  if (text === null || text.trim() === "") return fail("not-found");
  const rootRes = parseRootObject(text);
  if (!rootRes.ok) return fail("unreadable-file");
  const rawProviders = rootRes.root["providers"];
  if (!isRecord(rawProviders) || !(id in rawProviders)) return fail("not-found");
  const providers: Record<string, unknown> = { ...rawProviders };
  delete providers[id];
  rootRes.root["providers"] = providers;
  return { ok: true, text: serializeModelsRoot(rootRes.root, text) };
}

/** 修改内置提供商覆盖项（仅操作 `apiKey` 与 `modelOverrides` 中的能力参数，其余字段原样保留）。 */
export function applyPiOverride(text: string | null, id: string, input: ProviderOverrideInput): Edit {
  if (!isValidProviderId(id)) return fail("invalid-id");
  const key = input.key;
  if (key?.kind === "literal" && !isValidLiteralKey(key.value)) return fail("invalid-key");
  if (key?.kind === "env" && !isValidEnvKey(key)) return fail("invalid-key");
  if (input.models.length > limits.models) return fail("invalid-models");

  const wanted = new Map<string, CustomModelMeta>();
  for (const model of input.models) {
    if (!isValidModelId(model.id) || wanted.has(model.id) || !isMetaValid(model)) {
      return fail("invalid-models");
    }
    wanted.set(model.id, model);
  }

  if (text === null || text.trim() === "") return fail("not-found");
  const rootRes = parseRootObject(text);
  if (!rootRes.ok) return fail("unreadable-file");
  const rawProviders = rootRes.root["providers"];
  if (!isRecord(rawProviders) || !(id in rawProviders)) return fail("not-found");
  const rawProvider = rawProviders[id];
  if (!isRecord(rawProvider)) return fail("unreadable-file");

  const providers: Record<string, unknown> = { ...rawProviders };
  const provider: Record<string, unknown> = { ...rawProvider };

  if (key === null) {
    delete provider["apiKey"];
  } else if (key.kind === "literal") {
    provider["apiKey"] = key.value;
  } else if (key.kind === "env") {
    provider["apiKey"] = `$${normalizeInputEnvName(key.name)}`;
  }

  const rawOverrides = provider["modelOverrides"];
  if (rawOverrides !== undefined && rawOverrides !== null && !isRecord(rawOverrides)) {
    return fail("unreadable-file");
  }
  const overrides: Record<string, unknown> = isRecord(rawOverrides) ? { ...rawOverrides } : {};
  const emptyMeta: CustomModelMeta = {
    reasoning: null,
    images: null,
    contextWindow: null,
    maxTokens: null,
  };

  for (const [modelId, current] of Object.entries(overrides)) {
    if (wanted.has(modelId) || !isRecord(current)) continue;
    const copy = { ...current };
    applyMetaToObj(copy, emptyMeta);
    if (Object.keys(copy).length === 0) delete overrides[modelId];
    else overrides[modelId] = copy;
  }

  for (const [modelId, meta] of wanted) {
    const current = overrides[modelId];
    if (current !== undefined && current !== null && !isRecord(current)) {
      return fail("unreadable-file");
    }
    const copy: Record<string, unknown> = isRecord(current) ? { ...current } : {};
    applyMetaToObj(copy, meta);
    if (Object.keys(copy).length === 0) delete overrides[modelId];
    else overrides[modelId] = copy;
  }

  if (Object.keys(overrides).length === 0) delete provider["modelOverrides"];
  else provider["modelOverrides"] = overrides;

  if (Object.keys(provider).length === 0) delete providers[id];
  else providers[id] = provider;

  rootRes.root["providers"] = providers;
  return { ok: true, text: serializeModelsRoot(rootRes.root, text) };
}

type EnvWrite = { name: string; value: string } | null;

function envWriteOf(key: CustomProviderInput["key"] | ProviderOverrideInput["key"]): EnvWrite {
  if (key?.kind === "env" && key.value !== undefined && key.value !== "") {
    return { name: normalizeInputEnvName(key.name), value: key.value };
  }
  return null;
}

async function mutatePiModels(
  agentDir: string,
  id: string,
  edit: (text: string | null) => Edit,
  envWrite: EnvWrite,
): Promise<CustomModelsOutcome> {
  const modelsFile = piModelsFilePath(agentDir);
  return enqueueFileWrite(modelsFile, async () => {
    const currentText = await readIfExists(modelsFile);
    const result = edit(currentText);
    if (!result.ok) return result;

    const envText = await readEnvText(agentDir);
    let nextEnv = envText;
    if (envWrite !== null) {
      const written = setEnvLine(nextEnv, envWrite.name, envWrite.value);
      if (!written.ok) return fail("unsafe-env");
      nextEnv = written.text;
    }

    const before = parsePiProviders(currentText, envSourceOf(envText));
    const after = parsePiProviders(result.text, envSourceOf(nextEnv));
    const unused =
      before.ok && after.ok
        ? unusedEnvName(
            before.providers.find((provider) => provider.id === id),
            after.providers,
          )
        : null;

    if (unused !== null && nextEnv !== null) {
      const removed = removeEnvLine(nextEnv, unused);
      if (removed.ok) nextEnv = removed.text;
      else log.info(`pi custom provider ${id}: left unused ${unused} in .env (not single-line)`);
    }

    if (nextEnv !== envText && nextEnv !== null) {
      const envFile = envFilePath(agentDir);
      if (envText !== null) await copyFile(envFile, `${envFile}.bak`);
      await writeFileAtomic(envFile, nextEnv, `pi-studio-${process.pid}`);
      log.info(
        `pi custom provider ${id}: .env ${envWrite !== null ? `set ${envWrite.name}` : ""}${unused !== null ? ` removed ${unused}` : ""}`,
      );
    }

    if (currentText !== null) await copyFile(modelsFile, `${modelsFile}.bak`);
    await writeFileAtomic(modelsFile, result.text, `pi-studio-${process.pid}`);
    const shadowed = envWrite !== null && envSourceOf(nextEnv)(envWrite.name) === "system";
    return shadowed ? { ok: true, envShadowed: envWrite.name } : { ok: true };
  });
}

/** 读取 `<agentDir>/models.json`（兼容 `CustomModelsFileInfo` 契约）。 */
export async function readPiModelsFile(agentDir: string): Promise<CustomModelsFileInfo> {
  const file = piModelsFilePath(agentDir);
  const text = await readIfExists(file);
  const parsed = parsePiProviders(text, envSourceOf(await readEnvText(agentDir)));
  if (!parsed.ok) {
    throw new Error(`models file is not readable JSON: ${path.basename(file)}`);
  }
  return { path: file, exists: text !== null, providers: parsed.providers };
}

export function savePiCustomProvider(
  agentDir: string,
  input: CustomProviderInput,
  mode: "add" | "edit",
): Promise<CustomModelsOutcome> {
  return mutatePiModels(agentDir, input.id, (text) => applyPiProvider(text, input, mode), envWriteOf(input.key));
}

export function deletePiCustomProvider(agentDir: string, id: string): Promise<CustomModelsOutcome> {
  return mutatePiModels(agentDir, id, (text) => removePiProvider(text, id), null);
}

export function savePiProviderOverride(
  agentDir: string,
  id: string,
  input: ProviderOverrideInput,
): Promise<CustomModelsOutcome> {
  return mutatePiModels(agentDir, id, (text) => applyPiOverride(text, id, input), envWriteOf(input.key));
}

export async function readPiProviderKey(agentDir: string, providerId: string): Promise<string | null> {
  const text = await readIfExists(piModelsFilePath(agentDir));
  return piProviderKeyValue(text, providerId);
}

export function setPiEnvKey(agentDir: string, name: string, value: string): Promise<boolean> {
  const modelsFile = piModelsFilePath(agentDir);
  return enqueueFileWrite(modelsFile, async () => {
    const text = await readEnvText(agentDir);
    if (envSourceOf(text)(name) !== "env-file") return false;
    const written = setEnvLine(text, name, value);
    if (!written.ok) {
      throw new Error(`the ${name} line in .env can't be rewritten safely; edit .env by hand`);
    }
    const file = envFilePath(agentDir);
    await copyFile(file, `${file}.bak`);
    await writeFileAtomic(file, written.text, `pi-studio-${process.pid}`);
    log.info(`pi provider key: .env set ${name}`);
    return true;
  });
}

// 兼容 `src/main/omp-config/models-file.ts` 同名导出，方便 IPC 层无缝切换
export {
  applyPiOverride as applyOverride,
  applyPiProvider as applyProvider,
  deletePiCustomProvider as deleteCustomProvider,
  parsePiProviders as parseProviders,
  readPiModelsFile as readModelsFile,
  readPiProviderKey as readProviderKey,
  removePiProvider as removeProvider,
  savePiCustomProvider as saveCustomProvider,
  savePiProviderOverride as saveProviderOverride,
  setPiEnvKey as setEnvKey,
};
