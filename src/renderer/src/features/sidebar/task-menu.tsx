// 任务菜单：侧栏任务行的 ⋯ / 右键和顶栏的 ⋯ 打开的是同一份（项一致、顺序一致）。
// 第一组是任务本身（重命名、保持运行、会话信息、请求记录、分享链接），第二组是文件（工作目录、会话文件、复制、导出），最后是归档。
import type { TFunction } from "../../../../shared/i18n/index.ts";
import type { SessionSummary, TaskId } from "../../../../shared/ipc.ts";
import { CopyIcon, External, FileIcon, Folder, Info, Pencil, Pin, Trash } from "../../icons.tsx";
import { clearSelection, upsertTask } from "../../store/index.ts";
import { reportError } from "../../ui/errors.ts";
import type { MenuEntry } from "../../ui/Menu.tsx";
import { pushToast } from "../dialogs/index.ts";
import { exportConversationReporting } from "../composer/export-html.ts";
import { openSessionInfo, openShareDialog } from "../session-info/session-info-store.ts";
import { archiveWithUndo } from "./archive-store.ts";
import { ArchiveIcon, ExportIcon, ProcessIcon } from "./icons.tsx";
import { isItemPinned, isTaskUnread, toggleItemPinned, toggleTaskUnread } from "./sidebar-prefs-store.ts";
import { refreshHistorySessions, removeHistorySessionOptimistic } from "./use-history-sessions.ts";
export async function attempt(t: TFunction, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    reportError(t, error);
  }
}

async function copySession(
  t: TFunction,
  taskId: TaskId,
  pick: "sessionId" | "sessionFile" | "sessionRef",
): Promise<void> {
  await attempt(t, async () => {
    const ref = await window.studio.getTaskSessionRef(taskId);
    if (ref === null) {
      pushToast({ level: "info", message: t("task.noSession") });
      return;
    }
    if (pick === "sessionRef") {
      await navigator.clipboard.writeText(`#${ref.sessionId}`);
      pushToast({ level: "info", message: t("task.copiedRef", { id: ref.sessionId.slice(0, 8) }) });
    } else if (pick === "sessionId") {
      await navigator.clipboard.writeText(ref.sessionId);
      pushToast({ level: "info", message: t("task.copiedId", { id: ref.sessionId.slice(0, 8) }) });
    } else {
      await navigator.clipboard.writeText(ref.sessionFile);
    }
  });
}

