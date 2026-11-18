// 右侧文件面板的 PDF 阅读器：主进程按 Range 分片读字节（不整份进内存），逐页画 canvas + 透明文本层，
// 滚轮缩放走"CSS transform 顶着 → 停 200ms 再重画"的双缓冲，另带目录、全文查找和划词引用。
// 只认主进程给的相对路径，不拼 file:// 去加载（和 PreviewPage 一样，绕过主进程校验的路一律不走）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { DraftKey, ProjectFilesTarget, TaskId } from "../../../../shared/ipc.ts";
import { useT } from "../../i18n/use-t.ts";
import { ChevronLeft, ChevronRight, Comment, CopyIcon, Bolt, MapIcon, Search } from "../../icons.tsx";
import { Button, IconButton, TextField } from "../../ui/controls.tsx";
import { reportError } from "../../ui/errors.ts";
import { openBtwWithPrefill } from "../btw/btw-ui-store.ts";
import { quoteToComposer } from "../composer/quote.ts";
import { pushToast } from "../dialogs/toast-store.ts";
import {
  capturePdfZoomAnchor,
  clampScale,
  MAX_PDF_SELECTION_CHARS,
  MIN_SCALE,
  WHEEL_ZOOM_SENSITIVITY,
  ZOOM_COMMIT_DELAY_MS,
  ZOOM_STEP,
  formatPdfBtwPrefill,
  formatPdfQuote,
  getPdfPageDisplaySize,
  getPdfPagePreviewStyle,
  restorePdfZoomAnchor,
  type PdfSize,
  type PdfZoomAnchor,
} from "./pdf-zoom.ts";
import "./pdf-viewer.css";

GlobalWorkerOptions.workerSrc = workerUrl;

/** 每次 Range 请求的字节数：和 pdf.js 的 rangeChunkSize 一致，也远低于主进程单次上限（2 MB）。 */
const RANGE_CHUNK = 256 * 1024;
/** 页面四周留白（px），必须和 pdf-viewer.css 里 `.pdf-pv-stage` 的 padding 一致，算适应宽度要用。 */
const PAGE_GAP = 16;
const MAX_SEARCH_MATCHES = 999;
const SEARCH_DEBOUNCE_MS = 250;
/** 浮层与选区的间距、浮层名义宽度（只用来把左右边缘夹进窗口）。 */
const TIP_GAP = 8;
const TIP_WIDTH = 240;
const VIEWPORT_EDGE = 8;
/** 选区上方留够这么多像素才把浮层放上面，否则翻到下面。 */
const TIP_FLIP_MIN_SPACE = 56;

interface OutlineEntry {
  id: string;
  title: string;
  depth: number;
  dest: string | unknown[] | null;
}

/** `getOutline()` 的节点（items 在类型里是 any[]，只用到这三项）。 */
interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: readonly OutlineNode[] | undefined;
}

interface SearchState {
  /** 命中所在的页码（1 起），按页序排列，一个命中一项。 */
  matches: number[];
  index: number;
  done: boolean;
}

