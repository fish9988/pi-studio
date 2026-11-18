// 内联 Gen UI 卡片的核心：`::visualize{}` 指令解析、widget 状态归一、沙箱文档注入与 postMessage 协议校验。
// 纯 TS、不碰 DOM（沙箱脚本在字符串里），渲染层 GenUiCard.tsx 与 test/gen-ui.test.ts 共用这一份。
import { injectHtmlPreviewShim } from "../features/file-preview/html-preview.ts";

/** widget 状态（存 sessionStorage、随追问回传的 modelContent）序列化后的上限：16 KiB。 */
export const MAX_WIDGET_STATE_BYTES = 16 * 1024;
/** 卡片 iframe 的高度区间（px）：太矮控件挤成一团，太高会把对话顶走。 */
export const GEN_UI_MIN_HEIGHT = 160;
export const GEN_UI_MAX_HEIGHT = 720;
/** 宿主与卡片 iframe 之间的消息通道名。 */
export const GEN_UI_CHANNEL = "pi-gen-ui";
/** 引用进输入框的文字上限：再长也不是"引用一段"，还会把草稿撑爆。 */
const GEN_UI_TEXT_MAX_CHARS = 8000;
/** 指令标题的字符上限：头部只放一行，超出的截断。 */
const GEN_UI_TITLE_MAX_CHARS = 120;

// ───────────────────────── ::visualize{…} 指令 ─────────────────────────

export interface VisualizeDirective {
  /** 任务目录内的相对路径（不含 `..`、空白与控制字符）。 */
  path: string;
  title?: string;
  mode?: "normal" | "wide";
}

const DIRECTIVE_PATTERN = /^::visualize\{([\s\S]*)\}$/;
const ATTRIBUTE_PATTERN = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DIRECTIVE_KEYS = new Set(["path", "title", "mode"]);

type DirectiveFields = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 控制字符（含 DEL）：出现在路径里会让路径和文件系统对不上。 */
function isControlCode(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/** 有空白（含全角空格、NBSP）或控制字符。 */
function hasSpaceOrControl(value: string): boolean {
  for (const char of value) {
    if (isControlCode(char.codePointAt(0) ?? 0)) return true;
    if (/\s/u.test(char)) return true;
  }
  return false;
}

/** 控制字符换成空格，连续空白压成一个，去掉首尾空白。 */
function printableText(value: string): string {
  let text = "";
  for (const char of value) text += isControlCode(char.codePointAt(0) ?? 0) ? " " : char;
  return text.replace(/\s+/g, " ").trim();
}

/** JSON 形态：`::visualize{"path":"a.html"}`。外面那对花括号既是指令的、也是 JSON 的，所以缺了要补。 */
function parseJsonFields(body: string): DirectiveFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.startsWith("{") ? body : `{${body}}`);
  } catch {
    return null; // 写坏的 JSON 就是不成指令，原样留在正文里让人看见
  }
  if (!isRecord(parsed)) return null;
  const fields: DirectiveFields = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!DIRECTIVE_KEYS.has(key)) return null; // 拼错的键不静默忽略
    fields[key] = value;
  }
  return fields;
}

/** 属性形态：`::visualize{path="a.html" title="标题" mode="wide"}`。 */
function parseAttributeFields(body: string): DirectiveFields | null {
  const fields: DirectiveFields = {};
  let matched = 0;
  for (const match of body.matchAll(ATTRIBUTE_PATTERN)) {
    const key = match[1] ?? "";
    if (!DIRECTIVE_KEYS.has(key)) return null;
    matched += 1;
    fields[key] = match[2] ?? match[3] ?? "";
  }
  if (matched === 0) return null;
  // 去掉认出的属性后还剩下非空白字符：有拼错的内容，整条指令作废。
  if (body.replace(ATTRIBUTE_PATTERN, "").trim() !== "") return null;
  return fields;
}

function normalizeDirectivePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;
  // `..` 是越界，空白与控制字符会让路径和文件系统对不上。
  if (value.includes("..") || hasSpaceOrControl(value)) return null;
  return value;
}

