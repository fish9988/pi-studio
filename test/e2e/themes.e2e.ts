// 配色主题与独立深浅色模式（外观模式：跟随系统 / 浅色 / 深色 × 主题风格：默认 / Claude Code / Pi / DeepSeek / Gemini / OpenAI / 樱粉 / 水墨）。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { themeFamilies, themeFamilyNames, themes, type ThemeName } from "../../src/shared/themes.ts";
import { expectNoOverflow, launchApp, setColorMode, setLocaleTheme, setTheme } from "./launch.ts";

const stylesDir = path.resolve(import.meta.dirname, "..", "..", "src", "renderer", "styles");

async function cssBgApp(theme: ThemeName): Promise<string> {
  const file = theme === "light" || theme === "dark" ? "tokens.css" : "themes.css";
  const css = await readFile(path.join(stylesDir, file), "utf8");
  const selector = theme === "light" ? ':root,\n[data-theme="light"] {' : `[data-theme="${theme}"] {`;
  const start = css.indexOf(selector);
  expect(start, `${file} 里没有 ${theme} 的主题块`).toBeGreaterThanOrEqual(0);
  const value = /--bg-app:\s*([^;]+);/.exec(css.slice(start))?.[1]?.trim();
  if (value === undefined) throw new Error(`${theme} 没有 --bg-app`);
  return value;
}

function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

async function htmlTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const g = globalThis as unknown as { document: { documentElement: { getAttribute(name: string): string | null } } };
    return g.document.documentElement.getAttribute("data-theme");
  });
}

async function rootBgApp(page: Page): Promise<string> {
  return page.evaluate(() => {
    const g = globalThis as unknown as {
      document: { documentElement: unknown };
      getComputedStyle(el: unknown): { getPropertyValue(name: string): string };
    };
    return g.getComputedStyle(g.document.documentElement).getPropertyValue("--bg-app").trim();
  });
}

async function openGalleryFromPalette(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.getByTestId("app-root")).toBeVisible();
  await setLocaleTheme(page, "zh-CN", "light");
  await page.keyboard.press("Control+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill("主题");
  await palette.getByRole("option", { name: "选择主题…" }).click();
  await expect(page.getByTestId("settings")).toBeVisible();
  await expect(page.getByTestId("theme-gallery")).toBeVisible();
}

test("独立外观模式（跟随系统 / 浅色 / 深色）+ 全系双模式主题画廊（含 Claude Code）：深浅切换与每个主题实时正交联动", async () => {
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    await openGalleryFromPalette(page);
    await setColorMode(page, "system");

    const gallery = page.getByTestId("theme-gallery");
    const cards = gallery.getByRole("button");
    await expect(cards).toHaveCount(themeFamilyNames.length);
    const order = await cards.evaluateAll((elements) =>
      (elements as unknown as { getAttribute(name: string): string | null }[]).map((element) =>
        element.getAttribute("data-testid"),
      ),
    );
    expect(order).toEqual(themeFamilyNames.map((name) => `theme-card-${name}`));

    // 跟随系统模式下：每张主题卡片都左右对半同时预览自己的浅色与深色效果！
    for (const family of themeFamilyNames) {
      const pair = themeFamilies[family];
      const halves = page.getByTestId(`theme-card-${family}`).locator(".st-theme-main");
      await expect(halves).toHaveCount(2);
      await expect(halves.nth(0)).toHaveCSS("background-color", rgb(await cssBgApp(pair.light)));
      await expect(halves.nth(1)).toHaveCSS("background-color", rgb(await cssBgApp(pair.dark)));
    }

    // 切到独立「浅色」模式：选中 Claude Code -> claude-light (#ffffff)
    await page.getByTestId("setting-color-mode-light").click();
    const claudeCard = page.getByTestId("theme-card-claude");
    await claudeCard.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "claude-light");
    await expect(claudeCard).toHaveAttribute("aria-pressed", "true");
    expect(await rootBgApp(page)).toBe(await cssBgApp("claude-light"));
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(false);

    // 保持 Claude Code 不变，仅切「深色」外观模式 -> 自动切换为 claude-dark (#191919)！
    await page.getByTestId("setting-color-mode-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "claude-dark");
    await expect(claudeCard).toHaveAttribute("aria-pressed", "true");
    expect(await rootBgApp(page)).toBe(await cssBgApp("claude-dark"));
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(true);

    // 在深色模式下点 DeepSeek -> deepseek-dark；再切浅色模式 -> deepseek-light！
    await page.getByTestId("theme-card-deepseek").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "deepseek-dark");
    expect(await rootBgApp(page)).toBe(await cssBgApp("deepseek-dark"));

    await page.getByTestId("setting-color-mode-light").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "deepseek-light");
    expect(await rootBgApp(page)).toBe(await cssBgApp("deepseek-light"));

    // 默认主题 + 跟随系统 = <html> 上移除 data-theme
    await page.getByTestId("setting-color-mode-system").click();
    await page.getByTestId("theme-card-default").click();
    await expect.poll(() => htmlTheme(page)).toBeNull();
    await expect(page.getByTestId("theme-card-default")).toHaveAttribute("aria-pressed", "true");
  } finally {
    await launched.close();
  }
});

