// DSH 同款右侧多标签工作台状态（按任务 / 草稿键独立记忆）：
// 支持「🧭 开始」启动页、工作区文件、内置终端（支持多标签）、浏览器、代码变更、Subagent，零切换抖动。
import type { DraftKey, TaskId, TerminalKey } from "../../../../shared/ipc.ts";
import { createStore, useStoreValue } from "../../store/create-store.ts";

export type DshToolKind = "start" | "files" | "terminal" | "browser" | "changes" | "agents" | "extensions";

export type DshTabItem =
  | { readonly id: string; readonly kind: "start" }
  | { readonly id: "files"; readonly kind: "files" }
  | {
      readonly id: string;
      readonly kind: "terminal";
      readonly terminalKey: TerminalKey;
      readonly index: number;
      readonly shellLabel?: string | undefined;
    }
  | { readonly id: "browser"; readonly kind: "browser" }
  | { readonly id: "changes"; readonly kind: "changes" }
  | { readonly id: "agents"; readonly kind: "agents" }
  | { readonly id: "extensions"; readonly kind: "extensions" };

export interface DshWorkspaceState {
  readonly open: boolean;
  readonly expanded: boolean;
  readonly tabs: readonly DshTabItem[];
  readonly activeTabId: string;
}

const DEFAULT_CLOSED: DshWorkspaceState = {
  open: false,
  expanded: false,
  tabs: [],
  activeTabId: "",
};

let startSeq = 0;
const store = createStore<ReadonlyMap<TerminalKey, DshWorkspaceState>>(new Map());

function makeStartTab(): DshTabItem {
  startSeq += 1;
  return { id: `start-${startSeq}`, kind: "start" };
}

function getWorkspace(key: TerminalKey): DshWorkspaceState {
  return store.get().get(key) ?? DEFAULT_CLOSED;
}

function setWorkspace(key: TerminalKey, next: DshWorkspaceState): void {
  const prev = store.get();
  const map = new Map(prev);
  map.set(key, next);
  store.set(map);
}

function allocateTerminalTab(key: TerminalKey, existingTabs: readonly DshTabItem[]): DshTabItem {
  const usedIndices = new Set<number>();
  for (const tab of existingTabs) {
    if (tab.kind === "terminal") usedIndices.add(tab.index);
  }
  let idx = 1;
  while (usedIndices.has(idx)) idx += 1;
  const terminalKey = (idx === 1 ? key : `${key}#t${idx}`) as TerminalKey;
  return {
    id: `term-${idx}`,
    kind: "terminal",
    terminalKey,
    index: idx,
  };
}

/** 顶栏右侧栏图标点击：开着就收起（保留已开标签），关着就展开（首次展开默认打开 DSH「🧭 开始」标签）。 */
export function toggleDshSidebar(key: TerminalKey): void {
  const ws = getWorkspace(key);
  if (ws.open) {
    setWorkspace(key, { ...ws, open: false });
    return;
  }
  if (ws.tabs.length === 0) {
    const startTab = makeStartTab();
    setWorkspace(key, {
      open: true,
      expanded: ws.expanded,
      tabs: [startTab],
      activeTabId: startTab.id,
    });
    return;
  }
  const validActive = ws.tabs.some((t) => t.id === ws.activeTabId) ? ws.activeTabId : (ws.tabs[0]?.id ?? "");
  setWorkspace(key, { ...ws, open: true, activeTabId: validActive });
}

export function collapseDshSidebar(key: TerminalKey): void {
  const ws = getWorkspace(key);
  if (!ws.open) return;
  setWorkspace(key, { ...ws, open: false });
}

export function toggleDshExpanded(key: TerminalKey): void {
  const ws = getWorkspace(key);
  setWorkspace(key, { ...ws, expanded: !ws.expanded });
}

/** 点击标签栏 `+` 新标签页按钮：打开或激活一个「🧭 开始」页签。 */
export function addDshStartTab(key: TerminalKey): void {
  const ws = getWorkspace(key);
  const existingStart = ws.tabs.find((t) => t.kind === "start");
  if (existingStart) {
    setWorkspace(key, { ...ws, open: true, activeTabId: existingStart.id });
    return;
  }
  const startTab = makeStartTab();
  setWorkspace(key, {
    ...ws,
    open: true,
    tabs: [...ws.tabs, startTab],
    activeTabId: startTab.id,
  });
}

export function activateDshTab(key: TerminalKey, tabId: string): void {
  const ws = getWorkspace(key);
  if (!ws.tabs.some((t) => t.id === tabId)) return;
  if (ws.open && ws.activeTabId === tabId) return;
  setWorkspace(key, { ...ws, open: true, activeTabId: tabId });
}

/**
 * 在右侧工作台打开或激活指定工具标签。
 * - 若传了 `replaceTabId`（从「开始」页卡片点进某个工具），原位把该「开始」页签替换成目标工具页签（若单例工具已存在则合并过去）。
 * - 若当前只有一个「开始」页签，外部快捷键/文件链接打开工具时也自动替换该空白「开始」页签。
 */