/**
 * 解析独占一行的 `::visualize{…}` 指令；不是指令、写坏或路径越界时返回 null（调用方把这一行当普通正文）。
 * 只认两种写法：属性形态与 JSON 形态，`path` 必填且非空。
 */
export function parseVisualizeDirective(line: string): VisualizeDirective | null {
  const match = DIRECTIVE_PATTERN.exec(line.trim());
  if (match === null) return null;
  const body = (match[1] ?? "").trim();
  if (body === "") return null;
  const fields = body.startsWith("{") || body.startsWith('"') ? parseJsonFields(body) : parseAttributeFields(body);
  if (fields === null) return null;
  const path = normalizeDirectivePath(fields["path"]);
  if (path === null) return null;
  const directive: VisualizeDirective = { path };
  const rawTitle = fields["title"];
  if (rawTitle !== undefined) {
    if (typeof rawTitle !== "string") return null;
    const title = printableText(rawTitle);
    if (title !== "") directive.title = title.slice(0, GEN_UI_TITLE_MAX_CHARS);
  }
  const rawMode = fields["mode"];
  if (rawMode !== undefined) {
    if (rawMode !== "normal" && rawMode !== "wide") return null;
    directive.mode = rawMode;
  }
  return directive;
}

// ───────────────────────── 高度与 widget 状态 ─────────────────────────

/** 卡片高度限制在 [160, 720]；非有限数按最小值处理。 */
export function clampGenUiHeight(height: number): number {
  if (!Number.isFinite(height)) return GEN_UI_MIN_HEIGHT;
  return Math.min(GEN_UI_MAX_HEIGHT, Math.max(GEN_UI_MIN_HEIGHT, Math.round(height)));
}

export interface GenUiWidgetState {
  /** 可以随追问回传给模型的那部分状态。 */
  modelContent?: unknown;
  /** 只留在本机的状态（草稿、临时选项），不回传。 */
  privateContent?: unknown;
}

const textEncoder = new TextEncoder();

/** 序列化后的 UTF-8 字节数；循环引用、BigInt、undefined 这类存不下的内容返回 null。 */
function jsonBytes(value: unknown): number | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    // 序列化不了的形状按"存不下"处理：存储侧只认 JSON。
    return null;
  }
  return json === undefined ? null : textEncoder.encode(json).length;
}

/**
 * 归一 widget 状态：只保留 `modelContent` / `privateContent` 两个键，序列化超过 16 KiB 或存不进 JSON 时返回 null。
 * 两个键都没有也算无效（空状态没有保存的意义）。
 */
export function normalizeWidgetState(raw: unknown): GenUiWidgetState | null {
  if (!isRecord(raw)) return null;
  const state: GenUiWidgetState = {};
  if (Object.hasOwn(raw, "modelContent")) state.modelContent = raw["modelContent"];
  if (Object.hasOwn(raw, "privateContent")) state.privateContent = raw["privateContent"];
  if (state.modelContent === undefined && state.privateContent === undefined) return null;
  const bytes = jsonBytes(state);
  if (bytes === null || bytes > MAX_WIDGET_STATE_BYTES) return null;
  return state;
}

// ───────────────────────── 沙箱文档注入 ─────────────────────────

/** 卡片 iframe 内可读的主题色（CSS 变量 --bg / --fg / --accent / --border / --surface）。 */
export interface GenUiThemeTokens {
  bg: string;
  fg: string;
  accent: string;
  border: string;
  surface: string;
}

export interface BuildGenUiHtmlInput {
  html: string;
  /** 每次挂载随机生成：卡片消息只认这一个 token。 */
  token: string;
  theme: "light" | "dark";
  tokens: GenUiThemeTokens;
  /** 初始 `window.piStudio.widgetState`。 */
  initialState?: unknown;
}

const THEME_VAR_PAIRS: readonly (readonly [keyof GenUiThemeTokens, string])[] = [
  ["bg", "--bg"],
  ["fg", "--fg"],
  ["accent", "--accent"],
  ["border", "--border"],
  ["surface", "--surface"],
];

