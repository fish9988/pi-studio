// MCP Apps 服务：把 mcp.json 里启用的 MCP 服务器连起来，列出能渲染交互界面的资源（`ui://` 或 `profile=mcp-app`），
// 并按需 read / tools.call。连接池按「服务器名 + 配置签名」缓存：配置一改就换新连接、旧连接关掉。
// 边界：单个服务器连不上只记在该服务器的快照里（error 字段），列表照常返回；read / call 失败一律抛错，不假装成功。
// 日志只写服务器名、传输类型和错误文字：env / headers 的值（API Key、Authorization）绝不进日志。
import { createHash } from "node:crypto";
import type {
  McpAppContentBlock,
  McpAppReadResult,
  McpAppServerSnapshot,
  McpAppToolCallResult,
} from "../../shared/mcp-apps.ts";
import { isRecord } from "../../shared/type-guards.ts";
import { log } from "../log/log.ts";
import { listEnabledMcpRawServers, type McpRawServerConfig } from "../pi-config/resources.ts";
import { registerShutdownHook } from "../window/shutdown.ts";
import {
  createMcpClient,
  extractUiResourceUri,
  isMcpAppResourceUri,
  type McpCallToolResult,
  type McpClientHandle,
  type McpResourceDefinition,
  type McpToolDefinition,
} from "./mcp-client.ts";

const DEFAULT_APP_MIME_TYPE = "text/html";

export interface McpServerConnection {
  readonly key: string;
  readonly config: McpRawServerConfig;
  readonly client: McpClientHandle;
  resources: McpResourceDefinition[];
  tools: McpToolDefinition[];
  /** 连不上时的原因；有值时 client 已经关掉，不再复用。 */
  error: string | null;
  ready: Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortedEntries(map: Readonly<Record<string, string>> | undefined): [string, string][] {
  if (map === undefined) return [];
  return Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 配置签名：开关、命令、URL、env / headers 的键值任何变化都算另一套配置（只用来做缓存键，不外泄）。 */
function configSignature(config: McpRawServerConfig): string {
  const material = JSON.stringify([
    config.scope,
    config.transport,
    config.command ?? null,
    config.args ?? [],
    config.cwd ?? null,
    config.url ?? null,
    config.timeout ?? null,
    sortedEntries(config.env),
    sortedEntries(config.headers),
  ]);
  return createHash("sha256").update(material).digest("hex");
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item !== "");
  return items.length === 0 ? undefined : items;
}

/** MCP App 的 CSP 声明在 `_meta.ui.csp` 里（`connectDomains` / `resourceDomains`）。 */
function readCsp(metas: readonly (Record<string, unknown> | undefined)[]): McpAppReadResult["csp"] {
  for (const meta of metas) {
    if (meta === undefined) continue;
    const ui = meta["ui"];
    const csp = isRecord(ui) ? ui["csp"] : undefined;
    if (!isRecord(csp)) continue;
    const connectDomains = stringList(csp["connectDomains"]);
    const resourceDomains = stringList(csp["resourceDomains"]);
    if (connectDomains === undefined && resourceDomains === undefined) continue;
    return {
      ...(connectDomains !== undefined ? { connectDomains } : {}),
      ...(resourceDomains !== undefined ? { resourceDomains } : {}),
    };
  }
  return undefined;
}

function toAppContentBlock(block: McpCallToolResult["content"][number]): McpAppContentBlock {
  return {
    type: block.type,
    ...(block.text !== undefined ? { text: block.text } : {}),
    ...(block.data !== undefined ? { data: block.data } : {}),
    ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
  };
}

function buildSnapshot(connection: McpServerConnection): McpAppServerSnapshot[] {
  const server = connection.config.name;
  const scope = connection.config.scope;

  const resources = connection.resources
    .filter((resource) => isMcpAppResourceUri(resource.uri, resource.mimeType))
    .map((resource) => ({
      server,
      scope,
      uri: resource.uri,
      name: resource.name,
      ...(resource.title !== undefined ? { title: resource.title } : {}),
      ...(resource.description !== undefined ? { description: resource.description } : {}),
      ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
    }));

  const tools = connection.tools.flatMap((tool) => {
    const resourceUri = extractUiResourceUri({ _meta: tool._meta });
    if (resourceUri === undefined) return [];
    return [
      {
        server,
        name: tool.name,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        resourceUri,
      },
    ];
  });

  // 既没有交互界面又没出错：这个服务器跟 MCP Apps 无关，不进列表。
  if (resources.length === 0 && tools.length === 0 && connection.error === null) return [];
  return [
    {
      server,
      scope,
      resources,
      tools,
      ...(connection.error !== null ? { error: connection.error } : {}),
    },
  ];
}

export class McpAppsService {
  readonly #connections = new Map<string, McpServerConnection>();
  readonly #opening = new Map<string, Promise<McpServerConnection>>();

