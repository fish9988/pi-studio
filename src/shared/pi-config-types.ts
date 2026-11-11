// Pi 1.5+ (@earendil-works/pi-coding-agent) 专属配置、扩展包、MCP、提示词模板与系统提示词文档的共享契约类型。
import type { ProjectId, TaskId } from "./ipc.ts";

export type PiConfigScope = "global" | "project";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type PiMcpExposure = "codemode" | "deferred" | "direct" | "hidden";

export const PI_MCP_EXPOSURES: readonly PiMcpExposure[] = ["codemode", "deferred", "direct", "hidden"];

export type PiBuiltinToolId =
  "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls" | "codemode" | "tool_search";

export const PI_BUILTIN_TOOLS: readonly PiBuiltinToolId[] = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "codemode",
  "tool_search",
];

export type PiBuiltinExtensionId = "builtin:mcp" | "builtin:codemode" | "builtin:tool-search" | "builtin:llama.cpp";

export const PI_BUILTIN_EXTENSIONS: readonly PiBuiltinExtensionId[] = [
  "builtin:mcp",
  "builtin:codemode",
  "builtin:tool-search",
  "builtin:llama.cpp",
];

export interface PiMcpServerItem {
  name: string;
  scope: PiConfigScope;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  envKeys: string[];
  cwd?: string;
  url?: string;
  headerKeys: string[];
  enabled: boolean;
  exposure: PiMcpExposure;
  timeout?: number;
  description?: string;
}

export interface PiMcpServerSaveInput {
  scope: PiConfigScope;
  projectId: ProjectId | null;
  previousName?: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  /** 新填或修改的环境变量；空对象表示保持已有或无额外变量，clearEnv=true 时清空。 */
  env?: Record<string, string>;
  clearEnv?: boolean;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  clearHeaders?: boolean;
  enabled: boolean;
  exposure: PiMcpExposure;
  timeout?: number;
  description?: string;
}

export interface PiPackageItem {
  source: string;
  scope: PiConfigScope;
  kind: "npm" | "git" | "local";
}

export interface PiPromptTemplate {
  name: string;
  scope: PiConfigScope;
  description: string;
  fileName: string;
}

export type PiSystemDocKind = "AGENTS.md" | "SYSTEM.md" | "APPEND_SYSTEM.md";

export const PI_SYSTEM_DOC_KINDS: readonly PiSystemDocKind[] = ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"];

export interface PiSystemDoc {
  kind: PiSystemDocKind;
  scope: PiConfigScope;
  exists: boolean;
  content: string;
}

export interface PiBuiltinExtensionState {
  id: PiBuiltinExtensionId;
  enabled: boolean;
}

export interface PiResourcesSnapshot {
  packages: PiPackageItem[];
  builtinExtensions: PiBuiltinExtensionState[];
  customExtensions: string[];
  mcpServers: PiMcpServerItem[];
  prompts: PiPromptTemplate[];
  enableSkillCommands: boolean;
}

export interface PiProviderAuthStatus {
  id: string;
  name: string;
  supportsOAuth: boolean;
  acceptsApiKey: boolean;
  envVars: string[];
  activeEnvVar: string | null;
  authType: "oauth" | "api_key" | null;
  accountHint: string | null;
  modelCount: number;
}

export type PiConfigFileKind = "settings.json" | "models.json" | "mcp.json" | "keybindings.json" | "auth.json";

export interface PiCloneResult {
  task: { id: TaskId };
}