export function openDshToolTab(
  key: TerminalKey,
  kind: Exclude<DshToolKind, "start">,
  options: { replaceTabId?: string | undefined; forceNewTerminal?: boolean | undefined } = {},
): DshTabItem {
  const ws = getWorkspace(key);
  const replaceId =
    options.replaceTabId ?? (ws.tabs.length === 1 && ws.tabs[0]?.kind === "start" ? ws.tabs[0].id : undefined);

  if (kind === "terminal") {
    if (!options.forceNewTerminal) {
      const activeTerm = ws.tabs.find((t) => t.id === ws.activeTabId && t.kind === "terminal");
      if (activeTerm) {
        if (!ws.open) setWorkspace(key, { ...ws, open: true });
        return activeTerm;
      }
      const firstTerm = ws.tabs.find((t) => t.kind === "terminal");
      if (firstTerm && replaceId === undefined) {
        setWorkspace(key, { ...ws, open: true, activeTabId: firstTerm.id });
        return firstTerm;
      }
    }
    const newTerm = allocateTerminalTab(key, ws.tabs);
    const nextTabs =
      replaceId !== undefined && ws.tabs.some((t) => t.id === replaceId)
        ? ws.tabs.map((t) => (t.id === replaceId ? newTerm : t))
        : [...ws.tabs, newTerm];
    setWorkspace(key, {
      ...ws,
      open: true,
      tabs: nextTabs,
      activeTabId: newTerm.id,
    });
    return newTerm;
  }

  const singletonTab: DshTabItem =
    kind === "files"
      ? { id: "files", kind: "files" }
      : kind === "browser"
        ? { id: "browser", kind: "browser" }
        : kind === "changes"
          ? { id: "changes", kind: "changes" }
          : kind === "extensions"
            ? { id: "extensions", kind: "extensions" }
            : { id: "agents", kind: "agents" };

  const alreadyExists = ws.tabs.some((t) => t.id === singletonTab.id);
  let nextTabs: readonly DshTabItem[];
  if (alreadyExists) {
    nextTabs = replaceId !== undefined ? ws.tabs.filter((t) => t.id !== replaceId) : ws.tabs;
  } else if (replaceId !== undefined && ws.tabs.some((t) => t.id === replaceId)) {
    nextTabs = ws.tabs.map((t) => (t.id === replaceId ? singletonTab : t));
  } else {
    nextTabs = [...ws.tabs, singletonTab];
  }

  setWorkspace(key, {
    ...ws,
    open: true,
    tabs: nextTabs,
    activeTabId: singletonTab.id,
  });
  return singletonTab;
}

export function updateDshTerminalLabel(key: TerminalKey, terminalKey: TerminalKey, shellLabel: string): void {
  const ws = getWorkspace(key);
  let changed = false;
  const nextTabs = ws.tabs.map((t) => {
    if (t.kind === "terminal" && t.terminalKey === terminalKey && t.shellLabel !== shellLabel) {
      changed = true;
      return { ...t, shellLabel };
    }
    return t;
  });
  if (changed) setWorkspace(key, { ...ws, tabs: nextTabs });
}

/** 关闭指定标签；返回被关闭的标签（若是终端标签，调用方负责关闭对应 PTY）。最后一个标签关闭后自动收起右侧栏。 */
export function closeDshTab(key: TerminalKey, tabId: string): DshTabItem | null {
  const ws = getWorkspace(key);
  const idx = ws.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return null;
  const removed = ws.tabs[idx]!;
  const nextTabs = ws.tabs.filter((t) => t.id !== tabId);
  if (nextTabs.length === 0) {
    setWorkspace(key, { ...ws, open: false, tabs: [], activeTabId: "" });
    return removed;
  }
  const nextActive =
    ws.activeTabId === tabId ? (nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? nextTabs[0]!.id) : ws.activeTabId;
  setWorkspace(key, { ...ws, tabs: nextTabs, activeTabId: nextActive });
  return removed;
}

/** 关闭某类单例或主终端标签（供旧版 closeFilePreview / closeBrowserPanel / setTerminalOpen(false) 兼容同步）。 */
export function closeDshToolKind(key: TerminalKey, kind: Exclude<DshToolKind, "start">): void {
  const ws = getWorkspace(key);
  const target = ws.tabs.find((t) => t.kind === kind);
  if (!target) return;
  closeDshTab(key, target.id);
}

export function isDshToolActive(key: TerminalKey, kind: DshToolKind): boolean {
  const ws = getWorkspace(key);
  if (!ws.open) return false;
  const active = ws.tabs.find((t) => t.id === ws.activeTabId);
  return active?.kind === kind;
}

export function rekeyDshWorkbench(from: DraftKey, to: TaskId, worktree: boolean): void {
  const prev = store.get();
  const ws = prev.get(from);
  if (!ws) return;
  const map = new Map(prev);
  map.delete(from);
  const migratedTabs: DshTabItem[] = ws.tabs
    .filter((t) => !(worktree && t.kind === "terminal"))
    .map((t) => {
      if (t.kind === "terminal") {
        const suffix = t.terminalKey.slice(from.length);
        return { ...t, terminalKey: `${to}${suffix}` as TerminalKey };
      }
      return t;
    });
  if (migratedTabs.length > 0) {
    const activeStillExists = migratedTabs.some((t) => t.id === ws.activeTabId);
    map.set(to, {
      ...ws,
      tabs: migratedTabs,
      activeTabId: activeStillExists ? ws.activeTabId : migratedTabs[0]!.id,
    });
  }
  store.set(map);
}

export function useDshWorkspace(key: TerminalKey): DshWorkspaceState {
  return useStoreValue(store, (map) => map.get(key) ?? DEFAULT_CLOSED);
}

window.studio.onTaskRemoved((taskId) => {
  if (!store.get().has(taskId)) return;
  const map = new Map(store.get());
  map.delete(taskId);
  store.set(map);
});
