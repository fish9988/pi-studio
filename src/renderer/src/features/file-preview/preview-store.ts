// 右侧文件面板的状态：同一时间只有一个面板（任务 id 或新任务草稿的键），两页——文件树 / 预览；关闭时把焦点还给打开它的元素。
// 文件树的展开状态按键记在 tree-state.ts（面板关了、切走任务再回来仍在）。
import type { PreviewFile, TerminalKey } from "../../../../shared/ipc.ts";
import { createStore, useStoreValue } from "../../store/create-store.ts";
import { closeDshToolKind, isDshToolActive, openDshToolTab } from "../workbench/dsh-workbench-store.ts";
import { selectedRoot } from "./roots-store.ts";

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
  /** 预览的文件在哪个根里：缺省 = 任务目录，n = 第 n 个额外工作区目录（roots-store.ts）。 */
  root?: number | undefined;
}

const store = createStore<PanelState | null>(null);
const inlineArtifacts = new Map<string, PreviewFile>();
let returnFocus: HTMLElement | null = null;

function rememberFocus(): void {
  if (store.get() !== null) return;
  const active = document.activeElement;
  returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
}

/** 在预览页打开一个文件（工具卡上的文件链接或聊天交付卡片），可选定位到指定行号。 */
export function openFilePreview(key: TerminalKey, path: string, line?: number): void {
  rememberFocus();
  store.set({ key, page: "preview", path, line });
  openDshToolTab(key, "files");
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
  rememberFocus();
  store.set({ key, page: "preview", path: virtualPath });
  openDshToolTab(key, "files");
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

/** 文件树里选了一个文件：切到预览页显示它。 */
export function previewFileInPanel(path: string, line?: number): void {
  const current = store.get();
  if (current === null) return;
  const root = selectedRoot(current.key);
  store.set({ ...current, page: "preview", path, line, root: root > 0 ? root : undefined });
}

export function closeFilePreview(): void {
  const current = store.get();
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
