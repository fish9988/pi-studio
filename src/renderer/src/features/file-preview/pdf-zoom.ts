// PDF 阅读器（PdfViewer.tsx）的纯函数：缩放档位、Ctrl+滚轮锚点换算、页面显示尺寸与引用文案。
// 这里不碰 DOM（矩形用普通的 left/top/width/height），单测在 test/pdf-zoom.test.ts 里直接跑。

export const ZOOM_STEP = 0.25;
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const DEFAULT_SCALE = 1;
/** Ctrl/Cmd+滚轮的比例：滚一格（deltaY≈100）约 ±22%，触控板的小增量按同一系数连续缩。 */
export const WHEEL_ZOOM_SENSITIVITY = 0.002;
/** 滚轮停下这么久才按新比例重画页面，之前用 CSS transform 顶着（双缓冲缩放）。 */
export const ZOOM_COMMIT_DELAY_MS = 200;

/** `getBoundingClientRect` 用得到的那几项：单测不用造 DOM。 */
export interface PdfRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfSize {
  width: number;
  height: number;
}

/** 缩放锚点：指针落在页面内的相对位置（0…1，页面外夹到边缘）+ 指针的屏幕坐标。 */
export interface PdfZoomAnchor {
  fx: number;
  fy: number;
  clientX: number;
  clientY: number;
}

/** 缩放前后要让滚动容器挪多少（加到 scrollLeft / scrollTop 上）。 */
export interface PdfScrollDelta {
  left: number;
  top: number;
}

/** 页面盒子的内联样式：缩放期间页面尺寸不变，只把 CSS transform 拉伸预览。 */
export interface PdfPagePreviewStyle {
  width: string;
  height: string;
  transform: string;
  transformOrigin: string;
}

/** 引用的最多字数（和对话区划词浮条一致），超过当整页全选，不弹浮层。 */
export const MAX_PDF_SELECTION_CHARS = 8000;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 夹进 0.25…4；非有限值（坏输入、NaN 的乘法结果）回默认 100%。 */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * 记下指针在页面里的相对位置：缩放后把同一点重新放回指针下，页面不会从指针底下溜走。
 * 指针在页面外（灰色边距上）时夹到最近的边缘；页面还没排版好（宽或高为 0）返回 null。
 */
export function capturePdfZoomAnchor(clientX: number, clientY: number, rect: PdfRect): PdfZoomAnchor | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    fx: clamp01((clientX - rect.left) / rect.width),
    fy: clamp01((clientY - rect.top) / rect.height),
    clientX,
    clientY,
  };
}

/** 页面按新尺寸/新 transform 排好之后，同一个相对位置离开指针多远：把返回值加到滚动容器上即可。 */
export function restorePdfZoomAnchor(anchor: PdfZoomAnchor, rect: PdfRect): PdfScrollDelta {
  if (!(rect.width > 0) || !(rect.height > 0)) return { left: 0, top: 0 };
  return {
    left: rect.left + anchor.fx * rect.width - anchor.clientX,
    top: rect.top + anchor.fy * rect.height - anchor.clientY,
  };
}

/** 页面在某个缩放下的 CSS 尺寸（px）。 */
export function getPdfPageDisplaySize(pageWidth: number, pageHeight: number, scale: number): PdfSize {
  const applied = clampScale(scale);
  return {
    width: Math.max(1, pageWidth * applied),
    height: Math.max(1, pageHeight * applied),
  };
}

/**
 * 页面盒子的内联样式：宽高用已排版尺寸，`previewScale` 是滚轮期间对已渲染画面的临时拉伸
 * （1 = 不拉伸）。锚点换算靠 `transform-origin: 0 0`，和 restorePdfZoomAnchor 的算法配套。
 */
export function getPdfPagePreviewStyle(size: PdfSize, previewScale: number): PdfPagePreviewStyle {
  const zoom = Number.isFinite(previewScale) && previewScale > 0 ? previewScale : 1;
  return {
    width: `${round(size.width)}px`,
    height: `${round(size.height)}px`,
    transform: Math.abs(zoom - 1) < 0.001 ? "none" : `scale(${round(zoom, 4)})`,
    transformOrigin: "0 0",
  };
}

/** 选区文字整理成一段干净的文字：统一换行、去掉行尾空白和首尾空行。 */
function normalizeQuoteText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

function normalizeQuotePath(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

const quotePageLabel = (path: string, pageNumber: number): string =>
  `${normalizeQuotePath(path)} · P${Math.max(1, Math.round(Number.isFinite(pageNumber) ? pageNumber : 1))}`;

/**
 * PDF 选区引用进输入框的文案：Markdown 引用块，末尾一行是文件路径与页码（`— docs/a.pdf · P3`）。
 * 空选区返回空串（调用方据此跳过）。
 */
export function formatPdfQuote(path: string, pageNumber: number, text: string): string {
  const body = normalizeQuoteText(text);
  if (body === "") return "";
  const lines = body.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
  lines.push(`> — ${quotePageLabel(path, pageNumber)}`);
  return lines.join("\n");
}

/** 旁路提问的预填：同样的引用块，末尾留一个空行让用户接着写问题。 */
export function formatPdfBtwPrefill(path: string, pageNumber: number, text: string): string {
  const quote = formatPdfQuote(path, pageNumber, text);
  return quote === "" ? "" : `${quote}\n\n`;
}
