import { describe, expect, it } from "vitest";
import {
  buildGenUiHtml,
  clampGenUiHeight,
  GEN_UI_MAX_HEIGHT,
  GEN_UI_MIN_HEIGHT,
  MAX_WIDGET_STATE_BYTES,
  normalizeWidgetState,
  parseGenUiMessage,
  parseVisualizeDirective,
  type GenUiThemeTokens,
} from "../src/renderer/src/markdown/gen-ui-directive.ts";

const TOKENS: GenUiThemeTokens = {
  bg: "#ffffff",
  fg: "#131629",
  accent: "#5b4ee6",
  border: "rgba(19, 22, 41, 0.13)",
  surface: "#f4f6fc",
};

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

describe("parseVisualizeDirective", () => {
  it("解析属性形态，标题与模式可选", () => {
    expect(parseVisualizeDirective('::visualize{path="charts/trend.html"}')).toEqual({ path: "charts/trend.html" });
    expect(parseVisualizeDirective('  ::visualize{path="a.html" title="  向量  夹角  " mode="wide"}  ')).toEqual({
      path: "a.html",
      title: "向量 夹角",
      mode: "wide",
    });
    expect(parseVisualizeDirective('::visualize{path="a.html" mode="normal"}')).toEqual({
      path: "a.html",
      mode: "normal",
    });
  });

  it("解析 JSON 形态", () => {
    expect(parseVisualizeDirective('::visualize{"path":"a.html","title":"走势","mode":"wide"}')).toEqual({
      path: "a.html",
      title: "走势",
      mode: "wide",
    });
    expect(parseVisualizeDirective('::visualize{ "path" : "a.html" }')).toEqual({ path: "a.html" });
  });

  it("单引号属性也被接受，空标题按没有标题处理", () => {
    expect(parseVisualizeDirective("::visualize{path='a.html' title=''}")).toEqual({ path: "a.html" });
  });

  it("拒绝越界路径、空白与控制字符、空路径", () => {
    expect(parseVisualizeDirective('::visualize{path="../secret.html"}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{path="a/../../b.html"}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{path="a b.html"}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{path="a\u0000b.html"}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{path=""}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{path="   "}')).toBeNull();
    expect(parseVisualizeDirective("::visualize{}")).toBeNull();
    expect(parseVisualizeDirective('::visualize{"title":"没有路径"}')).toBeNull();
  });

  it("拒绝不是指令的行、写坏的 JSON 与拼错的键", () => {
    expect(parseVisualizeDirective('看看这个 ::visualize{path="a.html"}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{path="a.html"')).toBeNull();
    expect(parseVisualizeDirective("::visualize{path}")).toBeNull();
    expect(parseVisualizeDirective('::visualize{"path":}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{"path":"a.html","title":1}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{"path":"a.html","widht":"wide"}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{path="a.html" mode="huge"}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{path="a.html" title="t" extra}')).toBeNull();
    expect(parseVisualizeDirective('::visualize{path="a.html"} 多余文字')).toBeNull();
    expect(parseVisualizeDirective("普通正文")).toBeNull();
  });
});

describe("clampGenUiHeight", () => {
  it("限制在 160–720 之间并取整", () => {
    expect(clampGenUiHeight(90)).toBe(GEN_UI_MIN_HEIGHT);
    expect(clampGenUiHeight(5000)).toBe(GEN_UI_MAX_HEIGHT);
    expect(clampGenUiHeight(320.6)).toBe(321);
    expect(clampGenUiHeight(Number.NaN)).toBe(GEN_UI_MIN_HEIGHT);
    expect(clampGenUiHeight(Number.POSITIVE_INFINITY)).toBe(GEN_UI_MIN_HEIGHT);
  });
});

