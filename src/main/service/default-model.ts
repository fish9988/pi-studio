// 新任务实际会用的默认模型与全局模型目录缓存：通过 `piService()`（`pi --mode rpc --no-session`）查询
// `get_state` 与 `get_available_models`，并按 `settings.json` / `models.json` / `auth.json` / `.env` 指纹缓存。
import { createHash } from "node:crypto";
import path from "node:path";
import { app } from "electron";
import type { DefaultModelInfo, ModelOption } from "../../shared/ipc.ts";
import { isProviderKeyEnv } from "../../shared/provider-keys.ts";
import { resolveAgentDir } from "../history/session-index.ts";
import { emitEvent } from "../ipc/events.ts";
import { log } from "../log/log.ts";
import { piService, readyPiVersion } from "../pi/runtime-singleton.ts";
import { inputStamp } from "./input-stamp.ts";
import { startupCache } from "./startup-cache-instance.ts";

/** 这些设置变了，默认模型/思考强度/可用模型可能跟着变。 */
const watchedKeys = new Set([
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "modelThinkingLevels",
  "enabledModels",
  "extensions",
  "packages",
]);

const reloadDelayMs = 300;

async function catalogStamp(): Promise<string> {
  const agentDir = resolveAgentDir();
  const keys = Object.keys(process.env)
    .filter(isProviderKeyEnv)
    .sort()
    .map((name) => `${name}=${process.env[name]}`);
  const keyHash = createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16);
  return inputStamp(
    `${app.getVersion()}+${await readyPiVersion()}+${keyHash}`,
    ["settings.json", "models.json", "auth.json", ".env"].map((file) => path.join(agentDir, file)),
  );
}

/** `refresh` 为 false 时缓存优先；true 一定问服务进程。读不到时为 null（启动缓存不动）。 */
export async function readDefaultModel(refresh: boolean): Promise<DefaultModelInfo | null> {
  try {
    const generation = startupCache().catalogGeneration();
    const stamp = await catalogStamp();
    const cached = refresh ? undefined : startupCache().freshDefaultModel(stamp);
    if (cached !== undefined) return cached;
    const model = await piService().readDefaultModel(refresh, stamp);
    startupCache().setDefaultModel(model, stamp, generation);
    return model;
  } catch (error) {
    log.warn("get_state on the pi service process failed", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Pi 的全部可用模型（服务进程 `get_available_models`）。`refresh` 为 false 时缓存优先；
 * true（打开模型选择器、改了模型相关设置）一定现读，同时现读默认模型并推 `defaultModel` 事件。
 */
export async function listModelOptions(refresh: boolean): Promise<ModelOption[]> {
  const generation = startupCache().catalogGeneration();
  const stamp = await catalogStamp();
  const cached = refresh ? null : startupCache().freshModels(stamp);
  if (cached) return cached;
  if (refresh) void readDefaultModel(true).then((model) => emitEvent("defaultModel", model));
  const models = await piService().listModelOptions(true, stamp);
  startupCache().setModels(models, stamp, generation);
  return models;
}

/**
 * Pi 的模型、凭据或扩展在服务进程之外变了：关掉服务进程并作废缓存，下次读取时重新启动。
 */
export async function reloadServiceModels(): Promise<void> {
  startupCache().forgetCatalog();
  await piService().invalidate();
}

export function prewarmToolbarData(): void {
  void readDefaultModel(false);
  listModelOptions(false).catch((error: unknown) =>
    log.warn("prewarming the pi model list failed", error instanceof Error ? error.message : error),
  );
}

export function onOmpConfigChanged(key: string): void {
  if (!watchedKeys.has(key)) return;
  void piService().invalidate();
  setTimeout(() => {
    listModelOptions(true).catch((error: unknown) =>
      log.warn("re-reading the pi model list failed", error instanceof Error ? error.message : error),
    );
  }, reloadDelayMs).unref();
}
