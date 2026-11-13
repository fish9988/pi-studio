// 过程区右侧的对话线（spec §4.14"对话线"）：会话里每条用户消息一个刻度，从上到下按发送顺序；点刻度把那条消息滚到视口顶部。
// 视口里正在读的那一轮（最后一条顶边在视口上 1/3 以上的消息）的刻度加深、加长。少于 2 条消息不画。
// 消息来自 TSP 文档（omp.user 卡片，shared/tsp/user-messages.ts），页面里按 `[data-id]` 找到卡片：每次消息列表变化后各找一次，
// 元素换掉（重挂载）了再找；滚动时按顶边二分（卡片在页面里按发送顺序排，顶边递增），每帧只读 O(log n) 个矩形。
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { TaskId } from "../../../../shared/ipc.ts";
import {
  sameUserMessages,
  USER_MESSAGE_NODES,
  userMessages,
  type UserMessage,
} from "../../../../shared/tsp/user-messages.ts";
import { useT } from "../../i18n/use-t.ts";
import { noteProgrammaticTop, noteSmoothScroll } from "../conversation/scroll-intent.ts";
import { flushDeferredHistory } from "./deferred-mount.ts";
import { useTspDerived } from "./tsp-store.ts";

const NONE: readonly UserMessage[] = [];
const PREVIEW_CHARS = 80;
/** 跳过去后消息顶边离视口顶部的距离（--space-4）。 */
const LANDING_GAP = 16;
/** 落点高亮淡掉的时长：提示动画，不走 --dur-* 档（那些在减少动效下归零）。 */
const LANDING_FLASH_MS = 900;
/** 平滑滚动的预算：到点就把落点钉正（并解除这段时间的"程序滚动"抑制）。比实际动画长一点，动画被提前打断也能落到点上。 */
const SMOOTH_SETTLE_MS = 280;

function preview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= PREVIEW_CHARS ? line : `${line.slice(0, PREVIEW_CHARS - 1)}…`;
}

function card(scroller: HTMLElement, id: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
}

/** 落点提示：accent-soft 底 + 2px accent 环，从有到无淡掉。只动颜色，不属于位移，减少动效下也保留。再跳一次会重播。 */
function flashLanding(target: HTMLElement): void {
  const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim();
  // 只给起点帧：终点是元素自己原本的底色和阴影。
  target.animate([{ backgroundColor: "var(--accent-soft)", boxShadow: "0 0 0 2px var(--accent)" }], {
    duration: LANDING_FLASH_MS,
    easing,
  });
}

/** 正在读的消息：顶边在视口上 1/3 以上的最后一条；都在下面时是第一条；滚到底就是最后一条。页面里找不到卡片的消息跳过。 */
function currentIndex(
  scroller: HTMLElement,
  messages: readonly UserMessage[],
  cardOf: (id: string) => HTMLElement | null,
): number {
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) return messages.length - 1;
  const box = scroller.getBoundingClientRect();
  const line = box.top + box.height / 3;
  let current = 0;
  let lo = 0;
  let hi = messages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let probe = mid;
    let el = cardOf(messages[probe]!.id);
    while (el === null && probe > lo) {
      probe -= 1;
      el = cardOf(messages[probe]!.id);
    }
    if (el === null) lo = mid + 1;
    else if (el.getBoundingClientRect().top <= line) {
      current = probe;
      lo = mid + 1;
    } else hi = probe - 1;
  }
  return current;
}

/** 用户在滚动区里自己动了（滚轮、按下、按键）：落点不再保持。 */
const USER_SCROLL_EVENTS = ["wheel", "pointerdown", "keydown"] as const;

/** 跳过去以后的一小段时间里，对话列尺寸一变就把落点放回原处：离屏的消息块是 content-visibility: auto（tsp.css），
 *  按估计高度排，滚到附近才换成实际高度，落点上方的块变高变矮会把目标推走。返回停止函数。 */
function holdLanding(scroller: HTMLElement, place: () => void): () => void {
  const column = scroller.firstElementChild;
  if (column === null) return () => {};
  const observer = new ResizeObserver(place);
  observer.observe(column);
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, stop, true);
  };
  const timer = setTimeout(stop, LANDING_FLASH_MS);
  for (const type of USER_SCROLL_EVENTS) scroller.addEventListener(type, stop, { capture: true, passive: true });
  return stop;
}

