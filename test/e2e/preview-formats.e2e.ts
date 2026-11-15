import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, setLocaleTheme, testPi } from "./launch.ts";

test("文件预览跨格式回归：Markdown、SVG、PNG、Mermaid、CSV、JSON 与源码完整显示", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "studio-preview-formats-"));
  const project = path.join(work, "project");
  await mkdir(project);
  const fixtures = {
    "notes.md": "# Markdown 正文\n\n可正常阅读。",
    "figure.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>',
    "flow.mmd": "flowchart LR\n A[开始] --> B[结束]",
    "table.csv": 'name,value\n"中文,单元格",42',
    "data.json": '{"label":"结构树","items":[1,2]}',
    "invalid.json": '{"missing":',
    "long.txt": Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"),
  };
  await Promise.all(Object.entries(fixtures).map(([name, text]) => writeFile(path.join(project, name), text)));
  await writeFile(
    path.join(project, "pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const launched = await launchApp({ STUDIO_TEST_PI: testPi() });
  try {
    const { app, page } = launched;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setLocaleTheme(page, "zh-CN", "light");
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, project);
    await page.getByTestId("sidebar-open-folder").click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+E" : "Control+Shift+E");
    const body = page.getByTestId("file-preview-body");
    const open = async (name: string) => {
      await page.getByTestId("file-preview-page-files").click();
      await page.locator(`[data-testid="file-tree-row"][data-path="${name}"]`).click();
      await expect(page.getByTestId("file-preview-name")).toHaveText(name);
    };
    await open("notes.md");
    await expect(body.getByRole("heading", { name: "Markdown 正文" })).toBeVisible();
    await page.getByTestId("file-preview-mode-source").click();
    await expect(body.locator("pre")).toContainText("# Markdown 正文");
    for (const name of ["pixel.png", "figure.svg"]) {
      await open(name);
      const img = body.getByTestId("file-preview-image");
      await expect(img).toBeVisible();
      await expect
        .poll(() => img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth))
        .toBeGreaterThan(0);
      if (name.endsWith("svg")) {
        await page.getByTestId("file-preview-mode-source").click();
        await expect(body.locator("pre")).toContainText('<svg xmlns="http://www.w3.org/2000/svg"');
      }
    }
    await open("flow.mmd");
    await expect(body.getByTestId("codeblock-figure")).toBeVisible();
    await open("table.csv");
    await expect(body.getByRole("cell", { name: "中文,单元格", exact: true })).toBeVisible();
    await open("data.json");
    await page.getByTestId("file-preview-json-tree-toggle").click();
    await expect(body.getByTestId("file-preview-json-tree")).toContainText("结构树");
    await open("invalid.json");
    await page.getByTestId("file-preview-json-tree-toggle").click();
    await expect(body.locator("pre")).toContainText('{"missing":');
    await open("long.txt");
    await expect(body.locator("pre")).toContainText("line 299");
    await expect(body.getByTestId("codeblock-toggle")).toHaveCount(0);
  } finally {
    await launched.close();
    await rm(work, { recursive: true, force: true, maxRetries: 5 });
  }
});
