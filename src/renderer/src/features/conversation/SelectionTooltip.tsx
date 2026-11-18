// 划词浮条（对话区与 Markdown 预览共用）：在 rootRef 里选中一段文字后，选区上方浮出「引用到对话 / 旁路提问 / 复制」。
// 浮层挂到 body 上（不占对话流、不被滚动容器裁掉），坐标由下面的纯函数算；按 Esc、滚动、选区消失都收起。
// 按钮的 mousedown 一律 preventDefault：抓住焦点会让选区塌掉，点击就晚了。
import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { DraftKey, TaskId } from "../../../../shared/ipc.ts";
import { useT } from "../../i18n/use-t.ts";
import { Bolt, Comment, CopyIcon } from "../../icons.tsx";
import { reportError } from "../../ui/errors.ts";
import { openBtwWithPrefill } from "../btw/btw-ui-store.ts";
import { quoteToComposer } from "../composer/quote.ts";
import { pushToast } from "../dialogs/toast-store.ts";
import {
  MAX_SELECTION_CHARS,
  computeTooltipPosition,
  formatSelectionBtwPrefill,
  formatSelectionQuote,
  isExcludedSelectionTarget,
} from "./selection-tooltip-model.ts";
import "./selection-tooltip.css";

/** selectionchange 很密（拖选时每帧都来），等手停下来再看。 */
const DEBOUNCE_MS = 80;

interface Tip {
  text: string;
  x: number;
  y: number;
  placement: "above" | "below";
}

export interface SelectionTooltipProps {
  /** 允许划词的范围（对话列表、预览正文……）：选区两端都得落在里面。 */
  rootRef: RefObject<HTMLElement | null>;
  /** 当前任务：null 时没有「旁路提问」按钮（那需要一份会话）。 */
  taskId: TaskId | null;
  /** 引用写进哪份草稿：任务 id 或草稿键（`new:<projectId>`），null = 无项目的那份。 */
  quoteTarget: TaskId | DraftKey | null;
  /** 来源说明（文件名、消息序号……）：有值时引用块末尾带一行来源。 */
  sourceLabel?: string;
  enabled?: boolean;
}

export function SelectionTooltip({ rootRef, taskId, quoteTarget, sourceLabel, enabled = true }: SelectionTooltipProps) {
  const t = useT();
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || root === null) {
      setTip(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;

    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      setTip(null);
    };

    /** 选区两端都在 root 里、都不在排除目标里、文字长度合适时算出坐标显示；否则收起。 */
    const measure = () => {
      timer = undefined;
      // rootRef 指向的元素可能已经被换掉（切任务时列表重挂），每次现读，不用闭包里那一份。
      const current = rootRef.current;
      const selection = window.getSelection();
      if (current === null || selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        setTip(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const text = selection.toString().trim();
      if (
        text === "" ||
        text.length > MAX_SELECTION_CHARS ||
        !current.contains(range.startContainer) ||
        !current.contains(range.endContainer) ||
        isExcludedSelectionTarget(range.startContainer) ||
        isExcludedSelectionTarget(range.endContainer)
      ) {
        setTip(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setTip(null);
        return;
      }
      const at = computeTooltipPosition(rect, { width: window.innerWidth, height: window.innerHeight });
      setTip({ text, ...at });
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(measure, DEBOUNCE_MS);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("selectionchange", schedule);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", hide, true);
    root.addEventListener("mouseup", schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", hide, true);
      root.removeEventListener("mouseup", schedule);
    };
  }, [enabled, rootRef]);

  if (tip === null) return null;

  const dismiss = (clearSelection: boolean) => {
    if (clearSelection) window.getSelection()?.removeAllRanges();
    setTip(null);
  };

  const quote = () => {
    quoteToComposer(quoteTarget, formatSelectionQuote(tip.text, sourceLabel), { fold: tip.text.length > 400 });
    dismiss(true);
  };

  const ask = () => {
    if (taskId === null) return;
    openBtwWithPrefill(taskId, formatSelectionBtwPrefill(tip.text, sourceLabel));
    dismiss(true);
  };

  const copy = () => {
    const { text } = tip;
    navigator.clipboard.writeText(text).then(
      () => pushToast({ message: t("common.copied"), durationMs: 1500 }),
      (error: unknown) => reportError(t, error),
    );
    dismiss(false);
  };

  return createPortal(
    <div
      className="sel-tip"
      data-placement={tip.placement}
      data-testid="selection-tooltip"
      role="toolbar"
      style={{ left: tip.x, top: tip.y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" className="sel-tip-btn" data-testid="selection-quote" onClick={quote}>
        <Comment size={13} />
        {t("preview.quoteToChat")}
      </button>
      {taskId !== null && (
        <button type="button" className="sel-tip-btn" data-testid="selection-btw" onClick={ask}>
          <Bolt size={13} />
          {t("preview.askInBtw")}
        </button>
      )}
      <button type="button" className="sel-tip-btn" data-testid="selection-copy" onClick={copy}>
        <CopyIcon size={13} />
        {t("preview.copySelection")}
      </button>
    </div>,
    document.body,
  );
}