describe("normalizeWidgetState", () => {
  it("只保留 modelContent / privateContent", () => {
    expect(normalizeWidgetState({ modelContent: { a: 1 }, privateContent: [1, 2], extra: true })).toEqual({
      modelContent: { a: 1 },
      privateContent: [1, 2],
    });
    expect(normalizeWidgetState({ privateContent: "草稿" })).toEqual({ privateContent: "草稿" });
  });

  it("非对象、空状态与存不进 JSON 的内容返回 null", () => {
    expect(normalizeWidgetState(null)).toBeNull();
    expect(normalizeWidgetState("x")).toBeNull();
    expect(normalizeWidgetState([{ modelContent: 1 }])).toBeNull();
    expect(normalizeWidgetState({})).toBeNull();
    expect(normalizeWidgetState({ modelContent: 10n })).toBeNull();
  });

  it("按 UTF-8 字节数卡 16 KiB", () => {
    const room = MAX_WIDGET_STATE_BYTES - bytes({ modelContent: "" });
    expect(normalizeWidgetState({ modelContent: "a".repeat(room) })).not.toBeNull();
    expect(normalizeWidgetState({ modelContent: "a".repeat(room + 1) })).toBeNull();
    // 中文一个字 3 字节：字符数远小于上限，字节数超了也要拒。
    expect(normalizeWidgetState({ modelContent: "中".repeat(6000) })).toBeNull();
  });
});

describe("buildGenUiHtml", () => {
  const built = buildGenUiHtml({
    html: "<html><head></head><body>hi</body></html>",
    token: "tok-1",
    theme: "light",
    tokens: TOKENS,
  });

  it("保留沙箱垫片并注入主题 CSS 变量", () => {
    expect(built).toContain("localStorage");
    expect(built).toContain("replaceState");
    expect(built).toContain("--bg:#ffffff");
    expect(built).toContain("--fg:#131629");
    expect(built).toContain("--accent:#5b4ee6");
    expect(built).toContain("--border:rgba(19, 22, 41, 0.13)");
    expect(built).toContain("--surface:#f4f6fc");
    expect(built).toContain("color-scheme:light");
    // 垫片与桥都在 <head> 之后、正文之前。
    expect(built.indexOf("<script>")).toBeGreaterThan(built.indexOf("<head>"));
    expect(built.indexOf("<script>")).toBeLessThan(built.indexOf("<body>"));
  });

  it("注入 window.piStudio 桥与兼容别名，并按 token 配置", () => {
    expect(built).toContain("window.piStudio = api");
    expect(built).toContain("window.zcode = api");
    expect(built).toContain("setWidgetState");
    expect(built).toContain("sendFollowUpMessage");
    expect(built).toContain("quoteToComposer");
    expect(built).toContain("openExternal");
    expect(built).toContain("ResizeObserver");
    expect(built).toContain("pi:theme");
    expect(built).toContain("zcode:set_globals");
    expect(built).toContain('"token":"tok-1"');
    expect(built).toContain('"theme":"light"');
  });

  it("深色主题标注 color-scheme:dark", () => {
    const dark = buildGenUiHtml({ html: "<div>x</div>", token: "t", theme: "dark", tokens: TOKENS });
    expect(dark).toContain("color-scheme:dark");
    expect(dark.startsWith("<style>")).toBe(true);
  });

  it("初始状态进 JSON 配置，且不能闭合脚本标签", () => {
    const out = buildGenUiHtml({
      html: "<html><head></head><body></body></html>",
      token: "tok-2",
      theme: "light",
      tokens: TOKENS,
      initialState: { modelContent: { n: 1 }, privateContent: "</script><script>alert(1)</script>" },
    });
    expect(out).toContain('"initialState":{"modelContent":{"n":1}');
    expect(out).not.toContain("</script><script>alert(1)");
    expect(out).toContain("\\u003c/script>");
  });

  it("主题色值里的花括号与分号被清掉，注入不了新规则", () => {
    const out = buildGenUiHtml({
      html: "<div>x</div>",
      token: "t",
      theme: "light",
      tokens: { ...TOKENS, accent: "red;}body{display:none" },
    });
    // 只看 <style> 那一块：JSON 配置里存原值没问题，能执行的是 CSS。
    const style = out.slice(out.indexOf("<style>"), out.indexOf("</style>"));
    expect(style).toContain("--accent:redbodydisplaynone");
    expect(style).not.toContain("body{");
    // 只剩 :root 那一对花括号，注入不进新规则。
    expect(style.split("{")).toHaveLength(2);
    expect(style.split("}")).toHaveLength(2);
  });
});

