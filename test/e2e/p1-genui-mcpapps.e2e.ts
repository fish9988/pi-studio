// P1 全链路端到端验证：
// 1. 轻量 Gen UI：HTML Artifact 块就地交互运行 + `::visualize{path="..." title="..."}` 工作区交互页渲染、
//    状态保存（widgetState）、引用写回（quoteToComposer）与确认条追问（sendFollowUp）；
// 2. MCP Apps 容器：通过真实 stdio MCP Server 暴露 `ui://` 资源与工具，从右侧工作台概览打开应用 Tab、
//    完成 ext-apps `ui/initialize` 握手、在沙箱 iframe 内触发 `tools/call` 与 `ui/update-model-context`。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, setLocaleTheme, testPi } from "./launch.ts";

function buildMockMcpAppServerScript(): string {
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Demo App</title></head>
<body>
  <h3 id="status">booting</h3>
  <button id="call-btn" type="button">Run Tool</button>
  <button id="ctx-btn" type="button">Send Context</button>
  <div id="tool-out"></div>
  <script>
    (function () {
      var seq = 1;
      var pending = new Map();
      var statusEl = document.getElementById("status");
      var outEl = document.getElementById("tool-out");

      function rpcRequest(method, params) {
        var id = seq++;
        return new Promise(function (resolve, reject) {
          pending.set(id, { resolve: resolve, reject: reject });
          window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
        });
      }

      window.addEventListener("message", function (event) {
        var msg = event.data;
        if (!msg || msg.jsonrpc !== "2.0" || msg.id === undefined) return;
        var entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message || "RPC error"));
        else entry.resolve(msg.result);
      });

      rpcRequest("ui/initialize", {
        appInfo: { name: "demo-mcp-app", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion: "2026-01-26"
      }).then(function (res) {
        statusEl.textContent = "ready:" + (res && res.hostContext && res.hostContext.theme ? res.hostContext.theme : "unknown");
        window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
      }).catch(function (err) {
        statusEl.textContent = "err:" + err.message;
      });

      document.getElementById("call-btn").addEventListener("click", function () {
        rpcRequest("tools/call", { name: "calc_metric", arguments: { x: 21 } }).then(function (res) {
          var text = res && res.content && res.content[0] && res.content[0].text ? res.content[0].text : "";
          outEl.textContent = text;
        });
      });

      document.getElementById("ctx-btn").addEventListener("click", function () {
        rpcRequest("ui/update-model-context", {
          content: [{ type: "text", text: "MCP App Selected Node #42" }]
        });
      });
    })();
  </script>
</body>
</html>`;

  return `import { StringDecoder } from "node:string_decoder";
const decoder = new StringDecoder("utf8");
let buf = "";
const APP_HTML = ${JSON.stringify(html)};

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

