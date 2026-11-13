// 文件面板的"预览"页：一条工具栏（文件名、路径、预览/源码、缩放、打开、在文件夹中显示）+ 正文。
// 内容由主进程 readPreviewFile 读（校验落在根目录内）；这里不拼任何文件路径去加载，避免绕过主进程校验。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PreviewFile, ProjectFilesTarget } from "../../../../shared/ipc.ts";
import { draftKey } from "../../../../shared/ipc.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import { CopyIcon, External, FileIcon, Folder } from "../../icons.tsx";
import { Button, Checkbox, IconButton, Segmented } from "../../ui/controls.tsx";
import { reportError } from "../../ui/errors.ts";
import { pushToast } from "../dialogs/index.ts";
import { baseName, extension, PreviewContent } from "./PreviewContent.tsx";
import { getInlineArtifact } from "./preview-store.ts";
import { quotePathToComposer } from "../composer/quote.ts";

/** 文件树的右键菜单只拿得到路径（没有草稿键），走 quote.ts 的 `@path ` 写入。 */
export function insertFileRefIntoComposer(filePath: string): void {
  quotePathToComposer(filePath);
}

interface MarkdownHeading {
  level: number;
  text: string;
  index: number;
}

function extractMarkdownHeadings(text: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  const lines = text.replace(/```[\s\S]*?```/g, "").split(/\r?\n/);
  let idx = 0;
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line.trim());
    if (m) {
      out.push({
        level: m[1]!.length,
        text: m[2]!.replace(/[`*_~[\]]/g, "").trim(),
        index: idx++,
      });
    }
  }
  return out;
}
type Load = { state: "loading" } | { state: "error"; message: string } | { state: "done"; file: PreviewFile };

const zoomStep = 1.25;
const zoomRange = [0.1, 8] as const;

/** Ctrl+滚轮缩放时指针下的那一点：记下它在被缩放元素里的相对位置，排版后滚动外框，让它回到指针下。 */
interface ZoomAnchor {
  element: Element;
  scroller: Element;
  x: number;
  y: number;
  fx: number;
  fy: number;
}

export function PreviewPage({
  target,
  path,
  focusLine,
  hidden,
}: {
  target: ProjectFilesTarget;
  path: string;
  focusLine?: number | undefined;
  hidden: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const isZh = locale === "zh-CN";
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [source, setSource] = useState(false);
  const [scripts, setScripts] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  // 图片以外的内容（文本、Markdown、源码、网页）整体缩放；换文件不复位，面板开着时一直沿用。
  const [textZoom, setTextZoom] = useState(1);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const anchor = useRef<ZoomAnchor | null>(null);
  // 上一次画出来的缩放值（下面的 useLayoutEffect 更新）：Ctrl+滚轮判断还能不能再缩。
  const shown = useRef({ zoom, textZoom });
  // 从"适应窗口"开始缩放时以眼前的实际比例为起点：大图适应窗口时可能只有 25%，按 100% 算的话"缩小"反而变大。
  const stepZoom = (factor: number) =>
    setZoom((current) => {
      const img = imageRef.current;
      const from = current !== "fit" ? current : img && img.naturalWidth > 0 ? img.clientWidth / img.naturalWidth : 1;
      return Math.min(zoomRange[1], Math.max(zoomRange[0], from * factor));
    });
  const stepTextZoom = (factor: number) =>
    setTextZoom((current) => Math.min(zoomRange[1], Math.max(zoomRange[0], current * factor)));

  useEffect(() => {
    const inline = getInlineArtifact(path);
    if (inline !== null) {
      setLoad({ state: "done", file: inline });
      setSource(focusLine !== undefined);
      setScripts(inline.kind === "html");
      setZoom("fit");
      return;
    }
    let cancelled = false;
    setLoad({ state: "loading" });
    setSource(focusLine !== undefined);
    setScripts(false);
    setZoom("fit");
    window.studio.readPreviewFile(target, path).then(
      (file) => {
        if (!cancelled) setLoad({ state: "done", file });
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ state: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [target, path, focusLine]);
  const file = load.state === "done" ? load.file : null;
  const name = baseName(file?.path ?? path);
  const ext = extension(file?.path ?? path);
  const isMarkdown = file?.kind === "text" && (ext === "md" || ext === "markdown" || ext === "mdx");
  const isCsv = file?.kind === "text" && (ext === "csv" || ext === "tsv");
  const isMermaid = file?.kind === "text" && (ext === "mmd" || ext === "mermaid");
  const isJson = file?.kind === "text" && ext === "json";
  const [jsonTree, setJsonTree] = useState(false);
  const isSvg = file?.kind === "image" && ext === "svg";
  const toggleable = isMarkdown || isCsv || isMermaid || isSvg || file?.kind === "html";
  const imageView = file?.kind === "image" && !source;
  const textView = file?.kind === "text" || file?.kind === "html" || (file?.kind === "image" && source);
  const mdHeadings = useMemo(
    () =>
      isMarkdown && file?.kind === "text" && typeof file.text === "string" ? extractMarkdownHeadings(file.text) : [],
    [isMarkdown, file],
  );

  // Ctrl+滚轮缩放（整页缩放锁在字号档位上，见主进程 main-window.ts）。React 的 onWheel 是 passive，拦不住，只能自己挂。
  useEffect(() => {
    const box = body.current;
    if (box === null || !(imageView || textView)) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      // 鼠标滚一格 = 一步（×1.25，同图片的 − / +）；触控板捏合的增量小，按比例缩。字号调大后一格的 deltaY 会变小
      // （约 100 / 页面缩放），所以按 50 算满一步；一次最多一步，免得"一次滚动多行"的系统设置一格跳好几档。
      const steps = Math.max(-1, Math.min(1, -event.deltaY / 50));
      // 已经到上下限（或没有竖向滚动）时缩放不变、不会重排：不记锚点，否则它留到下一次缩放才用，把那时的位置拉偏。
      const current = imageView ? shown.current.zoom : shown.current.textZoom;
      if (steps === 0 || (current !== "fit" && (steps > 0 ? current >= zoomRange[1] : current <= zoomRange[0]))) return;
      const element = imageView ? imageRef.current : box.firstElementChild;
      const rect = element?.getBoundingClientRect();
      if (element && rect && rect.width > 0 && rect.height > 0) {
        anchor.current = {
          element,
          scroller: imageView ? (element.parentElement ?? box) : box,
          x: event.clientX,
          y: event.clientY,
          fx: (event.clientX - rect.left) / rect.width,
          fy: (event.clientY - rect.top) / rect.height,
        };
      }
      if (imageView) stepZoom(zoomStep ** steps);
      else stepTextZoom(zoomStep ** steps);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [imageView, textView]);

  // 网页预览是沙箱 iframe，滚轮事件到不了上面的监听：页面没处理的 Ctrl+滚轮由主进程连同光标位置转来，光标在网页预览上才缩放。
  useEffect(
    () =>
      window.studio.onZoomGesture(({ direction, x, y }) => {
        const frame = body.current?.querySelector(".file-preview-frame");
        if (frame && document.elementFromPoint(x, y) === frame)
          stepTextZoom(direction === "in" ? zoomStep : 1 / zoomStep);
      }),
    [],
  );

  useLayoutEffect(() => {
    shown.current = { zoom, textZoom };
    const pending = anchor.current;
    if (pending === null) return;
    anchor.current = null;
    const rect = pending.element.getBoundingClientRect();
    pending.scroller.scrollLeft += rect.left + pending.fx * rect.width - pending.x;
    pending.scroller.scrollTop += rect.top + pending.fy * rect.height - pending.y;
  }, [zoom, textZoom]);

  // 系统打开按任务 id 走；在文件夹中显示支持任务与项目/默认文件夹。
  const taskId = target.kind === "task" ? target.taskId : null;
  // `@file` 引用进哪份草稿：任务 → 这个任务；项目文件面板 → 这个项目的草稿页；默认文件夹 → 无项目的聊天草稿。
  const quoteTarget =
    target.kind === "task" ? target.taskId : target.kind === "project" ? draftKey(target.projectId) : null;
  const run = (action: "openTaskFile" | "revealTaskFile") => {
    if (!file) return;
    if (taskId !== null) {
      window.studio[action](taskId, file.path, target.kind === "task" ? target.root : undefined).catch(
        (error: unknown) => reportError(t, error),
      );
    } else if (action === "revealTaskFile") {
      window.studio.revealProjectFile(target, file.path).catch((error: unknown) => reportError(t, error));
    }
  };

  return (
    <div className="file-preview-page" hidden={hidden}>
      <div className="file-preview-bar">
        <FileIcon size={14} />
        <span className="file-preview-name" data-testid="file-preview-name">
          {name}
        </span>
        {/* 路径和文件名一样（根目录下的文件）时不重复显示。 */}
        {(file?.path ?? path) !== name && (
          <span className="file-preview-path" title={file?.path ?? path}>
            {file?.path ?? path}
          </span>
        )}
        {/* 右边的控件是一组：面板窄得放不下时整组换到第二行（file-preview.css）。 */}
        <span className="file-preview-actions">
          {toggleable && (
            <Segmented
              size="sm"
              value={source ? "source" : "preview"}
              options={[
                { value: "preview", label: t("preview.modePreview") },
                { value: "source", label: t("preview.modeSource") },
              ]}
              onChange={(next) => setSource(next === "source")}
              label={t("preview.mode")}
              testId="file-preview-mode"
            />
          )}
          {file?.kind === "html" && !source && (
            <Checkbox checked={scripts} onChange={setScripts}>
              {t("preview.runScripts")}
            </Checkbox>
          )}
          {imageView && (
            <span className="file-preview-zoom" role="group" aria-label={t("preview.zoom")}>
              <IconButton label={t("preview.zoomOut")} onClick={() => stepZoom(1 / zoomStep)}>
                −
              </IconButton>
              <Button variant="quiet" size="sm" testId="file-preview-zoom-reset" onClick={() => setZoom("fit")}>
                {zoom === "fit" ? t("preview.zoomFit") : `${Math.round(zoom * 100)}%`}
              </Button>
              <IconButton label={t("preview.zoomIn")} onClick={() => stepZoom(zoomStep)}>
                +
              </IconButton>
            </span>
          )}
          {/* 文字只用 Ctrl+滚轮缩放：缩放过（不是 100%）才显示百分比，点它回到 100%。 */}
          {textView && textZoom !== 1 && (
            <span className="file-preview-zoom" role="group" aria-label={t("preview.zoom")}>
              <Button variant="quiet" size="sm" testId="file-preview-zoom-reset" onClick={() => setTextZoom(1)}>
                {`${Math.round(textZoom * 100)}%`}
              </Button>
            </span>
          )}
          {isJson && (
            <Button
              variant="quiet"
              size="sm"
              testId="file-preview-json-tree-toggle"
              onClick={() => setJsonTree((v) => !v)}
            >
              {jsonTree ? (isZh ? "源码" : "Raw") : isZh ? "结构树" : "Tree"}
            </Button>
          )}
          {isMarkdown && !source && mdHeadings.length > 1 && (
            <Button
              variant="quiet"
              size="sm"
              testId="file-preview-outline-toggle"
              onClick={() => setOutlineOpen((v) => !v)}
            >
              {isZh ? `大纲 (${mdHeadings.length})` : `Outline (${mdHeadings.length})`}
            </Button>
          )}
          {!path.startsWith("@artifact/") && (
            <IconButton
              label={isZh ? "引用 @file 到输入框" : "Insert @file into composer"}
              testId="file-preview-insert-ref"
              onClick={() => quotePathToComposer(file?.path ?? path, quoteTarget)}
            >
              <span className="file-preview-at-glyph">@</span>
            </IconButton>
          )}
          {file && (file.kind === "text" || file.kind === "html") && typeof file.text === "string" && (
            <IconButton
              label={isZh ? "复制文件内容" : "Copy file content"}
              testId="file-preview-copy"
              onClick={() => {
                void navigator.clipboard
                  .writeText(file.text ?? "")
                  .then(() => pushToast({ level: "info", message: isZh ? "已复制文件内容" : "Copied file content" }));
              }}
            >
              <CopyIcon size={13} />
            </IconButton>
          )}
          {taskId !== null && !path.startsWith("@artifact/") && file?.canOpen && (
            <IconButton label={t("preview.open")} testId="file-preview-open" onClick={() => run("openTaskFile")}>
              <External size={14} />
            </IconButton>
          )}
          {!path.startsWith("@artifact/") && file !== null && file.kind !== "missing" && (
            <IconButton label={t("preview.reveal")} testId="file-preview-reveal" onClick={() => run("revealTaskFile")}>
              <Folder size={14} />
            </IconButton>
          )}
        </span>
      </div>
      {isMarkdown && !source && outlineOpen && mdHeadings.length > 1 && (
        <nav className="file-preview-outline" data-testid="file-preview-outline">
          {mdHeadings.map((h) => (
            <button
              key={h.index}
              type="button"
              className="file-preview-outline-item"
              data-level={h.level}
              onClick={() => {
                const container = body.current;
                if (!container) return;
                const nodes = container.querySelectorAll("h1, h2, h3");
                const targetEl = nodes[h.index];
                targetEl?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {h.text}
            </button>
          ))}
        </nav>
      )}
      <div
        ref={body}
        className="file-preview-body"
        data-testid="file-preview-body"
        style={{ "--preview-zoom": textZoom } as CSSProperties}
      >
        {load.state === "loading" && <p className="file-preview-note">{t("preview.loading")}</p>}
        {load.state === "error" && (
          <p className="file-preview-note" role="alert">
            {t("preview.readFailed", { message: load.message })}
          </p>
        )}
        {file && (
          <PreviewContent
            file={file}
            ext={ext}
            name={name}
            source={source}
            scripts={scripts}
            zoom={zoom}
            imageRef={imageRef}
            isMarkdown={isMarkdown}
            isCsv={isCsv}
            isMermaid={isMermaid}
            jsonTree={isJson && jsonTree && focusLine === undefined}
            focusLine={focusLine}
            onExternal={taskId === null ? null : () => run(file.canOpen ? "openTaskFile" : "revealTaskFile")}
          />
        )}
      </div>
    </div>
  );
}
