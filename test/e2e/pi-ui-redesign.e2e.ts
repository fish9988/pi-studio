// PI STUDIO 全量 UI/UX 重构验收：
// 1. M3 Expressive × Fluent 2 × Liquid Glass 外壳、6 大双模式主题家族、顶栏工具胶囊、Overview 2×2 磁贴；
// 2. Markdown 代码块深色终端卡片（默认折叠、点击展开）；
// 3. 输入框复制全部（含图片 <img> 富文本）、支持图片上下文的提示词优化（只替换文字保留附件）、发送后气泡内联芯片渲染；
// 4. 设置页移除旧「过程行」三卡、UI 与聊天字体独立配置及持久化。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { themeFamilyNames } from "../../src/shared/themes.ts";
import { launchApp, lockClipboard, setColorMode, setLocaleTheme, testPi } from "./launch.ts";

function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x70)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function pasteImage(page: Page, png: Buffer): Promise<void> {
  await page.evaluate((base64) => {
    const g = globalThis as unknown as {
      document: { querySelector(selector: string): { dispatchEvent(event: unknown): boolean } | null };
      ClipboardEvent: new (
        type: string,
        init: { clipboardData: unknown; bubbles: boolean; cancelable: boolean },
      ) => unknown;
    };
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    g.document
      .querySelector('[data-testid="composer-input"]')!
      .dispatchEvent(new g.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, png.toString("base64"));
}

test("UI/UX 全面重构：主题家族、默认折叠代码卡、图文全量复制与优化、用户气泡芯片及字体独立设置", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "pi-ui-redesign-"));
  const project = path.join(work, "demo-project");
  await mkdir(project);

  const launched = await launchApp({ STUDIO_TEST_PI: testPi() });
  try {
    const { app, page } = launched;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1360, height: 840 });
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, project);

    await setLocaleTheme(page, "zh-CN", "light");
    await page.getByTestId("sidebar-open-folder").click();
    await expect(page.getByTestId("empty-state")).toHaveAttribute("data-kind", "project");

    // 1. 空态隐藏「复制全部 / 优化提示词」，粘贴图片或输入文本后平滑显现
    const enhanceGroup = page.getByTestId("enhance-prompt-group");
    await expect(enhanceGroup).not.toBeVisible();
    const input = page.getByTestId("composer-input");
    await input.click();
    await pasteImage(page, solidPng(40, 30));
    await expect(page.getByTestId("attachment")).toHaveCount(1);
    await expect(enhanceGroup).toBeVisible();
    await input.pressSequentially("请检查样式，示例：");
    await input.press("Shift+Enter");
    await input.pressSequentially("```css");
    await input.press("Shift+Enter");
    await input.pressSequentially(".box { color: red; }");
    await input.press("Shift+Enter");
    await input.pressSequentially("```");

    // 2. 点击「复制全部（含附件）」：验证系统剪贴板同时写入纯文本与包含 <img> 的 HTML
    const unlock = await lockClipboard();
    try {
      await page.getByTestId("composer-copy-all").click();
      await expect
        .poll(async () =>
          app.evaluate(async ({ clipboard }) => {
            const items = await clipboard.read();
            const first = items[0];
            if (!first) return null;
            const text = first.types.includes("text/plain") ? await (await first.getType("text/plain")).text() : "";
            const html = first.types.includes("text/html") ? await (await first.getType("text/html")).text() : "";
            return { text, html };
          }),
        )
        .toEqual({
          text: expect.stringContaining("[Image #1, 40x30]"),
          html: expect.stringContaining('<img src="data:image/'),
        });
    } finally {
      await unlock();
    }

    // 3. 点击「✨ 优化提示词」：优化后只替换文本、图片附件 #1 完整保留且可还原
    await page.getByTestId("enhance-prompt-btn").click();
    await expect(page.getByTestId("enhance-prompt-undo")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("attachment")).toHaveCount(1);
    await expect(input).toHaveValue(/#1/);
    await page.getByTestId("enhance-prompt-undo").click();
    await expect(page.getByTestId("attachment")).toHaveCount(1);

    // 4. 发送消息：验证用户气泡不显示原始 [Image #1, 40x30] 括号文本，而是内联 #1 芯片 + 顶部缩略图；
    //    并验证回复中的 Markdown 代码块默认折叠、点击展开
    await input.press("Enter");
    await expect(page.getByTestId("tsp-view")).toBeVisible({ timeout: 20_000 });
    const userCard = page.locator('[data-testid="tsp-view"] [data-role="omp.user"]').first();
    await expect(userCard).toBeVisible({ timeout: 20_000 });
    await expect(userCard).not.toContainText("[Image #1");
    await expect(userCard.locator('.md-attach-chip[data-kind="image"]')).toHaveText("#1");
    await expect(userCard.locator('[data-role="omp.user.images"] [data-testid="tsp-img-frame"]')).toHaveCount(1);

    const assistantCode = page
      .locator('[data-testid="tsp-view"] [data-role="omp.assistant"] [data-testid="codeblock"]')
      .first();
    await expect(assistantCode).toBeVisible({ timeout: 20_000 });
    await expect(assistantCode).toHaveAttribute("data-collapsed", "true");
    await expect(assistantCode).toHaveAttribute("data-code-dark", "");
    await expect(assistantCode.locator(".md-codebody")).toHaveCount(0);
    await assistantCode.getByTestId("codeblock-toggle").click();
    await expect(assistantCode).not.toHaveAttribute("data-collapsed");
    await expect(assistantCode.locator(".md-codebody")).toBeVisible();

    // 5. 检查主画布圆角、输入浮岛圆角、顶栏唯一的右栏切换按钮与右侧 Overview 2×2 M3 磁贴
    // 顶栏右侧只留一个右栏切换按钮（设置改由侧栏底部 / Ctrl+, 打开）；旧子面板图标收进 1px 透明兜底层，看不见也点不到。
    await expect(page.getByTestId("topbar-settings")).toHaveCount(0);
    await expect(page.getByTestId("topbar-files")).toBeVisible();
    await expect(page.locator(".topbar-legacy-toggles")).toHaveCSS("opacity", "0");
    await expect(page.locator(".topbar-legacy-toggles")).toHaveCSS("pointer-events", "none");
    await page.getByTestId("topbar-files").click();
    await expect(page.getByTestId("dsh-start-launcher")).toBeVisible();
    await expect(page.getByTestId("dsh-start-files")).toBeVisible();
    await expect(page.getByTestId("dsh-start-terminal")).toBeVisible();

    const readRadii = () =>
      page.evaluate(() => {
        const g = globalThis as unknown as {
          document: { querySelector(s: string): unknown };
          getComputedStyle(el: unknown): { borderRadius: string };
        };
        const panel = g.document.querySelector('[data-testid="main-panel"]');
        const composer = g.document.querySelector(".composer");
        return {
          panel: g.getComputedStyle(panel).borderRadius,
          composer: g.getComputedStyle(composer).borderRadius,
        };
      });
    // 默认 M3 灵动：主区面板 18px、输入浮岛 22px。
    expect(await readRadii()).toEqual({ panel: "18px", composer: "22px" });

    // 6. 切暗色再切回浅色
    await setColorMode(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await setColorMode(page, "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // 7. 设置页 → 通用（顶栏不再有设置图标，走 Ctrl+,）：确认旧「过程行」三卡已移除、新 6 套主题全在、UI 与聊天字体独立设置并持久化
    const openSettingsKeys = process.platform === "darwin" ? "Meta+," : "Control+,";
    await page.keyboard.press(openSettingsKeys);
    await expect(page.getByTestId("settings")).toBeVisible();
    await page.getByTestId("settings-nav-general").click();

    await expect(page.getByTestId("setting-process-rows")).toHaveCount(0);
    for (const family of themeFamilyNames) {
      await expect(page.getByTestId(`theme-card-${family}`)).toBeVisible();
    }

    await page.getByTestId("setting-ui-font-style-serif").click();
    await page.getByTestId("setting-chat-font-style-sans").click();

    const chatSelect = page.getByTestId("setting-chat-font-family");
    await chatSelect.click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const optionCount = await listbox.getByRole("option").count();
    expect(optionCount).toBeGreaterThan(2);

    const pickFont = listbox.getByRole("option").nth(1);
    const chosenFontName = (await pickFont.innerText()).trim();
    await pickFont.click();
    await expect(chatSelect).toContainText(chosenFontName);

    const readFontVars = () =>
      page.evaluate(() => {
        const g = globalThis as unknown as {
          document: { documentElement: unknown };
          getComputedStyle(el: unknown): { getPropertyValue(n: string): string };
        };
        const cs = g.getComputedStyle(g.document.documentElement);
        return {
          ui: cs.getPropertyValue("--font-sans").trim(),
          chat: cs.getPropertyValue("--font-display").trim(),
        };
      });
    const fontVars = await readFontVars();
    expect(fontVars.ui).toContain("Anthropic Serif");
    expect(fontVars.chat).toContain(chosenFontName);
    expect(fontVars.chat).toContain("Anthropic Sans");

    // 8. 五套界面风格与代码块配色：圆角跟着骨架变，浅色主题下 fluent / mica-liquid / claude 用冷灰浅色代码卡，手选配色优先于风格。
    const closeSettings = async () => {
      await page.getByTestId("settings-win-close").click();
      await expect(page.getByTestId("settings")).toHaveCount(0);
    };

    await page.getByTestId("setting-ui-style-fluent").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-style", "fluent");
    await closeSettings();
    expect(await readRadii()).toEqual({ panel: "12px", composer: "14px" });
    await expect(assistantCode).toHaveAttribute("data-code-light", "");
    await expect(assistantCode).not.toHaveAttribute("data-code-dark");

    // 云母液态：圆角在 Fluent 与液态玻璃之间，浅色主题下同样用冷灰浅色代码卡（code-block-theme.ts）。
    await page.keyboard.press(openSettingsKeys);
    await page.getByTestId("setting-ui-style-mica-liquid").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-style", "mica-liquid");
    await closeSettings();
    expect(await readRadii()).toEqual({ panel: "14px", composer: "18px" });
    await expect(assistantCode).toHaveAttribute("data-code-light", "");
    await expect(assistantCode).not.toHaveAttribute("data-code-dark");

    // Claude 极简：面板平铺无圆角（0px），输入浮岛只留 18px；浅色主题下同样用冷灰浅色代码卡。
    await page.keyboard.press(openSettingsKeys);
    await page.getByTestId("setting-ui-style-claude").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-style", "claude");
    await closeSettings();
    expect(await readRadii()).toEqual({ panel: "0px", composer: "18px" });
    await expect(assistantCode).toHaveAttribute("data-code-light", "");
    await expect(assistantCode).not.toHaveAttribute("data-code-dark");

    await page.keyboard.press(openSettingsKeys);
    await page.getByTestId("setting-ui-style-liquid").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-style", "liquid");
    await closeSettings();
    expect(await readRadii()).toEqual({ panel: "20px", composer: "24px" });
    await expect(assistantCode).toHaveAttribute("data-code-dark", "");

    await page.keyboard.press(openSettingsKeys);
    await page.getByTestId("setting-ui-style-expressive").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-style", "expressive");
    await closeSettings();
    expect(await readRadii()).toEqual({ panel: "18px", composer: "22px" });
    await expect(assistantCode).toHaveAttribute("data-code-dark", "");

    await page.keyboard.press(openSettingsKeys);
    await page.getByTestId("setting-code-block-style-light").click();
    await closeSettings();
    await expect(assistantCode).toHaveAttribute("data-code-light", "");
    await expect(assistantCode).not.toHaveAttribute("data-code-dark");

    await page.keyboard.press(openSettingsKeys);
    await page.getByTestId("setting-code-block-style-dark").click();
    await closeSettings();
    await expect(assistantCode).toHaveAttribute("data-code-dark", "");
    await expect(assistantCode).not.toHaveAttribute("data-code-light");

    await page.keyboard.press(openSettingsKeys);
    await page.getByTestId("setting-code-block-style-auto").click();
    await closeSettings();
    await expect(page.locator("html")).toHaveAttribute("data-code-block-style", "auto");
    await expect(assistantCode).toHaveAttribute("data-code-dark", "");

    // 收起前留一组非默认值：重载后界面风格与代码块配色都还在。
    await page.keyboard.press(openSettingsKeys);
    await page.getByTestId("setting-ui-style-liquid").click();
    await page.getByTestId("setting-code-block-style-light").click();
    await closeSettings();
    expect(await readRadii()).toEqual({ panel: "20px", composer: "24px" });
    await expect(assistantCode).toHaveAttribute("data-code-light", "");

    await page.reload();
    await expect(page.getByTestId("app-root")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-ui-style", "liquid");
    await expect(page.locator("html")).toHaveAttribute("data-code-block-style", "light");
    await expect(page.getByTestId("main-panel")).toHaveCSS("border-radius", "20px");
    await expect.poll(async () => (await readFontVars()).ui).toContain("Anthropic Serif");
    await expect.poll(async () => (await readFontVars()).chat).toContain(chosenFontName);
  } finally {
    await launched.close();
    await rm(work, { recursive: true, force: true });
  }
});

test("UI 精细优化与 Plan Mode 交互兼容：无框 SVG、HTML Artifact 卡片、主题随动变更条、Other 自由输入与提问期空间紧凑", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "pi-ui-polish-"));
  const project = path.join(work, "demo-project");
  await mkdir(project);

  const launched = await launchApp({ STUDIO_TEST_PI: testPi() });
  try {
    const { app, page } = launched;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1360, height: 840 });
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, project);

    await setLocaleTheme(page, "zh-CN", "sage-light");
    await page.getByTestId("sidebar-open-folder").click();
    await expect(page.getByTestId("empty-state")).toHaveAttribute("data-kind", "project");

    // 1. 验证顶栏清理后无残留中心节点，左右分栏图标统一为 16x16 viewBox；空态草稿隐藏次级操作组；思考气泡图标无十字杂线
    await expect(page.locator(".topbar-center")).toHaveCount(0);
    await expect(page.locator('[data-testid="topbar-sidebar"] svg')).toHaveAttribute("viewBox", "0 0 16 16");
    await expect(page.locator('[data-testid="topbar-files"] svg')).toHaveAttribute("viewBox", "0 0 16 16");
    await expect(page.getByTestId("draft-composer").getByTestId("enhance-prompt-group")).not.toBeVisible();
    await expect(page.locator('[data-testid="chip-thinking"] .effort-pill-icon path')).toHaveCount(2);

    // 1.1 命令面板主题图标已改为线性调色盘（4 个色点圆 + 轮廓 path，不再是半黑半白对比度圆）
    await page.keyboard.press("Control+k");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox").fill("选择主题");
    const themeOpt = palette.getByRole("option").first();
    await expect(themeOpt).toBeVisible();
    await expect(themeOpt.locator("svg circle")).toHaveCount(4);
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);

    // 2. 发送带 [edit] 与 [render:svg-html] 的消息，检验 SVG/Mermaid 无框直出、HTML Artifact 卡片、以及变更条在 sage-light 下不是纯白 #ffffff
    const input = page.getByTestId("composer-input");
    await input.fill("[edit] [render:svg-html]");
    await input.press("Enter");
    await expect(page.getByTestId("tsp-view")).toBeVisible({ timeout: 20_000 });

    const assistant = page.locator('[data-testid="tsp-view"] [data-role="omp.assistant"]').last();
    const blocks = assistant.getByTestId("codeblock");
    await expect(blocks).toHaveCount(3, { timeout: 20_000 });

    const svgBlock = blocks.nth(0);
    await expect(svgBlock).toHaveAttribute("data-figure", "true");
    await expect(svgBlock.locator(".md-codehead")).toHaveCount(0);
    await expect(svgBlock.getByTestId("codeblock-figure")).toBeVisible();
    await svgBlock.hover();
    await expect(svgBlock.getByTestId("codeblock-figure-actions")).toBeVisible();

    const mermaidBlock = blocks.nth(1);
    await expect(mermaidBlock).toHaveAttribute("data-figure", "true", { timeout: 15_000 });
    await expect(mermaidBlock.locator(".md-codehead")).toHaveCount(0);
    await expect(mermaidBlock.getByTestId("codeblock-figure")).toBeVisible();
    await mermaidBlock.hover();
    await expect(mermaidBlock.getByTestId("codeblock-figure-actions")).toBeVisible();

    const htmlBlock = blocks.nth(2);
    await expect(htmlBlock).toHaveAttribute("data-artifact", "html");
    await expect(htmlBlock.getByTestId("codeblock-artifact-head")).toContainText("交互式演示页");
    await htmlBlock.getByTestId("codeblock-preview-sidebar").click();
    await expect(page.getByTestId("file-preview")).toBeVisible();
    await page.keyboard.press("Escape");
    await htmlBlock.getByTestId("codeblock-toggle").click();
    await expect(htmlBlock.locator(".md-codebody")).toBeVisible();

    const agPanel = page.getByTestId("tsp-ag-changes-panel");
    await expect(agPanel).toBeVisible();
    const bgColorLight = await agPanel.evaluate((el) => {
      const g = globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string } };
      return g.getComputedStyle(el).backgroundColor;
    });
    expect(bgColorLight).not.toBe("rgb(255, 255, 255)");
    await setLocaleTheme(page, "zh-CN", "dusk-dark");
    const bgColorDark = await agPanel.evaluate((el) => {
      const g = globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string } };
      return g.getComputedStyle(el).backgroundColor;
    });
    expect(bgColorDark).not.toBe("rgb(255, 255, 255)");
    expect(bgColorDark).not.toBe(bgColorLight);
    await setLocaleTheme(page, "zh-CN", "sage-light");

    // 3. 长对话下校验电梯条与右侧滚动条间隔（right >= 18px）
    await input.fill("第二轮消息，用于触发对话线电梯条");
    await input.press("Enter");
    const convline = page.getByTestId("conversation-line");
    await expect(convline).toBeVisible({ timeout: 20_000 });
    await expect(convline).toHaveCSS("right", "18px");

    // 4. Plan Mode 问答兼容：select(Other (free-form)) + 原生输入法/文本提交，且提问期底部重复 Composer 折叠
    await input.fill("[ask:plan]");
    await input.press("Enter");
    const askGate = page.locator('[data-testid="tsp-view"] [data-role="omp.editor.ask"]');
    await expect(askGate).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("composer-stack")).toHaveAttribute("data-asking", "");
    await expect(page.getByTestId("composer-input")).toHaveCount(0);

    // 点选 Other (free-form) 选项后，无缝弹出原生编辑器，输入中文并 Ctrl+Enter 提交
    await askGate.locator('[data-role="omp.ask.other"]').click();
    const nativeEditor = askGate.getByTestId("tspi-ask-native-input");
    await expect(nativeEditor).toBeVisible({ timeout: 10_000 });
    await nativeEditor.fill("采用极简方案并保留中文支持");
    await nativeEditor.press("Control+Enter");
    await expect(askGate).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('[data-testid="tsp-view"] [data-role="omp.assistant"]').last()).toContainText(
      "[UI value: 采用极简方案并保留中文支持]",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("composer-input")).toBeVisible();

    // 5. 测试内联 Other 输入框直接提交与 Esc 取消
    await input.fill("[ask:plan]");
    await input.press("Enter");
    await expect(askGate).toBeVisible({ timeout: 20_000 });
    const otherInline = askGate.getByTestId("tspi-ask-other-input");
    await expect(otherInline).toBeVisible();
    await otherInline.fill("内联直接提交的方案");
    await otherInline.press("Enter");
    await expect(askGate).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('[data-testid="tsp-view"] [data-role="omp.assistant"]').last()).toContainText(
      "[UI value: 内联直接提交的方案]",
      { timeout: 20_000 },
    );

    // Esc 取消 input 对话框
    await input.fill("[ask:input]");
    await input.press("Enter");
    await expect(askGate).toBeVisible({ timeout: 20_000 });
    const singleNative = askGate.getByTestId("tspi-ask-native-input");
    await expect(singleNative).toBeVisible();
    await singleNative.press("Escape");
    await expect(askGate).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('[data-testid="tsp-view"] [data-role="omp.assistant"]').last()).toContainText(
      "[UI cancelled]",
      { timeout: 20_000 },
    );

    // 6. 本地 HTML 交互页面预览：默认开启脚本且兼容 localStorage / history.replaceState，源码模式直接展示高亮代码
    const realFixture = process.env["STUDIO_TEST_HTML_FIXTURE"];
    if (realFixture) await writeFile(path.join(project, "theorem.html"), await readFile(realFixture));
    const htmlFile = path.join(project, "viz.html");
    await writeFile(
      htmlFile,
      [
        "<!doctype html><html><head><meta charset='utf-8'><title>Viz</title></head><body>",
        "<div id='out'>waiting</div><canvas id='cv' width='60' height='20'></canvas>",
        "<button id='btn'>switch</button>",
        "<script>",
        "localStorage.setItem('k','ok');",
        "document.getElementById('out').textContent = 'rendered:' + localStorage.getItem('k');",
        "var ctx = document.getElementById('cv').getContext('2d'); ctx.fillStyle='#2f6f5e'; ctx.fillRect(0,0,60,20);",
        "document.getElementById('btn').addEventListener('click', function(){ history.replaceState(null,'','#tab2'); document.getElementById('out').textContent='clicked:' + location.hash; });",
        "</script></body></html>",
      ].join(""),
      "utf8",
    );
    await page.getByTestId("topbar-files").click();
    const omni = page.getByTestId("dsh-sidebar-omni-input");
    if ((await omni.count()) === 0) {
      await page.getByTestId("dsh-start-files").click();
    }
    await page.getByTestId("dsh-sidebar-omni-input").fill("viz.html");
    await page.getByTestId("dsh-sidebar-omni-results").locator("button").first().click();

    const previewFrame = page.getByTestId("file-preview-frame");
    await expect(previewFrame).toBeVisible({ timeout: 10_000 });
    const frameHandle = await previewFrame.elementHandle();
    const frameContent = (await frameHandle!.contentFrame())!;
    await expect(frameContent.locator("#out")).toHaveText("rendered:ok", { timeout: 10_000 });
    await frameContent.locator("#btn").click();
    await expect(frameContent.locator("#out")).toHaveText("clicked:#tab2");
    // 子文档没有 preload、Node 和父窗口权限；Canvas 真实输出了像素。
    expect(await frameContent.evaluate("typeof window.studio")).toBe("undefined");
    expect(await frameContent.evaluate("typeof require")).toBe("undefined");
    expect(await frameContent.evaluate("(() => { try { return !!parent.document; } catch { return false; } })()")).toBe(
      false,
    );
    expect(
      await frameContent.evaluate("document.getElementById('cv').getContext('2d').getImageData(5,5,1,1).data[3]"),
    ).toBe(255);
    const runScripts = page.getByRole("checkbox", { name: "运行脚本" });
    await runScripts.click();
    await expect(runScripts).not.toBeChecked();
    await expect(page.frameLocator('[data-testid="file-preview-frame"]').locator("#out")).toHaveText("waiting");
    await runScripts.click();
    await expect(runScripts).toBeChecked();
    await expect(page.frameLocator('[data-testid="file-preview-frame"]').locator("#out")).toHaveText("rendered:ok");

    // 切到「源码」模式应展示完整代码而非嵌套 Artifact 卡片
    await page.getByTestId("file-preview-mode-source").click();
    await expect(page.getByTestId("file-preview-body").locator("pre.md-codebody")).toContainText("rendered:");
    await expect(page.getByTestId("file-preview-body").getByTestId("codeblock-artifact-head")).toHaveCount(0);

    // 本机复现可经环境变量指定真实页面，只读复制到隔离测试项目。
    if (realFixture) {
      await page.getByTestId("file-preview-page-files").click();
      await page.getByTestId("dsh-sidebar-omni-input").fill("theorem.html");
      await page.getByTestId("dsh-sidebar-omni-results").locator("button").first().click();
      const theorem = page.frameLocator('[data-testid="file-preview-frame"]');
      await expect(theorem.locator("#stageTitle")).toContainText("拉格朗日");
      await expect(theorem.locator("#valK")).not.toHaveText("—");
      await theorem.getByRole("tab", { name: "罗尔定理", exact: true }).click();
      await expect(theorem.locator("#stageTitle")).toContainText("罗尔");
      await theorem.getByRole("button", { name: "自动找到解点" }).click();
      await expect(theorem.locator("#valGap")).toHaveText("0.000");
      const handle = await page.getByTestId("file-preview-frame").elementHandle();
      const child = (await handle!.contentFrame())!;
      expect(
        await child.evaluate(
          "(() => { const c=document.getElementById('stage'); const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let count=0; for(let i=3;i<pixels.length;i+=4) if(pixels[i]) count++; return count; })()",
        ),
      ).toBeGreaterThan(100);
    }
  } finally {
    await launched.close();
    await rm(work, { recursive: true, force: true });
  }
});
