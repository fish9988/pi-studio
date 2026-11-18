// Office 文档预览（docx / xlsx）：字节由主进程 readPreviewBytes 读（路径校验在那边），
// 解析库按需动态加载——没打开过这类文件就不进首屏包。
// docx 走 DOM 渲染器（渲染进自己的挂载节点，切文件 / 卸载时整块移除，不碰 innerHTML；
// 它自己注入的 <style> 也在挂载节点里，一起移除）；
// xlsx 走 office-model.ts 的表格模型，用 React 的 table 渲染（列标 + 行号 + 横纵滚动）。
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { OfficePreviewKind, ProjectFilesTarget } from "../../../../shared/ipc.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import { Button, IconButton, Tabs, tabPanelProps } from "../../ui/controls.tsx";
import { reportError } from "../../ui/errors.ts";
import { pushToast } from "../dialogs/index.ts";
import { buildWorkbookModel, toMarkdownTable, type OfficeSheet, type OfficeWorkbook } from "./office-model.ts";
import "./office-viewer.css";

type DocxModule = typeof import("docx-preview");
type XlsxModule = typeof import("xlsx");

// 模块级缓存：同一份分包只加载一次；加载失败清空，下次打开再试（同 markdown/Markdown.tsx 的 KaTeX）。
let docxModule: Promise<DocxModule> | null = null;
let xlsxModule: Promise<XlsxModule> | null = null;

function loadDocx(): Promise<DocxModule> {
  docxModule ??= import("docx-preview").catch((error: unknown) => {
    docxModule = null;
    throw error;
  });
  return docxModule;
}

function loadXlsx(): Promise<XlsxModule> {
  xlsxModule ??= import("xlsx").catch((error: unknown) => {
    xlsxModule = null;
    throw error;
  });
  return xlsxModule;
}

const zoomMin = 0.5;
const zoomMax = 2;
const zoomStep = 1.1;

/** 缩放值对齐到 1%：连乘会带出 51.00000000000001% 这种显示值。 */
function clampZoom(value: number): number {
  return Math.min(zoomMax, Math.max(zoomMin, Math.round(value * 100) / 100));
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Bytes = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; bytes: Uint8Array };

export interface OfficeViewerProps {
  target: ProjectFilesTarget;
  path: string;
  officeKind: OfficePreviewKind;
  /** 原始文件大小（页面上只用来显示，真正读多少由主进程按上限决定）。 */
  totalBytes?: number | undefined;
}

/**
 * Office 预览：`officeKind` 决定走哪条链路。切文件时两个子视图按 path 重新挂载（缩放与选中的表复位）。
 */
