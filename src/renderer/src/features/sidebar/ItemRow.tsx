// 列表里的一行（spec §4.2、§4.5）：studio 任务用 TaskRow，还没挂在任务上的历史会话用 SessionRow（点开 = 恢复成任务）。两种行同高（--row-task）、同一套行样式。
import { memo } from "react";
import type { SessionSummary, TaskId } from "../../../../shared/ipc.ts";
import { Dots, Pin } from "../../icons.tsx";
import { sessionTitle, type SidebarItem } from "../../../../shared/ui/sidebar-model.ts";
import { formatTaskTime } from "../../../../shared/ui/task-time.ts";
import { selectTask, upsertTask } from "../../store/index.ts";
import { IconButton } from "../../ui/controls.tsx";
import { reportError } from "../../ui/errors.ts";
import { SessionStatusDot } from "./StatusDot.tsx";
import { useCoarseClock } from "./task-time.ts";
import { TaskRow, type RowHandlers } from "./TaskRow.tsx";
import { refreshHistorySessions, removeHistorySessionOptimistic } from "./use-history-sessions.ts";

interface SessionRowProps {
  session: SessionSummary;
  tabStop: boolean;
  pinned?: boolean | undefined;
  projectLabel?: string | undefined;
  rows: RowHandlers;
}

const SessionRow = memo(function SessionRow({ session, tabStop, pinned, projectLabel, rows }: SessionRowProps) {
  const { t, locale } = rows;
  const label = sessionTitle(session) ?? t("history.untitled");
  const navId = `session:${session.id}`;
  const time = useCoarseClock((now) => formatTaskTime(t, locale, session.modifiedAt, now));
  return (
    <div
      className="sb-row"
      data-flip-key={session.id}
      data-menu={rows.onOpenSessionMenu ? "" : undefined}
      data-pinned={pinned || undefined}
      data-testid="sidebar-session"
      onContextMenu={(event) => {
        if (!rows.onOpenSessionMenu) return;
        event.preventDefault();
        rows.onOpenSessionMenu(
          session,
          event.clientX,
          event.clientY,
          event.currentTarget.querySelector<HTMLElement>(".sb-row-main") ?? event.currentTarget,
        );
      }}
    >
      <button
        type="button"
        className="sb-row-main"
        data-nav={navId}
        tabIndex={tabStop ? 0 : -1}
        title={`${label}\n${session.cwd}`}
        onFocus={() => rows.onFocusItem(navId)}
        onClick={() =>
          void window.studio
            .resumeSession(session.id)
            .then((task) => {
              upsertTask(task);
              return selectTask(task.id);
            })
            .catch((error: unknown) => reportError(t, error, (message) => t("history.resumeFailed", { message })))
        }
        onKeyDown={(event) => {
          if (event.key === "F2") {
            event.preventDefault();
            void window.studio
              .resumeSession(session.id)
              .then((task) => {
                upsertTask(task);
                refreshHistorySessions();
                rows.onStartRename(task);
              })
              .catch((error: unknown) => reportError(t, error));
          } else if (event.key === "Delete") {
            event.preventDefault();
            removeHistorySessionOptimistic(session.id);
            void window.studio
              .deleteSession(session.id)
              .then(() => refreshHistorySessions())
              .catch((error: unknown) => reportError(t, error));
          }
        }}
      >
        <SessionStatusDot session={session} t={t} />
        <span className="sb-row-title">{label}</span>
        {pinned && (
          <span className="sb-row-pin" title={t("task.unpin")} aria-hidden="true">
            <Pin size={11} />
          </span>
        )}
        {projectLabel !== undefined && projectLabel !== "" && (
          <span className="sb-row-project" title={projectLabel}>
            {projectLabel}
          </span>
        )}
        <span className="sb-row-tail">{time}</span>
      </button>
      {rows.onOpenSessionMenu && (
        <IconButton
          className="sb-row-more"
          label={t("task.more")}
          tabIndex={-1}
          aria-haspopup="menu"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const mainBtn =
              event.currentTarget.parentElement?.querySelector<HTMLElement>(".sb-row-main") ?? event.currentTarget;
            rows.onOpenSessionMenu!(session, box.left, box.bottom + 4, mainBtn);
          }}
        >
          <Dots />
        </IconButton>
      )}
    </div>
  );
});

interface ItemRowProps {
  item: SidebarItem;
  selectedTaskId: TaskId | null;
  tabStopId: string;
  renamingId: TaskId | null;
  unreadTaskIds?: ReadonlySet<string> | undefined;
  showProjectLabel?: boolean | undefined;
  rows: RowHandlers;
}

export function ItemRow({
  item,
  selectedTaskId,
  tabStopId,
  renamingId,
  unreadTaskIds,
  showProjectLabel,
  rows,
}: ItemRowProps) {
  if (item.kind === "session")
    return (
      <SessionRow
        session={item.session}
        tabStop={tabStopId === item.key}
        pinned={item.pinned}
        projectLabel={showProjectLabel ? item.projectLabel : undefined}
        rows={rows}
      />
    );
  return (
    <TaskRow
      task={item.task}
      selected={item.task.id === selectedTaskId}
      tabStop={tabStopId === item.key}
      renaming={renamingId === item.task.id}
      pinned={item.pinned}
      unread={unreadTaskIds?.has(item.task.id)}
      projectLabel={showProjectLabel ? item.projectLabel : undefined}
      rows={rows}
    />
  );
}
