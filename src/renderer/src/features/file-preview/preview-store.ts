// 右侧文件面板的状态：同一时间只有一个面板（任务 id 或新任务草稿的键），两页——文件树 / 预览；关闭时把焦点还给打开它的元素。
// 文件树的展开状态按键记在 tree-state.ts（面板关了、切走任务再回来仍在）。
import type { PreviewFile, TerminalKey } from "../../../../shared/ipc.ts";
import { createStore, useStoreValue } from "../../store/create-store.ts";
import {
  closeDshTab,
  closeDshToolKind,
  isDshToolActive,
  openDshPreviewTab,
  openDshToolTab,
} from "../workbench/dsh-workbench-store.ts";
import { parsePreviewPathFragment, type ParsedPreviewRef } from "./files-target.ts";
import { selectedRoot } from "./roots-store.ts";

export { parsePreviewPathFragment, type ParsedPreviewRef };

export type PanelPage = "files" | "preview";

export interface InlineArtifact {
  id: string;
  name: string;
  ext: "html" | "svg" | "md";
  content: string;
}

export interface PanelState {
  /** 面板属于谁：任务 id，或草稿的键（`new:<项目 id>`）。 */
  key: TerminalKey;
  page: PanelPage;
  /** 预览页显示的文件：调用方给的路径（相对根目录，或落在根内的绝对路径，或 `@artifact/...` 内联交付物）；还没打开过文件时为 null。 */
  path: string | null;
  /** 可选跳转定位的源码行号（从 1 开始）。 */
  line?: number | undefined;
  /** 可选跳转定位的 PDF 页码（从 1 开始）。 */
  pageNum?: number | undefined;
  /** 预览的文件在哪个根里：缺省 = 任务目录，n = 第 n 个额外工作区目录（roots-store.ts）。 */
  root?: number | undefined;
}

const store = createStore<PanelState | null>(null);
const inlineArtifacts = new Map<string, PreviewFile>();
const tabReturnFocus = new Map<string, HTMLElement | null>();
let returnFocus: HTMLElement | null = null;

function captureActiveElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function rememberFocus(): void {
  if (store.get() !== null) return;
  returnFocus = captureActiveElement();
}

export function restorePreviewTabFocus(tabId: string): void {
  const target = tabReturnFocus.get(tabId) ?? null;
  tabReturnFocus.delete(tabId);
  if (target !== null && target.isConnected) {
    target.focus();
    return;
  }
  // 打开它的入口可能已经不在了（启动器自己的页签被预览页签原位替换掉了）：退到工作台的当前页签，再退到输入框。
  const workbench = document.querySelector<HTMLElement>('[data-testid="right-workbench"]');
  const fallback =
    workbench?.querySelector<HTMLElement>('[role="tab"][data-active]') ??
    workbench ??
    document.querySelector<HTMLElement>("[data-composer-input]");
  fallback?.focus({ preventScroll: true });
}

export function closePreviewTabAndRestoreFocus(key: TerminalKey, tabId: string): void {
  closeDshTab(key, tabId);
  restorePreviewTabFocus(tabId);
}

/** 在独立多文件预览标签中打开文件（工具卡文件链接、Omnibox、文件树“新标签打开”等），支持 `#L行号` 与 `#page:页码`。 */
export function openFilePreview(
  key: TerminalKey,
  rawPath: string,
  lineOrOptions?:
    | number
    | {
        line?: number | undefined;
        page?: number | undefined;
        root?: number | undefined;
        replaceTabId?: string | undefined;
      },
): void {
  const parsed = parsePreviewPathFragment(rawPath);
  const opts = typeof lineOrOptions === "number" ? { line: lineOrOptions } : (lineOrOptions ?? {});
  const line = opts.line ?? parsed.line;
  const page = opts.page ?? parsed.page;
  const trigger = captureActiveElement();
  const tab = openDshPreviewTab(key, parsed.path, {
    line,
    page,
    root: opts.root,
    replaceTabId: opts.replaceTabId,
  });
  if (trigger && !tabReturnFocus.has(tab.id)) {
    tabReturnFocus.set(tab.id, trigger);
  }
}

/** 在右侧预览面板直接打开聊天中的内联交付物（SVG / HTML / Markdown 代码块或交付卡片）。 */
export function openInlineArtifact(key: TerminalKey, artifact: InlineArtifact): void {
  const virtualPath = `@artifact/${artifact.id}/${artifact.name}`;
  const size = new Blob([artifact.content]).size;
  let preview: PreviewFile;
  if (artifact.ext === "html") {
    preview = { kind: "html", path: artifact.name, size, text: artifact.content, canOpen: false };
  } else if (artifact.ext === "svg") {
    preview = {
      kind: "image",
      path: artifact.name,
      size,
      dataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(artifact.content)}`,
      canOpen: false,
    };
  } else {
    preview = { kind: "text", path: artifact.name, size, text: artifact.content, canOpen: false };
  }
  inlineArtifacts.set(virtualPath, preview);
  openFilePreview(key, virtualPath);
}

export function getInlineArtifact(path: string): PreviewFile | null {
  return inlineArtifacts.get(path) ?? null;
}
/** 顶栏按钮 / 快捷键：当前右侧栏正在看该任务的文件页就关掉，否则打开它的文件页。 */
export function toggleFilesPanel(key: TerminalKey): void {
  if (isDshToolActive(key, "files")) {
    closeFilePreview();
    return;
  }
  openFilesPanel(key);
}

/** 斜杠命令（/dirs 等）：保证 key 的文件面板开着、停在文件页（已经开着就只切页）。 */
export function openFilesPanel(key: TerminalKey): void {
  const current = store.get();
  if (current?.key === key) {
    if (current.page !== "files") store.set({ ...current, page: "files" });
  } else {
    rememberFocus();
    store.set({ key, page: "files", path: null });
  }
  openDshToolTab(key, "files");
}

export function setPanelPage(page: PanelPage): void {
  const current = store.get();
  if (current === null || current.page === page || (page === "preview" && current.path === null)) return;
  store.set({ ...current, page });
}

/** 文件树里选了一个文件：切到预览页显示它（或独立预览标签打开）。 */
export function previewFileInPanel(path: string, line?: number): void {
  const current = store.get();
  if (current === null) return;
  const parsed = parsePreviewPathFragment(path);
  const root = selectedRoot(current.key);
  store.set({
    ...current,
    page: "preview",
    path: parsed.path,
    line: line ?? parsed.line,
    pageNum: parsed.page,
    root: root > 0 ? root : undefined,
  });
}

/** `key` 给了就只在面板属于它时才关（关某个工作台的标签，不能顺带把别的任务的面板清掉）。 */
export function closeFilePreview(key?: TerminalKey): void {
  const current = store.get();
  if (key !== undefined && current !== null && current.key !== key) return;
  if (current !== null) {
    store.set(null);
    closeDshToolKind(current.key, "files");
  }
  const target = returnFocus;
  returnFocus = null;
  if (target?.isConnected) target.focus();
}

export function usePreviewPanel(): PanelState | null {
  return useStoreValue(store, (state) => state);
}

/** 面板宽度（px）；null = 默认占主区约 36%（CSS 里给）。只在内存，不持久化。 */
const widthStore = createStore<number | null>(null);

export function setPreviewWidth(width: number): void {
  widthStore.set(Math.round(width));
}

export function usePreviewWidth(): number | null {
  return useStoreValue(widthStore, (state) => state);
}
