// Office 预览的纯逻辑（不碰 DOM、不加载解析库）：把解析出的工作簿整理成能直接渲染的表格模型，
// 以及列标换算与 Markdown 表格导出。入参按最小结构声明（解析库的 WorkBook 结构上就满足），
// 单测用普通对象构造即可，不需要二进制样本。
// 行列都有上限：整表塞进 DOM 会让切一个文件就白屏几秒。

/** 一张表最多渲染的行数；超出只显示前这么多行（界面提示"已显示前 N 行"）。 */
export const officeMaxRows = 1000;

/** 一张表最多渲染的列数。 */
export const officeMaxColumns = 100;

/** 单元格里会读的两处：w 是按单元格格式排好的文本，v 是原始值。 */
interface CellSource {
  w?: unknown;
  v?: unknown;
}

/** 解析结果里的工作表：`!ref` 是维度，其余键是 `A1` 形式的单元格。 */
export interface OfficeSheetSource {
  "!ref"?: unknown;
  [address: string]: unknown;
}

/** 解析结果里的工作簿：只用到表名顺序和每张表的单元格。 */
export interface OfficeWorkbookSource {
  SheetNames?: unknown;
  Sheets?: Record<string, OfficeSheetSource | undefined> | undefined;
}

/** 一张可直接渲染的表。 */
export interface OfficeSheet {
  /** 表名（底部标签条上的文字）。 */
  name: string;
  /** 列标 A、B、C…：从表里第一个有内容的列算起，最多 officeMaxColumns 个。 */
  columns: string[];
  /** 每行的单元格文本，与 columns 前面对齐；尾部空单元格已裁掉，尾部整行全空的行不占版面。 */
  rows: string[][];
  /** 第一行在这张表里的 0 基行号：显示行号用 startRow + 下标 + 1。 */
  startRow: number;
  /** 这张表实际有多少行（截断前的维度）。 */
  totalRows: number;
  /** 行数超过 officeMaxRows，rows 里只有前 officeMaxRows 行。 */
  truncated: boolean;
}

export interface OfficeWorkbook {
  sheets: OfficeSheet[];
}

export interface OfficeModelOptions {
  maxRows?: number | undefined;
  maxColumns?: number | undefined;
}

interface Bounds {
  minRow: number;
  minCol: number;
  maxRow: number;
  maxCol: number;
}

const addressPattern = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/;

/** 0 基列号 → 列标：0 → A、25 → Z、26 → AA、701 → ZZ。非法值返回空串。 */
export function columnLabel(index: number): string {
  if (!Number.isFinite(index) || index < 0) return "";
  let rest = Math.floor(index) + 1;
  let label = "";
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    rest = Math.floor((rest - 1) / 26);
  }
  return label;
}

/** `A1` / `$C$3` → 0 基行列；不是单元格地址（`!ref`、`!merges` 等）返回 null。 */
function parseAddress(address: string): { row: number; col: number } | null {
  const match = addressPattern.exec(address);
  if (match === null) return null;
  let col = 0;
  for (const char of match[1]!.toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

/** `A1:C10` 或 `A1` → 0 基范围；顺序写反了也按左上到右下归一。 */
function parseBounds(ref: string): Bounds | null {
  const parts = ref.split(":");
  const start = parseAddress(parts[0]?.trim() ?? "");
  if (start === null) return null;
  const end = parts.length > 1 ? parseAddress(parts[1]?.trim() ?? "") : start;
  if (end === null) return null;
  return {
    minRow: Math.min(start.row, end.row),
    minCol: Math.min(start.col, end.col),
    maxRow: Math.max(start.row, end.row),
    maxCol: Math.max(start.col, end.col),
  };
}

/** 表的维度：优先信 `!ref`（它含尾部空行 / 空列的宽度），没有就从单元格地址兜底。 */
function sheetBounds(sheet: OfficeSheetSource): Bounds | null {
  const ref = sheet["!ref"];
  if (typeof ref === "string") {
    const declared = parseBounds(ref);
    if (declared !== null) return declared;
  }
  let bounds: Bounds | null = null;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith("!")) continue;
    const cell = parseAddress(key);
    if (cell === null) continue;
    bounds =
      bounds === null
        ? { minRow: cell.row, minCol: cell.col, maxRow: cell.row, maxCol: cell.col }
        : {
            minRow: Math.min(bounds.minRow, cell.row),
            minCol: Math.min(bounds.minCol, cell.col),
            maxRow: Math.max(bounds.maxRow, cell.row),
            maxCol: Math.max(bounds.maxCol, cell.col),
          };
  }
  return bounds;
}

