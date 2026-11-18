// MCP Apps 交互插件容器的共享契约类型（兼容 `@modelcontextprotocol/ext-apps` 协议）。
import type { PiConfigScope } from "./pi-config-types.ts";

export interface McpAppResourceItem {
  readonly server: string;
  readonly scope: PiConfigScope;
  readonly uri: string;
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
}

export interface McpAppToolItem {
  readonly server: string;
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly resourceUri: string;
}

export interface McpAppServerSnapshot {
  readonly server: string;
  readonly scope: PiConfigScope;
  readonly resources: readonly McpAppResourceItem[];
  readonly tools: readonly McpAppToolItem[];
  readonly error?: string | undefined;
}

export interface McpAppReadResult {
  readonly server: string;
  readonly uri: string;
  readonly mimeType: string;
  readonly html: string;
  readonly csp?:
    | {
        readonly connectDomains?: readonly string[] | undefined;
        readonly resourceDomains?: readonly string[] | undefined;
      }
    | undefined;
}

export interface McpAppContentBlock {
  readonly type: string;
  readonly text?: string | undefined;
  readonly data?: string | undefined;
  readonly mimeType?: string | undefined;
}

export interface McpAppToolCallResult {
  readonly content: readonly McpAppContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}
