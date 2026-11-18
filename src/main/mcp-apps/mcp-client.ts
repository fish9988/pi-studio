// MCP（Model Context Protocol）客户端：stdio 与 Streamable HTTP 两种传输，零第三方依赖。
// 只实现本仓库需要的最小子集：initialize → notifications/initialized → resources/list → resources/read →
// tools/list → tools/call；MCP Apps 的交互界面识别见 isMcpAppResourceUri / extractUiResourceUri。
// 拼帧：stdio 严格按 `\n` 切（剥离可选 `\r`），不用 readline（消息正文可能含 U+2028 / U+2029 被误切）；
// HTTP 同时吃 application/json 与 text/event-stream（SSE），Mcp-Session-Id 会话头自己维护。
// 连接与调用的失败一律抛出（调用方决定怎么显示），不返回假的空结果。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "../../shared/type-guards.ts";
import { killProcessTree } from "../platform/process-tree.ts";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_LEGACY_PROTOCOL_VERSION = "2024-11-05";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PAGES = 100;
const MAX_STDERR_CHARS = 4_096;
const CLIENT_INFO = { name: "pi-studio", version: "1.0.0" } as const;

export interface McpContentBlock {
  readonly type: string;
  readonly text?: string | undefined;
  readonly data?: string | undefined;
  readonly mimeType?: string | undefined;
}

export interface McpResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface McpResourceContents {
  readonly uri: string;
  readonly mimeType?: string | undefined;
  readonly text?: string | undefined;
  readonly blob?: string | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface McpCallToolResult {
  readonly content: readonly McpContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

/** stdio 与 HTTP 两种传输共用的客户端形状（MCP Apps 服务只认这个接口）。 */
export interface McpClientHandle {
  initialize(): Promise<void>;
  listResources(): Promise<McpResourceDefinition[]>;
  readResource(uri: string): Promise<McpResourceContents>;
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

/** JSON-RPC 错误响应；`code` 供 initialize 判断要不要退回旧协议版本。 */
export class McpJsonRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "McpJsonRpcError";
  }
}

// ============================================================================
// 纯函数（单测直接测；主进程与渲染进程都不该绕开它们自己解析）
// ============================================================================

/** MCP App 资源：`ui://` 开头的 URI，或 MIME 里带 `profile=mcp-app`。 */
export function isMcpAppResourceUri(uri: string, mimeType?: string): boolean {
  if (uri.startsWith("ui://")) return true;
  if (mimeType === undefined) return false;
  return mimeType.toLowerCase().includes("profile=mcp-app");
}

/**
 * 从 `tools/list` 的工具定义里取交互界面的资源 URI。
 * 规范写法是 `_meta.ui.resourceUri`，扁平写法 `_meta["ui/resourceUri"]` 也认（早期实现两种都有）。
 */
export function extractUiResourceUri(tool: Record<string, unknown>): string | undefined {
  const meta = tool["_meta"];
  if (!isRecord(meta)) return undefined;
  const nested = meta["ui"];
  if (isRecord(nested)) {
    const uri = nested["resourceUri"];
    if (typeof uri === "string" && uri !== "") return uri;
  }
  const flat = meta["ui/resourceUri"];
  return typeof flat === "string" && flat !== "" ? flat : undefined;
}

/** 解析 `text/event-stream` 响应：按空行分事件，取每个事件的 `data:` 行拼成 JSON-RPC 消息。 */
export function parseSseJsonRpcMessages(raw: string): unknown[] {
  const messages: unknown[] = [];
  let data: string[] = [];

  const flush = () => {
    if (data.length === 0) return;
    const payload = data.join("\n");
    data = [];
    const parsed = parseJsonValue(payload);
    if (parsed === null) return;
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue; // 注释 / 心跳
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") continue; // event / id / retry 与 JSON-RPC 无关
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    data.push(rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue);
  }
  flush();
  return messages;
}

/** 严格按 `\n` 切帧、剥掉行尾 `\r` 的 JSON-RPC 流解码器；非 JSON 噪音行（服务器打到 stdout 的日志）丢弃。 */
export class JsonRpcLineDecoder {
  #buffer = "";

  /** 喂一段文本，返回这之后能凑成完整行的 JSON-RPC 消息。 */
  push(chunk: string): unknown[] {
    this.#buffer += chunk;
    const messages: unknown[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) break;
      const rawLine = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim() === "") continue;
      const parsed = parseJsonValue(line);
      if (parsed !== null) messages.push(parsed);
    }
    return messages;
  }

  /** 还没凑满一行的残留（正常应为空；连接中途断开时用来判断是不是半个消息）。 */
  get pending(): string {
    return this.#buffer;
  }
}

