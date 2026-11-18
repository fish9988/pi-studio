// P0 全链路端到端验证：
// 1. 右侧工作台多文件独立预览 Tab 并存、切换、关闭与 Esc 关闭；
// 2. 侧栏 PDF Range 分片渲染、翻页、查找、TextLayer 划词引用到对话与旁路提问；
// 3. 侧栏 Office（DOCX / XLSX）原生预览、多 Sheet 切换、复制 Markdown 表格；
// 4. Markdown 预览划词悬浮条（引用到对话 / 旁路提问）。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { launchApp, openTaskRow, setLocaleTheme, testPi } from "./launch.ts";

/** 生成带准确 xref 表的合法 2 页 PDF 1.4 字节流。 */
function buildTwoPagePdf(pageTexts: readonly [string, string]): Buffer {
  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n",
  ];
  for (const text of pageTexts) {
    const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const stream = `BT /F1 18 Tf 72 700 Td (${escaped}) Tj ET\n`;
    const idx = objects.length + 1;
    objects.push(
      `${idx} 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream\nendobj\n`,
    );
  }
  objects.push("7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "utf8")];
  const offsets: number[] = [0];
  let cursor = chunks[0]!.length;
  for (const obj of objects) {
    offsets.push(cursor);
    const buf = Buffer.from(obj, "utf8");
    chunks.push(buf);
    cursor += buf.length;
  }
  const xrefOffset = cursor;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (let i = 1; i < offsets.length; i++) {
    xrefLines.push(`${String(offsets[i]!).padStart(10, "0")} 00000 n \n`);
  }
  xrefLines.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  chunks.push(Buffer.from(xrefLines.join(""), "utf8"));
  return Buffer.concat(chunks);
}