interface Tip {
  text: string;
  x: number;
  y: number;
  placement: "above" | "below";
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 关掉加载任务（连同 worker 与半途的 Range 请求）：失败只留一行日志，不再往界面上抛。 */
const destroyTask = (task: PDFDocumentLoadingTask): void => {
  void task.destroy().catch((error: unknown) => console.error("PDF 关闭失败", error));
};

/** 渲染/文本层的取消（换页、换缩放、关面板）不是错误，不当成加载失败。 */
const isCancellation = (error: unknown): boolean =>
  error instanceof Error && (error.name === "RenderingCancelledException" || error.name === "AbortException");

const sameSize = (a: PdfSize | null, b: PdfSize): boolean =>
  a !== null && Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;

const clampPage = (value: number, pageCount: number): number =>
  Math.min(Math.max(1, Math.round(value)), Math.max(1, pageCount));

function flattenOutline(nodes: readonly OutlineNode[], depth = 0, prefix = ""): OutlineEntry[] {
  return nodes.flatMap((node, index) => {
    const id = `${prefix}${index}`;
    const entry: OutlineEntry = { id, title: node.title, depth, dest: node.dest };
    const children = node.items ?? [];
    return children.length === 0 ? [entry] : [entry, ...flattenOutline(children, depth + 1, `${id}.`)];
  });
}

/** 大纲目标 → 页码（1 起）：dest 可能是命名目标，也可能是 [页引用, x, y, zoom]。 */
async function resolveOutlinePage(doc: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  if (dest === null) return null;
  const resolved = typeof dest === "string" ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(resolved) || resolved.length === 0) return null;
  const first: unknown = resolved[0];
  if (typeof first === "number") return first + 1;
  if (first !== null && typeof first === "object" && "num" in first && "gen" in first) {
    const index = await doc.getPageIndex(first as { num: number; gen: number });
    return index + 1;
  }
  return null;
}

export interface PdfViewerProps {
  /** 文件树的根：Range 请求按它换算真实路径，主进程校验落在根内。 */
  target: ProjectFilesTarget;
  /** 相对根目录的路径。 */
  path: string;
  /** 文件字节数：PDFDataRangeTransport 靠它算 Range 边界。 */
  totalBytes: number;
  /** 打开时跳到的页码（1 起，越界夹回范围内）。 */
  initialPage?: number | undefined;
  /** 当前任务：null 时没有"旁路提问"（那需要一份会话）。 */
  taskId: TaskId | null;
  /** 引用写进哪份草稿。 */
  quoteTarget: TaskId | DraftKey | null;
}