/** 单元格显示文本：优先格式化文本，其次原始值的字符串形式。富文本、错误值、公式对象不展开。 */
function cellText(cell: unknown): string {
  if (cell === null || typeof cell !== "object") return "";
  const { w, v } = cell as CellSource;
  if (typeof w === "string" && w !== "") return w;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  // 日期单元格没有格式化文本时按 YYYY-MM-DD 显示（v 是 Date）。
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return "";
}

const emptySheet = (name: string): OfficeSheet => ({
  name,
  columns: [],
  rows: [],
  startRow: 0,
  totalRows: 0,
  truncated: false,
});

function buildSheet(name: string, source: OfficeSheetSource, maxRows: number, maxColumns: number): OfficeSheet {
  const bounds = sheetBounds(source);
  if (bounds === null) return emptySheet(name);
  const totalRows = bounds.maxRow - bounds.minRow + 1;
  const shownRows = Math.min(totalRows, maxRows);
  const shownCols = Math.min(bounds.maxCol - bounds.minCol + 1, maxColumns);
  const rows: string[][] = [];
  let width = 0;
  for (let row = 0; row < shownRows; row++) {
    const cells: string[] = [];
    for (let col = 0; col < shownCols; col++) {
      const address = `${columnLabel(bounds.minCol + col)}${bounds.minRow + row + 1}`;
      cells.push(cellText(source[address]));
    }
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    width = Math.max(width, cells.length);
    rows.push(cells);
  }
  // 尾部全空的行不占版面（`!ref` 常把用过的空行也算进去），但 totalRows 保留真实维度。
  while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
  return {
    name,
    columns: Array.from({ length: width }, (_, index) => columnLabel(bounds.minCol + index)),
    rows,
    startRow: bounds.minRow,
    totalRows,
    truncated: totalRows > shownRows,
  };
}

/** 解析结果 → 渲染模型：按原顺序保留所有表（空表也留一个，界面自己提示"这张表是空的"）。 */
export function buildWorkbookModel(workbook: OfficeWorkbookSource, options: OfficeModelOptions = {}): OfficeWorkbook {
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? officeMaxRows));
  const maxColumns = Math.max(1, Math.floor(options.maxColumns ?? officeMaxColumns));
  const names = Array.isArray(workbook.SheetNames)
    ? workbook.SheetNames.filter((name): name is string => typeof name === "string")
    : [];
  const sheets = workbook.Sheets ?? {};
  return {
    sheets: names.map((name) => {
      const source = sheets[name];
      return source === undefined ? emptySheet(name) : buildSheet(name, source, maxRows, maxColumns);
    }),
  };
}

/** Markdown 表格里一个单元格：竖线转义、换行写成 `<br>`（表格行内不能有真换行）。 */
function markdownCell(text: string | undefined): string {
  return (text ?? "")
    .replace(/\r\n?|\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * 当前表 → 标准 Markdown 表格：第一行当表头，其余是数据行，列数与 columns 对齐（短的补空）。
 * 表里没有任何内容时返回空串（调用方据此不写剪贴板）。
 */
export function toMarkdownTable(sheet: OfficeSheet): string {
  const width = sheet.columns.length;
  const head = sheet.rows[0];
  if (width === 0 || head === undefined) return "";
  const line = (cells: string[] | undefined): string =>
    `| ${Array.from({ length: width }, (_, col) => markdownCell(cells?.[col])).join(" | ")} |`;
  const lines = [line(head), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`];
  for (const row of sheet.rows.slice(1)) lines.push(line(row));
  return lines.join("\n");
}