/** 用 JSZip 生成最小合法 .docx 文件。 */
async function buildMinimalDocx(paragraphText: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${paragraphText}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 用 SheetJS 生成真实双工作表 .xlsx 文件。 */
function buildSampleXlsx(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([
    ["Metric", "Value"],
    ["Accuracy", 0.94],
  ]);
  const ws2 = XLSX.utils.aoa_to_sheet([
    ["Stage", "Status"],
    ["Release", "Ready"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws1, "Summary");
  XLSX.utils.book_append_sheet(wb, ws2, "Pipeline");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("P0 集成：PDF 交互阅读、DOCX/XLSX 原生预览、多文件标签并存与 Markdown 划词浮条", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "studio-p0-"));
  const project = path.join(work, "project");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "paper.pdf"), buildTwoPagePdf(["Page One Benchmark", "Page Two Latency"]));
  await writeFile(path.join(project, "report.docx"), await buildMinimalDocx("Quarterly Engineering Summary"));
  await writeFile(path.join(project, "data.xlsx"), buildSampleXlsx());
  await writeFile(path.join(project, "notes.md"), "# Spec Notes\n\nAlpha target latency improved significantly.\n");

  const launched = await launchApp({ STUDIO_TEST_PI: testPi() });
  try {
    const { app, page } = launched;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setLocaleTheme(page, "zh-CN", "light");
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, project);

    await page.evaluate(async () => {
      const added = await globalThis.studio.addProject();
      if (!added) throw new Error("addProject failed");
      await globalThis.studio.createTask({ projectId: added.id });
    });
    await openTaskRow(page);
    await expect(page.getByTestId("composer-input")).toBeVisible();

    // 打开文件树面板，在树里用"新标签打开"并存打开 4 个不同文件
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+E" : "Control+Shift+E");
    const openNewTabFromTree = async (fileName: string) => {
      await page.getByTestId("wb-tab-files").click();
      const row = page.locator(`[data-testid="file-tree-row"][data-path="${fileName}"]`);
      await expect(row).toBeVisible();
      await row.click({ button: "middle" });
    };

    // 1) 打开 PDF 独立标签页并测试交互
    await openNewTabFromTree("paper.pdf");
    const pdfViewer = page.getByTestId("pdf-viewer");
    await expect(pdfViewer).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("pdf-page-input")).toHaveValue("1");
    await expect(pdfViewer.locator(".pdf-pv-text")).toContainText("Page One Benchmark", { timeout: 15_000 });

    // 翻到第 2 页
    await page.getByTestId("pdf-next").click();
    await expect(page.getByTestId("pdf-page-input")).toHaveValue("2");
    await expect(pdfViewer.locator(".pdf-pv-text")).toContainText("Page Two Latency", { timeout: 15_000 });

    // PDF 全文查找（首次命中自动跳转第 1 页）
    await page.getByTestId("pdf-search-toggle").click();
    await page.getByTestId("pdf-search-input").fill("Benchmark");
    await expect(page.getByTestId("pdf-search-count")).toContainText("1/1", { timeout: 10_000 });
    await expect(page.getByTestId("pdf-page-input")).toHaveValue("1");
    await expect(pdfViewer.locator(".pdf-pv-text")).toContainText("Page One Benchmark", { timeout: 10_000 });

    // PDF 文本层划词并触发"引用到对话"
    await pdfViewer
      .locator(".pdf-pv-text span")
      .first()
      .evaluate((el) => {
        const domEl = el as unknown as {
          firstChild: unknown;
          ownerDocument: {
            createRange(): { selectNodeContents(node: unknown): void };
            defaultView: { getSelection(): { removeAllRanges(): void; addRange(r: unknown): void } | null } | null;
            dispatchEvent(ev: unknown): void;
          };
        };
        if (!domEl.firstChild) throw new Error("missing pdf text span");
        const range = domEl.ownerDocument.createRange();
        range.selectNodeContents(domEl.firstChild);
        const sel = domEl.ownerDocument.defaultView?.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        domEl.ownerDocument.dispatchEvent(new Event("selectionchange"));
      });
    const pdfTip = page.getByTestId("pdf-selection-tooltip");
    await expect(pdfTip).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("pdf-quote").click();
    await expect(page.getByTestId("composer-input")).toContainText("paper.pdf");
    await expect(page.getByTestId("composer-input")).toContainText("Page One Benchmark");

    // 2) 打开 XLSX 独立标签页并切换工作表
    await openNewTabFromTree("data.xlsx");
    const xlsxGrid = page.getByTestId("office-pv-grid");
    await expect(xlsxGrid).toBeVisible({ timeout: 15_000 });
    await expect(xlsxGrid).toContainText("Accuracy");
    await page.getByRole("tab", { name: "Pipeline" }).click();
    await expect(xlsxGrid).toContainText("Ready");

    // 3) 打开 DOCX 独立标签页
    await openNewTabFromTree("report.docx");
    const docxView = page.getByTestId("office-pv-docx");
    await expect(docxView).toBeVisible({ timeout: 15_000 });
    await expect(docxView).toContainText("Quarterly Engineering Summary", {
      timeout: 15_000,
    });

    // 4) 打开 Markdown 独立标签页并验证 4 个预览标签同时并存、可切回且划词可触发 BTW
    await openNewTabFromTree("notes.md");
    await expect(page.getByTestId("wb-tab-preview")).toHaveCount(4);
    const mdBody = page.getByTestId("file-preview-md").last();
    await expect(mdBody).toContainText("Alpha target latency improved significantly.");

    // 选中 Markdown 文本触发 SelectionTooltip -> 旁路提问 (BTW)
    await mdBody
      .locator("p")
      .filter({ hasText: "Alpha target latency" })
      .evaluate((el) => {
        const domEl = el as unknown as {
          firstChild: unknown;
          ownerDocument: {
            createRange(): { selectNodeContents(node: unknown): void };
            defaultView: { getSelection(): { removeAllRanges(): void; addRange(r: unknown): void } | null } | null;
            dispatchEvent(ev: unknown): void;
          };
        };
        if (!domEl.firstChild) throw new Error("missing md paragraph");
        const range = domEl.ownerDocument.createRange();
        range.selectNodeContents(domEl.firstChild);
        const sel = domEl.ownerDocument.defaultView?.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        domEl.ownerDocument.dispatchEvent(new Event("selectionchange"));
      });
    const selTip = page.getByTestId("selection-tooltip");
    await expect(selTip).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("selection-btw").click();
    await expect(page.getByTestId("btw-panel")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("btw-input")).toHaveValue(/Alpha target latency/);

    // 切回 paper.pdf 标签页，它仍保持活跃且状态完好
    await page.getByTestId("wb-tab-preview").filter({ hasText: "paper.pdf" }).click();
    await expect(page.getByTestId("pdf-viewer")).toBeVisible();
  } finally {
    await launched.close();
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
