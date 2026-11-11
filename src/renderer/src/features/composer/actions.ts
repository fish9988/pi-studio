// 输入框的几个动作：发送、停止并取回排队消息。Composer 和命令面板的事件都走这里。
import { reportError } from "../../ui/errors.ts";
import type { TaskId } from "../../../../shared/ipc.ts";
import type { TFunction } from "../../../../shared/i18n/index.ts";
import { pushToast } from "../dialogs/index.ts";
import { requestStickToBottom } from "../conversation/scroll-bus.ts";
import { appendToDraft, clearDraft, getDraft, restoreDraft } from "./draft-store.ts";
import { buildSubmission, ensureAttachmentTokens } from "./composer-tokens.ts";
import { stopToasts } from "./stop-outcome.ts";
import { findStudioSlash, handledCommands, type SlashRunResult } from "./studio-slash.ts";
import { PI_STUDIO_SLASH_COMMANDS } from "./pi-slash-table.ts";

export type Delivery = "steer" | "followUp";

/**
 * 发送草稿。先清空输入框（乐观），发送失败再放回去并提示；发送后强制吸底。
 * studio 接管的斜杠命令（pi-slash-table.ts）不发给 Pi；别的 `/` `!` 开头的文字原样交给 Pi。
 */
export async function sendDraft(taskId: TaskId, whenBusy: Delivery, t: TFunction): Promise<void> {
  const draft = getDraft(taskId);
  // 粘贴占位符换回原文、图片占位符按出现的编号重排；若用户删了文字里的 #N 但没点卡片 ×，自动补回后一起发。
  const submission = buildSubmission(ensureAttachmentTokens(draft));
  const text = submission.text.trim();
  if (text === "" && submission.images.length === 0 && submission.files.length === 0) return;
  const studio =
    submission.images.length === 0 ? findStudioSlash(text, handledCommands(PI_STUDIO_SLASH_COMMANDS)) : null;
  clearDraft(taskId);
  if (studio !== null) {
    let outcome: SlashRunResult | void;
    try {
      outcome = await studio.command.run(taskId, studio.args, t);
    } catch (error) {
      restoreDraft(taskId, draft);
      reportError(t, error);
      return;
    }
    // studio 认得这条命令的参数就办完了；不认得（"omp"）时原文照常发给 omp。
    if (outcome !== "omp") return;
  }
  requestStickToBottom(taskId);
  try {
    await window.studio.sendPrompt(taskId, {
      text,
      ...(submission.images.length > 0 ? { images: submission.images } : {}),
      ...(submission.files.length > 0 ? { fileIds: submission.files.map((file) => file.id) } : {}),
      whenBusy,
    });
  } catch (error) {
    restoreDraft(taskId, draft);
    reportError(t, error, t("msg.sendFailed"));
  }
}

/** 停止：撤回排队消息并中止；返回的消息按原文追加回草稿。 */
export async function stopAndRestore(taskId: TaskId, t: TFunction): Promise<void> {
  try {
    const restored = await window.studio.stopTask(taskId);
    const queued = [...restored.steering, ...restored.followUp];
    if (queued.length > 0) appendToDraft(taskId, queued);
    for (const toast of stopToasts(restored)) {
      const message = toast.count === undefined ? t(toast.key) : t(toast.key, { count: toast.count });
      pushToast(toast.level ? { level: toast.level, message } : { message });
    }
  } catch (error) {
    reportError(t, error);
  }
}
