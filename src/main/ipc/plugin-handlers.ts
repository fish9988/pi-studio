// 旧版插件市场 IPC 兼容桩（Pi 扩展包改走 `piHandlers.runPiPackageAction` / `getPiResources`）。
import type { HandlerGroup } from "../../shared/ipc.ts";
import { parseMarketplaceName, parsePluginAction, parsePluginName } from "../../shared/omp-output/plugins.ts";
import { IpcValidationError, parseProjectId } from "./validate.ts";

function validated<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch (error) {
    throw new IpcValidationError(error instanceof Error ? error.message : String(error));
  }
}

export const pluginHandlers: HandlerGroup<"listPlugins" | "discoverPlugins" | "getPluginConfig" | "runPluginAction"> = {
  listPlugins: (projectId) => {
    if (projectId !== null && projectId !== undefined) parseProjectId(projectId);
    return Promise.resolve({ npm: [], marketplace: [], marketplaces: [] });
  },
  discoverPlugins: (marketplace) => {
    validated(parseMarketplaceName, marketplace);
    return Promise.resolve([]);
  },
  getPluginConfig: (plugin) => {
    validated(parsePluginName, plugin);
    return Promise.reject(new Error("请在「设置 → 扩展、包与 Skill」中管理 Pi 扩展包。"));
  },
  runPluginAction: (action, projectId) => {
    validated(parsePluginAction, action);
    if (projectId !== null && projectId !== undefined) parseProjectId(projectId);
    return Promise.reject(new Error("请在「设置 → 扩展、包与 Skill」中使用 pi install / remove / update 管理包。"));
  },
};
