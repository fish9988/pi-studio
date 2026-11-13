// 输入框工具栏的「复制全部（含图片/附件）」与「✨ 优化提示词」按钮组：
// - 复制全部：将输入框文本与附带图片/文件（含富文本 <img>）一并写入剪贴板，可直接粘贴到其他多模态 AI；
// - 优化提示词：调用主进程 enhancePrompt（支持将草稿里的图片和文件作为上下文传入辅助 LLM），并只替换文字部分，完整保留附件与支持一键还原。
import { useEffect, useState } from "react";
import type { TaskId } from "../../../../shared/ipc.ts";
import { useT } from "../../i18n/use-t.ts";
import { Check, CopyIcon } from "../../icons.tsx";
import { reportError } from "../../ui/errors.ts";
import { pushToast } from "../dialogs/toast-store.ts";
import { buildSubmission, reconcileDraft, type Draft } from "./composer-tokens.ts";
import { getDraft, setDraft, useDraft } from "./draft-store.ts";

const ATTACHMENT_TOKEN_RE = /\[(Image|Paste|File) #[1-9]\d*(?:,[^\]\n]*)?\]/g;
const FILE_SLOT_RE = /\uE000file:([1-9]\d*)\uE001/g;

function SparkleIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={spinning ? "enhance-sparkle is-spinning" : "enhance-sparkle"}
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
      <path d="M8 1.5l1.6 4.1 4.1 1.6-4.1 1.6L8 12.9 6.4 8.8 2.3 7.2l4.1-1.6L8 1.5z" />
      <path d="M13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4z" />
    </svg>
  );
}

export function EnhancePromptButton({
  draftKey,
  text,
  taskId,
  disabled = false,
  onFocusField,
}: {
  draftKey: TaskId;
  text: string;
  taskId: TaskId | null;
  disabled?: boolean;
  onFocusField?: () => void;
}) {
  const t = useT();
  const draft = useDraft(draftKey);
  const [busy, setBusy] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [backup, setBackup] = useState<{ originalDraft: Draft; enhancedText: string } | null>(null);

  useEffect(() => {
    if (!copiedAll) return;
    const timer = setTimeout(() => setCopiedAll(false), 1400);
    return () => clearTimeout(timer);
  }, [copiedAll]);

  const strippedText = text.replace(ATTACHMENT_TOKEN_RE, "").trim();
  const hasAttachments = draft.images.length > 0 || draft.files.length > 0 || Object.keys(draft.pastes).length > 0;
  const hasContent = strippedText.length > 0 || hasAttachments;
  const canUndo = backup !== null && text === backup.enhancedText;

  const onCopyAll = async () => {
    if (!hasContent) return;
    const currentDraft = getDraft(draftKey);
    const submission = buildSubmission(currentDraft);
    const missingImages = currentDraft.images.filter((img) => !submission.images.includes(img));
    const missingFiles = currentDraft.files.filter((file) => !submission.files.includes(file));
    const allImages = [...submission.images, ...missingImages];
    const allFiles = [...submission.files, ...missingFiles];
    try {
      await window.studio.copyDraftToClipboard({
        text: submission.text,
        images: allImages.map(({ mimeType, data }) => ({ mimeType, data })),
        fileIds: allFiles.map((file) => file.id).filter((id) => id !== ""),
      });
      setCopiedAll(true);
      pushToast({ level: "info", message: t("composer.copyAllDone") });
    } catch (error) {
      reportError(t, error);
    }
  };

  const onEnhance = async () => {
    if (busy || !hasContent || disabled) return;
    const currentDraft = getDraft(draftKey);
    const allTokens = [...currentDraft.text.matchAll(ATTACHMENT_TOKEN_RE)].map((m) => m[0]);
    const submission = buildSubmission(currentDraft);
    // 包含未被文本内引用的图片/文件，确保优化器能看到全部附加上下文
    const missingImages = currentDraft.images.filter((img) => !submission.images.includes(img));
    const missingFiles = currentDraft.files.filter((file) => !submission.files.includes(file));
    const allImages = [...submission.images, ...missingImages];
    const allFiles = [...submission.files, ...missingFiles];
    // 把提交文本里的 \uE000file:N\uE001 还原成 [File #N, name]，避免辅助模型输出私有控制字符
    const optimizerText = submission.text.replace(FILE_SLOT_RE, (_, numStr: string) => {
      const idx = Number(numStr) - 1;
      const name = allFiles[idx]?.name ?? `file-${numStr}`;
      return `[File #${numStr}, ${name}]`;
    });

    setBusy(true);
    try {
      const enhanced = await window.studio.enhancePrompt(
        {
          text: optimizerText,
          images: allImages.map(({ mimeType, data }) => ({ mimeType, data })),
          fileIds: allFiles.map((file) => file.id).filter((id) => id !== ""),
        },
        taskId,
      );
      if (enhanced && enhanced.trim() !== "") {
        // 优化结果只替换文本：原附件标记（图片、文件、粘贴片段）必须全部保留，不能因为模型重写文字而丢掉附件。
        const missingTokens = allTokens.filter((tok) => !enhanced.includes(tok));
        const finalText = missingTokens.length > 0 ? `${missingTokens.join(" ")} ${enhanced.trim()}` : enhanced.trim();
        const nextDraft = reconcileDraft({ ...currentDraft, text: finalText });
        setDraft(draftKey, nextDraft);
        setBackup({ originalDraft: currentDraft, enhancedText: nextDraft.text });
        pushToast({ level: "info", message: t("composer.enhanceDone") });
        onFocusField?.();
      }
    } catch (error) {
      reportError(t, error);
    } finally {
      setBusy(false);
    }
  };

  const onUndo = () => {
    if (!backup) return;
    setDraft(draftKey, backup.originalDraft);
    setBackup(null);
    onFocusField?.();
  };
  return (
    <span className="enhance-prompt-group" data-testid="enhance-prompt-group">
      {canUndo && (
        <button
          type="button"
          className="ui-chip enhance-undo-btn"
          title={t("composer.enhanceUndoTip")}
          onClick={onUndo}
          data-testid="enhance-prompt-undo"
        >
          <span>{t("composer.enhanceUndo")}</span>
        </button>
      )}
      <button
        type="button"
        className="ui-chip enhance-prompt-btn"
        disabled={!hasContent}
        title={t("composer.copyAllTip")}
        aria-label={t("composer.copyAll")}
        onClick={() => void onCopyAll()}
        data-testid="composer-copy-all"
      >
        {copiedAll ? <Check size={14} /> : <CopyIcon size={14} />}
      </button>
      <button
        type="button"
        className="ui-chip enhance-prompt-btn"
        disabled={busy || !hasContent || disabled}
        title={t("composer.enhanceTip")}
        aria-label={t("composer.enhance")}
        onClick={() => void onEnhance()}
        data-busy={busy ? "" : undefined}
        data-testid="enhance-prompt-btn"
      >
        <SparkleIcon spinning={busy} />
      </button>
    </span>
  );
}
