// Pi 账号、凭据（auth.json / .env / 环境变量）与模型列表 IPC handlers。
import { limits, type HandlerGroup } from "../../shared/ipc.ts";
import { resolveAgentDir } from "../history/session-index.ts";
import {
  listPiAccounts,
  listPiLoginProviders,
  readPiApiKeyEnvSources,
  removePiCredential,
  savePiApiKey,
  setPiEnvKey,
} from "../pi-config/auth-and-models.ts";
import { listModelOptions, reloadServiceModels } from "../service/default-model.ts";
import { startupCache } from "../service/startup-cache-instance.ts";
import { parseApiKey, parseBoolean, parseInteger, parseString } from "./validate.ts";

const parseProviderId = (value: unknown) => parseString(value, "providerId", 200);

const TERMINAL_LOGIN_GUIDE = "请在内置终端运行 pi 后执行 /login 完成交互式 OAuth 登录。";

export const accountHandlers: HandlerGroup<
  | "listModels"
  | "listRunnerModels"
  | "listLoginProviders"
  | "startLogin"
  | "answerLoginInput"
  | "cancelLogin"
  | "startTerminalLogin"
  | "cancelTerminalLogin"
  | "listAccounts"
  | "logout"
  | "saveApiKey"
  | "apiKeyEnvSources"
  | "setTavilyBackupKeys"
  | "tavilyBackupKeyCount"
  | "tavilyKeyUsage"
> = {
  listModels: (refresh) => listModelOptions(parseBoolean(refresh, "refresh")),
  listRunnerModels: () => Promise.resolve([]),
  listLoginProviders: () => listPiLoginProviders(resolveAgentDir()),
  startLogin: (providerId) => {
    parseProviderId(providerId);
    return Promise.resolve({ ok: false, message: TERMINAL_LOGIN_GUIDE });
  },
  answerLoginInput: (inputId, value) => {
    parseString(inputId, "inputId", 200);
    if (value !== null) parseString(value, "value", 8192, { allowEmpty: true });
    return Promise.resolve();
  },
  cancelLogin: () => Promise.resolve(),
  startTerminalLogin: (providerId) => {
    parseProviderId(providerId);
    return Promise.resolve({ ok: false, message: TERMINAL_LOGIN_GUIDE });
  },
  cancelTerminalLogin: () => Promise.resolve(),
  listAccounts: async (providerId) => {
    const id = parseProviderId(providerId);
    const accounts = await listPiAccounts(resolveAgentDir(), id);
    startupCache().setSubscription(
      id,
      accounts.some((account) => account.type === "oauth"),
    );
    return accounts;
  },
  logout: async (providerId, credentialId) => {
    const id = parseProviderId(providerId);
    parseInteger(credentialId, "credentialId", 0, Number.MAX_SAFE_INTEGER);
    await removePiCredential(resolveAgentDir(), id);
    await reloadServiceModels();
  },
  saveApiKey: async (providerId, key) => {
    const id = parseProviderId(providerId);
    const raw = parseApiKey(key);
    const agentDir = resolveAgentDir();
    const envSources = await readPiApiKeyEnvSources(agentDir);
    const env = envSources[id];
    const inEnvFile = env?.source === "env-file" && (await setPiEnvKey(agentDir, env.name, raw.trim()));
    if (!inEnvFile) await savePiApiKey(agentDir, id, raw);
    await reloadServiceModels();
  },
  apiKeyEnvSources: () => readPiApiKeyEnvSources(resolveAgentDir()),
  setTavilyBackupKeys: (keys) => {
    parseString(keys, "keys", limits.apiKeyMaxChars, { allowEmpty: true });
    return Promise.resolve(0);
  },
  tavilyBackupKeyCount: () => Promise.resolve(0),
  tavilyKeyUsage: () => Promise.resolve([]),
};
