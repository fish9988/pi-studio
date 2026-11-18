// Office 预览的纯逻辑（src/renderer/src/features/file-preview/office-model.ts）：
// 列标换算、工作簿 → 表格模型（格式化文本、偏移、行 / 列上限与截断标记）、Markdown 表格导出。
// 样本用普通对象构造，不依赖解析库和真实二进制文件。
import { describe, expect, it } from "vitest";
import {
  buildWorkbookModel,
  columnLabel,
  officeMaxColumns,
  officeMaxRows,
  toMarkdownTable,
  type OfficeSheet,
  type OfficeSheetSource,
} from "../src/renderer/src/features/file-preview/office-model.ts";

/** 单元格：w 是格式化文本，v 是原始值。 */
const text = (value: string) => ({ t: "s", v: value, w: value });
const number = (value: number, formatted?: string) => ({ t: "n", v: value, w: formatted ?? String(value) });

const sheetOf = (ref: string | null, cells: Record<string, unknown>): OfficeSheetSource =>
  ref === null ? { ...cells } : { "!ref": ref, ...cells };

describe("columnLabel", () => {
  it("0 基列号转成 A、Z、AA、ZZ、AAA", () => {
    expect(columnLabel(0)).toBe("A");
    expect(columnLabel(1)).toBe("B");
    expect(columnLabel(25)).toBe("Z");
    expect(columnLabel(26)).toBe("AA");
    expect(columnLabel(27)).toBe("AB");
    expect(columnLabel(51)).toBe("AZ");
    expect(columnLabel(52)).toBe("BA");
    expect(columnLabel(701)).toBe("ZZ");
    expect(columnLabel(702)).toBe("AAA");
    expect(columnLabel(16383)).toBe("XFD");
  });

  it("非法列号给空串，不抛错", () => {
    expect(columnLabel(-1)).toBe("");
    expect(columnLabel(Number.NaN)).toBe("");
    expect(columnLabel(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("buildWorkbookModel", () => {
  it("按工作表顺序给出名字与单元格文本，格式化文本优先于原始值", () => {
    const model = buildWorkbookModel({
      SheetNames: ["汇总", "明细"],
      Sheets: {
        汇总: sheetOf("A1:B2", {
          A1: text("项目"),
          B1: number(1200, "1,200"),
          A2: text("合计"),
          B2: number(1200, "¥1,200.00"),
        }),
        明细: sheetOf("A1:A1", { A1: number(0.5, "50%") }),
      },
    });
    expect(model.sheets.map((sheet) => sheet.name)).toEqual(["汇总", "明细"]);
    expect(model.sheets[0]).toMatchObject({
      columns: ["A", "B"],
      rows: [
        ["项目", "1,200"],
        ["合计", "¥1,200.00"],
      ],
      startRow: 0,
      totalRows: 2,
      truncated: false,
    });
    expect(model.sheets[1]?.rows).toEqual([["50%"]]);
  });

  it("没有 w 时回退原始值：数字、布尔、日期都写得出来", () => {
    const model = buildWorkbookModel({
      SheetNames: ["S"],
      Sheets: {
        S: sheetOf("A1:C1", {
          A1: { t: "n", v: 42 },
          B1: { t: "b", v: true },
          C1: { t: "d", v: new Date("2026-11-02T00:00:00.000Z") },
        }),
      },
    });
    expect(model.sheets[0]?.rows).toEqual([["42", "TRUE", "2026-11-02"]]);
  });

  it("空单元格、富文本对象、坏值一律给空串", () => {
    const model = buildWorkbookModel({
      SheetNames: ["S"],
      Sheets: {
        S: sheetOf("A1:C1", { A1: { t: "z" }, B1: { t: "e", v: { error: "#N/A" } }, C1: text("有值") }),
      },
    });
    expect(model.sheets[0]?.rows).toEqual([["", "", "有值"]]);
  });

  it("没有 !ref 时按单元格地址推维度", () => {
    const model = buildWorkbookModel({
      SheetNames: ["S"],
      Sheets: { S: sheetOf(null, { B2: text("x"), C4: text("y") }) },
    });
    expect(model.sheets[0]).toMatchObject({
      columns: ["B", "C"],
      startRow: 1,
      totalRows: 3,
      rows: [["x"], [], ["", "y"]],
    });
  });

  it("表从 C3 起：列标与行号都不假装从 A1 开始", () => {
    const model = buildWorkbookModel({
      SheetNames: ["S"],
      Sheets: { S: sheetOf("C3:D4", { C3: text("甲"), D4: text("乙") }) },
    });
    expect(model.sheets[0]).toMatchObject({ columns: ["C", "D"], startRow: 2, totalRows: 2 });
    expect(model.sheets[0]?.rows).toEqual([["甲"], ["", "乙"]]);
  });

  it("尾部全空的行 / 列不占版面，但 totalRows 保留真实维度", () => {
    const model = buildWorkbookModel({
      SheetNames: ["S"],
      Sheets: { S: sheetOf("A1:D9", { A1: text("表头"), B1: text("值") }) },
    });
    expect(model.sheets[0]).toMatchObject({ columns: ["A", "B"], totalRows: 9, truncated: false });
    expect(model.sheets[0]?.rows).toEqual([["表头", "值"]]);
  });

  it("行数超过上限时截断并标记，行号仍从表头数起", () => {
    const cells: Record<string, unknown> = {};
    for (let row = 1; row <= 1500; row++) cells[`A${row}`] = text(`r${row}`);
    const model = buildWorkbookModel({ SheetNames: ["长表"], Sheets: { 长表: sheetOf("A1:A1500", cells) } });
    const sheet = model.sheets[0];
    expect(sheet?.totalRows).toBe(1500);
    expect(sheet?.truncated).toBe(true);
    expect(sheet?.rows).toHaveLength(officeMaxRows);
    expect(sheet?.rows[0]).toEqual(["r1"]);
    expect(sheet?.rows.at(-1)).toEqual([`r${officeMaxRows}`]);
  });

  it("列数超过上限时只保留前 officeMaxColumns 列", () => {
    const cells: Record<string, unknown> = {};
    for (let col = 1; col <= 130; col++) cells[`${columnLabel(col - 1)}1`] = text(`c${col}`);
    const model = buildWorkbookModel({
      SheetNames: ["宽表"],
      Sheets: { 宽表: sheetOf(`A1:${columnLabel(129)}1`, cells) },
    });
    const sheet = model.sheets[0];
    expect(sheet?.columns).toHaveLength(officeMaxColumns);
    expect(sheet?.columns[0]).toBe("A");
    expect(sheet?.columns.at(-1)).toBe(columnLabel(officeMaxColumns - 1));
    expect(sheet?.rows[0]).toHaveLength(officeMaxColumns);
  });

  it("上限可以调小（测试与特殊场景用）", () => {
    const cells: Record<string, unknown> = {};
    for (let row = 1; row <= 8; row++) cells[`A${row}`] = text(`r${row}`);
    const model = buildWorkbookModel(
      { SheetNames: ["S"], Sheets: { S: sheetOf("A1:A8", cells) } },
      { maxRows: 3, maxColumns: 1 },
    );
    expect(model.sheets[0]?.rows.map((row) => row[0])).toEqual(["r1", "r2", "r3"]);
    expect(model.sheets[0]?.truncated).toBe(true);
  });

  it("空表、名字对不上单元格的表都给空模型，不抛错", () => {
    const model = buildWorkbookModel({
      SheetNames: ["空表", "没数据"],
      Sheets: { 空表: {}, 没数据: undefined },
    });
    expect(model.sheets.map((sheet) => sheet.name)).toEqual(["空表", "没数据"]);
    for (const sheet of model.sheets) {
      expect(sheet.columns).toEqual([]);
      expect(sheet.rows).toEqual([]);
      expect(sheet.totalRows).toBe(0);
      expect(sheet.truncated).toBe(false);
    }
  });

  it("!ref 认不出来时改按实际单元格地址推维度", () => {
    const model = buildWorkbookModel({
      SheetNames: ["坏 ref"],
      Sheets: { "坏 ref": sheetOf("???", { A1: text("x") }) },
    });
    expect(model.sheets[0]).toMatchObject({ columns: ["A"], rows: [["x"]], totalRows: 1 });
  });

  it("SheetNames 不是数组时给空列表", () => {
    expect(buildWorkbookModel({}).sheets).toEqual([]);
    expect(buildWorkbookModel({ SheetNames: "S" }).sheets).toEqual([]);
  });
});

describe("toMarkdownTable", () => {
  const sheet = (rows: string[][]): OfficeSheet => ({
    name: "S",
    columns: rows
      .reduce((widest, row) => (row.length > widest.length ? row : widest), [])
      .map((_, index) => columnLabel(index)),
    rows,
    startRow: 0,
    totalRows: rows.length,
    truncated: false,
  });

  it("第一行当表头，第二行是分隔行", () => {
    expect(
      toMarkdownTable(
        sheet([
          ["名称", "数量"],
          ["苹果", "3"],
        ]),
      ),
    ).toBe(["| 名称 | 数量 |", "| --- | --- |", "| 苹果 | 3 |"].join("\n"));
  });

  it("竖线转义、换行写成 <br>、短行补空单元格", () => {
    expect(toMarkdownTable(sheet([["a|b", "换\n行"], ["只有一个"]]))).toBe(
      ["| a\\|b | 换<br>行 |", "| --- | --- |", "| 只有一个 |  |"].join("\n"),
    );
  });

  it("只有表头时只给表头和分隔行", () => {
    expect(toMarkdownTable(sheet([["x", "y"]]))).toBe(["| x | y |", "| --- | --- |"].join("\n"));
  });

  it("空表给空串（调用方据此不写剪贴板）", () => {
    expect(toMarkdownTable(sheet([]))).toBe("");
  });
});