/** 只留 CSS 值能用的字符：括号、逗号、百分号、`#`、斜杠，别的一律去掉，注入不了 `}` 或 `<`。 */
function sanitizeCssValue(value: string): string {
  return value.replace(/[^\w\s#%.,()/-]/g, "");
}

function themeStyle(input: BuildGenUiHtmlInput): string {
  const declarations = THEME_VAR_PAIRS.map(([key, name]) => `${name}:${sanitizeCssValue(input.tokens[key])}`).join(";");
  return `<style>:root{${declarations};color-scheme:${input.theme}}</style>`;
}

/** JSON 直接塞进 `<script>` 必须切断 `</script>`、U+2028、U+2029。 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028]/g, "\\u2028")
    .replace(/[\u2029]/g, "\\u2029");
}

// 注入到卡片文档里的桥：只 postMessage，不碰宿主 DOM。属性名与消息格式必须和 parseGenUiMessage 对齐。
const GEN_UI_BRIDGE_BODY = `
var CHANNEL = "pi-gen-ui";
var THEME_VARS = [["bg", "--bg"], ["fg", "--fg"], ["accent", "--accent"], ["border", "--border"], ["surface", "--surface"]];
var root = document.documentElement;
var api = {};
function post(type, payload) {
  try {
    parent.postMessage({ channel: CHANNEL, token: CFG.token, type: type, payload: payload }, "*");
  } catch (error) {}
}
function applyTheme(theme, tokens) {
  if (theme === "light" || theme === "dark") {
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
  }
  if (tokens) {
    for (var i = 0; i < THEME_VARS.length; i++) {
      var value = tokens[THEME_VARS[i][0]];
      if (typeof value === "string" && value !== "") root.style.setProperty(THEME_VARS[i][1], value);
    }
  }
  var detail = { theme: theme, tokens: tokens || {} };
  try { window.dispatchEvent(new CustomEvent("pi:theme", { detail: detail })); } catch (error) {}
  try { window.dispatchEvent(new CustomEvent("zcode:set_globals", { detail: detail })); } catch (error) {}
}
function followUpPayload(input) {
  var value = typeof input === "string" ? { prompt: input } : input || {};
  return {
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    title: typeof value.title === "string" ? value.title : ""
  };
}
api.widgetState = CFG.initialState;
api.setWidgetState = function (next) {
  api.widgetState = next;
  post("state", next);
  return next;
};
api.sendFollowUp = function (input) { post("followUp", followUpPayload(input)); };
api.sendFollowUpMessage = function (input) { post("followUp", followUpPayload(input)); };
api.quoteToComposer = function (text) {
  if (typeof text === "string" && text !== "") post("quote", { text: text });
};
api.openExternal = function (input) {
  var href = typeof input === "string" ? input : input && typeof input.href === "string" ? input.href : "";
  if (href !== "") post("openExternal", { href: href });
};
window.piStudio = api;
window.zcode = api;
var lastHeight = 0;
function measure() {
  var body = document.body;
  var height = Math.max(root.scrollHeight, root.offsetHeight, body ? body.scrollHeight : 0);
  if (height > 0 && height !== lastHeight) {
    lastHeight = height;
    post("resize", { height: height });
  }
}
function watch() {
  if (typeof ResizeObserver === "function") {
    var observer = new ResizeObserver(measure);
    observer.observe(root);
    if (document.body) observer.observe(document.body);
  }
  window.addEventListener("resize", measure);
  measure();
}
window.addEventListener("message", function (event) {
  var data = event.data;
  if (!data || data.channel !== CHANNEL || data.token !== CFG.token || data.type !== "theme") return;
  var payload = data.payload || {};
  applyTheme(payload.theme, payload.tokens);
});
applyTheme(CFG.theme, CFG.tokens);
if (document.body) watch();
else window.addEventListener("DOMContentLoaded", watch);
`;

function bridgeScript(input: BuildGenUiHtmlInput): string {
  const config = {
    token: input.token,
    theme: input.theme,
    tokens: input.tokens,
    initialState: input.initialState === undefined ? null : input.initialState,
  };
  return `<script>(function(){var CFG=${scriptJson(config)};${GEN_UI_BRIDGE_BODY}})();</script>`;
}

/** 插到 `<head>` 之后；没有 head 就插到 `<html>` 之后，连 html 都没有就放最前面。 */
function injectIntoHead(html: string, snippet: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head !== null) {
    const index = head.index + head[0].length;
    return `${html.slice(0, index)}${snippet}${html.slice(index)}`;
  }
  const root = /<html\b[^>]*>/i.exec(html);
  if (root !== null) {
    const index = root.index + root[0].length;
    return `${html.slice(0, index)}${snippet}${html.slice(index)}`;
  }
  return `${snippet}${html}`;
}

/**
 * 生成交给 registerHtmlPreview 的完整文档：先注入原有的 localStorage / history 沙箱垫片，
 * 再带上主题 CSS 变量与 `window.piStudio`（兼容别名 `window.zcode`）桥。
 */
export function buildGenUiHtml(input: BuildGenUiHtmlInput): string {
  const snippet = `${themeStyle(input)}${bridgeScript(input)}`;
  return injectIntoHead(injectHtmlPreviewShim(input.html), snippet);
}

// ───────────────────────── 来自卡片的 postMessage ─────────────────────────

export type GenUiMessage =
  | { type: "resize"; height: number }
  | { type: "state"; state: GenUiWidgetState }
  | { type: "quote"; text: string }
  | { type: "openExternal"; href: string }
  | { type: "followUp"; prompt: string; title?: string; modelContent?: unknown };

/** 追问附带的 modelContent：存不进 JSON 或超限就丢掉，别让一条消息把发送卡住。 */
function acceptModelContent(value: unknown): unknown {
  const bytes = jsonBytes(value);
  return bytes === null || bytes > MAX_WIDGET_STATE_BYTES ? undefined : value;
}

function trimmedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text.slice(0, max);
}

