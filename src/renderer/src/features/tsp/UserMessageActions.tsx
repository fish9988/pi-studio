// 用户消息气泡右下角操作栏：仅保留「复制」与反重力（Antigravity）同款「撤回」按钮；
// 点击撤回弹出 Confirm Undo 对话框（可选是否同时还原此轮及之后修改的工作区文件）。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskId } from "../../../../shared/ipc.ts";
import { userCardFromEnd } from "../../../../shared/tsp/session-tree.ts";
import { Check, Close, CopyIcon } from "../../icons.tsx";
import { currentLocale } from "../../store/settings-store.ts";
import { useTaskIdle } from "../../store/tasks-store.ts";
import { reportErrorNow } from "../../ui/errors.ts";
import { useTitleBarDim } from "../../ui/title-bar-dim.ts";
import { branchToNode } from "../conversation/fork-actions.ts";
import { focusIndexFromEnd } from "../conversation/tree-focus.ts";
import { pushToast } from "../dialogs/toast-store.ts";
import { copyText } from "./actions.ts";
import { peekTspDocument, peekTspNode } from "./tsp-store.ts";

async function resolveUserEntryId(taskId: TaskId, sf: string, cardId: string): Promise<string | null> {
  const doc = peekTspDocument(taskId);
  const fromEnd = doc === null ? null : userCardFromEnd(doc, sf, cardId);
  if (fromEnd === null) return null;
  const { nodes } = await window.studio.getSessionTree(taskId);
  const idx = focusIndexFromEnd(nodes, fromEnd);
  return idx !== null ? (nodes[idx]?.entryId ?? null) : null;
}

export function readUserCardText(taskId: TaskId, sf: string, cardId: string): string {
  const card = peekTspNode(taskId, sf, cardId);
  if (!card) return "";
  for (const cid of card.c) {
    const child = peekTspNode(taskId, sf, cid);
    if (child?.k === "md" && typeof child.p["text"] === "string") {
      return child.p["text"];
    }
  }
  return "";
}

function ConfirmUndoModal({
  open,
  busy,
  zh,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  zh: boolean;
  onClose(): void;
  onConfirm(revertFiles: boolean): void;
}) {
  const [revertFiles, setRevertFiles] = useState(false);
  useTitleBarDim(open, "scrim");

  useEffect(() => {
    if (!open) {
      setRevertFiles(false);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (busy) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        onConfirm(revertFiles);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, busy, revertFiles, onClose, onConfirm]);

  if (!open) return null;

  return createPortal(
    <div
      className="tsp-undo-scrim"
      data-testid="confirm-undo-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={zh ? "确认撤回" : "Confirm Undo"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="tsp-undo-modal" onClick={(event) => event.stopPropagation()}>
        <div className="tsp-undo-head">
          <span className="tsp-undo-title">{zh ? "确认撤回" : "Confirm Undo"}</span>
          <button
            type="button"
            className="tsp-undo-close"
            disabled={busy}
            aria-label={zh ? "关闭" : "Close"}
            onClick={onClose}
          >
            <Close size={14} />
          </button>
        </div>
        <p className="tsp-undo-desc">
          {revertFiles
            ? zh
              ? "对话将撤回至此轮之前，且此轮及之后修改的文件也将一并还原。"
              : "The conversation will be rewound and file changes from this point onward will be reverted."
            : zh
              ? "仅撤回对话至此轮之前，工作区文件将保持现状。"
              : "Only the conversation will be rewound; your files will be left as-is."}
        </p>
        <label className="tsp-undo-check">
          <input
            type="checkbox"
            checked={revertFiles}
            disabled={busy}
            onChange={(event) => setRevertFiles(event.target.checked)}
            data-testid="confirm-undo-revert-files"
          />
          <span>{zh ? "同时还原文件修改" : "Revert file changes"}</span>
        </label>
        <div className="tsp-undo-foot">
          <button
            type="button"
            className="tsp-undo-btn-cancel"
            disabled={busy}
            onClick={onClose}
            data-testid="confirm-undo-cancel"
          >
            {zh ? "取消" : "Cancel"}
          </button>
          <button
            type="button"
            className="tsp-undo-btn-confirm"
            disabled={busy}
            onClick={() => onConfirm(revertFiles)}
            data-testid="confirm-undo-submit"
          >
            <span>{zh ? "确认" : "Confirm"}</span>
            <span className="tsp-undo-enter-glyph" aria-hidden="true">
              ↵
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function UserMessageActions({ taskId, sf, cardId }: { taskId: TaskId; sf: string; cardId: string }) {
  const idle = useTaskIdle(taskId);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const zh = currentLocale() === "zh-CN";

  const onCopy = () => {
    const text = readUserCardText(taskId, sf, cardId);
    if (text === "") return;
    copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const onOpenUndo = () => {
    if (!idle) {
      pushToast({
        level: "info",
        message: zh ? "当前轮次还在运行，请等停止后再撤回" : "Wait for the current turn to finish first",
      });
      return;
    }
    if (busy) return;
    setConfirmOpen(true);
  };

  const onConfirmUndo = async (revertFiles: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const entryId = await resolveUserEntryId(taskId, sf, cardId);
      if (entryId === null) {
        setConfirmOpen(false);
        return;
      }
      await branchToNode(taskId, entryId, false, revertFiles);
      setConfirmOpen(false);
      pushToast({
        level: "info",
        message: revertFiles
          ? zh
            ? "已撤回对话并还原文件修改，原文已放回输入框"
            : "Conversation & files rewound; message restored to composer"
          : zh
            ? "已撤回对话至此轮，原文已放回输入框"
            : "Conversation rewound; message restored to composer",
      });
    } catch (error) {
      reportErrorNow(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="tsp-user-actions" data-testid="user-message-actions">
        <button
          type="button"
          className="tsp-user-action-btn"
          data-copied={copied || undefined}
          title={zh ? "复制消息" : "Copy message"}
          aria-label={zh ? "复制消息" : "Copy message"}
          onClick={onCopy}
          data-testid="user-msg-copy"
        >
          {copied ? <Check size={13} /> : <CopyIcon size={13} />}
        </button>
        <button
          type="button"
          className="tsp-user-action-btn"
          disabled={busy}
          title={zh ? "撤回至此轮" : "Undo to this message"}
          aria-label={zh ? "撤回至此轮" : "Undo to this message"}
          onClick={onOpenUndo}
          data-testid="user-msg-retract"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5.5 4L2.5 7l3 3" />
            <path d="M3 7h7a3.5 3.5 0 1 1 0 7H6" />
          </svg>
        </button>
      </div>
      <ConfirmUndoModal
        open={confirmOpen}
        busy={busy}
        zh={zh}
        onClose={() => setConfirmOpen(false)}
        onConfirm={(revertFiles) => void onConfirmUndo(revertFiles)}
      />
    </>
  );
}
