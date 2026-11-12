// 侧栏客户端偏好与活动状态（对齐 pi-agent-desktop-more 的 pinnedChats 与 unreadSessionIds）：
// - pinnedIds：置顶的任务 ID 或历史会话 ID（持久化于 localStorage），在文件夹内与时间线下均置顶优先排序；
// - unreadTaskIds：在后台运行完成、用户尚未点开查看的任务 ID，展示未读呼吸圆点与折叠文件夹未读计数，选中后自动清除。
import { useEffect, useRef } from "react";
import type { TaskId } from "../../../../shared/ipc.ts";
import { createStore, useStoreValue } from "../../store/create-store.ts";
import { useSelectedTaskId, useTasksState } from "../../store/index.ts";

const PINNED_STORAGE_KEY = "omp-studio:pinned-ids";
const UNREAD_STORAGE_KEY = "omp-studio:unread-tasks";
const HIDDEN_FOLDERS_STORAGE_KEY = "omp-studio:hidden-folders";
const FOLDER_ALIASES_STORAGE_KEY = "omp-studio:folder-aliases";

function readStoredMap(key: string): Readonly<Record<string, string>> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
      }
      return out;
    }
  } catch {
    // 忽略读取异常
  }
  return {};
}

function writeStoredMap(key: string, map: Readonly<Record<string, string>>): void {
  try {
    if (Object.keys(map).length === 0) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify(map));
  } catch {
    // 忽略配额异常
  }
}

function readStoredSet(key: string): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === "string" && item !== ""));
    }
  } catch {
    // 忽略 localStorage 读取异常
  }
  return new Set();
}

function writeStoredSet(key: string, set: ReadonlySet<string>): void {
  try {
    if (set.size === 0) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify([...set]));
  } catch {
    // 忽略配额异常
  }
}

interface SidebarPrefsState {
  pinnedIds: ReadonlySet<string>;
  unreadTaskIds: ReadonlySet<string>;
  hiddenFolderKeys: ReadonlySet<string>;
  folderAliases: Readonly<Record<string, string>>;
}

const store = createStore<SidebarPrefsState>({
  pinnedIds: readStoredSet(PINNED_STORAGE_KEY),
  unreadTaskIds: readStoredSet(UNREAD_STORAGE_KEY),
  hiddenFolderKeys: readStoredSet(HIDDEN_FOLDERS_STORAGE_KEY),
  folderAliases: readStoredMap(FOLDER_ALIASES_STORAGE_KEY),
});

export function usePinnedIds(): ReadonlySet<string> {
  return useStoreValue(store, (state) => state.pinnedIds);
}

export function useUnreadTaskIds(): ReadonlySet<string> {
  return useStoreValue(store, (state) => state.unreadTaskIds);
}

export function useHiddenFolderKeys(): ReadonlySet<string> {
  return useStoreValue(store, (state) => state.hiddenFolderKeys);
}

export function useFolderAliases(): Readonly<Record<string, string>> {
  return useStoreValue(store, (state) => state.folderAliases);
}

export function folderAliasKey(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function setFolderAlias(cwd: string, alias: string | null): void {
  const key = folderAliasKey(cwd);
  if (!key) return;
  const current = store.get().folderAliases;
  const trimmed = alias?.trim() ?? "";
  const next = { ...current };
  if (trimmed === "") {
    delete next[key];
  } else {
    next[key] = trimmed;
  }
  writeStoredMap(FOLDER_ALIASES_STORAGE_KEY, next);
  store.set({ ...store.get(), folderAliases: next });
}

export function hideFolderKey(folderKey: string): void {
  if (!folderKey) return;
  const current = store.get().hiddenFolderKeys;
  if (current.has(folderKey)) return;
  const next = new Set(current);
  next.add(folderKey);
  writeStoredSet(HIDDEN_FOLDERS_STORAGE_KEY, next);
  store.set({ ...store.get(), hiddenFolderKeys: next });
}

export function unhideFolderKey(folderKey: string): void {
  if (!folderKey) return;
  const current = store.get().hiddenFolderKeys;
  if (!current.has(folderKey)) return;
  const next = new Set(current);
  next.delete(folderKey);
  writeStoredSet(HIDDEN_FOLDERS_STORAGE_KEY, next);
  store.set({ ...store.get(), hiddenFolderKeys: next });
}

export function isItemPinned(id: string): boolean {
  return store.get().pinnedIds.has(id);
}

export function toggleItemPinned(id: string): boolean {
  const current = store.get().pinnedIds;
  const next = new Set(current);
  const nowPinned = !next.has(id);
  if (nowPinned) next.add(id);
  else next.delete(id);
  writeStoredSet(PINNED_STORAGE_KEY, next);
  store.set({ ...store.get(), pinnedIds: next });
  return nowPinned;
}

export function markTasksUnread(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const current = store.get().unreadTaskIds;
  const next = new Set(current);
  let changed = false;
  for (const id of ids) {
    if (!next.has(id)) {
      next.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  writeStoredSet(UNREAD_STORAGE_KEY, next);
  store.set({ ...store.get(), unreadTaskIds: next });
}

export function clearTaskUnread(id: string): void {
  const current = store.get().unreadTaskIds;
  if (!current.has(id)) return;
  const next = new Set(current);
  next.delete(id);
  writeStoredSet(UNREAD_STORAGE_KEY, next);
  store.set({ ...store.get(), unreadTaskIds: next });
}

export function isTaskUnread(id: string): boolean {
  return store.get().unreadTaskIds.has(id);
}

export function toggleTaskUnread(id: string): boolean {
  const current = store.get().unreadTaskIds;
  const next = new Set(current);
  const nowUnread = !next.has(id);
  if (nowUnread) next.add(id);
  else next.delete(id);
  writeStoredSet(UNREAD_STORAGE_KEY, next);
  store.set({ ...store.get(), unreadTaskIds: next });
  return nowUnread;
}

/** 挂在 App 根级（进入设置页或收起侧栏时不卸载）：全局追踪后台完成任务并亮起未读圆点，选中该任务时自动清除。 */
export function useUnreadTaskSync(): void {
  const selectedTaskId = useSelectedTaskId();
  const tasksState = useTasksState();
  const prevRunningRef = useRef<Set<TaskId>>(new Set());

  useEffect(() => {
    const nowRunning = new Set<TaskId>();
    const completedInBg: TaskId[] = [];
    for (const task of tasksState.list) {
      if (task.status === "running" || task.status === "starting") {
        nowRunning.add(task.id);
      } else if (
        prevRunningRef.current.has(task.id) &&
        task.id !== selectedTaskId &&
        task.status === "idle" &&
        task.lastTurn?.status === "completed"
      ) {
        completedInBg.push(task.id);
      }
    }
    prevRunningRef.current = nowRunning;
    if (completedInBg.length > 0) markTasksUnread(completedInBg);
  }, [tasksState.list, selectedTaskId]);

  useEffect(() => {
    if (selectedTaskId !== null) clearTaskUnread(selectedTaskId);
  }, [selectedTaskId]);

  useEffect(() => window.studio.onTaskRemoved((taskId) => clearTaskUnread(taskId)), []);
}
