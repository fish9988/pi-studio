// Pi 专属 8 大设置分区与 `/` 斜杠命令菜单的端到端验证：
// 验证重做后的全部 Pi 设置分区均可正常挂载读写 settings.json / AGENTS.md，且 `/` 命令仅暴露 Pi 原生命令、不含 OMP 专属命令。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, testOmp } from "./launch.ts";

test("Pi 8 大设置分区与 / 斜杠命令菜单端到端验证", async () => {
  const launched = await launchApp({ STUDIO_TEST_OMP: testOmp("slash-status") });
  try {
    const { page, agentDir } = launched;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 860 });

    // 1. 输入框不含 OMP 专属的权限模式/角色/目标模式胶囊，且 `/` 菜单只出现 Pi 原生命令。
    await expect(page.getByTestId("approval-chip")).toHaveCount(0);
    const input = page.getByTestId("composer-input");
    await input.fill("/");
    const slashPopup = page.getByRole("listbox");
    await expect(slashPopup).toBeVisible();
    await expect(slashPopup).toContainText("/settings");
    await expect(slashPopup).toContainText("/thinking");
    await expect(slashPopup).toContainText("/scoped-models");
    await expect(slashPopup).not.toContainText("/goal");
    await expect(slashPopup).not.toContainText("/vibe");
    await input.fill("");

    // 2. 通过快捷键打开重做后的 Pi 并行设置窗口，验证不覆盖左侧栏与主会话面板，且 8 大分区挂载与真实读写正常。
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await expect(page.getByTestId("settings-window")).toBeVisible();
    await expect(page.getByTestId("settings")).toBeVisible();
    await expect(page.getByTestId("settings-nav")).toBeVisible();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("main-panel")).toBeVisible();

    // Models 分区：切换默认思考强度并写入 <agentDir>/settings.json
    await page.getByTestId("settings-nav-models").click();
    await expect(page.getByTestId("pi-models-section")).toBeVisible();
    await page.getByTestId("pi-thinking-high").click();
    await expect
      .poll(async () => {
        const raw = await readFile(path.join(agentDir, "settings.json"), "utf8").catch(() => "{}");
        return (JSON.parse(raw) as { defaultThinkingLevel?: string }).defaultThinkingLevel;
      })
      .toBe("high");

    // Providers 分区：内置 Provider 与凭据卡片渲染
    await page.getByTestId("settings-nav-providers").click();
    await expect(page.getByTestId("pi-providers-section")).toBeVisible();

    // Tools 分区：内置工具矩阵与 CodeMode 配置渲染
    await page.getByTestId("settings-nav-tools").click();
    await expect(page.getByTestId("pi-tools-section")).toBeVisible();

    // Extensions 分区：已装插件、插件市场、内置增强、内置扩展、Skills、MCP 管理渲染
    await page.getByTestId("settings-nav-extensions").click();
    await expect(page.getByTestId("pi-installed-plugins-section")).toBeVisible();
    await expect(page.getByTestId("pi-marketplace-section")).toBeVisible();
    await expect(page.getByTestId("pi-marketplace-grid")).toBeVisible();
    await expect(page.getByTestId("pi-workbench-enhancements")).toBeVisible();
    await expect(page.getByTestId("pi-builtin-extensions")).toBeVisible();

    // Context 分区：自动压缩参数与 AGENTS.md 文档保存
    await page.getByTestId("settings-nav-context").click();
    await expect(page.getByTestId("pi-context-section")).toBeVisible();
    await page.getByTestId("pi-doc-editor").fill("# Workspace Rule\nPrefer concise code.\n");
    await page.getByTestId("pi-doc-save").click();
    await expect
      .poll(() => readFile(path.join(agentDir, "AGENTS.md"), "utf8").catch(() => ""))
      .toContain("Prefer concise code.");

    // Advanced 分区：网络传输与高级参数渲染
    await page.getByTestId("settings-nav-advanced").click();
    await expect(page.getByTestId("pi-advanced-section")).toBeVisible();

    // About & General 分区
    await page.getByTestId("settings-nav-about").click();
    await expect(page.getByTestId("settings")).toContainText("pi-studio");
    await page.getByTestId("settings-nav-general").click();

    // Esc 退出设置回到主界面
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings")).toHaveCount(0);
  } finally {
    await launched.close();
  }
});
