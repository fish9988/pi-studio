// 过程组（MainFlow 的 ProcessGroup）的折叠状态：按 (任务, surface, 轮次, 这一轮里的第几个过程组) 记，
// 键与节点 id 无关 —— 主进程在 text_end 换掉流式容器 id、hydrate 时整段重建 id，过程组都不该因此丢掉用户刚点开的状态。
// 用户手动点过摘要按钮的组记 `userToggled`：此后设置项翻转、流式更新、这一轮结束时自动收起都不得再改它的 collapsed
// （回归：以前折叠状态是组件 useState，`completed = settled || !running` 又在一轮之内反复 true，用户刚展开的抽屉会被立刻收回）。
// 例外是用户自己去改「自动收起」设置项（`pref`）：那是全局指令，连手动翻过的组也一并纠正。
import { useCallback } from "react";
import { createStore, useStoreValue } from "../../store/create-store.ts";

export interface GroupFold {
  /** 用户手动点过摘要按钮。此后程序的动作（auto-collapse / auto-expand / pref）都不再改这一组。 */
  userToggled: boolean;
  /** 收起（true）还是展开（false）。 */
  collapsed: boolean;
}

/** 谁在改这一组：用户点摘要按钮、程序自动收起 / 展开、设置项同步。 */
export type GroupFoldAction = "toggle" | "auto-collapse" | "auto-expand" | "pref";

const folds = createStore<Readonly<Record<string, GroupFold>>>({});

/** 过程组的折叠键：同一轮里的同一个过程组永远得到同一个键（不看节点 id）。 */
export function groupFoldKey(taskId: string, sf: string, turnIndex: number, ordinal: number): string {
  return `${taskId}\u0000${sf}\u0000${turnIndex}\u0000${ordinal}`;
}

/** 这一组当前的折叠状态；还没记录过就用程序给的默认值（`initialCollapsed`）。 */
export function resolveGroupCollapsed(entry: GroupFold | undefined, initialCollapsed: boolean): boolean {
  return entry !== undefined ? entry.collapsed : initialCollapsed;
}

/**
 * 按动作算出下一条记录。
 * - `toggle`：用户点摘要按钮，记下 `userToggled`。
 * - `auto-collapse` / `auto-expand`：程序根据流式状态自己决定的，用户手动翻过的组原样返回（同一个对象引用，调用方据此知道"没变"）。
 * - `pref`：用户主动改了「自动收起」设置项，这是全局指令，连手动翻过的组也一并纠正（并把 `userToggled` 清掉）。
 */
export function nextGroupFold(
  entry: GroupFold | undefined,
  initialCollapsed: boolean,
  action: GroupFoldAction,
): GroupFold {
  if (action === "toggle") {
    return { userToggled: true, collapsed: !resolveGroupCollapsed(entry, initialCollapsed) };
  }
  if (action === "pref") {
    const next: GroupFold = { userToggled: false, collapsed: initialCollapsed };
    return entry !== undefined && entry.userToggled === false && entry.collapsed === initialCollapsed ? entry : next;
  }
  if (entry?.userToggled === true) return entry;
  const collapsed = action === "auto-collapse";
  return entry !== undefined && entry.collapsed === collapsed ? entry : { userToggled: false, collapsed };
}

export function readGroupFold(key: string): GroupFold | undefined {
  return folds.get()[key];
}

export function writeGroupFold(key: string, entry: GroupFold): void {
  const state = folds.get();
  // 原样返回的（用户手动翻过的组）不必写，免得每批流式更新都通知一遍订阅者。
  if (state[key] === entry) return;
  folds.set({ ...state, [key]: entry });
}

/** 只保留不属于 taskId 的记录（键以 `taskId\u0000` 开头的是它的）。导出来方便单测，不碰 DOM。 */
export function pruneGroupFolds(
  state: Readonly<Record<string, GroupFold>>,
  taskId: string,
): Readonly<Record<string, GroupFold>> {
  const prefix = `${taskId}\u0000`;
  const kept = Object.entries(state).filter(([key]) => !key.startsWith(prefix));
  return kept.length === Object.keys(state).length ? state : Object.fromEntries(kept);
}

// 任务的镜像被丢掉时，由 MainFlow 把它挂到 onTspDocumentDropped 上（这里不引 tsp-store.ts：那是 renderer 专用模块，
// 单测要在 node 环境里直接 import 这个文件的纯逻辑）。
export function dropGroupFolds(taskId: string): void {
  const current = folds.get();
  const next = pruneGroupFolds(current, taskId);
  if (next !== current) folds.set(next);
}

/**
 * 当前折叠状态 + 派发动作。`initialCollapsed` 是程序这一刻的默认值（自动收起开关 && 这一轮真的结束了）：
 * 没有记录的组始终跟着它走，所以"设置项实时生效"和"这一轮结束时自动收起"都不需要额外写状态。
 * 返回的函数报告这次是不是真的写了新值（调用方据此决定要不要连带收起里面的子卡片）。
 */
export function useGroupFold(
  key: string,
  initialCollapsed: boolean,
): [collapsed: boolean, apply: (action: GroupFoldAction) => boolean] {
  const entry = useStoreValue(folds, (state) => state[key]);
  const apply = useCallback(
    (action: GroupFoldAction) => {
      const state = folds.get();
      const current = state[key];
      // 还没记录时的 pref 同步结果就是默认值本身，不用落库。
      if (current === undefined && action === "pref") return false;
      const next = nextGroupFold(current, initialCollapsed, action);
      if (next === current) return false;
      folds.set({ ...state, [key]: next });
      return true;
    },
    [key, initialCollapsed],
  );
  return [resolveGroupCollapsed(entry, initialCollapsed), apply];
}