test("外观的设置行：背景图选不用时没有浓度；不支持毛玻璃的系统上没有毛玻璃开关；900 宽、中英文下外观不越界", async () => {
  const launched = await launchApp();
  try {
    const { page } = launched;
    await openGalleryFromPalette(page);

    const strength = page.getByTestId("setting-backdrop-strength");
    await expect(page.getByTestId("setting-backdrop-theme")).toHaveAttribute("aria-checked", "true");
    await expect(strength).toBeVisible();
    await expect(page.getByTestId("setting-backdrop-choose")).toHaveCount(0);
    await page.getByTestId("setting-backdrop-none").click();
    await expect(page.getByTestId("setting-backdrop-none")).toHaveAttribute("aria-checked", "true");
    await expect(strength).toHaveCount(0);
    await page.getByTestId("setting-backdrop-theme").click();
    await expect(strength).toBeVisible();
    await page.getByTestId("setting-backdrop-strength-high").click();
    await expect(page.getByTestId("setting-backdrop-strength-high")).toHaveAttribute("aria-checked", "true");

    const { glassSupported } = await page.evaluate(() => globalThis.studio.getAppInfo());
    const glass = page.getByTestId("setting-glass");
    if (glassSupported) {
      await expect(glass).toHaveAttribute("aria-checked", "false");
      await glass.click();
      await expect(glass).toHaveAttribute("aria-checked", "true");
      await glass.click();
      await expect(glass).toHaveAttribute("aria-checked", "false");
    } else {
      await expect(glass).toHaveCount(0);
    }

    await page.setViewportSize({ width: 900, height: 800 });
    for (const locale of ["zh-CN", "en"] as const) {
      await setLocaleTheme(page, locale, "light");
      await expectNoOverflow(page.getByTestId("settings"));
    }
  } finally {
    await launched.close();
  }
});

async function spyOverlay(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("没有主窗口");
    const g = globalThis as unknown as { overlayCalls: { t: number; symbol: string }[] };
    g.overlayCalls = [];
    const original = window.setTitleBarOverlay.bind(window);
    window.setTitleBarOverlay = (options) => {
      g.overlayCalls.push({ t: Date.now(), symbol: options.symbolColor ?? "" });
      original(options);
    };
  });
}

async function overlayCalls(app: ElectronApplication): Promise<{ t: number; symbol: string }[]> {
  return app.evaluate(() => (globalThis as unknown as { overlayCalls: { t: number; symbol: string }[] }).overlayCalls);
}

async function lastSymbol(app: ElectronApplication): Promise<string | undefined> {
  return (await overlayCalls(app)).at(-1)?.symbol;
}

function dimmedSymbol(theme: ThemeName): string {
  const { text, scrim } = themes[theme];
  const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(scrim);
  if (match === null) throw new Error(`${theme} 的 scrim 不是 rgba()`);
  const [r, g, b, alpha] = match.slice(1).map(Number) as [number, number, number, number];
  const over = [r, g, b];
  const channels = [1, 3, 5].map((at) => Number.parseInt(text.slice(at, at + 2), 16));
  const mixed = channels.map((c, i) => Math.round(c + ((over[i] ?? 0) - c) * alpha));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

test("系统三键跟着网页换主题：网页换之前不先变，和网页一起淡入；遮罩弹窗开着时换成新主题变暗的颜色；设置里减少动效时命令面板的变暗不渐变", async () => {
  test.skip(process.platform === "darwin", "mac 没有 titleBarOverlay，三键是系统的红黄绿");
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    await expect(page.getByTestId("app-root")).toBeVisible();
    await setLocaleTheme(page, "zh-CN", "claude-light");
    await spyOverlay(app);
    await expect
      .poll(async () => (await lastSymbol(app)) ?? themes["claude-light"].text)
      .toBe(themes["claude-light"].text);
    await app.evaluate(() => {
      (globalThis as unknown as { overlayCalls: unknown[] }).overlayCalls.length = 0;
    });
    await page.evaluate(() => {
      const g = globalThis as unknown as {
        themeChangedAt: number | null;
        document: { documentElement: object };
        MutationObserver: new (callback: () => void) => { observe(target: object, options: object): void };
      };
      g.themeChangedAt = null;
      new g.MutationObserver(() => (g.themeChangedAt ??= Date.now())).observe(g.document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    });
    await setTheme(page, "claude-dark");
    await expect.poll(() => lastSymbol(app)).toBe(themes["claude-dark"].text);
    const changedAt = await page.evaluate(() => (globalThis as unknown as { themeChangedAt: number }).themeChangedAt);
    const calls = await overlayCalls(app);
    expect(
      calls.filter((call) => call.t < changedAt).every((call) => call.symbol === themes["claude-light"].text),
    ).toBe(true);
    expect(
      calls.some((call) => call.symbol !== themes["claude-light"].text && call.symbol !== themes["claude-dark"].text),
    ).toBe(true);

    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await expect.poll(() => lastSymbol(app)).toBe(dimmedSymbol("claude-dark"));
    await setTheme(page, "pi-dark");
    await expect.poll(() => lastSymbol(app)).toBe(dimmedSymbol("pi-dark"));
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toBeHidden();
    await expect.poll(() => lastSymbol(app)).toBe(themes["pi-dark"].text);

    await page.evaluate(() => globalThis.studio.setReduceMotion(true));
    await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
    await app.evaluate(() => {
      (globalThis as unknown as { overlayCalls: unknown[] }).overlayCalls.length = 0;
    });
    const ends = new Set<string>([themes["pi-dark"].text, dimmedSymbol("pi-dark")]);
    await page.keyboard.press("Control+k");
    await expect.poll(() => lastSymbol(app)).toBe(dimmedSymbol("pi-dark"));
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toBeHidden();
    await expect.poll(() => lastSymbol(app)).toBe(themes["pi-dark"].text);
    expect((await overlayCalls(app)).filter((call) => !ends.has(call.symbol))).toEqual([]);
  } finally {
    await launched.close();
  }
});
