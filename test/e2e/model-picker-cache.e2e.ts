// 模型选择器要"点开就有"：第二次打开用它上次读到的目录直接画表，不先闪一屏骨架屏。
// 骨架屏只在真的一个模型都没有时出现（首次启动、启动快照也是空的）。
// 逐帧记录在页面里跑：打开动画期间每一帧看一次骨架屏/模型行在不在。
import { expect, test } from "@playwright/test";
import { launchApp, setLocale, testPi } from "./launch.ts";

test("模型选择器第二次打开直接用缓存目录画表：一帧骨架屏都不出现", async () => {
  const launched = await launchApp({ STUDIO_TEST_PI: testPi() });
  try {
    const { page } = launched;
    await setLocale(page, "zh-CN");
    const chip = page.getByTestId("model-chip");
    await expect(chip).toBeVisible();
    // 第一次打开：把目录读进缓存（这次允许有骨架屏）。
    await chip.click();
    await expect(page.getByTestId("model-option").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("model-picker")).toHaveCount(0);

    // 第二次打开：从点下去开始逐帧记录，直到出现模型行。
    await page.evaluate(() => {
      const g = globalThis as unknown as {
        document: { querySelector(selector: string): unknown };
        requestAnimationFrame(callback: () => void): void;
        __pickerFrames: string[];
      };
      g.__pickerFrames = [];
      const tick = () => {
        // 从「选择器真的出现在 DOM 里」的第一帧开始算，之前是点击还没生效。
        if (g.document.querySelector('[data-testid="model-picker"]') !== null) {
          const skeleton = g.document.querySelector('[data-testid="model-skeleton"]') !== null;
          const row = g.document.querySelector('[data-testid="model-option"]') !== null;
          g.__pickerFrames.push(`${skeleton ? "S" : "-"}${row ? "R" : "-"}`);
        }
        if (g.__pickerFrames.length < 60) g.requestAnimationFrame(tick);
      };
      g.requestAnimationFrame(tick);
    });
    await chip.click();
    await expect(page.getByTestId("model-option").first()).toBeVisible();
    const frames = await page.evaluate(() => (globalThis as unknown as { __pickerFrames: string[] }).__pickerFrames);
    expect(frames.length).toBeGreaterThan(0);
    // 缓存命中时第一帧就是完整列表：不是"等一会儿才有行"，而是压根没画过骨架屏。
    expect(frames[0]?.endsWith("R")).toBe(true);
    expect(frames.filter((frame) => frame.startsWith("S"))).toEqual([]);
    expect(frames.some((frame) => frame.endsWith("R"))).toBe(true);
  } finally {
    await launched.close();
  }
});
