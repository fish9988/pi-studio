// 对话列宽度拖拽手柄（复刻 dsh-claude-style 的 width-handle）：
// 对话列左缘一条 14px 宽的透明命中带；鼠标停留满 60ms 或按下时才露出 2px 导轨线（防滑过误闪）；
// 拖动时中心对称缩放对话列宽度（Δwidth = ±2 × Δx），直接写主区面板的 --chat-current（零 React 重渲染），
// 松手后 commit 持久化；双击恢复自适应默认宽度；←/→ 键微调。
// 右缘不做手柄：中心对称缩放让左右等价，而右缘正好是覆盖式滚动条的位置（见文件末的说明）。
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { chatWidthRange, clampChatWidth, commitChatWidth, defaultChatWidth } from "./shell-store.ts";

const REST_MS = 60;
const KEY_STEP = 24;

function clampToPanel(panel: HTMLElement | null, value: number): number {
  const maxInPanel =
    panel && panel.clientWidth > chatWidthRange[0] + 32
      ? Math.min(chatWidthRange[1], panel.clientWidth - 32)
      : chatWidthRange[1];
  return Math.round(Math.min(maxInPanel, Math.max(chatWidthRange[0], value)));
}

function measureCurrentWidth(panel: HTMLElement | null, fallback: number): number {
  if (!panel) return fallback > 0 ? fallback : defaultChatWidth;
  const col = panel.querySelector<HTMLElement>(".tsp-column, .composer-stack, .empty > *");
  if (col && col.offsetWidth > 0) return clampToPanel(panel, col.offsetWidth);
  return fallback > 0 ? fallback : defaultChatWidth;
}

function HandleSide({
  side,
  width,
  panel,
}: {
  side: "left" | "right";
  width: number;
  panel: RefObject<HTMLElement | null>;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [rested, setRested] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const clearRest = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setRested(false);
  };

  const applyWidth = (handle: HTMLElement, next: number) => {
    if (next <= 0) {
      panel.current?.style.removeProperty("--chat-current");
      handle.setAttribute("aria-valuenow", String(defaultChatWidth));
    } else {
      panel.current?.style.setProperty("--chat-current", `${next}px`);
      handle.setAttribute("aria-valuenow", String(next));
    }
  };

  const calcDragged = (clientX: number): number => {
    if (!drag.current) return width > 0 ? width : defaultChatWidth;
    const dx = clientX - drag.current.startX;
    const delta = side === "right" ? dx * 2 : -dx * 2;
    return clampToPanel(panel.current, drag.current.startWidth + delta);
  };

  const onPointerEnter = () => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setRested(true);
    }, REST_MS);
  };

  const onPointerLeave = () => {
    if (!drag.current) clearRest();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = measureCurrentWidth(panel.current, width);
    drag.current = { startX: event.clientX, startWidth };
    setRested(true);
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    applyWidth(event.currentTarget, calcDragged(event.clientX));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = calcDragged(event.clientX);
    drag.current = null;
    setDragging(false);
    clearRest();
    commitChatWidth(next);
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    clearRest();
    applyWidth(event.currentTarget, width);
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    applyWidth(event.currentTarget, 0);
    commitChatWidth(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const base = measureCurrentWidth(panel.current, width);
    const dir = event.key === "ArrowRight" ? 1 : -1;
    const sign = side === "right" ? dir : -dir;
    const next = clampChatWidth(base + sign * KEY_STEP);
    applyWidth(event.currentTarget, next);
    commitChatWidth(next);
  };

  return (
    <div
      className={`chat-width-handle chat-width-handle-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize chat column left" : "Resize chat column right"}
      aria-valuemin={chatWidthRange[0]}
      aria-valuemax={chatWidthRange[1]}
      aria-valuenow={width > 0 ? width : defaultChatWidth}
      tabIndex={0}
      data-side={side}
      data-rest={rested ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      data-testid={`chat-width-handle-${side}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  );
}

export function ChatWidthResizer({ width, panel }: { width: number; panel: RefObject<HTMLElement | null> }) {
  // 只留左缘一条：缩放是中心对称的（Δwidth = ±2 × Δx），左右两条功能完全一样，
  // 而右缘那条正好压在会话面板的覆盖式滚动条上（两条命中带只隔 3px），
  // 想拖滚动条会变成拖列宽。右缘还给滚动条自己。
  return <HandleSide side="left" width={width} panel={panel} />;
}
