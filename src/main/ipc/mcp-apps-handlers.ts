// MCP Apps（交互界面容器）的 IPC：校验参数 → 转调 src/main/mcp-apps/mcp-apps-service.ts。
// 目录由主进程算：agent 目录来自 PI_CODING_AGENT_DIR / ~/.pi/agent，项目目录来自项目记录（不用渲染进程传的路径）。
import type { HandlerGroup, ProjectId } from "../../shared/ipc.ts";
import { resolveAgentDir } from "../history/session-index.ts";
import { mcpAppsService } from "../mcp-apps/mcp-apps-service.ts";
import { getTaskPool } from "../tasks/runtime.ts";
import { IpcValidationError, parseProjectId, parseRecord, parseString } from "./validate.ts";

const MAX_SERVER_CHARS = 128;
const MAX_URI_CHARS = 2_048;
const MAX_TOOL_NAME_CHARS = 200;

interface McpAppScope {
  readonly agentDir: string;
  readonly projectDir: string | null;
}

/** `null` = 只用全局配置；否则按 projectId 查主进程里的项目目录（项目是否存在由 getTaskPool 判）。 */
async function resolveScope(projectId: unknown): Promise<McpAppScope> {
  const agentDir = resolveAgentDir();
  if (projectId === null) return { agentDir, projectDir: null };
  const id: ProjectId = parseProjectId(projectId);
  return { agentDir, projectDir: await (await getTaskPool()).projectPath(id) };
}

/** 非空、限长、不带控制字符（换行、NUL 之类的字段会污染子进程 stdin 与 HTTP 头）。 */
function parseToken(value: unknown, name: string, maxChars: number): string {
  const text = parseString(value, name, maxChars);
  if (/[\p{Cc}]/u.test(text)) throw new IpcValidationError(`${name} 不能包含控制字符`);
  return text;
}

export const mcpAppsHandlers: HandlerGroup<
  "listMcpApps" | "readMcpAppResource" | "callMcpAppTool" | "closeMcpAppServer"
> = {
  listMcpApps: async (projectId) => {
    const scope = await resolveScope(projectId);
    return mcpAppsService.listMcpApps(scope.agentDir, scope.projectDir);
  },
  readMcpAppResource: async (projectId, server, uri) => {
    const scope = await resolveScope(projectId);
    return mcpAppsService.readMcpAppResource(
      scope.agentDir,
      scope.projectDir,
      parseToken(server, "server", MAX_SERVER_CHARS),
      parseToken(uri, "uri", MAX_URI_CHARS),
    );
  },
  callMcpAppTool: async (projectId, server, toolName, args) => {
    const scope = await resolveScope(projectId);
    return mcpAppsService.callMcpAppTool(
      scope.agentDir,
      scope.projectDir,
      parseToken(server, "server", MAX_SERVER_CHARS),
      parseToken(toolName, "toolName", MAX_TOOL_NAME_CHARS),
      parseRecord(args, "args"),
    );
  },
  closeMcpAppServer: async (server) => {
    await mcpAppsService.closeServer(parseToken(server, "server", MAX_SERVER_CHARS));
  },
};
