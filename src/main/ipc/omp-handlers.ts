// Pi CLI 状态管理、全局与项目配置（settings.json）、模型默认项与快捷键 IPC handlers。
import { resolveAgentDir } from "../history/session-index.ts";
import { log } from "../log/log.ts";
import {
  getNestedValue,
  piSettingsFilePath,
  readModelDefaultsFromPiSettings,
  readPiConfigSnapshot,
  readPiSettingsObject,
  resetPiSetting,
  setPiSetting,
  writeModelDefaultsToPiSettings,
} from "../pi-config/settings-file.ts";
import { readPiKeybindings } from "../pi-config/resources.ts";
import { piManager } from "../pi/runtime-singleton.ts";
import { onOmpConfigChanged, readDefaultModel } from "../service/default-model.ts";
import { startupCache } from "../service/startup-cache-instance.ts";
import { updateSettings } from "../settings/settings-store.ts";
import { getTaskPool } from "../tasks/runtime.ts";
import { resolveHostShellPath } from "../terminal/runtime.ts";
import type { CompactionSettings, HandlerGroup, ModelDefaults, PreferredShell, ProjectId } from "../../shared/ipc.ts";
import { emitEvent } from "./events.ts";
import {
  IpcValidationError,
  parseBoolean,
  parseIdleClose,
  parseModelKey,
  parseOneOf,
  parseProjectId,
  parseString,
} from "./validate.ts";

/** 一次最多查多少个模型。 */
const maxInsightKeys = 10_000;

/**
 * 将用户在设置里选择的 `preferredShell` 同步为本机真实绝对路径写入 Pi 的 `shellPath`；
 * `"auto"` 或目标 Shell 不存在时重置 `shellPath`。
 */
export async function syncPreferredShellToOmp(preferred: PreferredShell): Promise<void> {
  try {
    const agentDir = resolveAgentDir();
    const resolved = resolveHostShellPath(preferred);
    if (resolved === null) {
      await resetPiSetting(agentDir, "shellPath");
    } else {
      await setPiSetting(agentDir, "shellPath", JSON.stringify(resolved));
    }
    onOmpConfigChanged("shellPath");
    emitEvent("ompConfigChanged", { key: "shellPath" });
  } catch (error) {
    log.warn("syncPreferredShellToOmp failed", error instanceof Error ? error.message : error);
  }
}

async function projectPath(projectId: unknown): Promise<string | null> {
  if (projectId === null) return null;
  return (await getTaskPool()).projectPath(parseProjectId(projectId));
}

/** 项目目录里 Pi 对新任务实际用的默认值（同时记进启动缓存）。 */
export async function readProjectModelDefaults(projectId: ProjectId, cwd: string): Promise<ModelDefaults> {
  const defaults = await readModelDefaultsFromPiSettings(resolveAgentDir(), cwd);
  startupCache().setModelDefaults(projectId, defaults);
  return defaults;
}

function currentPiVersion(): string {
  const status = piManager().status;
  return status.state === "ready" ? status.version : "1.5.2";
}

function parseCompactionNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export const ompHandlers: HandlerGroup<
  | "getOmpStatus"
  | "answerTakeover"
  | "addManagedOmpToPath"
  | "takeOverOmp"
  | "retryOmpSetup"
  | "upgradePathOmp"
  | "checkOmpUpdate"
  | "installOmp"
  | "cancelOmpInstall"
  | "getOmpConfig"
  | "setOmpConfig"
  | "resetOmpConfig"
  | "setReduceMotion"
  | "setEnterWhileRunning"
  | "setIdleClose"
  | "setSoundOnDone"
  | "setCopyOnSelect"
  | "setToolHeadsOnly"
  | "setYoloConfirmed"
  | "getDefaultModel"
  | "getStartupSnapshot"
  | "getModelDefaults"
  | "getModelRoles"
  | "setModelRole"
  | "getApprovalMode"
  | "getModelInsights"
  | "getOmpKeybindings"
