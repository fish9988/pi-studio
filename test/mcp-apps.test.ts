// MCP Apps 客户端单测：纯解析函数 + 一个真实 stdio MCP 服务器（临时 .mjs）走完
// initialize → listResources（两页 nextCursor）→ readResource → listTools → callTool → close 整条链路。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JsonRpcLineDecoder,
  McpStdioClient,
  extractUiResourceUri,
  isMcpAppResourceUri,
  parseSseJsonRpcMessages,
  resolveStdioCommand,
} from "../src/main/mcp-apps/mcp-client.ts";

const FAKE_SERVER_SOURCE = `// 测试用的最小 MCP stdio 服务器：资源分两页返回，tools 里一个带 _meta.ui.resourceUri、一个不带。
import { createInterface } from "node:readline";

// 故意往 stdout 打一行非 JSON 噪音：客户端解码器必须忽略它。
process.stdout.write("fake mcp server starting\\n");

function reply(id, body) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n");
}

const PAGE_ONE = {
  resources: [
    {
      uri: "ui://demo/app",
      name: "demo",
      title: "Demo",
      description: "demo app",
      mimeType: "text/html;profile=mcp-app",
    },
  ],
  nextCursor: "page-2",
};
const PAGE_TWO = { resources: [{ uri: "ui://demo/chart", name: "chart", mimeType: "text/html" }] };

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "") continue;
  const message = JSON.parse(line);
  if (message.id === undefined) continue; // 通知（notifications/initialized）不回
  switch (message.method) {
    case "initialize":
      reply(message.id, {
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { resources: {}, tools: {} },
          serverInfo: { name: "fake-mcp-app", version: "1.0.0" },
        },
      });
      break;
    case "resources/list":
      reply(message.id, { result: message.params?.cursor === "page-2" ? PAGE_TWO : PAGE_ONE });
      break;
    case "resources/read":
      reply(message.id, {
        result: {
          contents: [
            {
              uri: message.params.uri,
              mimeType: "text/html;profile=mcp-app",
              text: "<h1>demo</h1>",
              _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] } } },
            },
          ],
        },
      });
      break;
    case "tools/list":
      reply(message.id, {
        result: {
          tools: [
            {
              name: "demo_tool",
              description: "echo",
              inputSchema: { type: "object" },
              _meta: { ui: { resourceUri: "ui://demo/app" } },
            },
            { name: "plain_tool", description: "no ui" },
          ],
        },
      });
      break;
    case "tools/call":
      reply(message.id, {
        result: {
          content: [{ type: "text", text: "echo:" + String(message.params.arguments.text) }],
          structuredContent: { echoed: message.params.arguments.text },
        },
      });
      break;
    default:
      reply(message.id, { error: { code: -32601, message: "Method not found: " + String(message.method) } });
  }
}
`;

const tempDirs: string[] = [];
const activeClients: McpStdioClient[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-apps-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeClients.length > 0) {
    const client = activeClients.pop();
    if (client !== undefined) await client.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe("isMcpAppResourceUri", () => {
  it("认 ui:// 前缀与 profile=mcp-app 的 MIME", () => {
    expect(isMcpAppResourceUri("ui://demo/app")).toBe(true);
    expect(isMcpAppResourceUri("ui://demo/app", "text/html")).toBe(true);
    expect(isMcpAppResourceUri("file:///tmp/a.html", "text/html;profile=mcp-app")).toBe(true);
    expect(isMcpAppResourceUri("file:///tmp/a.html", "TEXT/HTML;PROFILE=MCP-APP")).toBe(true);
    expect(isMcpAppResourceUri("file:///tmp/a.html", "text/html")).toBe(false);
    expect(isMcpAppResourceUri("file:///tmp/a.html")).toBe(false);
  });
});

describe("extractUiResourceUri", () => {
  it('支持嵌套 _meta.ui.resourceUri 与扁平的 _meta["ui/resourceUri"]', () => {
    expect(extractUiResourceUri({ _meta: { ui: { resourceUri: "ui://demo/app" } } })).toBe("ui://demo/app");
    expect(extractUiResourceUri({ _meta: { "ui/resourceUri": "ui://demo/flat" } })).toBe("ui://demo/flat");
  });

  it("没有声明的工具返回 undefined", () => {
    expect(extractUiResourceUri({ name: "plain" })).toBeUndefined();
    expect(extractUiResourceUri({ _meta: {} })).toBeUndefined();
    expect(extractUiResourceUri({ _meta: { ui: { resourceUri: "" } } })).toBeUndefined();
    expect(extractUiResourceUri({ _meta: { ui: "ui://demo/app" } })).toBeUndefined();
  });
});

describe("parseSseJsonRpcMessages", () => {
  it("取 data: 行的 JSON，忽略 event / id / 注释心跳", () => {
    const raw = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      "",
      ": keep-alive",
      "",
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      "",
    ].join("\n");
    expect(parseSseJsonRpcMessages(raw)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", method: "notifications/progress" },
    ]);
  });

  it("多行 data 拼成一条消息，坏 JSON 丢弃，CRLF 也认", () => {
    const raw = 'data: {"jsonrpc":"2.0",\r\ndata: "id":7,"result":{}}\r\n\r\ndata: not-json\r\n\r\n';
    expect(parseSseJsonRpcMessages(raw)).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
  });
});

