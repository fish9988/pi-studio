// MCP Apps 宿主桥接（纯 TS：不碰 DOM，便于单测）。
//
// 帧格式：官方 `@modelcontextprotocol/ext-apps` 的 App ↔ 宿主之间发的是裸 JSON-RPC 2.0（`{ jsonrpc: "2.0", … }`，
// 没有外层信封），所以宿主直接收发裸帧；`buildMcpAppShim` 注入的垫片也发裸帧，同时认透明信封
// `{ __piMcpApp: true, token, message }`（老垫片与手工调试用）。
//
// 安全边界不在这个文件里：帧"是不是本沙箱 iframe 发的"由 McpAppHost 用 `event.source === iframe.contentWindow`
// 核对（单测里没有 iframe，这里只做形状校验、协议常量、注入与文本提取）。

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_HOST_NAME = "pi-studio";
/** 兜底版本号；McpAppHost 会用 AppInfo.version 盖过它（打包版才是真版本）。 */
export const MCP_APP_HOST_VERSION = "0.6.5";

/** 应用内联高度范围（px）：沙箱里报上来的高度夹在这个区间内，避免一次 ui/size-changed 把对话顶飞。 */
export const MCP_APP_MIN_HEIGHT = 200;
export const MCP_APP_MAX_HEIGHT = 720;

export type McpAppTheme = "light" | "dark";
export type McpAppDisplayMode = "inline" | "fullscreen";

export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** 一条 JSON-RPC 2.0 帧：请求（有 id + method）、通知（只有 method）、应答（有 id + result/error）。 */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId | null | undefined;
  method?: string | undefined;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError | undefined;
}

export interface JsonRpcRequest extends JsonRpcMessage {
  id: JsonRpcId;
  method: string;
}

export interface JsonRpcNotification extends JsonRpcMessage {
  id?: null | undefined;
  method: string;
}

/** `jsonrpc` 必须是字符串 "2.0"，且要么有 method，要么是带 result / error 的应答。 */
export function isJsonRpcMessage(data: unknown): data is JsonRpcMessage {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const frame = data as Record<string, unknown>;
  if (frame["jsonrpc"] !== "2.0") return false;
  if (typeof frame["method"] === "string") return true;
  return "result" in frame || "error" in frame;
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return typeof message.method === "string" && message.id !== undefined && message.id !== null;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return typeof message.method === "string" && (message.id === undefined || message.id === null);
}

/** `ui/initialize` 结果里的 hostContext：只带界面用得到的字段，宿主每次握手时按当前主题重建。 */
export interface McpAppHostContext {
  theme: McpAppTheme;
  displayMode: McpAppDisplayMode;
  availableDisplayModes: readonly McpAppDisplayMode[];
  platform: "desktop" | "web" | "mobile";
  locale: string;
  timeZone: string;
  userAgent: string;
  /** ext-apps 标准变量名 → 当前主题下的字面值（沙箱是 opaque origin，读不到宿主 :root 的变量）。 */
  styles: { variables: Record<string, string> };
}

export interface McpAppHostCapabilities {
  openLinks: Record<string, never>;
  serverTools: Record<string, never>;
  serverResources: Record<string, never>;
  message: { text: Record<string, never> };
  updateModelContext: { text: Record<string, never> };
}

export interface McpAppInitializeResult {
  protocolVersion: string;
  hostInfo: { name: string; version: string };
  hostCapabilities: McpAppHostCapabilities;
  hostContext: McpAppHostContext;
}

/** ext-apps 的 `ui/initialize` 结果。hostVersion 由宿主传 AppInfo.version，缺省用兜底常量。 */
export function buildInitializeResult(
  hostContext: McpAppHostContext,
  hostVersion: string = MCP_APP_HOST_VERSION,
): McpAppInitializeResult {
  return {
    protocolVersion: MCP_APP_PROTOCOL_VERSION,
    hostInfo: { name: MCP_APP_HOST_NAME, version: hostVersion },
    hostCapabilities: {
      openLinks: {},
      serverTools: {},
      serverResources: {},
      message: { text: {} },
      updateModelContext: { text: {} },
    },
    hostContext,
  };
}

