// PI STUDIO 全量 UI/UX 重构验收：
// 1. M3 Expressive × Fluent 2 × Liquid Glass 外壳、6 大双模式主题家族、顶栏工具胶囊、Overview 2×2 磁贴；
// 2. Markdown 代码块深色终端卡片（默认折叠、点击展开）；
// 3. 输入框复制全部（含图片 <img> 富文本）、支持图片上下文的提示词优化（只替换文字保留附件）、发送后气泡内联芯片渲染；
// 4. 设置页移除旧「过程行」三卡、UI 与聊天字体独立配置及持久化。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

    // 1. 粘贴图片 + 输入带代码块的测试指令（Shift+Enter 换行不发送）
    const input = page.getByTestId("composer-input");
    await input.click();
    await pasteImage(page, solidPng(40, 30));
    await expect(page.getByTestId("attachment")).toHaveCount(1);
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

    // 5. 检查主画布圆角、输入浮岛圆角、顶栏工作台工具与右侧 Overview 2×2 M3 磁贴
    await expect(page.getByTestId("topbar-settings")).toBeVisible();
    await page.getByTestId("topbar-files").click();
    await expect(page.getByTestId("dsh-start-launcher")).toBeVisible();
    await expect(page.getByTestId("dsh-start-files")).toBeVisible();
    await expect(page.getByTestId("dsh-start-terminal")).toBeVisible();

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

    // 6. 切暗色再切回浅色
    await setColorMode(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await setColorMode(page, "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // 7. 设置页 → 通用：确认旧「过程行」三卡已移除、新 6 套主题全在、UI 与聊天字体独立设置并持久化
    await page.getByTestId("topbar-settings").click();
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

    await page.reload();
    await expect(page.getByTestId("app-root")).toBeVisible();
    await expect.poll(async () => (await readFontVars()).ui).toContain("Anthropic Serif");
    await expect.poll(async () => (await readFontVars()).chat).toContain(chosenFontName);
  } finally {
    await launched.close();
    await rm(work, { recursive: true, force: true });
  }
});