/**
 * 校验并解析卡片发来的消息：必须是本通道、本 token 的对象，各类型再各自校验载荷。
 * 任何一项不合规都返回 null（宿主的处理分支只处理合规消息）。
 */
export function parseGenUiMessage(data: unknown, expectedToken: string): GenUiMessage | null {
  if (expectedToken === "" || !isRecord(data)) return null;
  if (data["channel"] !== GEN_UI_CHANNEL || data["token"] !== expectedToken) return null;
  const payload = data["payload"];
  switch (data["type"]) {
    case "resize": {
      if (!isRecord(payload)) return null;
      const height = payload["height"];
      if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
      return { type: "resize", height: clampGenUiHeight(height) };
    }
    case "state": {
      const state = normalizeWidgetState(payload);
      return state === null ? null : { type: "state", state };
    }
    case "quote": {
      if (!isRecord(payload)) return null;
      const text = trimmedText(payload["text"], GEN_UI_TEXT_MAX_CHARS);
      return text === null ? null : { type: "quote", text };
    }
    case "openExternal": {
      if (!isRecord(payload)) return null;
      const href = payload["href"];
      // 只放行 http(s)：卡片里的链接不能唤起 file:// 或自定义协议。
      if (typeof href !== "string" || !/^https?:\/\//i.test(href)) return null;
      return { type: "openExternal", href };
    }
    case "followUp": {
      if (!isRecord(payload)) return null;
      const prompt = trimmedText(payload["prompt"], GEN_UI_TEXT_MAX_CHARS);
      if (prompt === null) return null;
      const message: GenUiMessage = { type: "followUp", prompt };
      const title = trimmedText(payload["title"], GEN_UI_TITLE_MAX_CHARS);
      if (title !== null) message.title = title;
      if (Object.hasOwn(payload, "modelContent")) {
        const modelContent = acceptModelContent(payload["modelContent"]);
        if (modelContent !== undefined) message.modelContent = modelContent;
      }
      return message;
    }
    default:
      return null;
  }
}
