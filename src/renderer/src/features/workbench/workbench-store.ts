// 右侧工作台（文件、变更、子代理、浏览器四模式共用右栏）的变更面板状态与单栏互斥切换。
import type { TaskId } from "../../../../shared/ipc.ts";
import { createStore, useStoreValue } from "../../store/create-store.ts";
import { closeReview } from "../../store/review-store.ts";
import { openAgentsPanel } from "../agents/agents-store.ts";
import { openBrowserPanel } from "../browser/browser-store.ts";
import { openFilesPanel } from "../file-preview/preview-store.ts";
import { closeDshToolKind, isDshToolActive, openDshToolTab } from "./dsh-workbench-store.ts";

export type WorkbenchTab = "files" | "changes" | "agents" | "browser";

const changesStore = createStore<TaskId | null>(null);
let returnFocus: HTMLElement | null = null;

window.studio.onTaskRemoved((taskId) => {
  if (changesStore.get() === taskId) changesStore.set(null);
});

export function openChangesPanel(taskId: TaskId): void {
  if (changesStore.get() === null) {
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  changesStore.set(taskId);
  openDshToolTab(taskId, "changes");
}

export function toggleChangesPanel(taskId: TaskId): void {
  if (isDshToolActive(taskId, "changes")) closeChangesPanel();
  else openChangesPanel(taskId);
}

export function closeChangesPanel(restoreFocus = true): void {
  const current = changesStore.get();
  if (current !== null) {
    changesStore.set(null);
    closeDshToolKind(current, "changes");
  }
  const target = returnFocus;
  returnFocus = null;
  if (restoreFocus && target?.isConnected) target.focus();
}

export function useChangesPanel(): TaskId | null {
  return useStoreValue(changesStore, (state) => state);
}

/**
 * 右侧「变更」面板和全屏评审共用同一个 `changes` 工作台标签，但状态在两个 store 里：
 * 从任一处关（顶栏开关、Ctrl+Shift+D、启动器、面板的 ×、Esc）都要两边一起清，否则另一边留个僵尸开关。
 */
export function closeChangesSurface(options: { restoreFocus?: boolean } = {}): void {
  closeChangesPanel(options.restoreFocus ?? true);
  closeReview();
}

/** 右栏顶部工作台切换：在同一栏内无缝切换面板。 */
export function switchWorkbenchTab(tab: WorkbenchTab, taskId: TaskId): void {
  if (tab === "files") {
    openFilesPanel(taskId);
    return;
  }
  if (tab === "changes") {
    openChangesPanel(taskId);
    return;
  }
  if (tab === "agents") {
    openAgentsPanel(taskId);
    return;
  }
  openBrowserPanel(taskId);
}