/** `ui/open-link` 只放行普通网页链接：javascript: / data: / file: / 协议相对地址一律拒绝。 */
export function isAllowedExternalUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // URL 解析失败就是非法输入（用户/应用给的字符串是这一层的信任边界）。
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
}

const MAX_TEXT_DEPTH = 8;

function collectText(value: unknown, depth: number, out: string[]): void {
  if (depth > MAX_TEXT_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, depth + 1, out);
    return;
  }
  if (typeof value !== "object") return;
  const block = value as Record<string, unknown>;
  const text = block["text"];
  if (typeof text === "string") {
    out.push(text);
    return;
  }
  collectText(block["content"], depth + 1, out);
}

/** 从 `ui/message` / `ui/update-model-context` 的 content（数组、单个块或 `{ text }`）里提出纯文本。 */
export function extractTextFromContent(content: unknown): string {
  const parts: string[] = [];
  collectText(content, 0, parts);
  return parts.join("\n\n").trim();
}

/** 内联模式的应用高度：四舍五入后夹在 200–720px，非数字按默认值。 */
export function clampAppHeight(px: number, fallback: number = MCP_APP_MIN_HEIGHT): number {
  if (!Number.isFinite(px)) return fallback;
  return Math.min(MCP_APP_MAX_HEIGHT, Math.max(MCP_APP_MIN_HEIGHT, Math.round(px)));
}

/**
 * ext-apps 标准样式变量 → Pi 的 token。宿主读当前主题下这些 token 的实算值，写进沙箱文档与
 * hostContext.styles.variables（沙箱里没有宿主的层叠样式表，只能给字面量）。
 */
export const MCP_APP_STYLE_TOKENS: Readonly<Record<string, string>> = {
  "--color-background-primary": "--bg-raised",
  "--color-background-secondary": "--bg-sunken",
  "--color-background-tertiary": "--bg-hover",
  "--color-text-primary": "--text",
  "--color-text-secondary": "--text-2",
  "--color-text-tertiary": "--text-3",
  "--color-border-primary": "--border",
  "--color-border-secondary": "--border-subtle",
  "--color-border-tertiary": "--border-subtle",
  "--color-ring-primary": "--focus-ring",
  "--color-accent-primary": "--accent",
  "--color-accent-secondary": "--accent-soft",
  "--color-text-on-accent": "--text-on-accent",
  "--font-sans": "--font-sans",
  "--font-mono": "--font-mono",
  "--font-weight-normal": "--fw-regular",
  "--font-weight-medium": "--fw-medium",
  "--font-weight-bold": "--fw-strong",
  "--font-text-xs-size": "--fs-2xs",
  "--font-text-sm-size": "--fs-xs",
  "--font-text-md-size": "--fs-sm",
  "--font-text-lg-size": "--fs-lg",
  "--border-radius-sm": "--radius-sm",
  "--border-radius-md": "--radius-md",
  "--border-radius-lg": "--radius-lg",
  "--border-radius-xl": "--radius-xl",
  "--spacing-xs": "--space-1",
  "--spacing-sm": "--space-2",
  "--spacing-md": "--space-3",
  "--spacing-lg": "--space-4",
  "--spacing-xl": "--space-6",
};

/** 宿主读到的 Pi token 值（键是 `--bg-raised` 这类）→ ext-apps 标准变量名。读不到的变量不写，交给应用自己的兜底。 */
export function resolveHostStyleVariables(piTokens: Readonly<Record<string, string>>): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, token] of Object.entries(MCP_APP_STYLE_TOKENS)) {
    const value = piTokens[token]?.trim() ?? "";
    if (value !== "") variables[name] = value;
  }
  return variables;
}

const CHANNEL_TOKEN_PATTERN = /^[\w-]{8,128}$/;

/**
 * 沙箱文档的垫片：storage / history 兜底（同 file-preview/html-preview.ts），外加一层裸 JSON-RPC 2.0 通道。
 *
 * 为什么不改写 `window.parent.postMessage`：带 ext-apps SDK 的应用自己就按裸帧发，改写只会多一层信封；
 * 这里直接给出对齐好的 `window.__piMcpApp.{request,notify}`（内部就是对 `parent.postMessage` 发 `jsonrpc:"2.0"` 帧）。
 * `token` 只用于信封形式与调试；来源校验由宿主按 `event.source` 做。
 */
