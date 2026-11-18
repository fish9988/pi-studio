import { describe, expect, it } from "vitest";
import {
  capturePdfZoomAnchor,
  clampScale,
  DEFAULT_SCALE,
  formatPdfBtwPrefill,
  formatPdfQuote,
  getPdfPageDisplaySize,
  getPdfPagePreviewStyle,
  MAX_SCALE,
  MIN_SCALE,
  restorePdfZoomAnchor,
  WHEEL_ZOOM_SENSITIVITY,
  ZOOM_COMMIT_DELAY_MS,
  ZOOM_STEP,
} from "../src/renderer/src/features/file-preview/pdf-zoom.ts";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe("缩放档位", () => {
  it("常量：一步 25%，范围 25%…400%，默认 100%", () => {
    expect(ZOOM_STEP).toBe(0.25);
    expect(MIN_SCALE).toBe(0.25);
    expect(MAX_SCALE).toBe(4);
    expect(DEFAULT_SCALE).toBe(1);
    expect(WHEEL_ZOOM_SENSITIVITY).toBe(0.002);
    expect(ZOOM_COMMIT_DELAY_MS).toBe(200);
  });

  it("clampScale 夹在上下限内，坏值回默认", () => {
    expect(clampScale(1.5)).toBe(1.5);
    expect(clampScale(0.1)).toBe(MIN_SCALE);
    expect(clampScale(9)).toBe(MAX_SCALE);
    expect(clampScale(Number.NaN)).toBe(DEFAULT_SCALE);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SCALE);
  });
});

describe("缩放锚点", () => {
  it("记下指针在页面里的相对位置", () => {
    const anchor = capturePdfZoomAnchor(150, 120, rect(100, 100, 200, 100));
    expect(anchor).toEqual({ fx: 0.25, fy: 0.2, clientX: 150, clientY: 120 });
  });

  it("指针在页面外时夹到最近的边缘（灰色边距上缩放也不会飞走）", () => {
    expect(capturePdfZoomAnchor(0, 0, rect(100, 100, 200, 100))).toMatchObject({ fx: 0, fy: 0 });
    expect(capturePdfZoomAnchor(900, 900, rect(100, 100, 200, 100))).toMatchObject({ fx: 1, fy: 1 });
  });

  it("页面还没排版（宽或高为 0）或坐标不是有限值时不记锚点", () => {
    expect(capturePdfZoomAnchor(10, 10, rect(0, 0, 0, 100))).toBeNull();
    expect(capturePdfZoomAnchor(10, 10, rect(0, 0, 100, 0))).toBeNull();
    expect(capturePdfZoomAnchor(Number.NaN, 10, rect(0, 0, 100, 100))).toBeNull();
  });

  it("放大后同一个相对位置要往左、往上挪，才能回到指针下", () => {
    const anchor = capturePdfZoomAnchor(150, 120, rect(100, 100, 200, 100));
    expect(anchor).not.toBeNull();
    // 同一点在新布局里是 (100+0.25*400, 100+0.2*200) = (200, 140)
    expect(restorePdfZoomAnchor(anchor!, rect(100, 100, 400, 200))).toEqual({ left: 50, top: 20 });
  });

  it("位置没变时不需要滚动；页面不可见时返回零", () => {
    const anchor = capturePdfZoomAnchor(260, 200, rect(100, 100, 200, 100));
    expect(restorePdfZoomAnchor(anchor!, rect(100, 100, 200, 100))).toEqual({ left: 0, top: 0 });
    expect(restorePdfZoomAnchor(anchor!, rect(0, 0, 0, 0))).toEqual({ left: 0, top: 0 });
  });
});

describe("页面尺寸与预览样式", () => {
  it("按缩放换算显示尺寸", () => {
    expect(getPdfPageDisplaySize(612, 792, 1)).toEqual({ width: 612, height: 792 });
    expect(getPdfPageDisplaySize(612, 792, 1.5)).toEqual({ width: 918, height: 1188 });
  });

  it("缩放越界时夹到范围内，尺寸至少 1px", () => {
    expect(getPdfPageDisplaySize(612, 792, 0)).toEqual({ width: 153, height: 198 });
    expect(getPdfPageDisplaySize(1, 1, 0.01)).toEqual({ width: 1, height: 1 });
  });

  it("预览样式：宽高取已排版尺寸，临时拉伸用 transform，原点在左上角", () => {
    expect(getPdfPagePreviewStyle({ width: 612, height: 792 }, 1)).toEqual({
      width: "612px",
      height: "792px",
      transform: "none",
      transformOrigin: "0 0",
    });
    expect(getPdfPagePreviewStyle({ width: 612, height: 792 }, 1.25)).toEqual({
      width: "612px",
      height: "792px",
      transform: "scale(1.25)",
      transformOrigin: "0 0",
    });
  });

  it("预览比例坏掉时按 1 处理", () => {
    expect(getPdfPagePreviewStyle({ width: 100, height: 50 }, Number.NaN).transform).toBe("none");
    expect(getPdfPagePreviewStyle({ width: 100, height: 50 }, 0).transform).toBe("none");
  });
});

describe("划词引用文案", () => {
  it("引用块每行加 `> `，末尾一行是文件路径与页码", () => {
    expect(formatPdfQuote("docs/论文.pdf", 3, "第一行\n第二行")).toBe("> 第一行\n> 第二行\n> — docs/论文.pdf · P3");
  });

  it("Windows 路径统一成正斜杠；页码取整且不小于 1", () => {
    expect(formatPdfQuote("docs\\a b.pdf", 2.4, "文字")).toBe("> 文字\n> — docs/a b.pdf · P2");
    expect(formatPdfQuote("a.pdf", 0, "文字")).toBe("> 文字\n> — a.pdf · P1");
  });

  it("空行留成 `>`，行尾空白和首尾空行去掉", () => {
    expect(formatPdfQuote("a.pdf", 1, "\n  第一段  \n\n第二段\n\n")).toBe("> 第一段\n>\n> 第二段\n> — a.pdf · P1");
  });

  it("空选区返回空串", () => {
    expect(formatPdfQuote("a.pdf", 1, "   \n\t\n")).toBe("");
    expect(formatPdfBtwPrefill("a.pdf", 1, "")).toBe("");
  });

  it("旁路提问的预填在引用块后留一个空行", () => {
    expect(formatPdfBtwPrefill("a.pdf", 7, "摘录")).toBe("> 摘录\n> — a.pdf · P7\n\n");
  });
});