> = {
  getOmpStatus: () => {
    const manager = piManager();
    void manager.startOnce();
    return Promise.resolve(manager.status);
  },
  answerTakeover: (accept) => {
    parseBoolean(accept, "accept");
    return Promise.resolve();
  },
  addManagedOmpToPath: () => Promise.resolve(),
  takeOverOmp: () => Promise.resolve(),
  retryOmpSetup: async () => {
    await piManager().retry();
  },
  upgradePathOmp: () => piManager().upgradePi(),
  checkOmpUpdate: async () => {
    await piManager().retry();
    return { installedVersion: null, availableVersion: null };
  },
  installOmp: () => Promise.resolve(),
  cancelOmpInstall: () => Promise.resolve(),
  getOmpConfig: () => readPiConfigSnapshot(resolveAgentDir(), currentPiVersion()),
  setOmpConfig: async (key, valueJson) => {
    const name = parseString(key, "key", 200);
    const result = await setPiSetting(
      resolveAgentDir(),
      name,
      parseString(valueJson, "value", 1024 * 1024, { allowEmpty: true }),
    );
    onOmpConfigChanged(name);
    emitEvent("ompConfigChanged", { key: name });
    return result;
  },
  resetOmpConfig: async (key) => {
    const name = parseString(key, "key", 200);
    const result = await resetPiSetting(resolveAgentDir(), name);
    onOmpConfigChanged(name);
    emitEvent("ompConfigChanged", { key: name });
    return result;
  },
  setReduceMotion: (on) => Promise.resolve(updateSettings({ reduceMotion: parseBoolean(on, "reduceMotion") })),
  setEnterWhileRunning: (mode) =>
    Promise.resolve(
      updateSettings({ enterWhileRunning: parseOneOf(mode, "enterWhileRunning", ["steer", "followUp"]) }),
    ),
  setIdleClose: (value) => Promise.resolve(updateSettings({ idleClose: parseIdleClose(value) })),
  setSoundOnDone: (on) => Promise.resolve(updateSettings({ soundOnDone: parseBoolean(on, "soundOnDone") })),
  setCopyOnSelect: (on) => Promise.resolve(updateSettings({ copyOnSelect: parseBoolean(on, "copyOnSelect") })),
  setToolHeadsOnly: (on) => Promise.resolve(updateSettings({ toolHeadsOnly: parseBoolean(on, "toolHeadsOnly") })),
  setYoloConfirmed: () => Promise.resolve(updateSettings({ yoloConfirmed: true })),
  getDefaultModel: () => readDefaultModel(false),
  getStartupSnapshot: () => Promise.resolve(startupCache().snapshot()),
  getModelDefaults: async (projectId) => {
    const dir = await projectPath(projectId);
    const defaults = await readModelDefaultsFromPiSettings(resolveAgentDir(), dir);
    startupCache().setModelDefaults(projectId === null ? null : parseProjectId(projectId), defaults);
    return defaults;
  },
  getModelRoles: async (projectId) => {
    const defaults = await readModelDefaultsFromPiSettings(resolveAgentDir(), await projectPath(projectId));
    if (!defaults.model) return {};
    return {
      default: defaults.thinkingLevel ? `${defaults.model}:${defaults.thinkingLevel}` : defaults.model,
    };
  },
  getApprovalMode: async (projectId) => {
    await projectPath(projectId);
    return { mode: "write", source: "global" };
  },
  setModelRole: async (role, model, thinking) => {
    const parsedRole = parseString(role, "role", 64);
    const parsedModel = model === null ? null : parseModelKey(model);
    const parsedThinking = thinking === null ? null : parseString(thinking, "thinking", 16);
    if (parsedRole === "default") {
      await writeModelDefaultsToPiSettings(resolveAgentDir(), parsedModel, parsedThinking);
      onOmpConfigChanged("defaultModel");
      emitEvent("ompConfigChanged", { key: "defaultModel" });
    }
  },
  getModelInsights: async (projectId, keys) => {
    if (!Array.isArray(keys) || keys.length > maxInsightKeys) {
      throw new IpcValidationError(`keys 必须是不超过 ${maxInsightKeys} 项的数组`);
    }
    for (const k of keys) parseModelKey(k);
    const dir = await projectPath(projectId);
    const agentDir = resolveAgentDir();
    const [{ data: globalObj }, projectRes] = await Promise.all([
      readPiSettingsObject(piSettingsFilePath(agentDir, "global"), false),
      dir ? readPiSettingsObject(piSettingsFilePath(agentDir, "project", dir), false) : Promise.resolve(null),
    ]);
    const projectReserve = projectRes
      ? parseCompactionNumber(getNestedValue(projectRes.data, "compaction.reserveTokens"))
      : null;
    const globalReserve = parseCompactionNumber(getNestedValue(globalObj, "compaction.reserveTokens"));
    const compaction: CompactionSettings = {
      thresholdTokens: 0,
      thresholdPercent: 0,
      reserveTokens: projectReserve ?? globalReserve,
      modelThresholds: {},
      modelThresholdsEnabled: false,
      source: projectReserve !== null ? "project" : "global",
    };
    return { perf: {}, compaction };
  },
  getOmpKeybindings: () => readPiKeybindings(resolveAgentDir()),
};