  /** 当前所有启用的 MCP 服务器里能提供交互界面的那些；连不上的服务器带 error 出现在结果里。 */
  async listMcpApps(agentDir: string, projectDir: string | null): Promise<McpAppServerSnapshot[]> {
    const configs = await listEnabledMcpRawServers(agentDir, projectDir);
    const connections = await Promise.all(configs.map((config) => this.#connectionFor(config)));

    const liveKeys = new Set(connections.map((connection) => connection.key));
    await this.#closeKeys((key) => !liveKeys.has(key));

    return connections.flatMap(buildSnapshot);
  }

  async readMcpAppResource(
    agentDir: string,
    projectDir: string | null,
    server: string,
    uri: string,
  ): Promise<McpAppReadResult> {
    const connection = await this.requireConnection(agentDir, projectDir, server);
    const resource = connection.resources.find(
      (candidate) => candidate.uri === uri && isMcpAppResourceUri(candidate.uri, candidate.mimeType),
    );
    if (resource === undefined) {
      throw new Error(`MCP 服务器 ${server} 没有提供可渲染的资源 ${uri}`);
    }
    const contents = await connection.client.readResource(uri);
    const html =
      contents.text ?? (contents.blob !== undefined ? Buffer.from(contents.blob, "base64").toString("utf8") : "");
    if (html.trim() === "") throw new Error(`MCP 服务器 ${server} 返回的资源 ${uri} 是空的`);
    const csp = readCsp([contents._meta, resource._meta]);
    return {
      server,
      uri,
      mimeType: contents.mimeType ?? resource.mimeType ?? DEFAULT_APP_MIME_TYPE,
      html,
      ...(csp !== undefined ? { csp } : {}),
    };
  }

  async callMcpAppTool(
    agentDir: string,
    projectDir: string | null,
    server: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpAppToolCallResult> {
    const connection = await this.requireConnection(agentDir, projectDir, server);
    const tool = connection.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) throw new Error(`MCP 服务器 ${server} 没有工具 ${toolName}`);
    const result = await connection.client.callTool(toolName, args);
    return {
      content: result.content.map((block) => toAppContentBlock(block)),
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(result.isError === true ? { isError: true } : {}),
      ...(result._meta !== undefined ? { _meta: result._meta } : {}),
    };
  }

  /** 关掉某个服务器的所有连接（配置改动、用户手动断开都走这里）。 */
  async closeServer(server: string): Promise<void> {
    await this.#closeKeys((key) => this.#connections.get(key)?.config.name === server);
  }

  /** 应用退出时关掉全部连接，保证不留孤儿 MCP 子进程。 */
  async closeAll(): Promise<void> {
    await this.#closeKeys(() => true);
  }

  /** 按名字取活连接：配置里没有、或上次连接失败，都抛明确错误（不返回空壳）。 */
  async requireConnection(agentDir: string, projectDir: string | null, server: string): Promise<McpServerConnection> {
    const configs = await listEnabledMcpRawServers(agentDir, projectDir);
    const config = configs.find((candidate) => candidate.name === server);
    if (config === undefined) throw new Error(`MCP 服务器 ${server} 未启用或不存在`);
    const connection = await this.#connectionFor(config);
    if (connection.error !== null) {
      throw new Error(`连接 MCP 服务器 ${server} 失败：${connection.error}`);
    }
    return connection;
  }

  async #connectionFor(config: McpRawServerConfig): Promise<McpServerConnection> {
    const key = `${config.name}\u0000${configSignature(config)}`;
    const existing = this.#connections.get(key);
    if (existing !== undefined) {
      await existing.ready;
      return existing;
    }
    const opening = this.#opening.get(key);
    if (opening !== undefined) return opening;
    const promise = this.#open(config, key).finally(() => this.#opening.delete(key));
    this.#opening.set(key, promise);
    return promise;
  }

  /** 建连接并握手 + 拉资源/工具；失败只记在 connection.error 上，不让整个列表请求崩掉。 */
  async #open(config: McpRawServerConfig, key: string): Promise<McpServerConnection> {
    // 同名的旧连接（配置改过）先关掉，避免同一个服务器同时挂两个实例。
    await this.#closeKeys((_, connection) => connection.config.name === config.name);

    const label = `MCP 服务器 ${config.name}`;
    let client: McpClientHandle;
    try {
      client = createMcpClient(config, label);
    } catch (error) {
      // 配置本身不合法（缺 command / url）：不进池（不占住这个 key），修好配置后下一次列表立刻能连。
      const message = describeError(error);
      log.warn("mcp app server 配置无效", { server: config.name, transport: config.transport, message });
      return {
        key,
        config,
        client: unavailableClient(),
        resources: [],
        tools: [],
        error: message,
        ready: Promise.resolve(),
      };
    }

    const connection: McpServerConnection = {
      key,
      config,
      client,
      resources: [],
      tools: [],
      error: null,
      ready: Promise.resolve(),
    };
    this.#connections.set(key, connection);
    connection.ready = (async () => {
      try {
        await client.initialize();
        connection.resources = await client.listResources();
        connection.tools = await client.listTools();
        log.info("mcp app server 已连接", {
          server: config.name,
          transport: config.transport,
          resources: connection.resources.length,
          tools: connection.tools.length,
        });
      } catch (error) {
        connection.error = describeError(error);
        log.warn("mcp app server 连不上", {
          server: config.name,
          transport: config.transport,
          message: connection.error,
        });
        await client.close().catch(() => undefined);
      }
    })();
    await connection.ready;
    return connection;
  }

  async #closeKeys(predicate: (key: string, connection: McpServerConnection) => boolean): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, connection] of this.#connections) {
      if (!predicate(key, connection)) continue;
      this.#connections.delete(key);
      closing.push(connection.client.close().catch(() => undefined));
    }
    await Promise.all(closing);
  }
}

/** 配置无效时占位用的客户端：任何调用都抛，不会静默返回空数据。 */
function unavailableClient(): McpClientHandle {
  const fail = (): never => {
    throw new Error("MCP 服务器配置无效");
  };
  return {
    initialize: fail,
    listResources: fail,
    readResource: fail,
    listTools: fail,
    callTool: fail,
    close: async () => undefined,
  };
}

export const mcpAppsService = new McpAppsService();

// 退出时关掉所有 MCP 子进程（window/shutdown.ts 统一在 before-quit 里跑）。
registerShutdownHook(() => mcpAppsService.closeAll());
