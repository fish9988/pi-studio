// 预览页的正文：md 渲染 / 图片与 SVG（带画布背景切换与尺寸信息）/ html 沙箱 iframe / CSV&TSV 表格 / JSON 结构树 / Mermaid 流程图 / 音视频 / 其余文本高亮源码。
import { useMemo, useRef, useState, type RefObject } from "react";
import type { PreviewFile } from "../../../../shared/ipc.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import { Markdown } from "../../markdown/index.ts";
import { CodeBlock } from "../../markdown/CodeBlock.tsx";

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

export function extension(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** svg 的 data URL → 源码文本（主进程已优先带 text，若仅 dataUrl 则在此还原）。 */
function decodeDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return "";
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (!header.includes(";base64")) {
    try {
      return decodeURIComponent(body);
    } catch {
      return body;
    }
  }
  const binary = atob(body);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function parseDelimitedTable(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const maxChars = Math.min(text.length, 250_000);
  for (let i = 0; i < maxChars; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= 500) break;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (rows.length < 500) rows.push(row);
  }
  return rows;
}

function CsvTableView({ text, delimiter }: { text: string; delimiter: string }) {
  const locale = useLocale();
  const isZh = locale === "zh-CN";
  const rows = useMemo(() => parseDelimitedTable(text, delimiter), [text, delimiter]);
  if (rows.length === 0) {
    return <p className="file-preview-note">{isZh ? "空表格数据" : "Empty table"}</p>;
  }
  const header = rows[0]!;
  const bodyRows = rows.slice(1);
  return (
    <div className="file-preview-table-wrap" data-testid="file-preview-csv-table">
      <div className="file-preview-table-meta">
        <span>
          {isZh
            ? `共 ${bodyRows.length} 行 · ${header.length} 列`
            : `${bodyRows.length} rows · ${header.length} columns`}
        </span>
      </div>
      <div className="file-preview-table-scroll">
        <table className="file-preview-table">
          <thead>
            <tr>
              <th className="file-preview-table-idx">#</th>
              {header.map((col, idx) => (
                <th key={idx}>{col || `Col ${idx + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((r, rIdx) => (
              <tr key={rIdx}>
                <td className="file-preview-table-idx">{rIdx + 1}</td>
                {header.map((_, cIdx) => (
                  <td key={cIdx}>{r[cIdx] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function JsonNodeView({ label, value, depth }: { label: string | null; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (value !== null && typeof value === "object") {
    const isArr = Array.isArray(value);
    const entries = isArr
      ? (value as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);
    return (
      <div className="file-preview-json-branch" style={{ paddingLeft: depth > 0 ? 14 : 0 }}>
        <button type="button" className="file-preview-json-toggle" onClick={() => setOpen((v) => !v)}>
          <span className="file-preview-json-caret">{open ? "▾" : "▸"}</span>
          {label !== null && <span className="file-preview-json-key">"{label}": </span>}
          <span className="file-preview-json-meta">
            {isArr ? `Array(${entries.length})` : `Object{${entries.length}}`}
          </span>
        </button>
        {open && (
          <div className="file-preview-json-children">
            {entries.slice(0, 200).map(([k, v]) => (
              <JsonNodeView key={k} label={isArr ? k : k} value={v} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }
  const formatted = typeof value === "string" ? `"${value}"` : value === null ? "null" : String(value);
  const valType = typeof value === "string" ? "str" : typeof value === "number" ? "num" : "lit";
  return (
    <div className="file-preview-json-leaf" style={{ paddingLeft: depth > 0 ? 18 : 0 }}>
      {label !== null && <span className="file-preview-json-key">"{label}": </span>}
      <span className="file-preview-json-val" data-type={valType}>
        {formatted}
      </span>
    </div>
  );
}

function JsonTreeView({ text }: { text: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, data: JSON.parse(text) as unknown };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [text]);
  if (!parsed.ok) {
    return <CodeBlock code={text} lang="json" closed />;
  }
  return (
    <div className="file-preview-json-tree" data-testid="file-preview-json-tree">
      <JsonNodeView label={null} value={parsed.data} depth={0} />
    </div>
  );
}

interface ContentProps {
  file: PreviewFile;
  ext: string;
  name: string;
  source: boolean;
  scripts: boolean;
  zoom: number | "fit";
  /** 图片元素：缩放按钮要从"适应窗口"时的实际比例开始算。 */
  imageRef: RefObject<HTMLImageElement | null>;
  isMarkdown: boolean;
  isCsv?: boolean;
  isMermaid?: boolean;
  jsonTree?: boolean;
  focusLine?: number | undefined;
  onExternal: (() => void) | null;
}

/**
 * 图片与 SVG：放大后按住左键拖动平移（滚动外框）。底部浮层提供尺寸徽标与画布背景切换（棋盘格 / 亮底 / 暗底）。
 */
function ImageView({
  src,
  alt,
  size,
  zoom,
  imageRef,
}: {
  src: string;
  alt: string;
  size: number;
  zoom: number | "fit";
  imageRef: RefObject<HTMLImageElement | null>;
}) {
  const locale = useLocale();
  const isZh = locale === "zh-CN";
  const [natural, setNatural] = useState(0);
  const [naturalH, setNaturalH] = useState(0);
  const [bgMode, setBgMode] = useState<"auto" | "grid" | "light" | "dark">("grid");
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const end = () => {
    pan.current = null;
  };
  return (
    <>
      <div
        className="file-preview-image"
        data-fit={zoom === "fit" || undefined}
        data-bg={bgMode}
        onPointerDown={(event) => {
          if (zoom === "fit" || event.button !== 0) return;
          const box = event.currentTarget;
          pan.current = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
          box.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const start = pan.current;
          if (start === null) return;
          event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
          event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
        }}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          draggable={false}
          data-testid="file-preview-image"
          style={zoom === "fit" || natural === 0 ? undefined : { width: natural * zoom }}
          onLoad={(event) => {
            setNatural(event.currentTarget.naturalWidth);
            setNaturalH(event.currentTarget.naturalHeight);
          }}
        />
      </div>
      <div className="file-preview-image-hud" onPointerDown={(e) => e.stopPropagation()}>
        {natural > 0 && (
          <span className="file-preview-image-dims">
            {natural} × {naturalH} px · {formatSize(size)}
          </span>
        )}
        <button
          type="button"
          className="file-preview-image-bg-btn"
          onClick={() =>
            setBgMode((cur) => (cur === "grid" ? "light" : cur === "light" ? "dark" : cur === "dark" ? "auto" : "grid"))
          }
          title={isZh ? "切换预览画布背景" : "Toggle canvas background"}
        >
          {bgMode === "grid"
            ? isZh
              ? "棋盘格"
              : "Grid"
            : bgMode === "light"
              ? isZh
                ? "亮底"
                : "Light"
              : bgMode === "dark"
                ? isZh
                  ? "暗底"
                  : "Dark"
                : isZh
                  ? "默认"
                  : "Auto"}
        </button>
      </div>
    </>
  );
}

export function PreviewContent({
  file,
  ext,
  name,
  source,
  scripts,
  zoom,
  imageRef,
  isMarkdown,
  isCsv = false,
  isMermaid = false,
  jsonTree = false,
  focusLine,
  onExternal,
}: ContentProps) {
  const t = useT();
  switch (file.kind) {
    case "missing":
      return <p className="file-preview-note">{t("preview.missing")}</p>;
    case "binary":
    case "too_large": {
      const isAudio = ext === "mp3" || ext === "wav" || ext === "ogg" || ext === "m4a";
      const isVideo = ext === "mp4" || ext === "webm";
      return (
        <div className="file-preview-note">
          {file.dataUrl && isAudio && <audio controls src={file.dataUrl} className="file-preview-media-audio" />}
          {file.dataUrl && isVideo && <video controls src={file.dataUrl} className="file-preview-media-video" />}
          <p>{file.kind === "binary" ? t("preview.binary") : t("preview.tooLarge", { size: formatSize(file.size) })}</p>
          {onExternal !== null && (
            <button type="button" className="file-preview-external" onClick={onExternal}>
              {file.canOpen ? t("preview.open") : t("preview.reveal")}
            </button>
          )}
        </div>
      );
    }
    case "image": {
      const dataUrl = file.dataUrl ?? "";
      if (source) return <CodeBlock code={file.text ?? decodeDataUrl(dataUrl)} lang="xml" closed />;
      return (
        <ImageView
          src={dataUrl}
          alt={t("preview.imageAlt", { name })}
          size={file.size}
          zoom={zoom}
          imageRef={imageRef}
        />
      );
    }
    case "html":
      if (source) return <CodeBlock code={file.text ?? ""} lang="html" closed />;
      // 没有 allow-same-origin：页面拿不到应用的任何权限；脚本默认关，用户勾选后才放行。
      return (
        <iframe
          className="file-preview-frame"
          data-testid="file-preview-frame"
          title={t("preview.htmlTitle", { name })}
          sandbox={scripts ? "allow-scripts" : ""}
          srcDoc={file.text ?? ""}
        />
      );
    case "text":
      if (isMarkdown && !source) {
        return (
          <div className="file-preview-md" data-testid="file-preview-md">
            <Markdown source={file.text ?? ""} />
          </div>
        );
      }
      if (isCsv && !source) {
        return <CsvTableView text={file.text ?? ""} delimiter={ext === "tsv" ? "\t" : ","} />;
      }
      if (isMermaid && !source) {
        return (
          <div className="file-preview-md" data-testid="file-preview-mermaid">
            <Markdown source={`\`\`\`mermaid\n${file.text ?? ""}\n\`\`\``} />
          </div>
        );
      }
      if (jsonTree) {
        return <JsonTreeView text={file.text ?? ""} />;
      }
      return <CodeBlock code={file.text ?? ""} lang={ext} closed focusLine={focusLine} standalone />;
  }
}