export function OfficeViewer({ target, path, officeKind, totalBytes }: OfficeViewerProps) {
  const t = useT();
  const [file, setFile] = useState<Bytes>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    setFile({ state: "loading" });
    window.studio.readPreviewBytes(target, path).then(
      (bytes) => {
        if (!cancelled) setFile({ state: "ready", bytes });
      },
      (error: unknown) => {
        if (!cancelled) setFile({ state: "error", message: errorText(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [target, path]);

  return (
    <div className="office-pv-root" data-testid="office-preview">
      {file.state === "loading" && <p className="office-pv-note">{t("preview.loading")}</p>}
      {file.state === "error" && (
        <p className="office-pv-note" role="alert">
          {t("preview.readFailed", { message: file.message })}
        </p>
      )}
      {file.state === "ready" &&
        (officeKind === "docx" ? (
          <DocxBody key={path} bytes={file.bytes} totalBytes={totalBytes} />
        ) : (
          <SheetBody key={path} bytes={file.bytes} totalBytes={totalBytes} />
        ))}
    </div>
  );
}

/** docx：渲染进自己新建的挂载节点，晚到的过期渲染整块移除，不会把新内容再擦掉。 */
function DocxBody({ bytes, totalBytes }: { bytes: Uint8Array; totalBytes?: number | undefined }) {
  const t = useT();
  // 起步就是 100%，缩放在 50%–200% 之间；换文件时随子视图重新挂载复位。
  const [zoom, setZoom] = useState(1);
  const [state, setState] = useState<"rendering" | "done" | "failed">("rendering");
  const [message, setMessage] = useState("");
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = host.current;
    if (container === null) return;
    let cancelled = false;
    container.replaceChildren();
    // 每轮渲染一个自己的容器：过期那轮结束时只移除自己的节点，不会波及现行内容。
    const mount = document.createElement("div");
    container.append(mount);
    setState("rendering");
    void loadDocx()
      .then(({ renderAsync }) =>
        renderAsync(bytes, mount, undefined, {
          className: "office-pv-docx",
          inWrapper: true,
          ignoreWidth: false,
          renderHeaders: true,
          renderFooters: true,
        }),
      )
      .then(
        () => {
          if (cancelled) {
            mount.remove();
            return;
          }
          setState("done");
        },
        (error: unknown) => {
          if (cancelled) return;
          mount.remove();
          setMessage(errorText(error));
          setState("failed");
        },
      );
    return () => {
      cancelled = true;
      mount.remove();
    };
  }, [bytes]);

  return (
    <>
      <div className="office-pv-bar">
        <span className="office-pv-zoom" role="group" aria-label={t("preview.zoom")}>
          <IconButton
            label={t("preview.zoomOut")}
            onClick={() => setZoom((current) => clampZoom(current / zoomStep))}
            disabled={zoom <= zoomMin}
          >
            −
          </IconButton>
          <Button variant="quiet" size="sm" testId="office-pv-zoom-reset" onClick={() => setZoom(1)}>
            {`${Math.round(zoom * 100)}%`}
          </Button>
          <IconButton
            label={t("preview.zoomIn")}
            onClick={() => setZoom((current) => clampZoom(current * zoomStep))}
            disabled={zoom >= zoomMax}
          >
            +
          </IconButton>
        </span>
        {totalBytes !== undefined && <span className="office-pv-meta">{formatSize(totalBytes)}</span>}
      </div>
      <div className="office-pv-body" data-testid="office-pv-docx">
        <div
          ref={host}
          className="office-pv-paper"
          style={{ "--office-pv-zoom": zoom } as CSSProperties}
          data-testid="office-pv-paper"
        />
        {state === "rendering" && <p className="office-pv-hint">{t("preview.loading")}</p>}
        {state === "failed" && (
          <p className="office-pv-hint" role="alert">
            {t("preview.officeLoadError", { message })}
          </p>
        )}
      </div>
    </>
  );
}

/** xlsx：表格模型来自 office-model.ts（行 / 列有上限），第一行当表头显示列标 A、B、C… */
function SheetBody({ bytes, totalBytes }: { bytes: Uint8Array; totalBytes?: number | undefined }) {
  const t = useT();
  const locale = useLocale();
  const isZh = locale === "zh-CN";
  const [workbook, setWorkbook] = useState<OfficeWorkbook | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setWorkbook(null);
    setMessage(null);
    setSelected(0);
    void loadXlsx()
      .then(({ read }) => buildWorkbookModel(read(bytes, { type: "array" })))
      .then(
        (model) => {
          if (!cancelled) setWorkbook(model);
        },
        (error: unknown) => {
          if (!cancelled) setMessage(errorText(error));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  const sheet: OfficeSheet | null = workbook?.sheets[selected] ?? null;

  const copyMarkdown = () => {
    if (sheet === null) return;
    const markdown = toMarkdownTable(sheet);
    if (markdown === "") return;
    navigator.clipboard.writeText(markdown).then(
      () => pushToast({ level: "info", message: t("preview.officeCopiedMd") }),
      (error: unknown) => reportError(t, error),
    );
  };

  const tabs = (workbook?.sheets ?? []).map((item, index) => ({ id: String(index), label: item.name }));
  const panel = tabs.length > 0 ? tabPanelProps("office-pv-sheets", String(selected)) : null;
  return (
    <>
      <div className="office-pv-bar">
        {tabs.length > 0 && (
          <div className="office-pv-tabs">
            <Tabs
              tabs={tabs}
              value={String(selected)}
              onChange={(next) => setSelected(Number(next))}
              label={isZh ? "工作表" : "Sheets"}
              idBase="office-pv-sheets"
              testId="office-pv-sheet-tab"
            />
          </div>
        )}
        {totalBytes !== undefined && <span className="office-pv-meta">{formatSize(totalBytes)}</span>}
        <Button
          variant="quiet"
          size="sm"
          testId="office-pv-copy-markdown"
          onClick={copyMarkdown}
          disabled={sheet === null || sheet.rows.length === 0}
        >
          {t("preview.officeCopyMd")}
        </Button>
      </div>
      <div className="office-pv-body" {...(panel ?? {})}>
        {message !== null && (
          <p className="office-pv-note" role="alert">
            {t("preview.officeLoadError", { message })}
          </p>
        )}
        {message === null && workbook === null && <p className="office-pv-note">{t("preview.loading")}</p>}
        {sheet !== null && sheet.rows.length === 0 && (
          <p className="office-pv-note" data-testid="office-pv-sheet-empty">
            {t("preview.officeSheetEmpty")}
          </p>
        )}
        {sheet !== null && sheet.rows.length > 0 && (
          <div className="office-pv-grid-wrap" data-testid="office-pv-grid">
            <table className="office-pv-grid">
              <thead>
                <tr>
                  <th className="office-pv-grid-corner" scope="col">
                    <span className="sr-only">{isZh ? "行号" : "Row"}</span>
                  </th>
                  {sheet.columns.map((label) => (
                    <th key={label} className="office-pv-grid-col" scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((row, index) => (
                  <tr key={sheet.startRow + index}>
                    <th className="office-pv-grid-row" scope="row">
                      {sheet.startRow + index + 1}
                    </th>
                    {sheet.columns.map((_, col) => (
                      <td key={col}>{row[col] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {sheet !== null && sheet.truncated && (
          <p className="office-pv-foot" data-testid="office-pv-truncated">
            {t("preview.officeTruncated", { shown: sheet.rows.length, total: sheet.totalRows })}
          </p>
        )}
      </div>
    </>
  );
}