/**
 * 把配置里的命令翻译成实际要 spawn 的 `{ command, args }`。
 * Windows 上 `.cmd` / `.bat`（npm 装的 `npx`、`uvx` 等）不是可执行文件，直接 spawn 会 ENOENT：
 * 交给 `cmd.exe /d /s /c` 执行。全程不写 `shell: true`（scripts/check.ts 机械拦截，参数走数组不进 shell）。
 */
export function resolveStdioCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const passthrough = { command, args: [...args] };
  if (platform !== "win32") return passthrough;
  const resolved = /[\\/]/.test(command) || path.extname(command) !== "" ? command : (findOnPath(command) ?? command);
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args: [...args] };
  const comSpec = process.env["ComSpec"] ?? "cmd.exe";
  return { command: comSpec, args: ["/d", "/s", "/c", resolved, ...args] };
}

// ============================================================================
// 内部工具
// ============================================================================

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // 噪音行：忽略，不当成错误（服务器往 stdout 打字是常见现象）
  }
}

/** 按 PATHEXT 顺序在 PATH 里找一个裸命令（只在 win32 上用到）。 */
function findOnPath(name: string): string | null {
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((dir) => dir !== "");
  for (const ext of [".com", ".exe", ".bat", ".cmd", ""]) {
    for (const dir of dirs) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} 返回的不是 JSON 对象`);
  return value;
}

/** HTTP 地址只留 origin + path：查询串里可能有 token，不能进错误信息。 */
function displayUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

interface PendingCall {
  readonly method: string;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** id 分配 + 未完成请求的登记表；stdio 与 HTTP 共用同一套超时与错误格式化。 */
class JsonRpcSession {
  readonly #label: string;
  readonly #pending = new Map<number, PendingCall>();
  #nextId = 1;

  constructor(label: string) {
    this.#label = label;
  }

  begin(method: string, timeoutMs: number): { id: number; promise: Promise<unknown> } {
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`${this.#label} ${method} 超过 ${timeoutMs}ms 没有响应`));
    }, timeoutMs);
    timer.unref();
    this.#pending.set(id, { method, timer, resolve, reject });
    return { id, promise };
  }

  /** 处理一条入站消息；是（或不是）本次响应都返回它是否被当成响应消费掉。 */
  handle(message: unknown): boolean {
    if (!isRecord(message)) return false;
    const id = message["id"];
    if (typeof id !== "number") return false; // 通知、以及服务端发来的请求（本客户端不支持）都不回
    const error = message["error"];
    if (isRecord(error)) {
      const code = typeof error["code"] === "number" ? error["code"] : -32_603;
      const text = typeof error["message"] === "string" ? error["message"] : "unknown error";
      this.settle(id, new McpJsonRpcError(code, `${this.#label} ${text} (code ${code})`));
      return true;
    }
    const call = this.#pending.get(id);
    if (call === undefined) return true; // 超时之后迟到的响应：丢弃
    this.#pending.delete(id);
    clearTimeout(call.timer);
    call.resolve(message["result"]);
    return true;
  }

  settle(id: number, error: unknown): void {
    const call = this.#pending.get(id);
    if (call === undefined) return;
    this.#pending.delete(id);
    clearTimeout(call.timer);
    call.reject(error instanceof Error ? error : new Error(String(error)));
  }

  failAll(error: Error): void {
    for (const id of this.#pending.keys()) this.settle(id, error);
  }
}

function parseTool(raw: unknown): McpToolDefinition | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw["name"] === "string" ? raw["name"] : "";
  if (name === "") return null;
  return {
    name,
    ...(typeof raw["title"] === "string" ? { title: raw["title"] } : {}),
    ...(typeof raw["description"] === "string" ? { description: raw["description"] } : {}),
    ...(isRecord(raw["inputSchema"]) ? { inputSchema: raw["inputSchema"] } : {}),
    ...(isRecord(raw["_meta"]) ? { _meta: raw["_meta"] } : {}),
  };
}