export function buildMcpAppShim(channelToken: string): string {
  if (!CHANNEL_TOKEN_PATTERN.test(channelToken)) throw new Error(`无效的 MCP Apps 通道令牌：${channelToken}`);
  const token = JSON.stringify(channelToken).replaceAll("<", "\\u003c");
  const source = `(function(){
  try{window.localStorage}catch(_){
    var mem=function(){var s=Object.create(null);return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},setItem:function(k,v){s[String(k)]=String(v)},removeItem:function(k){delete s[String(k)]},clear:function(){s=Object.create(null)},key:function(i){return Object.keys(s)[i]||null},get length(){return Object.keys(s).length}}};
    try{Object.defineProperty(window,"localStorage",{value:mem(),configurable:true})}catch(_){}
    try{Object.defineProperty(window,"sessionStorage",{value:mem(),configurable:true})}catch(_){}
  }
  try{var h=window.history;if(h){var r=h.replaceState,p=h.pushState;
    h.replaceState=function(st,t,u){try{return r.call(this,st,t,u)}catch(_){if(typeof u==="string"&&u.charAt(0)==="#"){try{window.location.hash=u}catch(_){}}}};
    h.pushState=function(st,t,u){try{return p.call(this,st,t,u)}catch(_){if(typeof u==="string"&&u.charAt(0)==="#"){try{window.location.hash=u}catch(_){}}}};
  }}catch(_){}
  var seq=0,pending={};
  function send(frame){try{window.parent.postMessage(frame,"*")}catch(_){}}
  function request(method,params){var id="shim-"+(++seq);return new Promise(function(resolve,reject){pending[id]={resolve:resolve,reject:reject};send({jsonrpc:"2.0",id:id,method:method,params:params===undefined?{}:params})})}
  function notify(method,params){send({jsonrpc:"2.0",method:method,params:params===undefined?{}:params})}
  window.addEventListener("message",function(event){
    var frame=event.data;
    if(frame&&frame.__piMcpApp===true)frame=frame.message;
    if(!frame||frame.jsonrpc!=="2.0"||frame.method!==undefined||frame.id===undefined)return;
    var entry=pending[frame.id];
    if(!entry)return;
    delete pending[frame.id];
    if(frame.error)entry.reject(new Error(frame.error.message||"host error"));
    else entry.resolve(frame.result);
  });
  window.__piMcpApp={token:${token},request:request,notify:notify};
})();`;
  return `<script>${source}</script>`;
}

export interface McpAppHtmlInput {
  /** MCP 服务器给的原始 HTML。 */
  html: string;
  /** 每次装载新生成的通道令牌（写进垫片，见 buildMcpAppShim）。 */
  channelToken: string;
  theme: McpAppTheme;
  /** 宿主当前主题下读到的 Pi token 实算值（键形如 `--bg-raised`）。 */
  piTokens: Readonly<Record<string, string>>;
}

/** 注入标准 CSS 变量（按主题实算、写死字面量）+ 兜底垫片，返回交给 registerHtmlPreview 的文档。 */
export function buildMcpAppHtml(input: McpAppHtmlInput): string {
  const variables = resolveHostStyleVariables(input.piTokens);
  const declarations = Object.entries(variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  const style =
    `<style>:root{color-scheme:${input.theme};${declarations}}` +
    "html,body{margin:0;background:var(--color-background-primary,transparent);" +
    "color:var(--color-text-primary,inherit);font-family:var(--font-sans,system-ui,sans-serif);" +
    "font-size:var(--font-text-md-size,14px);line-height:1.45}" +
    "body{overflow:auto}</style>";
  return injectIntoSandboxDocument(input.html, `${style}${buildMcpAppShim(input.channelToken)}`);
}

/** 插在 `<head>` 后（没有 head 就插在 `<html>` 后，再没有就放在文档开头）。 */
function injectIntoSandboxDocument(html: string, snippet: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${snippet}${html.slice(at)}`;
  }
  const root = /<html\b[^>]*>/i.exec(html);
  if (root !== null) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}${snippet}${html.slice(at)}`;
  }
  return `${snippet}${html}`;
}
