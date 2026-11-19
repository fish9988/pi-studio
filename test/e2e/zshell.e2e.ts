import { expect, test } from "@playwright/test";
import { launchApp, setLocaleTheme, testPi } from "./launch.ts";

test("现代工作台风格：一体式顶栏侧栏、极简空态问候、双列新标签页启动器与 Pi 会话无缝联动", async () => {
  const launched = await launchApp({ STUDIO_TEST_PI: testPi() });
  try {
    const { app, page } = launched;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1568, 840));
    await setLocaleTheme(page, "zh-CN", "claude-light");
    await page.evaluate(() => globalThis.studio.setShellState({ uiStyle: "zcode", sidebarWidth: 244 }));
    await page.reload();

    const sidebar = page.getByTestId("sidebar");
    const mainPanel = page.getByTestId("main-panel");
    await expect(page.locator("html")).toHaveAttribute("data-ui-style", "zcode");
    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId("topbar-sidebar")).toBeVisible();
    await expect(page.getByTestId("topbar-back")).toBeVisible();
    await expect(page.getByTestId("topbar-forward")).toBeVisible();
    await expect(page.getByTestId("topbar-files")).toBeVisible();

    // 侧栏与主面板无双重竖线相切：sidebar-column 无右边框，主面板为圆角白底卡片。
    await expect(page.getByTestId("sidebar-column")).toHaveCSS("border-right-width", "0px");
    await expect(mainPanel).toHaveCSS("border-radius", "12px");

    // 侧栏顶部默认收起大搜索框，点击放大镜图标平滑展开搜索，Esc 收起。
    await expect(sidebar.getByTestId("sidebar-search")).toHaveCount(0);
    await sidebar.getByTestId("sidebar-search-toggle").click();
    const search = sidebar.getByTestId("sidebar-search");
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sidebar.getByTestId("sidebar-search")).toHaveCount(0);

    // 侧栏拖拽调宽保持生效。
    const sidebarResizer = page.getByTestId("sidebar-resizer");
    await expect(sidebarResizer).toHaveAttribute("aria-valuenow", "244");
    await sidebarResizer.focus();
    await page.keyboard.press("ArrowRight");
    await expect(sidebarResizer).toHaveAttribute("aria-valuenow", "260");

    // 空状态居中展示时段问候与输入框，且不出现重复的启动器网格或桌宠遮挡。
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await expect(page.getByTestId("dsh-start-launcher")).toHaveCount(0);

    // 打开右侧工作台：显示真实「新标签页」胶囊 + 双列横向应用启动器，所有入口均可用（无置灰死卡片）。
    await page.getByTestId("topbar-files").click();
    const wb = page.getByTestId("right-workbench");
    await expect(wb).toBeVisible();
    await expect(wb.getByTestId("wb-tab-start")).toContainText("新标签页");
    const launcher = wb.getByTestId("dsh-start-launcher");
    await expect(launcher).toBeVisible();
    await expect(launcher.getByTestId("dsh-start-files")).toBeEnabled();
    await expect(launcher.getByTestId("dsh-start-browser")).toBeEnabled();
    await expect(launcher.getByTestId("dsh-start-terminal")).toBeEnabled();
    await expect(launcher.getByTestId("dsh-start-changes")).toBeEnabled();

    // 在草稿态直接点击「文件」打开文件树页签，再点「+」新开「新标签页」。
    await launcher.getByTestId("dsh-start-files").click();
    await expect(wb.getByTestId("wb-tab-files")).toBeVisible();
    await wb.getByTestId("dsh-wb-add-tab").click();
    await expect(wb.getByTestId("dsh-start-launcher")).toBeVisible();

    // 发送真实 Pi 会话消息：对话流中隐藏重复的顶部 studio-header，任务出现在侧栏「会话」区。
    await page.getByTestId("composer-input").fill("用一句中文回答：2+2 等于几？不要调用任何工具。");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tsp-view")).toBeVisible();
    await expect(page.locator('[data-testid="tsp-view"] [data-testid="studio-header"]')).toBeHidden();
    await expect(sidebar.getByTestId("task-row")).toHaveCount(1);

    // 设置停靠与窄窗口抽屉遮罩均正常工作、无横向溢出。
    await sidebar.locator(".sb-settings").click();
    const settings = page.getByTestId("settings-window");
    await expect(settings).toBeVisible();
    await settings.getByTestId("settings-win-mode").click();
    await expect(settings).toHaveAttribute("data-mode", "dock");
    await settings.getByTestId("settings-win-close").click();
    await expect(settings).toHaveCount(0);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(880, 840));
    const html = page.locator("html");
    await expect.poll(() => html.evaluate((el) => (el as unknown as { clientWidth: number }).clientWidth)).toBe(880);
    const horizontalOverflow = await html.evaluate((el) => {
      const node = el as unknown as { scrollWidth: number; clientWidth: number };
      return node.scrollWidth - node.clientWidth;
    });
    expect(horizontalOverflow).toBeLessThanOrEqual(1);
    await page.getByTestId("topbar-sidebar").click();
    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId("drawer-scrim")).toBeVisible();
    await page.getByTestId("drawer-scrim").click({ position: { x: 650, y: 300 } });
    await expect(sidebar).toBeHidden();
  } finally {
    await launched.close();
  }
});
