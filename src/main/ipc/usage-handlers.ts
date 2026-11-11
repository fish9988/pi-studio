// 用量统计 IPC：从 `~/.pi/agent/sessions/**/*.jsonl` 增量汇总近 365 天每日消耗与模型分布。
import path from "node:path";
import { app } from "electron";
import type { HandlerGroup, UsageHeatmap } from "../../shared/ipc.ts";
import { resolveAgentDir } from "../history/session-index.ts";
import { readPiUsageHeatmap } from "../usage/pi-session-heatmap.ts";
import { parseBoolean } from "./validate.ts";

const HEATMAP_TTL_MS = 3 * 60 * 1000;

let heatmapCache: { agentDir: string; at: number; value: Promise<UsageHeatmap> } | null = null;

function heatmapCacheFilePath(): string {
  return path.join(app.getPath("userData"), "pi-usage-heatmap-cache.json");
}

export const usageHandlers: HandlerGroup<"getUsageQuota" | "getUsageHeatmap"> = {
  getUsageQuota: (refresh) => {
    parseBoolean(refresh, "refresh");
    return Promise.resolve({
      generatedAt: Date.now(),
      accounts: [],
      unavailable: [],
    });
  },
  getUsageHeatmap: (refresh) => {
    const force = parseBoolean(refresh, "refresh");
    const agentDir = resolveAgentDir();
    const now = Date.now();
    if (
      force ||
      heatmapCache === null ||
      heatmapCache.agentDir !== agentDir ||
      now - heatmapCache.at > HEATMAP_TTL_MS
    ) {
      const value = readPiUsageHeatmap(agentDir, heatmapCacheFilePath(), now);
      const entry = { agentDir, at: now, value };
      heatmapCache = entry;
      value.catch(() => {
        if (heatmapCache === entry) heatmapCache = null;
      });
    }
    return heatmapCache.value;
  },
};