describe("JsonRpcLineDecoder", () => {
  it("按 \\n 切帧、剥掉行尾 \\r、忽略噪音行", () => {
    const decoder = new JsonRpcLineDecoder();
    expect(decoder.push('{"jsonrpc":"2.0","id":1,"result":')).toEqual([]);
    expect(decoder.push('{}}\r\nnot json\n{"jsonrpc":"2.0","id":2,"result":null}\n')).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: null },
    ]);
    expect(decoder.pending).toBe("");
  });

  it("不在 U+2028 / U+2029 上断帧（readline 会切错的地方）", () => {
    const decoder = new JsonRpcLineDecoder();
    const message = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { text: "a\u2028b\u2029c" } });
    expect(decoder.push(`${message}\n`)).toEqual([{ jsonrpc: "2.0", id: 3, result: { text: "a\u2028b\u2029c" } }]);
  });

  it("半个帧留在 pending 里，下一段补齐后才产出", () => {
    const decoder = new JsonRpcLineDecoder();
    expect(decoder.push('{"id":4')).toEqual([]);
    expect(decoder.pending).toBe('{"id":4');
    expect(decoder.push("}\n")).toEqual([{ id: 4 }]);
  });
});

describe("resolveStdioCommand", () => {
  it("Windows 上 .cmd / .bat 交给 cmd.exe（不经 shell，参数走数组）", () => {
    const plan = resolveStdioCommand("C:\\tools\\npx.cmd", ["-y", "server"], "win32");
    expect(plan.command.toLowerCase().endsWith("cmd.exe")).toBe(true);
    expect(plan.args).toEqual(["/d", "/s", "/c", "C:\\tools\\npx.cmd", "-y", "server"]);
  });

  it(".exe 与非 Windows 平台原样传数组", () => {
    expect(resolveStdioCommand("C:\\tools\\server.exe", ["--x"], "win32")).toEqual({
      command: "C:\\tools\\server.exe",
      args: ["--x"],
    });
    expect(resolveStdioCommand("npx", ["-y", "server"], "linux")).toEqual({
      command: "npx",
      args: ["-y", "server"],
    });
  });
});

describe("McpStdioClient", () => {
  it("走完 initialize → listResources（分页）→ readResource → listTools → callTool → close", async () => {
    const dir = await makeTempDir();
    const script = path.join(dir, "fake-mcp-server.mjs");
    await writeFile(script, FAKE_SERVER_SOURCE, "utf8");

    const client = new McpStdioClient({ command: process.execPath, args: [script], label: "测试服务器" });
    activeClients.push(client);

    await client.initialize();
    expect(client.protocolVersion).toBe("2025-03-26");

    const resources = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(["ui://demo/app", "ui://demo/chart"]);
    expect(resources.filter((resource) => isMcpAppResourceUri(resource.uri, resource.mimeType))).toHaveLength(2);
    expect(resources[0]?.title).toBe("Demo");

    const contents = await client.readResource("ui://demo/app");
    expect(contents.mimeType).toBe("text/html;profile=mcp-app");
    expect(contents.text).toBe("<h1>demo</h1>");
    expect(contents._meta).toEqual({ ui: { csp: { connectDomains: ["https://api.example.com"] } } });

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["demo_tool", "plain_tool"]);
    expect(extractUiResourceUri({ _meta: tools[0]?._meta })).toBe("ui://demo/app");
    expect(extractUiResourceUri({ _meta: tools[1]?._meta })).toBeUndefined();

    const called = await client.callTool("demo_tool", { text: "hi" });
    expect(called.content).toEqual([{ type: "text", text: "echo:hi" }]);
    expect(called.structuredContent).toEqual({ echoed: "hi" });
    expect(called.isError).toBeUndefined();

    await client.close();
    await expect(client.listTools()).rejects.toThrow("已关闭");
  });
});