function parseResource(raw: unknown): McpResourceDefinition | null {
  if (!isRecord(raw)) return null;
  const uri = typeof raw["uri"] === "string" ? raw["uri"] : "";
  if (uri === "") return null;
  const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : uri;
  return {
    uri,
    name,
    ...(typeof raw["title"] === "string" ? { title: raw["title"] } : {}),
    ...(typeof raw["description"] === "string" ? { description: raw["description"] } : {}),
    ...(typeof raw["mimeType"] === "string" ? { mimeType: raw["mimeType"] } : {}),
    ...(isRecord(raw["_meta"]) ? { _meta: raw["_meta"] } : {}),
  };
}

function parseContents(raw: unknown, what: string): McpResourceContents {
  const record = requireRecord(raw, what);
  const text = typeof record["text"] === "string" ? record["text"] : undefined;
  const blob = typeof record["blob"] === "string" ? record["blob"] : undefined;
  if (text === undefined && blob === undefined) throw new Error(`${what} 既没有 text 也没有 blob`);
  return {
    uri: typeof record["uri"] === "string" ? record["uri"] : "",
    ...(typeof record["mimeType"] === "string" ? { mimeType: record["mimeType"] } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(blob !== undefined ? { blob } : {}),
    ...(isRecord(record["_meta"]) ? { _meta: record["_meta"] } : {}),
  };
}

function parseCallToolResult(raw: unknown, what: string): McpCallToolResult {
  const record = requireRecord(raw, what);
  const content: McpContentBlock[] = [];
  if (Array.isArray(record["content"])) {
    for (const item of record["content"]) {
      if (!isRecord(item)) continue;
      const type = typeof item["type"] === "string" ? item["type"] : "";
      if (type === "") continue;
      content.push({
        type,
        ...(typeof item["text"] === "string" ? { text: item["text"] } : {}),
        ...(typeof item["data"] === "string" ? { data: item["data"] } : {}),
        ...(typeof item["mimeType"] === "string" ? { mimeType: item["mimeType"] } : {}),
      });
    }
  }
  return {
    content,
    ...(record["structuredContent"] !== undefined ? { structuredContent: record["structuredContent"] } : {}),
    ...(record["isError"] === true ? { isError: true } : {}),
    ...(isRecord(record["_meta"]) ? { _meta: record["_meta"] } : {}),
  };
}

// ============================================================================
// 共用协议流程（握手、分页、read / tools.call），传输只管收发
// ============================================================================

abstract class JsonRpcClientBase implements McpClientHandle {
  readonly #session: JsonRpcSession;
  readonly timeoutMs: number;
  readonly label: string;
  #protocolVersion = MCP_PROTOCOL_VERSION;
  #closing: Promise<void> | null = null;
  #closed = false;

  constructor(label: string, timeoutMs: number) {
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.#session = new JsonRpcSession(label);
  }

  /** 发一条消息出去（stdio 写一行；HTTP POST 一次并把响应喂回来）。 */
  protected abstract transmit(message: Record<string, unknown>): Promise<void>;

  /** 关掉底层传输（子进程 / 会话）；必须 resolve，不抛。 */
  protected abstract teardown(): Promise<void>;

  protected accept(message: unknown): void {
    this.#session.handle(message);
  }

  protected acceptAll(messages: readonly unknown[]): void {
    for (const message of messages) this.#session.handle(message);
  }

  protected fail(error: Error): void {
    this.#session.failAll(error);
  }

  protected get closed(): boolean {
    return this.#closed;
  }

  get protocolVersion(): string {
    return this.#protocolVersion;
  }

  async initialize(): Promise<void> {
    const params = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { ...CLIENT_INFO },
    };
    let result: unknown;
    try {
      result = await this.request("initialize", params);
    } catch (error) {
      // 只认旧版握手流程的实现会回 -32600 / -32602：退回 2024-11-05 再握一次，其它错误照抛。
      const rejectVersion = error instanceof McpJsonRpcError && (error.code === -32_600 || error.code === -32_602);
      if (!rejectVersion) throw error;
      result = await this.request("initialize", { ...params, protocolVersion: MCP_LEGACY_PROTOCOL_VERSION });
    }
    const record = requireRecord(result, `${this.label} initialize`);
    if (typeof record["protocolVersion"] === "string" && record["protocolVersion"] !== "") {
      this.#protocolVersion = record["protocolVersion"];
    }
    await this.transmit({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listResources(): Promise<McpResourceDefinition[]> {
    const resources = new Map<string, McpResourceDefinition>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = requireRecord(
        await this.request("resources/list", cursor === undefined ? {} : { cursor }),
        `${this.label} resources/list`,
      );
      if (Array.isArray(result["resources"])) {
        for (const item of result["resources"]) {
          const resource = parseResource(item);
          if (resource !== null) resources.set(resource.uri, resource);
        }
      }
      const next = result["nextCursor"];
      if (typeof next !== "string" || next === "") return [...resources.values()];
      cursor = next;
    }
    throw new Error(`${this.label} resources/list 分页超过 ${MAX_PAGES} 页（nextCursor 可能循环了）`);
  }

  async readResource(uri: string): Promise<McpResourceContents> {
    const result = requireRecord(await this.request("resources/read", { uri }), `${this.label} resources/read ${uri}`);
    const contents = result["contents"];
    if (!Array.isArray(contents) || contents.length === 0) {
      throw new Error(`${this.label} resources/read ${uri} 没有返回 contents`);
    }
    return parseContents(contents[0], `${this.label} resources/read ${uri} 的 contents[0]`);
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const tools = new Map<string, McpToolDefinition>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = requireRecord(
        await this.request("tools/list", cursor === undefined ? {} : { cursor }),
        `${this.label} tools/list`,
      );
      if (Array.isArray(result["tools"])) {
        for (const item of result["tools"]) {
          const tool = parseTool(item);
          if (tool !== null) tools.set(tool.name, tool);
        }
      }
      const next = result["nextCursor"];
      if (typeof next !== "string" || next === "") return [...tools.values()];
      cursor = next;
    }
    throw new Error(`${this.label} tools/list 分页超过 ${MAX_PAGES} 页（nextCursor 可能循环了）`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    return parseCallToolResult(result, `${this.label} tools/call ${name}`);
  }

  async close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.fail(new Error(`${this.label} 已关闭`));
    this.#closing = this.teardown();
    return this.#closing;
  }

  protected async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) throw new Error(`${this.label} 已关闭`);
    const { id, promise } = this.#session.begin(method, this.timeoutMs);
    try {
      await this.transmit({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      // 传输层失败（进程没了、HTTP 4xx/5xx）：把同一个错误交给等响应的 promise，状态不留在 pending 里。
      this.#session.settle(id, error);
    }
    return promise;
  }
}

// ============================================================================
// stdio 传输
// ============================================================================

export interface McpStdioClientOptions {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  /** 叠加在 `process.env` 之上；值只进子进程，绝不出现在日志里。 */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly label?: string | undefined;
}

export class McpStdioClient extends JsonRpcClientBase {
  readonly #options: McpStdioClientOptions;
  readonly #decoder = new StringDecoder("utf8");
  readonly #framing = new JsonRpcLineDecoder();
  #child: ReturnType<typeof spawn> | null = null;
  #stdin: Writable | null = null;
  #exited = false;
  #stderrTail = "";

  constructor(options: McpStdioClientOptions) {
    super(options.label ?? `MCP stdio 服务器 ${options.command}`, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#options = options;
  }

  protected async transmit(message: Record<string, unknown>): Promise<void> {
    const stdin = this.#ensureChild();
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (error) => {
        if (error) reject(new Error(`${this.label} 写入失败：${error.message}`));
        else resolve();
      });
    });
  }

  protected async teardown(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    this.#stdin = null;
    if (child === null) return;
    if (child.stdin !== null) child.stdin.end();
    if (child.pid === undefined) {
      child.kill();
      return;
    }
    await killProcessTree(child.pid);
  }

  #ensureChild(): Writable {
    if (this.#stdin !== null) return this.#stdin;
    if (this.closed) throw new Error(`${this.label} 已关闭`);
    // 进程已经退出了就不再偷偷重启：没握过手的新进程会按旧会话处理请求，错得更难查。
    if (this.#exited) throw new Error(`${this.label} 进程已退出，需要重新连接`);
    const plan = resolveStdioCommand(this.#options.command, this.#options.args ?? []);
    const child = spawn(plan.command, plan.args, {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) {
      child.kill();
      throw new Error(`${this.label} 子进程的 stdin/stdout 不可用`);
    }

    this.#child = child;
    this.#stdin = stdin;

    stdout.on("data", (chunk: Buffer) => {
      for (const message of this.#framing.push(this.#decoder.write(chunk))) this.accept(message);
    });
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-MAX_STDERR_CHARS).trimStart();
    });
    stdin.on("error", () => {
      // 子进程先退出时写 stdin 会 EPIPE：真正的错误由下面的 exit 统一报出。
    });
    child.on("error", (error) => {
      this.#child = null;
      this.#stdin = null;
      this.fail(new Error(`${this.label} 启动失败：${error.message}`));
    });
    child.on("exit", (code, signal) => {
      this.#child = null;
      this.#stdin = null;
      this.#exited = true;
      const reason = signal === null ? `退出码 ${code}` : `信号 ${signal}`;
      const tail = this.#stderrTail.trim();
      this.fail(new Error(`${this.label} 进程已结束（${reason}）${tail === "" ? "" : `：${tail}`}`));
    });
    return stdin;
  }
}