describe("parseGenUiMessage", () => {
  const TOKEN = "tok";
  const envelope = (type: string, payload: unknown): unknown => ({
    channel: "pi-gen-ui",
    token: TOKEN,
    type,
    payload,
  });

  it("拒绝别的通道、别的 token 与非对象", () => {
    expect(
      parseGenUiMessage({ channel: "other", token: TOKEN, type: "resize", payload: { height: 300 } }, TOKEN),
    ).toBeNull();
    expect(
      parseGenUiMessage({ channel: "pi-gen-ui", token: "diff", type: "quote", payload: { text: "x" } }, TOKEN),
    ).toBeNull();
    expect(parseGenUiMessage(envelope("quote", { text: "x" }), "")).toBeNull();
    expect(parseGenUiMessage("x", TOKEN)).toBeNull();
    expect(parseGenUiMessage(null, TOKEN)).toBeNull();
    expect(parseGenUiMessage([], TOKEN)).toBeNull();
    expect(parseGenUiMessage(envelope("unknown", {}), TOKEN)).toBeNull();
  });

  it("resize 收高度并夹到区间内", () => {
    expect(parseGenUiMessage(envelope("resize", { height: 300.4 }), TOKEN)).toEqual({ type: "resize", height: 300 });
    expect(parseGenUiMessage(envelope("resize", { height: 20 }), TOKEN)).toEqual({
      type: "resize",
      height: GEN_UI_MIN_HEIGHT,
    });
    expect(parseGenUiMessage(envelope("resize", { height: 9999 }), TOKEN)).toEqual({
      type: "resize",
      height: GEN_UI_MAX_HEIGHT,
    });
    expect(parseGenUiMessage(envelope("resize", { height: "300" }), TOKEN)).toBeNull();
    expect(parseGenUiMessage(envelope("resize", { height: -1 }), TOKEN)).toBeNull();
    expect(parseGenUiMessage("resize", TOKEN)).toBeNull();
  });

  it("state 归一后返回，超限的丢弃", () => {
    expect(parseGenUiMessage(envelope("state", { modelContent: { a: 1 } }), TOKEN)).toEqual({
      type: "state",
      state: { modelContent: { a: 1 } },
    });
    expect(parseGenUiMessage(envelope("state", { modelContent: "中".repeat(6000) }), TOKEN)).toBeNull();
    expect(parseGenUiMessage(envelope("state", {}), TOKEN)).toBeNull();
  });

  it("quote 去掉首尾空白，空文本丢弃", () => {
    expect(parseGenUiMessage(envelope("quote", { text: "  选中的话  " }), TOKEN)).toEqual({
      type: "quote",
      text: "选中的话",
    });
    expect(parseGenUiMessage(envelope("quote", { text: "   " }), TOKEN)).toBeNull();
    expect(parseGenUiMessage(envelope("quote", {}), TOKEN)).toBeNull();
  });

  it("openExternal 只放行 http(s)", () => {
    expect(parseGenUiMessage(envelope("openExternal", { href: "https://example.com/a" }), TOKEN)).toEqual({
      type: "openExternal",
      href: "https://example.com/a",
    });
    expect(parseGenUiMessage(envelope("openExternal", { href: "HTTP://example.com" }), TOKEN)).not.toBeNull();
    expect(parseGenUiMessage(envelope("openExternal", { href: "javascript:alert(1)" }), TOKEN)).toBeNull();
    expect(parseGenUiMessage(envelope("openExternal", { href: "file:///C:/Windows" }), TOKEN)).toBeNull();
    expect(parseGenUiMessage(envelope("openExternal", { href: 1 }), TOKEN)).toBeNull();
  });

  it("followUp 带问题、可选标题与 modelContent", () => {
    expect(parseGenUiMessage(envelope("followUp", { prompt: "  解释一下这一步  " }), TOKEN)).toEqual({
      type: "followUp",
      prompt: "解释一下这一步",
    });
    expect(
      parseGenUiMessage(envelope("followUp", { prompt: "为什么", title: "追问", modelContent: { k: 2 } }), TOKEN),
    ).toEqual({ type: "followUp", prompt: "为什么", title: "追问", modelContent: { k: 2 } });
    // privateContent 只在本机，不回传。
    expect(parseGenUiMessage(envelope("followUp", { prompt: "p", privateContent: { a: 1 } }), TOKEN)).toEqual({
      type: "followUp",
      prompt: "p",
    });
    expect(parseGenUiMessage(envelope("followUp", { prompt: "  " }), TOKEN)).toBeNull();
    expect(parseGenUiMessage(envelope("followUp", { prompt: 1 }), TOKEN)).toBeNull();
  });
});
