// 会话信息对话框与请求记录追踪 IPC：直接从 Pi 会话 `.jsonl` 文件读取文件头、按模型用量与每次请求 / 工具调用记录。
import type { HandlerGroup, SessionHeaderInfo } from "../../shared/ipc.ts";
import { resolveAgentDir } from "../history/session-index.ts";
import { readSessionHeader } from "../session-info/session-header.ts";
import { readSessionPins } from "../session-info/session-pins.ts";
import { getTaskPool } from "../tasks/runtime.ts";
import { readSessionUsage } from "../tsp/session-files.ts";
import { readPiSessionTrace } from "../usage/pi-session-heatmap.ts";
import { parseBoolean, parseTaskId } from "./validate.ts";

export const sessionInfoHandlers: HandlerGroup<
  "getTaskSessionInfo" | "getTaskSessionTrace" | "getShareSettings" | "shareTask"
> = {
  async getTaskSessionInfo(taskId) {
    const id = parseTaskId(taskId);
    const pool = await getTaskPool();
    const context = pool.taskGitContext(id);
    const sessionFile = pool.sessionFileOf(id);
    const parsed = sessionFile === null ? null : await readSessionHeader(sessionFile);
    const pins = await readSessionPins(resolveAgentDir());
    const { id: sessionId, ...header } = parsed ?? { id: null };
    return {
      sessionId,
      sessionFile,
      header: parsed === null ? null : (header as SessionHeaderInfo),
      pinned: sessionId !== null && pins.has(sessionId),
      projectPath: context.projectPath,
      worktree: context.worktree,
      usage: await readSessionUsage(sessionFile),
    };
  },

  async getTaskSessionTrace(taskId, refresh) {
    const id = parseTaskId(taskId);
    parseBoolean(refresh, "refresh");
    const sessionFile = (await getTaskPool()).sessionFileOf(id);
    return readPiSessionTrace(sessionFile);
  },

  getShareSettings(taskId) {
    parseTaskId(taskId);
    return Promise.resolve({
      serverUrl: "",
      store: "gist",
      redactSecrets: true,
    });
  },

  shareTask(taskId, gist) {
    parseTaskId(taskId);
    parseBoolean(gist, "gist");
    return Promise.reject(new Error("Pi 不内置远程分享服务，请使用 /export 导出本地 HTML 会话文件。"));
  },
};