// ============================================================================
// Streamable HTTP 传输
// ============================================================================

export interface McpHttpClientOptions {
  readonly url: string;
  /** 配置里的 headers（可能带 Authorization），只发请求、不进日志。 */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly label?: string | undefined;
}

export class McpHttpClient extends JsonRpcClientBase {
  readonly #options: McpHttpClientOptions;
  readonly #endpoint: string;
  #sessionId: string | null = null;

  constructor(options: McpHttpClientOptions) {
    super(options.label ?? `MCP HTTP 服务器 ${displayUrl(options.url)}`, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#options = options;
    this.#endpoint = options.url;
  }

  protected async transmit(message: Record<string, unknown>): Promise<void> {
    const headers = new Headers(this.#options.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    if (this.#sessionId !== null) headers.set("mcp-session-id", this.#sessionId);

    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "follow",
    });

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId !== null && sessionId !== "") this.#sessionId = sessionId;

    if (!response.ok && response.status !== 202) {
      const detail = (await response.text()).slice(0, 512).trim();
      throw new Error(`${this.label} HTTP ${response.status}${detail === "" ? "" : `：${detail}`}`);
    }
    // 通知（notifications/initialized 等）按规范回 202，没有正文。
    const id = message["id"];
    if (response.status === 202 || typeof id !== "number") {
      await response.body?.cancel();
      return;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const messages = contentType.includes("text/event-stream")
      ? await readSseUntilResponse(response, id, this.label)
      : parseJsonBody(await response.text(), this.label);
    if (messages.length === 0) throw new Error(`${this.label} 的响应里没有 JSON-RPC 消息`);
    this.acceptAll(messages);
  }