export function PdfViewer({ target, path, totalBytes, initialPage, taskId, quoteTarget }: PdfViewerProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);

  const docRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerRef = useRef<TextLayer | null>(null);
  const renderGenerationRef = useRef(0);
  const snapshotRef = useRef<HTMLCanvasElement | null>(null);
  /** 已重画的缩放（页面真实尺寸按它算）。 */
  const scaleRef = useRef(MIN_SCALE);
  /** 滚轮期间的视觉缩放：可能还没重画。 */
  const visualScaleRef = useRef(MIN_SCALE);
  const anchorRef = useRef<PdfZoomAnchor | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState<PdfSize | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [previewScale, setPreviewScale] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState("1");
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ matches: [], index: -1, done: true });
  const [tip, setTip] = useState<Tip | null>(null);

  // ───────── 加载：Range 分片 ─────────

  useEffect(() => {
    let disposed = false;
    setDoc(null);
    docRef.current = null;
    setPageCount(0);
    setPageNumber(1);
    setPageInput("1");
    setPageSize(null);
    setScale(null);
    scaleRef.current = MIN_SCALE;
    visualScaleRef.current = MIN_SCALE;
    setPreviewScale(1);
    setFitMode(true);
    setLoadError(null);
    setOutline([]);
    setOutlineOpen(false);
    setSearch({ matches: [], index: -1, done: true });
    setSearchInput("");
    setQuery("");
    setTip(null);

    // 大 PDF 不整份读：pdf.js 要哪段就只读那段，读到的字节原样交回 transport。
    // 它会把相邻的 chunk 合并成一次范围请求（可能远大于 rangeChunkSize），主进程单次上限 2 MB，所以这里按 256 KB 切片再拼起来。
    const transport = new PDFDataRangeTransport(totalBytes, null);
    let aborted = false;
    const loadingTask: PDFDocumentLoadingTask = getDocument({
      range: transport,
      rangeChunkSize: RANGE_CHUNK,
      disableAutoFetch: true,
      disableStream: true,
      cMapUrl: new URL("./pdfjs/cmaps/", window.location.href).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("./pdfjs/standard_fonts/", window.location.href).href,
    });

    const readRange = async (offset: number, length: number): Promise<Uint8Array> => {
      if (length <= RANGE_CHUNK) return window.studio.readPreviewRange(target, path, offset, length);
      const out = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const chunk = await window.studio.readPreviewRange(
          target,
          path,
          offset + filled,
          Math.min(RANGE_CHUNK, length - filled),
        );
        out.set(chunk, filled);
        filled += chunk.byteLength;
        if (chunk.byteLength === 0) break;
      }
      return filled === length ? out : out.subarray(0, filled);
    };

    transport.abort = () => {
      aborted = true;
    };
    transport.requestDataRange = (begin, end) => {
      void readRange(begin, end - begin).then(
        (bytes) => {
          if (!aborted) transport.onDataRange(begin, bytes);
        },
        (error: unknown) => {
          if (aborted) return;
          aborted = true;
          setLoadError(messageOf(error));
          destroyTask(loadingTask);
        },
      );
    };

    loadingTask.promise.then(
      (loaded) => {
        if (disposed) {
          destroyTask(loadingTask);
          return;
        }
        docRef.current = loaded;
        setDoc(loaded);
        setPageCount(loaded.numPages);
        loaded.getOutline().then(
          (nodes) => {
            if (!disposed && nodes !== null) setOutline(flattenOutline(nodes as OutlineNode[]));
          },
          (error: unknown) => reportError(t, error),
        );
      },
      (error: unknown) => {
        if (!disposed) setLoadError(messageOf(error));
      },
    );

    return () => {
      disposed = true;
      aborted = true;
      docRef.current = null;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      textLayerRef.current?.cancel();
      textLayerRef.current = null;
      destroyTask(loadingTask);
    };
  }, [target, path, totalBytes, t]);

  // 打开时（或外部换了页码）跳到初始页。
  useEffect(() => {
    if (initialPage === undefined || pageCount <= 0) return;
    setPageNumber(clampPage(initialPage, pageCount));
  }, [initialPage, pageCount]);

  // 当前页的基础尺寸（scale = 1）：页面盒子、适应宽度都按它算。
  useEffect(() => {
    const current = docRef.current;
    if (current === null) return;
    let cancelled = false;
    current.getPage(pageNumber).then(
      (page) => {
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const size: PdfSize = { width: base.width, height: base.height };
        setPageSize((previous) => (sameSize(previous, size) ? previous : size));
      },
      (error: unknown) => {
        if (!cancelled) reportError(t, error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, t]);

  // 容器宽度：适应宽度和窗口尺寸变化时重算。
  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    setViewportWidth(scroll.clientWidth);
    const observer = new ResizeObserver(() => setViewportWidth(scroll.clientWidth));
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);

  // ───────── 缩放 ─────────

  const clearSnapshot = useCallback(() => {
    snapshotRef.current?.remove();
    snapshotRef.current = null;
  }, []);

  const applyScale = useCallback((next: number) => {
    const clamped = clampScale(next);
    scaleRef.current = clamped;
    visualScaleRef.current = clamped;
    setScale(clamped);
    setPreviewScale(1);
  }, []);

  /** 把当前画面截成一张覆盖层（双缓冲的"旧帧"），新比例画完再撤掉。 */
  const captureSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    const page = pageRef.current;
    const stage = stageRef.current;
    if (canvas === null || page === null || stage === null || canvas.width === 0) return;
    clearSnapshot();
    const rect = page.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const layer = document.createElement("canvas");
    layer.className = "pdf-pv-snapshot";
    layer.width = canvas.width;
    layer.height = canvas.height;
    layer.style.left = `${rect.left - stageRect.left}px`;
    layer.style.top = `${rect.top - stageRect.top}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
    layer.getContext("2d")?.drawImage(canvas, 0, 0);
    stage.append(layer);
    snapshotRef.current = layer;
  }, [clearSnapshot]);

  /** 滚轮停下后按新比例真正重画；画面尺寸没变就只把临时拉伸撤掉。 */
  const commitZoom = useCallback(() => {
    commitTimerRef.current = undefined;
    const next = visualScaleRef.current;
    if (Math.abs(next - scaleRef.current) < 0.0001) {
      setPreviewScale(1);
      return;
    }
    captureSnapshot();
    applyScale(next);
  }, [applyScale, captureSnapshot]);

  // Ctrl/Cmd+滚轮：React 的 onWheel 是 passive，拦不住浏览器缩放，只能自己挂（也会抢在页面缩放手势之前）。
  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const page = pageRef.current;
      if (page === null) return;
      event.preventDefault();
      const anchor = capturePdfZoomAnchor(event.clientX, event.clientY, page.getBoundingClientRect());
      if (anchor === null) return;
      anchorRef.current = anchor;
      const next = clampScale(visualScaleRef.current * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY));
      if (Math.abs(next - visualScaleRef.current) < 0.0001) return;
      visualScaleRef.current = next;
      setPreviewScale(next / scaleRef.current);
      setFitMode(false);
      if (commitTimerRef.current !== undefined) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = setTimeout(commitZoom, ZOOM_COMMIT_DELAY_MS);
    };
    scroll.addEventListener("wheel", onWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", onWheel);
  }, [commitZoom]);

  useEffect(
    () => () => {
      if (commitTimerRef.current !== undefined) clearTimeout(commitTimerRef.current);
      clearSnapshot();
    },
    [clearSnapshot],
  );

  // CSS 拉伸或页面重排之后，把锚点重新放回指针下：两种缩放路径共用一套换算。
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const page = pageRef.current;
    const scroll = scrollRef.current;
    if (anchor === null || page === null || scroll === null) return;
    anchorRef.current = null;
    const delta = restorePdfZoomAnchor(anchor, page.getBoundingClientRect());
    if (delta.left !== 0) scroll.scrollLeft += delta.left;
    if (delta.top !== 0) scroll.scrollTop += delta.top;
  }, [previewScale, scale]);

  // 适应宽度：容器宽度或页面尺寸变了就跟着算；用户手动缩放过就不再跟。
  useEffect(() => {
    if (!fitMode || pageSize === null || viewportWidth <= 0) return;
    const next = clampScale((viewportWidth - PAGE_GAP * 2) / pageSize.width);
    if (scale !== null && Math.abs(next - scale) < 0.001) return;
    applyScale(next);
  }, [fitMode, pageSize, viewportWidth, scale, applyScale]);

  // ───────── 渲染当前页 ─────────

  const hasPage = pageSize !== null;
  useEffect(() => {
    const current = docRef.current;
    const canvas = canvasRef.current;
    const layer = textRef.current;
    if (current === null || canvas === null || layer === null || scale === null) return;
    let cancelled = false;
    const generation = renderGenerationRef.current + 1;
    renderGenerationRef.current = generation;
    const finish = () => {
      if (cancelled || renderGenerationRef.current !== generation) return;
      clearSnapshot();
      setPreviewScale(1);
    };
    void (async () => {
      const page = await current.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      // 高分屏按 devicePixelRatio 放大位图，CSS 尺寸仍是逻辑像素，字和线条才不发虚。
      const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const task = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      renderTaskRef.current = task;
      await task.promise;
      if (cancelled) return;
      layer.replaceChildren();
      const textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
      textLayerRef.current = textLayer;
      await textLayer.render();
      if (cancelled) return;
      finish();
    })().catch((error: unknown) => {
      if (cancelled || isCancellation(error)) return;
      setLoadError(messageOf(error));
    });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      textLayerRef.current?.cancel();
    };
  }, [doc, pageNumber, scale, hasPage, clearSnapshot]);

  // ───────── 页码 ─────────

  useEffect(() => setPageInput(String(pageNumber)), [pageNumber]);

  const goToPage = useCallback((next: number) => {
    setPageNumber(clampPage(next, docRef.current?.numPages ?? 0));
  }, []);

  const commitPageInput = () => {
    const parsed = Number.parseInt(pageInput, 10);
    if (Number.isFinite(parsed)) goToPage(parsed);
    else setPageInput(String(pageNumber));
  };

  /** 工具栏缩放：以容器中心为锚点（滚轮是跟着指针）。 */
  const zoomBy = (direction: 1 | -1) => {
    const page = pageRef.current;
    const scroll = scrollRef.current;
    if (page !== null && scroll !== null) {
      const rect = scroll.getBoundingClientRect();
      anchorRef.current = capturePdfZoomAnchor(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        page.getBoundingClientRect(),
      );
    }
    setFitMode(false);
    applyScale(scaleRef.current + direction * ZOOM_STEP);
  };

  // ← → 翻页：焦点在面板里（或点过页面、焦点落在 body）时生效，输入框里不抢键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const root = rootRef.current;
      if (root === null) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body && !root.contains(active)) return;
      event.preventDefault();
      setPageNumber((current) =>
        clampPage(current + (event.key === "ArrowRight" ? 1 : -1), docRef.current?.numPages ?? 0),
      );
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // ───────── 全文查找 ─────────

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const current = docRef.current;
    const needle = query.trim().toLowerCase();
    if (current === null || needle === "") {
      setSearch({ matches: [], index: -1, done: true });
      return;
    }
    let cancelled = false;
    let jumpedToFirst = false;
    const matches: number[] = [];
    setSearch({ matches: [], index: -1, done: false });
    void (async () => {
      for (let page = 1; page <= current.numPages; page++) {
        if (cancelled) return;
        const proxy = await current.getPage(page);
        const content = await proxy.getTextContent();
        if (cancelled) return;
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .toLowerCase();
        let from = 0;
        for (;;) {
          const hit = text.indexOf(needle, from);
          if (hit < 0) break;
          matches.push(page);
          from = hit + needle.length;
          if (matches.length >= MAX_SEARCH_MATCHES) break;
        }
        // 长文档一页一页地报进度，用户能马上看到前面的命中；首次命中自动跳到目标页。
        setSearch({ matches: [...matches], index: matches.length > 0 ? 0 : -1, done: false });
        if (!jumpedToFirst && matches.length > 0 && matches[0] !== undefined) {
          jumpedToFirst = true;
          goToPage(matches[0]);
        }
        if (matches.length >= MAX_SEARCH_MATCHES) break;
      }
      if (!cancelled) setSearch({ matches, index: matches.length > 0 ? 0 : -1, done: true });
    })().catch((error: unknown) => {
      if (!cancelled) reportError(t, error);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, query, t, goToPage]);

  const stepMatch = (direction: 1 | -1) => {
    const { matches, index } = search;
    if (matches.length === 0) return;
    const next = index < 0 ? 0 : (index + direction + matches.length) % matches.length;
    setSearch((state) => ({ ...state, index: next }));
    const page = matches[next];
    if (page !== undefined) goToPage(page);
  };

  // ───────── 目录 ─────────

  const jumpToOutline = async (entry: OutlineEntry) => {
    const current = docRef.current;
    if (current === null) return;
    const page = await resolveOutlinePage(current, entry.dest);
    if (page !== null) goToPage(page);
    setOutlineOpen(false);
  };

  // ───────── 划词浮层 ─────────

  useEffect(() => {
    setTip(null);
  }, [pageNumber, scale]);

  useEffect(() => {
    const hide = () => setTip(null);
    document.addEventListener("scroll", hide, true);
    return () => document.removeEventListener("scroll", hide, true);
  }, []);

  const readSelection = useCallback(() => {
    const layer = textRef.current;
    const selection = window.getSelection();
    if (layer === null || selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      setTip(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const text = selection.toString().trim();
    if (
      text === "" ||
      text.length > MAX_PDF_SELECTION_CHARS ||
      !layer.contains(range.startContainer) ||
      !layer.contains(range.endContainer)
    ) {
      setTip(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setTip(null);
      return;
    }
    const placement = rect.top >= TIP_FLIP_MIN_SPACE ? "above" : "below";
    const centered = rect.left + rect.width / 2 - TIP_WIDTH / 2;
    setTip({
      text,
      placement,
      x: Math.max(VIEWPORT_EDGE, Math.min(centered, window.innerWidth - VIEWPORT_EDGE - TIP_WIDTH)),
      y: placement === "above" ? rect.top - TIP_GAP : rect.bottom + TIP_GAP,
    });
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(readSelection, 80);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearTimeout(timer);
        setTip(null);
      }
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [readSelection]);

  const dismissTip = (clearSelection: boolean) => {
    if (clearSelection) window.getSelection()?.removeAllRanges();
    setTip(null);
  };

  const quoteSelection = () => {
    if (tip === null) return;
    quoteToComposer(quoteTarget, formatPdfQuote(path, pageNumber, tip.text), { fold: false });
    dismissTip(true);
  };

  const askSelection = () => {
    if (tip === null || taskId === null) return;
    openBtwWithPrefill(taskId, formatPdfBtwPrefill(path, pageNumber, tip.text));
    dismissTip(true);
  };

  const copySelection = () => {
    if (tip === null) return;
    navigator.clipboard.writeText(tip.text).then(
      () => pushToast({ message: t("common.copied"), durationMs: 1500 }),
      (error: unknown) => reportError(t, error),
    );
    dismissTip(false);
  };

  // ───────── 视图 ─────────

  const displaySize =
    pageSize === null || scale === null ? null : getPdfPageDisplaySize(pageSize.width, pageSize.height, scale);
  const pageStyle =
    displaySize === null || scale === null
      ? undefined
      : ({
          ...getPdfPagePreviewStyle(displaySize, previewScale),
          // TextLayer 按这个变量算自己的宽高（pdf.js 用 round(down, …) 生成内联尺寸）。
          "--total-scale-factor": scale,
        } as CSSProperties);
  const searchText =
    query.trim() === ""
      ? ""
      : search.matches.length === 0
        ? search.done
          ? t("preview.pdfNoMatches")
          : "…"
        : `${search.index + 1}/${search.matches.length}`;

  return (
    <div className="pdf-pv" ref={rootRef} data-testid="pdf-viewer">
      <div className="pdf-pv-bar">
        <IconButton
          label={t("preview.pdfPrevPage")}
          onClick={() => goToPage(pageNumber - 1)}
          disabled={pageNumber <= 1}
          testId="pdf-prev"
        >
          <ChevronLeft size={14} />
        </IconButton>
        <TextField
          size="sm"
          width={48}
          value={pageInput}
          onChange={setPageInput}
          onBlur={commitPageInput}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commitPageInput();
            event.currentTarget.blur();
          }}
          aria-label={t("preview.pdfPageInput")}
          className="pdf-pv-page-input"
          testId="pdf-page-input"
        />
        <span className="pdf-pv-total">{pageCount > 0 ? `/ ${pageCount}` : "/ –"}</span>
        <IconButton
          label={t("preview.pdfNextPage")}
          onClick={() => goToPage(pageNumber + 1)}
          disabled={pageCount === 0 || pageNumber >= pageCount}
          testId="pdf-next"
        >
          <ChevronRight size={14} />
        </IconButton>
        <span className="pdf-pv-spacer" />
        <IconButton label={t("preview.zoomOut")} onClick={() => zoomBy(-1)} testId="pdf-zoom-out">
          −
        </IconButton>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => setFitMode(true)}
          aria-pressed={fitMode}
          testId="pdf-fit-width"
        >
          {t("preview.pdfFitWidth")}
        </Button>
        <IconButton label={t("preview.zoomIn")} onClick={() => zoomBy(1)} testId="pdf-zoom-in">
          +
        </IconButton>
        <IconButton
          label={t("preview.pdfOutline")}
          pressed={outlineOpen}
          onClick={() => setOutlineOpen((open) => !open)}
          disabled={outline.length === 0}
          testId="pdf-outline-toggle"
        >
          <MapIcon size={14} />
        </IconButton>
        <IconButton
          label={t("preview.pdfSearch")}
          pressed={searchOpen}
          onClick={() => setSearchOpen((open) => !open)}
          testId="pdf-search-toggle"
        >
          <Search size={14} />
        </IconButton>
      </div>
      {searchOpen && (
        <div className="pdf-pv-search">
          <TextField
            size="sm"
            width="100%"
            value={searchInput}
            onChange={setSearchInput}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                stepMatch(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setSearchOpen(false);
              }
            }}
            placeholder={t("preview.pdfSearchPlaceholder")}
            leading={<Search size={13} />}
            aria-label={t("preview.pdfSearch")}
            testId="pdf-search-input"
          />
          <span className="pdf-pv-count" data-testid="pdf-search-count">
            {searchText}
          </span>
          <IconButton
            label={t("preview.pdfPrevPage")}
            onClick={() => stepMatch(-1)}
            disabled={search.matches.length === 0}
            testId="pdf-search-prev"
          >
            <ChevronLeft size={14} />
          </IconButton>
          <IconButton
            label={t("preview.pdfNextPage")}
            onClick={() => stepMatch(1)}
            disabled={search.matches.length === 0}
            testId="pdf-search-next"
          >
            <ChevronRight size={14} />
          </IconButton>
        </div>
      )}
      <div className="pdf-pv-body">
        {outlineOpen && outline.length > 0 && (
          <nav className="pdf-pv-outline" data-testid="pdf-outline">
            {outline.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="pdf-pv-outline-item"
                data-depth={entry.depth}
                onClick={() => void jumpToOutline(entry).catch((error: unknown) => reportError(t, error))}
              >
                {entry.title}
              </button>
            ))}
          </nav>
        )}
        <div
          className="pdf-pv-scroll"
          ref={scrollRef}
          tabIndex={0}
          aria-label={t("preview.pagePreview")}
          data-testid="pdf-scroll"
        >
          <div className="pdf-pv-stage" ref={stageRef}>
            {loadError !== null ? (
              <p className="pdf-pv-note" role="alert">
                {t("preview.pdfLoadError", { message: loadError })}
              </p>
            ) : displaySize === null ? (
              <p className="pdf-pv-note">{t("preview.loading")}</p>
            ) : (
              <div className="pdf-pv-page" ref={pageRef} style={pageStyle} data-testid="pdf-page">
                <canvas ref={canvasRef} className="pdf-pv-canvas" />
                <div ref={textRef} className="pdf-pv-text" onMouseUp={readSelection} />
              </div>
            )}
          </div>
        </div>
      </div>
      {tip !== null &&
        createPortal(
          <div
            className="pdf-pv-tip"
            data-placement={tip.placement}
            role="toolbar"
            style={{ left: tip.x, top: tip.y }}
            data-testid="pdf-selection-tooltip"
            onMouseDown={(event) => event.preventDefault()}
          >
            <button type="button" className="pdf-pv-tip-btn" onClick={quoteSelection} data-testid="pdf-quote">
              <Comment size={13} />
              {t("preview.quoteToChat")}
            </button>
            {taskId !== null && (
              <button type="button" className="pdf-pv-tip-btn" onClick={askSelection} data-testid="pdf-btw">
                <Bolt size={13} />
                {t("preview.askInBtw")}
              </button>
            )}
            <button type="button" className="pdf-pv-tip-btn" onClick={copySelection} data-testid="pdf-copy">
              <CopyIcon size={13} />
              {t("preview.copySelection")}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
