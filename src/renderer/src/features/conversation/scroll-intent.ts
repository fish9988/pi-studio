// 滚动意图记账（spec 5.4）：判断"这次 scrollTop 变化是程序做的还是用户做的"只在这里做一次判断。
// useStickToBottom 的吸底状态机靠它区分"自己贴底 / 按锚点补偿 / reveal / 对话线跳转"和"用户上滑"；
// 三处各自写 scrollTop 的地方（吸底引擎、TspView 的 reveal、ConversationLine 的跳转）都要先 noteProgrammaticTop，
// 否则下一次流式增量会按旧锚点把视口拽回去，或者把程序滚动当成用户上滑而静默解除跟随。
// 这里不 import React、不读布局：只要有 scrollTop 字段就行，单测直接用 `{ scrollTop: 0 }` 这种假对象。

/** 记账需要的最小信息：浏览器传进来的 HTMLElement 天然满足。 */
export interface ScrollTopLike {
  scrollTop: number;
}

/** 最后一次由程序设置的 scrollTop。 */
const programmaticTops = new WeakMap<object, number>();
/** 平滑滚动的抑制截止时间：动画中间每一帧的 scrollTop 都和记账值对不上，但那不是用户在滚。 */
const smoothUntil = new WeakMap<object, number>();

/** 程序改完 scrollTop（要读回夹紧后的实际值）之后调用。 */
export function noteProgrammaticTop(el: ScrollTopLike, top: number): void {
  programmaticTops.set(el, top);
}

export function readProgrammaticTop(el: ScrollTopLike): number | undefined {
  return programmaticTops.get(el);
}

/** 开始一段程序发起的平滑滚动：这段时间内的 scroll 事件都不算用户上滑。 */
export function noteSmoothScroll(el: ScrollTopLike, durationMs: number): void {
  smoothUntil.set(el, Date.now() + durationMs);
}

export function isSmoothScrolling(el: ScrollTopLike, now: number): boolean {
  const until = smoothUntil.get(el);
  return until !== undefined && now < until;
}

/** 这次 scroll 事件是程序滚动（含平滑滚动中）还是用户滚动。`epsilon` 是 subpixel 容差。 */
export function classifyScroll(el: ScrollTopLike, top: number, epsilon: number): "programmatic" | "user" {
  if (isSmoothScrolling(el, Date.now())) return "programmatic";
  const recorded = programmaticTops.get(el);
  return recorded !== undefined && Math.abs(top - recorded) <= epsilon ? "programmatic" : "user";
}

/** 换任务、卸载时清掉（WeakMap 跟着元素回收，这里只是让判断回到"没有记录"的初始状态）。 */
export function resetScrollIntent(el: ScrollTopLike): void {
  programmaticTops.delete(el);
  smoothUntil.delete(el);
}

/** 滚轮链上的一环：Element 天然满足（parentElement / scrollTop / scrollHeight / clientHeight）。 */
export interface ScrollChainNode {
  parentElement: ScrollChainNode | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * 滚轮事件是不是该由内层滚动容器吃掉：从 `target` 一路往上找到 `root`（根滚动容器），
 * 路上只要有一环还能朝 deltaY 的方向继续滚，这次滚轮就不该解除吸底。
 *
 * 内层的思考正文（300px）、过程组（440px）、工具正文（260px）、`.md-codebody`（440px）都有自己的滚动条，
 * 滚到头之前 `wheel` 会冒泡到根滚动容器上；以前一律当成用户上滑，读长代码块/长思考时轻轻一滚就脱离跟随。
 *
 * `scrollable`：滚轮真的能滚这个元素吗（`overflow: hidden` 的元素几何上有余量但不吃滚轮），由调用方用 getComputedStyle 判断。
 */
export function wheelEscapesStick(
  target: ScrollChainNode | null,
  root: ScrollChainNode,
  deltaY: number,
  scrollable: (node: ScrollChainNode) => boolean = () => true,
): boolean {
  for (let node = target; node !== null && node !== root; node = node.parentElement) {
    // 向下还有内容 / 向上还能回滚：留 1px 容差，滚到正好到底时 subpixel 夹紧过。
    const room = deltaY > 0 ? node.scrollHeight - node.clientHeight - node.scrollTop : node.scrollTop;
    if (room > 1 && scrollable(node)) return true;
  }
  return false;
}