process.stdin.on("data", (chunk) => {
  buf += decoder.write(chunk);
  for (;;) {
    const nl = buf.indexOf("\\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") {
      reply({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { resources: {}, tools: {} },
          serverInfo: { name: "demo-ui-server", version: "1.0.0" },
        },
      });
    } else if (msg.method === "resources/list") {
      reply({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          resources: [
            {
              uri: "ui://demo/board",
              name: "board",
              title: "Demo Interactive Board",
              mimeType: "text/html;profile=mcp-app",
            },
          ],
        },
      });
    } else if (msg.method === "resources/read") {
      reply({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          contents: [
            {
              uri: "ui://demo/board",
              mimeType: "text/html;profile=mcp-app",
              text: APP_HTML,
            },
          ],
        },
      });
    } else if (msg.method === "tools/list") {
      reply({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "calc_metric",
              description: "Double x",
              _meta: { ui: { resourceUri: "ui://demo/board" } },
            },
          ],
        },
      });
    } else if (msg.method === "tools/call") {
      const x = Number(msg.params?.arguments?.x ?? 0);
      reply({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: "Metric=" + String(x * 2) }],
          structuredContent: { value: x * 2 },
        },
      });
    } else {
      reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
`;
}

const GEN_UI_CHART_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Interactive Loss Chart</title></head>
<body>
  <h2 id="heading">Loss Tuner</h2>
  <button id="save-btn" type="button">Save LR</button>
  <button id="quote-btn" type="button">Quote Result</button>
  <button id="ask-btn" type="button">Ask Follow-up</button>
  <script>
    document.getElementById("save-btn").addEventListener("click", function () {
      window.piStudio.setWidgetState({ modelContent: { lr: 0.05 }, privateContent: { tab: "loss" } });
    });
    document.getElementById("quote-btn").addEventListener("click", function () {
      window.piStudio.quoteToComposer("Best LR = 0.05");
    });
    document.getElementById("ask-btn").addEventListener("click", function () {
      window.piStudio.sendFollowUp({ prompt: "请用最佳学习率继续训练" });
    });
  </script>
</body>
</html>`;

test("P1 集成：Gen UI 内联卡片交互（::visualize 与 HTML Artifact）及 MCP Apps 宿主闭环", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "studio-p1-"));
  const project = path.join(work, "project");
  const agentDir = path.join(work, "agent");
  const sessionBucket = path.join(agentDir, "sessions", "--p1-demo--");
  await mkdir(project, { recursive: true });
  await mkdir(sessionBucket, { recursive: true });

  await writeFile(path.join(project, "chart.html"), GEN_UI_CHART_HTML, "utf8");
  const mcpServerScript = path.join(work, "demo-mcp-app-server.mjs");
  await writeFile(mcpServerScript, buildMockMcpAppServerScript(), "utf8");
  await writeFile(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        demoUi: {
          command: process.execPath,
          args: [mcpServerScript],
          enabled: true,
        },
      },
    }),
    "utf8",
  );

  // 在 agentDir/visuals 下也种一个带交互滑块的中值定理可视化片段，检验无框透明渲染 + visuals 目录安全读取
  const visualsDir = path.join(agentDir, "visuals");
  await mkdir(visualsDir, { recursive: true });
  await writeFile(
    path.join(visualsDir, "mvt-demo.html"),
    `<div style="padding:4px 0">
      <div class="viz-controls">
        <label class="form-label">切点 x₀ = <span id="xi-val" class="tabular-nums">1.00</span>
          <input id="xi-slider" class="form-range" type="range" min="0.2" max="1.8" step="0.1" value="1.0" />
        </label>
        <span class="viz-badge" id="slope-badge">斜率 2.00</span>
      </div>
      <svg viewBox="0 0 300 100" style="width:100%;height:auto;display:block">
        <line x1="20" y1="80" x2="280" y2="80" stroke="var(--border)" />
        <circle id="pt-c" cx="150" cy="50" r="5" fill="var(--viz-series-1)" />
      </svg>
    </div>
    <script>
      var s = document.getElementById("xi-slider");
      s.addEventListener("input", function () {
        var v = Number(s.value);
        document.getElementById("xi-val").textContent = v.toFixed(2);
        document.getElementById("slope-badge").textContent = "斜率 " + (2 * v).toFixed(2);
      });
    </script>`,
    "utf8",
  );

  // 种一个带 `::visualize` 指令和 ```html Artifact 的会话
  const sessionFile = path.join(sessionBucket, "2026-11-18T12-00-00-000Z_p1-session.jsonl");
  const assistantMarkdown = [
    "下面展示交互可视化：",
    "",
    '::visualize{path="chart.html" title="训练曲线面板"}',
    "",
    '::visualize{"path":"mvt-demo.html","title":"拉格朗日中值定理"}',
    "",
    "```html",
    '<!doctype html><html><head><title>Inline Widget</title></head><body><button id="hi">Hello GenUI</button></body></html>',
    "```",
  ].join("\n");

  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "p1-session",
      timestamp: "2026-11-18T12:00:00.000Z",
      cwd: project,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "生成交互图表" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: [{ type: "text", text: assistantMarkdown }] },
    }),
  ].join("\n");
  await writeFile(sessionFile, `${lines}\n`, "utf8");

  const launched = await launchApp({
    STUDIO_TEST_PI: testPi(),
    PI_CODING_AGENT_DIR: agentDir,
  });
  try {
    const { page } = launched;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setLocaleTheme(page, "zh-CN", "light");

    // 1) 从侧栏打开种好的历史会话（project 分组默认收起，先展开分组）
    const groupToggle = page.getByRole("button", { name: /展开或收起 project/ });
    await expect(groupToggle).toBeVisible({ timeout: 15_000 });
    await groupToggle.click();
    const row = page.getByText("生成交互图表").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.getByTestId("tsp-view")).toBeVisible({ timeout: 15_000 });

    // 2) 验证 `::visualize{path="chart.html"}` 自动渲染出无框透明 GenUiCard，并与沙箱 iframe 完成双向桥接
    const genUiCard = page.getByTestId("gen-ui-card").first();
    await expect(genUiCard).toBeVisible({ timeout: 15_000 });
    await expect(genUiCard).toHaveCSS("border-top-width", "0px");
    const genFrame = page.frameLocator("iframe.gen-ui-frame").first();
    await expect(genFrame.locator("#heading")).toHaveText("Loss Tuner", { timeout: 15_000 });

    // 验证位于 agentDir/visuals/mvt-demo.html 的无框透明交互图可直接渲染并实时调参
    const mvtFrame = page.frameLocator("iframe.gen-ui-frame").nth(1);
    await expect(mvtFrame.locator("#slope-badge")).toHaveText("斜率 2.00", { timeout: 15_000 });
    await mvtFrame.locator("#xi-slider").fill("1.5");
    await expect(mvtFrame.locator("#slope-badge")).toHaveText("斜率 3.00");

    // 触发 setWidgetState -> 宿主出现已保存状态徽标
    await genFrame.locator("#save-btn").click();
    await expect(genUiCard.locator(".gen-ui-saved")).toBeVisible({ timeout: 5_000 });

    // 触发 quoteToComposer -> 写入主输入框
    await genFrame.locator("#quote-btn").click();
    await expect(page.getByTestId("composer-input")).toContainText("Best LR = 0.05");

    // 触发 sendFollowUp -> 宿主弹出确认条（不擅自发送）
    await genFrame.locator("#ask-btn").click();
    await expect(genUiCard.getByTestId("gen-ui-confirm")).toBeVisible({ timeout: 5_000 });
    await expect(genUiCard.getByTestId("gen-ui-confirm")).toContainText("请用最佳学习率继续训练");
    await genUiCard.getByTestId("gen-ui-confirm").getByRole("button", { name: "取消" }).click();
    await expect(genUiCard.getByTestId("gen-ui-confirm")).toHaveCount(0);

    // 3) 验证 ```html Artifact 块点击「交互预览」就地展开第三个 GenUiCard
    await page.getByTestId("codeblock-run-genui").click();
    await expect(page.getByTestId("gen-ui-card")).toHaveCount(3, { timeout: 10_000 });
    const inlineFrame = page.frameLocator("iframe.gen-ui-frame").nth(2);
    await expect(inlineFrame.locator("#hi")).toHaveText("Hello GenUI", { timeout: 10_000 });

    // 4) 打开右侧工作台，从概览启动真实 stdio MCP Apps 容器并完成双向交互
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+E" : "Control+Shift+E");
    await page.getByTestId("dsh-wb-add-tab").click();
    const mcpItem = page.getByTestId("dsh-start-mcp-app-item").filter({ hasText: "Demo Interactive Board" });
    await expect(mcpItem).toBeVisible({ timeout: 15_000 });
    await mcpItem.click();

    const mcpHost = page.getByTestId("mcp-app-host");
    await expect(mcpHost).toBeVisible({ timeout: 15_000 });
    const mcpFrame = page.frameLocator('[data-testid="mcp-app-frame"]');
    await expect(mcpFrame.locator("#status")).toHaveText(/ready:(light|dark)/, { timeout: 15_000 });

    // 点击 iframe 按钮调用真实 stdio MCP server 的 `calc_metric` 工具
    await mcpFrame.locator("#call-btn").click();
    await expect(mcpFrame.locator("#tool-out")).toHaveText("Metric=42", { timeout: 10_000 });

    // 点击 iframe 按钮通过 `ui/update-model-context` 写入主输入框
    await mcpFrame.locator("#ctx-btn").click();
    await expect(page.getByTestId("composer-input")).toContainText("MCP App Selected Node #42", { timeout: 5_000 });
  } finally {
    await launched.close();
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
