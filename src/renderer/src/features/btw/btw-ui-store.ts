// 旁路提问面板的界面状态（每个任务一份）：开关、选中的话题、"请把焦点给输入框"的计数。
// 记录本身在 store/btw-store.ts（主进程事件的投影）；这里只有界面自己的状态，重载渲染进程后回到默认（关闭）。
import type { TaskId } from "../../../../shared/ipc.ts";
import { createStore, useStoreValue } from "../../store/create-store.ts";
import { refreshBtw } from "../../store/btw-store.ts";
import { NEW_TOPIC, type BtwSelection } from "./btw-view.ts";

export interface BtwPrefill {
  readonly text: string;
  readonly nonce: number;
}

export interface BtwUi {
  open: boolean;
  selection: BtwSelection;
  /** 每次要求聚焦（`/btw`、命令面板）加一：面板已经开着时也能把焦点拉回输入框。 */
  focusNonce: number;
  prefill?: BtwPrefill | undefined;
}

const closed: BtwUi = { open: false, selection: null, focusNonce: 0 };
const uiStore = createStore<Readonly<Record<string, BtwUi>>>({});

if (typeof window !== "undefined" && "studio" in window) {
  window.studio.onTaskRemoved((taskId) => {
    const { [taskId]: _removed, ...rest } = uiStore.get();
    uiStore.set(rest);
  });
}

function update(taskId: TaskId, patch: Partial<BtwUi>): void {
  const state = uiStore.get();
  uiStore.set({ ...state, [taskId]: { ...(state[taskId] ?? closed), ...patch } });
}

/** 打开面板并聚焦输入框；顺便向主进程对齐一次记录（历史随会话落盘，恢复后的任务里也有）。 */
export function openBtw(taskId: TaskId): void {
  update(taskId, { open: true, focusNonce: (uiStore.get()[taskId]?.focusNonce ?? 0) + 1 });
  refreshBtw(taskId).catch((error: unknown) => console.error("getBtw 失败", error));
}

/** 打开旁路提问面板并预填一段引用/问题，切换为新话题、聚焦输入框但不自动发送。 */
export function openBtwWithPrefill(taskId: TaskId, prefillText: string): void {
  const prev = uiStore.get()[taskId] ?? closed;
  update(taskId, {
    open: true,
    selection: NEW_TOPIC,
    focusNonce: prev.focusNonce + 1,
    prefill: { text: prefillText, nonce: (prev.prefill?.nonce ?? 0) + 1 },
  });
  refreshBtw(taskId).catch((error: unknown) => console.error("getBtw 失败", error));
}

export function closeBtw(taskId: TaskId): void {
  update(taskId, { open: false });
}

export function selectBtwTopic(taskId: TaskId, selection: BtwSelection): void {
  update(taskId, { selection });
}

/** 面板现在的选择（提问期间用户可能已经换了话题 / 点了"新话题"）。 */
export function currentBtwSelection(taskId: TaskId): BtwSelection {
  return (uiStore.get()[taskId] ?? closed).selection;
}

export function useBtwUi(taskId: TaskId): BtwUi {
  return useStoreValue(uiStore, (state) => state[taskId] ?? closed);
}
