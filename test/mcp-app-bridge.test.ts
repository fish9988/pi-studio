// MCP Apps 宿主桥接的纯逻辑单测：裸 JSON-RPC 2.0 帧识别、握手结果、外链白名单、content 文本提取、
// 高度夹取、垫片注入与沙箱文档拼装。帧来源（event.source）在组件里核对，这里不涉及 DOM。
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  buildInitializeResult,
  buildMcpAppHtml,
  buildMcpAppShim,
  clampAppHeight,
  extractTextFromContent,
  isAllowedExternalUrl,
  isJsonRpcMessage,
  isJsonRpcNotification,
  isJsonRpcRequest,
  MCP_APP_MAX_HEIGHT,
  MCP_APP_MIN_HEIGHT,
  MCP_APP_PROTOCOL_VERSION,
  MCP_APP_STYLE_TOKENS,
  resolveHostStyleVariables,
  type McpAppHostContext,
} from "../src/renderer/src/features/mcp-apps/app-bridge.ts";

const hostContext: McpAppHostContext = {
  theme: "dark",
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  platform: "desktop",
  locale: "zh-CN",
  timeZone: "Asia/Shanghai",
  userAgent: "studio-test",
  styles: { variables: { "--color-text-primary": "#f2f4fc" } },
};

describe("isJsonRpcMessage", () => {
  it("认裸 JSON-RPC 2.0 请求 / 通知 / 应答", () => {
    expect(isJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} })).toBe(true);
    expect(isJsonRpcMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" })).toBe(true);
    expect(isJsonRpcMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } })).toBe(true);
    expect(isJsonRpcMessage({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } })).toBe(true);
  });

  it("拒掉信封、别的协议版本和非对象载荷", () => {
    expect(isJsonRpcMessage({ __piMcpApp: true, token: "t", message: { jsonrpc: "2.0", method: "x" } })).toBe(false);
    expect(isJsonRpcMessage({ jsonrpc: "1.0", id: 1, result: {} })).toBe(false);
    expect(isJsonRpcMessage({ jsonrpc: 2, method: "x" })).toBe(false);
    expect(isJsonRpcMessage({ jsonrpc: "2.0" })).toBe(false);
    expect(isJsonRpcMessage([{ jsonrpc: "2.0", method: "x" }])).toBe(false);
    expect(isJsonRpcMessage("2.0")).toBe(false);
    expect(isJsonRpcMessage(null)).toBe(false);
    expect(isJsonRpcMessage(undefined)).toBe(false);
  });
});

describe("请求与通知的区分", () => {
  it("有 id 的是请求，没 id 的是通知", () => {
    const request = { jsonrpc: "2.0", id: "shim-1", method: "tools/call" } as const;
    const notification = { jsonrpc: "2.0", method: "ui/notifications/size-changed" } as const;
    expect(isJsonRpcRequest(request)).toBe(true);
    expect(isJsonRpcNotification(request)).toBe(false);
    expect(isJsonRpcRequest(notification)).toBe(false);
    expect(isJsonRpcNotification(notification)).toBe(true);
  });
});

describe("buildInitializeResult", () => {
  it("按 ext-apps 规范给出协议版本、宿主信息与能力，并原样带回 hostContext", () => {
    const result = buildInitializeResult(hostContext);
    expect(result.protocolVersion).toBe(MCP_APP_PROTOCOL_VERSION);
    expect(result.protocolVersion).toBe("2026-01-26");
    expect(result.hostInfo).toEqual({ name: "pi-studio", version: "0.6.5" });
    expect(Object.keys(result.hostCapabilities).toSorted()).toEqual([
      "message",
      "openLinks",
      "serverResources",
      "serverTools",
      "updateModelContext",
    ]);
    expect(result.hostCapabilities.message).toEqual({ text: {} });
    expect(result.hostCapabilities.updateModelContext).toEqual({ text: {} });
    expect(result.hostContext).toBe(hostContext);
  });

  it("打包版的真版本号可以盖过兜底常量", () => {
    expect(buildInitializeResult(hostContext, "1.2.3").hostInfo.version).toBe("1.2.3");
  });
});

