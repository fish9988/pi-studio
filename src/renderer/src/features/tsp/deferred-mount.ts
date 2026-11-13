// 长历史首次挂载的分帧（见 MainFlow 的 useDeferredHead）：刚打开一个几千块的会话时，对话列先只画最后一截，
// 其余在后面的帧里往前补，避免一次插入一万多个 DOM 节点卡住主线程几百毫秒。
// 每帧补一批，直到全部挂载；这段时间里要跳到还没画出来的老消息（对话线、reveal、Alt+↑）
// 会先调 flushDeferredHistory 把剩下的立刻画出来，再重试一次定位：不能因为分帧丢了"历史都点得到"。
type Flush = () => void;
const pending = new Set<Flush>();

/** 少于这么多块（几百条消息的短会话）不拆：一次画完更快。 */
export const DEFER_MIN_BLOCKS = 120;
/** 第一帧先画最后这么多块（最新的一屏多一点）。 */
export const DEFER_TAIL_BLOCKS = 20;
/** 之后每个帧再往前补这么多块。 */
export const DEFER_STEP_BLOCKS = 20;

/** 这一帧从第几个块开始画：长历史（且是 inline 对话区）只画最后一截，返回要藏起来的前缀块数；0 表示全部画。 */
export function deferredHeadStart(total: number, enabled: boolean): number {
  if (!enabled || total < DEFER_MIN_BLOCKS) return 0;
  return Math.max(0, total - DEFER_TAIL_BLOCKS);
}

/** 立刻画完剩下没画的历史（对话区还处在分帧挂载的那一小段时间里才有意义，别的时候是空操作）。 */
export function flushDeferredHistory(): void {
  for (const flush of Array.from(pending)) flush();
}

/** MainFlow 登记自己的 flush，返回注销函数。 */
export function registerDeferredFlush(flush: Flush): () => void {
  pending.add(flush);
  return () => {
    pending.delete(flush);
  };
}
