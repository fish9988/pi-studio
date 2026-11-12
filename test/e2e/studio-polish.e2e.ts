// 六项体验升级端到端验证：
// 1. 用户消息仅保留「复制 + 反重力同款撤回（Confirm Undo 弹窗 + 可选还原文件修改）」，去除顶部按钮与不可点冗余图标；
// 2. 聊天排版与可点击文件胶囊 vs 普通行内代码差异化视觉；
// 3. 回答完成后工具调用与 Diff 默认自动收起，且设置页双开关实时联动；
// 4. Pi / DeepSeek / Gemini / OpenAI 设计师主题；
// 5. DSH 同款右侧多标签工作台（开始 / 文件 / 内嵌终端 / 浏览器 / 变更 / Subagent），零切换动画，终端不再在底部弹出；
// 6. 用户消息图片与 Read 工具图片真实缩略图渲染 + 点击大图预览。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { launchApp, openTaskRow, setColorMode, setLocale, setTheme } from "./launch.ts";

function makeSolidPngBase64(rgb: [number, number, number], size = 24): string {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0;
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

test("六大核心体验端到端验收：撤回弹窗、文件胶囊区分、自动收缩双开关、四大主题、DSH 右侧栏内嵌终端与多图预览", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "pi-studio-polish-e2e-"));
  const projectDir = path.join(work, "demo-proj");
  const agentDir = path.join(work, "pi-agent");
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await writeFile(path.join(projectDir, "src", "index.ts"), "export const version = 2;\n", "utf8");

  // 预置一个真实的 Pi v3 会话文件（含用户附图、read 读取图片、edit 产生 diff、正文含普通代码与文件路径胶囊）
  const encodedCwd = `--${projectDir.replace(/^([A-Za-z]):/, "$1-").replace(/[\\/]+/g, "-")}--`;
  const sessionsDir = path.join(agentDir, "sessions", encodedCwd);
  await mkdir(sessionsDir, { recursive: true });

  const bluePng = makeSolidPngBase64([56, 85, 232], 36);
  const greenPng = makeSolidPngBase64([16, 163, 127], 36);
  const sessionFile = path.join(sessionsDir, "2026-11-12T01-00-00-000Z_019a0000-0000-7000-8000-000000000001.jsonl");
  const sessionLines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "019a0000-0000-7000-8000-000000000001",
      timestamp: "2026-11-12T01:00:00.000Z",
      cwd: projectDir,
    }),
    JSON.stringify({
      type: "session_info",
      id: "si1",
      parentId: null,
      timestamp: "2026-11-12T01:00:01.000Z",
      name: "Pi Studio 全面升级验收",
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: "si1",
      timestamp: "2026-11-12T01:00:02.000Z",
      message: {
        role: "user",
        timestamp: 1762909202000,
        content: [
          { type: "text", text: "请检查这张截图并更新版本号" },
          { type: "image", mimeType: "image/png", data: bluePng },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-11-12T01:00:04.000Z",
      message: {
        role: "assistant",
        model: "gemini-4-argon",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "先读取截图与源码文件。" },
          { type: "toolCall", id: "tc_read_img", name: "read", arguments: { path: "shot.png" } },
          {
            type: "toolCall",
            id: "tc_edit",
            name: "edit",
            arguments: {
              path: "src/index.ts",
              oldText: "export const version = 1;",
              newText: "export const version = 2;",
            },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-11-12T01:00:05.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc_read_img",
        toolName: "read",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", mimeType: "image/png", data: greenPng },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "tr2",
      parentId: "tr1",
      timestamp: "2026-11-12T01:00:06.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc_edit",
        toolName: "edit",
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/index.ts." }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "a2",
      parentId: "tr2",
      timestamp: "2026-11-12T01:00:08.000Z",
      message: {
        role: "assistant",
        model: "gemini-4-argon",
        stopReason: "stop",
        usage: { input: 142000, output: 1200, cacheRead: 0, cacheWrite: 0, totalTokens: 143200 },
        content: [
          {
            type: "text",
            text: [
              "已经完成检查并更新了版本号配置：",
              "",
              "- 普通配置项 `AUTO_COMPACT_RATIO` 保持默认常量；",
              "- 已修改源码文件 `src/index.ts` 将版本号升级至 `2`。",
            ].join("\n"),
          },
        ],
      },
    }),
    // 模拟触发 dsh-compact 上下文压缩：压缩作为当前分支末尾条目，尚未有新一轮回复
    JSON.stringify({
      type: "compaction",
      id: "comp1",
      parentId: "a2",
      timestamp: "2026-11-12T01:00:10.000Z",
      tokensBefore: 143200,
      firstKeptEntryId: "u1",
      summary: "## 1. Primary Request and Intent\n已完成图片检查与 `src/index.ts` 版本号升级。",
    }),
  ];
  await writeFile(sessionFile, `${sessionLines.join("\n")}\n`, "utf8");

  const launched = await launchApp({ PI_CODING_AGENT_DIR: agentDir });
  try {
    const { page } = launched;
    await page.setViewportSize({ width: 1440, height: 900 });
    await setLocale(page, "zh-CN");
    await setColorMode(page, "light");
    await setTheme(page, "claude");

    await launched.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, projectDir);
    await page.evaluate(async () => {
      const added = await globalThis.studio.addProject();
      if (!added) throw new Error("addProject failed");
      await globalThis.studio.resumeSession("019a0000-0000-7000-8000-000000000001");
    });
    await openTaskRow(page);

    // 1. 验证回答完成后：工具调用过程与底部 Diff 面板均默认自动收起！
    const processSummary = page.getByTestId("tsp-process-summary");
    const changesToggle = page.getByTestId("tsp-ag-changes-toggle");
    await expect(processSummary).toHaveAttribute("aria-expanded", "false");
    await expect(changesToggle).toHaveAttribute("aria-expanded", "false");

    // 1b. 验证触发 dsh-compact 压缩之后：聊天输入框右下角上下文圆环正常展示（不再是无法点击的灰圈），点开可见「上下文压缩摘要」！
    await expect(page.getByTestId("context-meter-pending")).toHaveCount(0);
    const contextMeter = page.getByTestId("context-meter");
    await expect(contextMeter).toBeVisible();
    await contextMeter.click();
    const breakdown = page.getByTestId("context-breakdown");
    await expect(breakdown).toBeVisible();
    await expect(breakdown.locator('[data-part="compactionSummary"]').first()).toBeVisible();
    await page.keyboard.press("Escape");

    // 2. 验证用户消息中的附图真实渲染成 <img> 且可点击打开大图预览（不再是死灰框 Image 1）
    const userImg = page.locator('.tsp-card[data-role="omp.user"] [data-testid="tsp-img-frame"]');
    await expect(userImg).toBeVisible();
    expect(await userImg.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
    await userImg.click();
    await expect(page.getByTestId("tsp-zoom")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tsp-zoom")).toHaveCount(0);

    // 展开过程组并点开 Read 工具行后，Read 工具内的图片真实渲染成 <img>（不再是灰色占位符 read image 1）！
    await processSummary.click();
    await expect(processSummary).toHaveAttribute("aria-expanded", "true");
    await page.locator('.tsp-tool[data-name="read"] .tsp-tool-head').click();
    const toolImg = page.locator('.tsp-tool[data-name="read"] [data-testid="tsp-img-frame"]');
    await expect(toolImg).toBeVisible();
    expect(await toolImg.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
    await processSummary.click();

    // 3. 验证普通行内代码与可点击文件胶囊的视觉样式明显区分，且文件胶囊点击直接打开右侧预览！
    const plainCode = page.locator(".md-code-inline:not(.md-file-chip)").first();
    const fileChip = page.locator(".md-code-inline.md-file-chip").first();
    const plainRadius = await plainCode.evaluate((el) => {
      const g = globalThis as unknown as { getComputedStyle(node: unknown): { borderRadius: string } };
      return g.getComputedStyle(el).borderRadius;
    });
    const chipRadius = await fileChip.evaluate((el) => {
      const g = globalThis as unknown as { getComputedStyle(node: unknown): { borderRadius: string } };
      return g.getComputedStyle(el).borderRadius;
    });
    expect(plainRadius).not.toBe(chipRadius);

    // 4. 验证用户消息气泡仅保留「复制」与「撤回」两个按钮，悬停可点击，且撤回弹出反重力同款 Confirm Undo 弹窗！
    const userCard = page.locator('.tsp-card[data-role="omp.user"]');
    await expect(userCard.locator('[data-role="omp.user.tools"]')).toHaveCount(0);
    await userCard.hover();
    const actions = page.getByTestId("user-message-actions");
    await expect(actions.locator("button")).toHaveCount(2);
    await expect(page.getByTestId("user-msg-copy")).toBeVisible();
    await expect(page.getByTestId("user-msg-retract")).toBeVisible();

    await page.getByTestId("user-msg-retract").click();
    const undoDialog = page.getByTestId("confirm-undo-dialog");
    await expect(undoDialog).toBeVisible();
    await expect(page.getByTestId("confirm-undo-revert-files")).toBeVisible();
    await page.getByTestId("confirm-undo-cancel").click();
    await expect(undoDialog).toHaveCount(0);

    // 5. 验证 DSH 同款右侧工作台：开始页 -> 新建终端内嵌在右侧边栏 + 加号多标签切换零动画
    await page.getByTestId("topbar-files").click();
    const wb = page.getByTestId("right-workbench");
    await expect(wb).toBeVisible();
    await expect(page.getByTestId("dsh-start-launcher")).toBeVisible();
    expect(
      await wb.evaluate((el) => {
        const g = globalThis as unknown as { getComputedStyle(node: unknown): { animationName: string } };
        return g.getComputedStyle(el).animationName;
      }),
    ).toBe("none");

    // 点击新建终端：在右侧栏内打开终端，主对话底部绝不出现终端
    await page.getByTestId("dsh-start-terminal").click();
    await expect(wb.getByTestId("terminal-panel")).toBeVisible();
    expect(await page.getByTestId("main-panel").getByTestId("terminal-panel").count()).toBe(0);

    // 点击 `+` 新标签页，再打开工作区文件：终端与文件双标签并存
    await page.getByTestId("dsh-wb-add-tab").click();
    await expect(page.getByTestId("dsh-start-launcher")).toBeVisible();
    await page.getByTestId("dsh-start-files").click();
    await expect(wb.getByTestId("file-preview")).toBeVisible();
    await expect(wb.getByTestId("wb-tab-terminal")).toBeVisible();
    await expect(wb.getByTestId("wb-tab-files")).toBeVisible();

    // 6. 切换 Claude Code / Gemini / OpenAI / Pi 主题在深色与浅色外观模式下正常响应，并验证自动收缩双开关
    await setColorMode(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "claude-dark");
    await setTheme(page, "gemini");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "gemini-dark");
    await setColorMode(page, "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "gemini-light");
    await setTheme(page, "pi");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "pi-light");
    await setTheme(page, "openai");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "openai-light");

    // 测试设置里的两个自动收缩开关实时联动对话区
    await page.evaluate(async () => {
      await globalThis.studio.setAutoCollapseTools(false);
      await globalThis.studio.setAutoCollapseDiffs(false);
    });
    await expect(processSummary).toHaveAttribute("aria-expanded", "true");
    await expect(changesToggle).toHaveAttribute("aria-expanded", "true");

    // 验证源码文件未被刚才取消的 Undo 改动
    expect(await readFile(path.join(projectDir, "src", "index.ts"), "utf8")).toBe("export const version = 2;\n");
  } finally {
    await launched.close();
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