  protected async teardown(): Promise<void> {
    this.#sessionId = null;
  }
}

/**
 * 边收边切 `text/event-stream`：拿到本次请求的响应就取消流并返回。
 * 有实现会把 POST 的 SSE 连接挂着继续推通知，等 `response.text()` 会一直不返回，所以这里不等 EOF。
 */
async function readSseUntilResponse(response: Response, id: number, label: string): Promise<unknown[]> {
  const body = response.body;
  if (body === null) throw new Error(`${label} 的响应没有正文`);
  const reader = body.getReader();
  const decoder = new StringDecoder("utf8");
  const messages: unknown[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      messages.push(...parseSseJsonRpcMessages(buffer));
      if (!messages.some((message) => isRecord(message) && message["id"] === id)) {
        throw new Error(`${label} 的 SSE 响应里没有 id=${id} 的回复`);
      }
      return messages;
    }
    buffer += decoder.write(value);
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (boundary === null) break;
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      messages.push(...parseSseJsonRpcMessages(event));
      if (messages.some((message) => isRecord(message) && message["id"] === id)) {
        await reader.cancel().catch(() => undefined);
        return messages;
      }
    }
  }
}

function parseJsonBody(text: string, label: string): unknown[] {
  if (text.trim() === "") throw new Error(`${label} 返回了空的响应正文`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 返回的不是 JSON：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** 按配置新建活连接（服务层用它建池；两种传输都在这里收口）。 */
export interface McpClientTransportConfig {
  readonly transport: "stdio" | "http";
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly timeout?: number | undefined;
}

/** 依据 mcp.json 的配置建客户端；缺命令 / 缺 URL 时立刻抛（不建一个永远连不上的空客户端）。 */
export function createMcpClient(config: McpClientTransportConfig, label: string): McpClientHandle {
  const timeoutMs = config.timeout !== undefined ? config.timeout : DEFAULT_TIMEOUT_MS;
  if (config.transport === "http") {
    const url = config.url?.trim() ?? "";
    if (url === "") throw new Error(`${label} 缺少 url`);
    return new McpHttpClient({ url, headers: config.headers, timeoutMs, label });
  }
  const command = config.command?.trim() ?? "";
  if (command === "") throw new Error(`${label} 缺少 command`);
  return new McpStdioClient({ command, args: config.args, cwd: config.cwd, env: config.env, timeoutMs, label });
}
