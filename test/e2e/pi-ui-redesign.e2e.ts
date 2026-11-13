// PI STUDIO 全量 UI/UX 重构验收：
// 1. M3 Expressive × Fluent 2 × Liquid Glass 外壳、悬浮圆角主画布（18px）与悬浮输入浮岛（22px）；
// 2. 冰川云母（light）/ 极光深海（dark）切换与 2×2 M3 Overview 磁贴交互；
// 3. UI 字体与聊天正文字体独立配置（无衬线 / 衬线切换 + 本机已安装字体检索枚举 + 重载持久化）。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, setColorMode, setLocaleTheme, testPi } from "./launch.ts";

test("UI/UX 重构：悬浮云母画布、Overview 2×2 磁贴与 UI/聊天字体独立设置", async () => {
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

    // 1. 发出一条消息进入会话流，并打开右侧 Overview 工作台
    const input = page.getByTestId("composer-input");
    await input.fill("用一句中文回答：2+2 等于几？不要调用任何工具。");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tsp-view")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("topbar-files").click();
    await expect(page.getByTestId("dsh-start-launcher")).toBeVisible();
    await expect(page.getByTestId("dsh-start-files")).toBeVisible();
    await expect(page.getByTestId("dsh-start-terminal")).toBeVisible();

    // 检查主画布圆角与悬浮输入浮岛圆角
    const radii = await page.evaluate(() => {
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
    expect(radii.panel).toBe("18px");
    expect(radii.composer).toBe("22px");

    // 2. 切换极光深海暗色主题后再切回浅色
    await setColorMode(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await setColorMode(page, "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // 3. 打开设置页 → 通用 → 独立配置 UI 字体与聊天正文字体（并检验系统已安装字体枚举）
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await expect(page.getByTestId("settings")).toBeVisible();
    await page.getByTestId("settings-nav-general").click();

    await page.getByTestId("setting-ui-font-style-serif").click();
    await page.getByTestId("setting-chat-font-style-sans").click();

    // 打开聊天字体下拉框，检查通过 queryLocalFonts() 加载的系统字体列表不为空且可搜索
    const chatSelect = page.getByTestId("setting-chat-font-family");
    await chatSelect.click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const optionCount = await listbox.getByRole("option").count();
    expect(optionCount).toBeGreaterThan(2);

    // 选中一个非默认的真实系统字体（列表第 2 项）
    const pickFont = listbox.getByRole("option").nth(1);
    const chosenFontName = (await pickFont.innerText()).trim();
    await pickFont.click();
    await expect(chatSelect).toContainText(chosenFontName);

    // 验证 --font-sans（UI，衬线）与 --font-display（聊天，指定无衬线）独立生效
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

    // 重载窗口验证 ShellState 持久化
    await page.reload();
    await expect(page.getByTestId("app-root")).toBeVisible();
    await expect.poll(async () => (await readFontVars()).ui).toContain("Anthropic Serif");
    await expect.poll(async () => (await readFontVars()).chat).toContain(chosenFontName);
  } finally {
    await launched.close();
    await rm(work, { recursive: true, force: true });
  }
});