export function ConversationLine({
  taskId,
  scroller,
  onProgrammaticScroll,
}: {
  taskId: TaskId;
  scroller: RefObject<HTMLElement | null>;
  /** 跳转是程序改 scrollTop：转给吸附引擎记账，否则流式增量会按旧锚点把视口拽回底部。 */
  onProgrammaticScroll?: ((options?: { away?: boolean }) => void) | undefined;
}) {
  const t = useT();
  const messages = useTspDerived(taskId, userMessages, sameUserMessages, USER_MESSAGE_NODES) ?? NONE;
  const [current, setCurrent] = useState(0);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const stopLanding = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el === null || messages.length < 2) return;
    const cards = new Map<string, HTMLElement | null>();
    const cardOf = (id: string): HTMLElement | null => {
      let found = cards.get(id);
      if (found === undefined || found === null || !found.isConnected) {
        found = card(el, id);
        cards.set(id, found);
      }
      return found;
    };
    let frame = 0;
    const update = () => {
      frame = 0;
      setCurrent(currentIndex(el, messages, cardOf));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller, messages]);

  useEffect(
    () => () => {
      clearTimeout(closeTimer.current);
      stopLanding.current?.();
    },
    [],
  );

  const jump = useCallback(
    (id: string) => {
      const el = scroller.current;
      const target = el === null ? null : card(el, id);
      if (el === null || target === null) return;
      // 落点固定：每次改 scrollTop 都记账（holdLanding 里也会反复调），不然会被当成用户上滑。
      const place = () => {
        const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top - LANDING_GAP;
        if (Math.abs(delta) > 0.5) {
          el.scrollTop += delta;
          noteProgrammaticTop(el, el.scrollTop);
        }
      };
      stopLanding.current?.();
      const reduced =
        document.documentElement.dataset.motion === "reduced" ||
        (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      /** 落到点上、重新取阅读锚点，然后进入 holdLanding 保持落点。 */
      const land = () => {
        place();
        onProgrammaticScroll?.();
        stopLanding.current = holdLanding(el, place);
      };
      // 一开始就脱离吸底：否则流式中途的一次贴底会把平滑滚动或落点直接拽回底部。
      onProgrammaticScroll?.({ away: true });
      if (reduced) {
        land();
      } else {
        const initialDelta = target.getBoundingClientRect().top - el.getBoundingClientRect().top - LANDING_GAP;
        // 平滑滚动的每一帧 scrollTop 都和记账值对不上：这段时间内不解除跟随、也不做锚点补偿。
        // 预算比下面 settle 的定时器长，避免定时器到点时抑制已经过期（只差一帧）又被当成用户滚动。
        noteSmoothScroll(el, SMOOTH_SETTLE_MS * 2);
        el.scrollTo({ top: el.scrollTop + initialDelta, behavior: "smooth" });
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(settleTimer);
          for (const type of USER_SCROLL_EVENTS) el.removeEventListener(type, cancel, true);
          land();
        };
        const cancel = () => {
          settled = true;
          clearTimeout(settleTimer);
          for (const type of USER_SCROLL_EVENTS) el.removeEventListener(type, cancel, true);
        };
        const settleTimer = window.setTimeout(settle, SMOOTH_SETTLE_MS);
        for (const type of USER_SCROLL_EVENTS) el.addEventListener(type, cancel, { capture: true, passive: true });
        stopLanding.current = cancel;
      }
      flashLanding(target);
    },
    [scroller, onProgrammaticScroll],
  );
  // 长历史刚打开时对话列还在分帧挂载（MainFlow）：目标可能还没画出来。先把剩下的历史画完，再逐帧重试定位（最多 6 帧）。
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const goTo = useCallback(
    (id: string) => {
      flushDeferredHistory();
      let attempts = 0;
      const attempt = (): void => {
        const el = scroller.current;
        if (el === null) return;
        if (card(el, id) !== null || attempts >= 6) {
          jumpRef.current(id);
          return;
        }
        attempts += 1;
        requestAnimationFrame(attempt);
      };
      attempt();
    },
    [scroller],
  );
  // Alt+↑ / Alt+↓ 在当前会话的用户消息刻度之间快速跳转
  useEffect(() => {
    if (messages.length < 2) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (event.target instanceof Element && event.target.closest('[aria-modal="true"]') !== null) return;
      const nextIdx = event.key === "ArrowUp" ? Math.max(0, current - 1) : Math.min(messages.length - 1, current + 1);
      const targetMsg = messages[nextIdx];
      if (!targetMsg) return;
      event.preventDefault();
      goTo(targetMsg.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, goTo, messages]);

  if (messages.length < 2) return null;

  const onEnter = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
    setOpen(true);
  };

  const onLeave = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = undefined;
      setOpen(false);
    }, 140);
  };

  return (
    <nav
      className="tsp-convline"
      aria-label={t("scroll.line")}
      data-testid="conversation-line"
      data-open={open ? "" : undefined}
    >
      <div
        className="tsp-convline-card"
        data-open={open ? "" : undefined}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
      >
        {messages.map((message, index) => {
          const shortText = preview(message.text);
          const label = t("scroll.lineItem", { n: index + 1, text: shortText });
          return (
            <button
              key={message.id}
              type="button"
              className="tsp-convline-tick"
              aria-label={label}
              aria-current={index === current ? "location" : undefined}
              data-testid="conversation-line-tick"
              onClick={() => goTo(message.id)}
            >
              <span className="tsp-convline-text">{shortText || `#${index + 1}`}</span>
              <span className="tsp-convline-dash" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