function SparkleMenuIcon() {
  return (
    <svg
      width="16"
      height="16"
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

export function buildTaskMenu(options: {
  t: TFunction;
  taskId: TaskId;
  keepAlive: boolean;
  selectedTaskId: TaskId | null;
  onRename(): void;
}): MenuEntry[] {
  const { t, taskId } = options;
  const pinned = isItemPinned(taskId);
  const unread = isTaskUnread(taskId);
  return [
    {
      id: "pin",
      label: t(pinned ? "task.unpin" : "task.pin"),
      icon: <Pin />,
      onSelect: () => {
        toggleItemPinned(taskId);
      },
    },
    {
      id: "unread",
      label: t(unread ? "task.markRead" : "task.markUnread"),
      icon: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="3.5"
            fill={unread ? "none" : "currentColor"}
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      ),
      onSelect: () => {
        toggleTaskUnread(taskId);
      },
    },
    { id: "rename", label: t("task.rename"), icon: <Pencil />, shortcut: "F2", onSelect: options.onRename },
    {
      id: "smartRename",
      label: t("task.smartRename"),
      icon: <SparkleMenuIcon />,
      onSelect: () =>
        void attempt(t, async () => {
          const title = await window.studio.smartRenameTask(taskId);
          refreshHistorySessions();
          pushToast({ level: "info", message: t("task.smartRenamed", { title }) });
        }),
    },
    {
      id: "keepAlive",
      label: t(options.keepAlive ? "task.keepAliveOff" : "task.keepAlive"),
      icon: <Pin />,
      onSelect: () => void attempt(t, () => window.studio.setTaskKeepAlive(taskId, !options.keepAlive)),
    },
    { id: "info", label: t("sessionInfo.menu.info"), icon: <Info />, onSelect: () => openSessionInfo(taskId, "info") },
    {
      id: "trace",
      label: t("sessionInfo.menu.trace"),
      icon: <ProcessIcon />,
      onSelect: () => openSessionInfo(taskId, "trace"),
    },
    { id: "share", label: t("sessionInfo.menu.share"), icon: <External />, onSelect: () => openShareDialog(taskId) },
    { kind: "separator", id: "sep-files" },
    // 工作目录 = omp 读写文件、跑命令的地方；会话文件是 omp 自己存在 ~/.omp/agent/sessions 下的记录，两者不是一个地方。
    {
      id: "openFolder",
      label: t("task.openFolder"),
      icon: <Folder />,
      onSelect: () => void attempt(t, () => window.studio.openTaskFolder(taskId)),
    },
    {
      id: "reveal",
      label: t("task.reveal"),
      icon: <FileIcon />,
      onSelect: () => void attempt(t, () => window.studio.revealTaskSession(taskId)),
    },
    {
      id: "copyId",
      label: t("task.copyId"),
      icon: <CopyIcon />,
      onSelect: () => void copySession(t, taskId, "sessionId"),
    },
    {
      id: "copyRef",
      label: t("task.copyRef"),
      icon: <CopyIcon />,
      onSelect: () => void copySession(t, taskId, "sessionRef"),
    },
    {
      id: "copyPath",
      label: t("task.copyPath"),
      icon: <CopyIcon />,
      onSelect: () => void copySession(t, taskId, "sessionFile"),
    },
    {
      id: "exportHtml",
      label: t("task.exportHtml"),
      icon: <ExportIcon />,
      onSelect: () => void exportConversationReporting(taskId, t),
    },
    { kind: "separator", id: "sep-archive" },
    {
      id: "archive",
      label: t("task.archive"),
      icon: <ArchiveIcon />,
      shortcut: "Del",
      onSelect: () => archiveWithUndo(taskId, options.selectedTaskId, t),
    },
    {
      id: "delete",
      label: t("task.delete"),
      icon: <Trash />,
      tone: "danger",
      onSelect: () =>
        void attempt(t, async () => {
          if (options.selectedTaskId === taskId) clearSelection();
          await window.studio.deleteTask(taskId);
          refreshHistorySessions();
          pushToast({ level: "info", message: t("task.deleted") });
        }),
    },
  ];
}

export function buildSessionMenu(options: {
  t: TFunction;
  session: SessionSummary;
  onRenamedToTask?(taskId: TaskId): void;
}): MenuEntry[] {
  const { t, session } = options;
  const pinned = session.pinned || isItemPinned(session.id);
  return [
    {
      id: "pin",
      label: t(pinned ? "task.unpin" : "task.pin"),
      icon: <Pin />,
      onSelect: () => {
        toggleItemPinned(session.id);
      },
    },
    {
      id: "rename",
      label: t("task.rename"),
      icon: <Pencil />,
      shortcut: "F2",
      onSelect: () =>
        void attempt(t, async () => {
          const task = await window.studio.resumeSession(session.id);
          upsertTask(task);
          refreshHistorySessions();
          options.onRenamedToTask?.(task.id);
        }),
    },
    {
      id: "smartRename",
      label: t("task.smartRename"),
      icon: <SparkleMenuIcon />,
      onSelect: () =>
        void attempt(t, async () => {
          const task = await window.studio.resumeSession(session.id);
          upsertTask(task);
          const title = await window.studio.smartRenameTask(task.id);
          refreshHistorySessions();
          pushToast({ level: "info", message: t("task.smartRenamed", { title }) });
        }),
    },
    {
      id: "copyId",
      label: t("task.copyId"),
      icon: <CopyIcon />,
      onSelect: () =>
        void attempt(t, async () => {
          await navigator.clipboard.writeText(session.id);
          pushToast({ level: "info", message: t("task.copiedId", { id: session.id.slice(0, 8) }) });
        }),
    },
    {
      id: "copyRef",
      label: t("task.copyRef"),
      icon: <CopyIcon />,
      onSelect: () =>
        void attempt(t, async () => {
          await navigator.clipboard.writeText(`#${session.id}`);
          pushToast({ level: "info", message: t("task.copiedRef", { id: session.id.slice(0, 8) }) });
        }),
    },
    { kind: "separator", id: "sep-delete-session" },
    {
      id: "deleteSession",
      label: t("task.delete"),
      icon: <Trash />,
      tone: "danger",
      shortcut: "Del",
      onSelect: () =>
        void attempt(t, async () => {
          removeHistorySessionOptimistic(session.id);
          await window.studio.deleteSession(session.id);
          refreshHistorySessions();
          pushToast({ level: "info", message: t("task.deleted") });
        }),
    },
  ];
}