describe("isAllowedExternalUrl", () => {
  it("只放行 http / https", () => {
    expect(isAllowedExternalUrl("https://example.com/a?b=1#c")).toBe(true);
    expect(isAllowedExternalUrl("  http://example.com  ")).toBe(true);
  });

  it("拒掉其它协议、空串与解析不了的输入", () => {
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("data:text/html,<b>x</b>")).toBe(false);
    expect(isAllowedExternalUrl("file:///C:/Windows")).toBe(false);
    expect(isAllowedExternalUrl("mailto:a@b.c")).toBe(false);
    expect(isAllowedExternalUrl("http:")).toBe(false);
    expect(isAllowedExternalUrl("//example.com")).toBe(false);
    expect(isAllowedExternalUrl("")).toBe(false);
    expect(isAllowedExternalUrl("   ")).toBe(false);
  });
});

describe("extractTextFromContent", () => {
  it("把 text 块数组拼成一段", () => {
    expect(
      extractTextFromContent([
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段\n\n第二段");
  });

  it("接受单个块、{ text } 与嵌套 content，忽略图片等非文本块", () => {
    expect(extractTextFromContent({ type: "text", text: "单个" })).toBe("单个");
    expect(extractTextFromContent({ text: "直给" })).toBe("直给");
    expect(extractTextFromContent({ content: [{ type: "text", text: "嵌套" }] })).toBe("嵌套");
    expect(extractTextFromContent([{ type: "image", data: "AAAA", mimeType: "image/png" }])).toBe("");
    expect(extractTextFromContent(undefined)).toBe("");
    expect(extractTextFromContent(42)).toBe("");
    expect(extractTextFromContent("  纯字符串  ")).toBe("纯字符串");
  });
});

describe("clampAppHeight", () => {
  it("夹在 200–720px 之间并取整", () => {
    expect(clampAppHeight(50)).toBe(MCP_APP_MIN_HEIGHT);
    expect(clampAppHeight(199.6)).toBe(200);
    expect(clampAppHeight(360.4)).toBe(360);
    expect(clampAppHeight(4000)).toBe(MCP_APP_MAX_HEIGHT);
  });

  it("非数字回落到给定默认值", () => {
    expect(clampAppHeight(Number.NaN)).toBe(MCP_APP_MIN_HEIGHT);
    expect(clampAppHeight(Number.NaN, 300)).toBe(300);
    expect(clampAppHeight(Number.POSITIVE_INFINITY)).toBe(MCP_APP_MIN_HEIGHT);
  });
});

describe("buildMcpAppShim", () => {
  it("注入裸 JSON-RPC 2.0 通道、通道令牌与 storage/history 兜底", () => {
    const shim = buildMcpAppShim("abc-123-def");
    expect(shim.startsWith("<script>")).toBe(true);
    expect(shim.endsWith("</script>")).toBe(true);
    expect(shim).toContain('jsonrpc:"2.0"');
    expect(shim).toContain('postMessage(frame,"*")');
    expect(shim).toContain('"abc-123-def"');
    expect(shim).toContain("__piMcpApp");
    expect(shim).toContain("localStorage");
    expect(shim).toContain("replaceState");
  });

  it("令牌不合法时直接报错（不静默生成一个坏脚本）", () => {
    expect(() => buildMcpAppShim("")).toThrow();
    expect(() => buildMcpAppShim("short")).toThrow();
    expect(() => buildMcpAppShim('"><script>alert(1)</script>')).toThrow();
    expect(() => buildMcpAppShim("a".repeat(129))).toThrow();
  });
});

interface ShimApp {
  token: string;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
}

interface ShimSandbox {
  posted: unknown[];
  app: ShimApp;
  deliver(data: unknown): void;
}

/** 把垫片脚本放进一个只有 window 的沙箱跑起来（模拟 opaque origin 的 iframe，但不碰真 DOM）。 */
function runShim(channelToken: string): ShimSandbox {
  const posted: unknown[] = [];
  const listeners: ((event: { data: unknown }) => void)[] = [];
  const host = {
    parent: { postMessage: (frame: unknown) => posted.push(frame) },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") listeners.push(listener);
    },
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: () => null },
    history: { replaceState: () => undefined, pushState: () => undefined },
    location: { hash: "" },
  };
  const source = buildMcpAppShim(channelToken)
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");
  runInNewContext(source, { window: host });
  return {
    posted,
    app: (host as unknown as { __piMcpApp: ShimApp }).__piMcpApp,
    deliver: (data: unknown) => {
      for (const listener of listeners) listener({ data });
    },
  };
}

describe("垫片脚本", () => {
  it("发裸 JSON-RPC 2.0 请求，收到应答后 resolve", async () => {
    const sandbox = runShim("abc-123-def");
    expect(sandbox.app.token).toBe("abc-123-def");
    const answered = sandbox.app.request("tools/call", { name: "search", arguments: {} });
    expect(sandbox.posted).toEqual([
      { jsonrpc: "2.0", id: "shim-1", method: "tools/call", params: { name: "search", arguments: {} } },
    ]);
    sandbox.deliver({ jsonrpc: "2.0", id: "shim-1", result: { content: [{ type: "text", text: "ok" }] } });
    await expect(answered).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("通知不带 id；信封形式的错误应答也认，并让请求 reject", async () => {
    const sandbox = runShim("abc-123-def");
    sandbox.app.notify("ui/notifications/initialized");
    expect(sandbox.posted).toEqual([{ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }]);

    const rejected = sandbox.app.request("ui/open-link", { url: "javascript:alert(1)" });
    sandbox.deliver({
      __piMcpApp: true,
      token: "abc-123-def",
      message: { jsonrpc: "2.0", id: "shim-1", error: { code: -32602, message: "only http/https links" } },
    });
    // 垫片的 Error 建在 vm 的 realm 里，instanceof 不成立；按文本断言。
    const reason = await rejected.then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(reason)).toContain("only http/https links");
  });

  it("认不出来的帧不碰在途请求", async () => {
    const sandbox = runShim("abc-123-def");
    const answered = sandbox.app.request("ui/initialize");
    sandbox.deliver({ hello: "world" });
    sandbox.deliver({ jsonrpc: "1.0", id: "shim-1", result: {} });
    sandbox.deliver({ jsonrpc: "2.0", id: "shim-1", result: { protocolVersion: "2026-01-26" } });
    await expect(answered).resolves.toEqual({ protocolVersion: "2026-01-26" });
  });
});

describe("resolveHostStyleVariables", () => {
  it("把 Pi token 的实算值换成 ext-apps 标准变量名", () => {
    const variables = resolveHostStyleVariables({ "--bg-raised": " #ffffff ", "--text": "#131629" });
    expect(variables["--color-background-primary"]).toBe("#ffffff");
    expect(variables["--color-text-primary"]).toBe("#131629");
    expect(MCP_APP_STYLE_TOKENS["--color-accent-primary"]).toBe("--accent");
  });

  it("读不到的 token 不写（交给应用自己的兜底）", () => {
    const variables = resolveHostStyleVariables({ "--bg-raised": "   " });
    expect(variables["--color-background-primary"]).toBeUndefined();
    expect(Object.keys(variables)).toHaveLength(0);
  });
});

describe("buildMcpAppHtml", () => {
  it("在 <head> 后插入主题变量与垫片，保留原文档结构", () => {
    const html = buildMcpAppHtml({
      html: "<!doctype html><html><head><title>App</title></head><body><div id=a></div></body></html>",
      channelToken: "token-12345678",
      theme: "dark",
      piTokens: { "--bg-raised": "#192036", "--text": "#f2f4fc" },
    });
    expect(html.startsWith("<!doctype html><html><head><style>")).toBe(true);
    expect(html).toContain("color-scheme:dark");
    expect(html).toContain("--color-background-primary:#192036;");
    expect(html).toContain("--color-text-primary:#f2f4fc;");
    expect(html).toContain("<script>");
    expect(html).toContain('"token-12345678"');
    expect(html).toContain("<title>App</title></head><body><div id=a></div></body></html>");
  });

  it("缺 head / 缺 html 时回退到 <html> 后或文档开头", () => {
    const headless = buildMcpAppHtml({
      html: "<html><body>Hi</body></html>",
      channelToken: "token-12345678",
      theme: "light",
      piTokens: {},
    });
    expect(headless.startsWith("<html><style>")).toBe(true);
    expect(headless).toContain("color-scheme:light");

    const fragment = buildMcpAppHtml({
      html: "<div>Fragment</div>",
      channelToken: "token-12345678",
      theme: "light",
      piTokens: {},
    });
    expect(fragment.startsWith("<style>")).toBe(true);
    expect(fragment).toContain("<div>Fragment</div>");
  });
});
