// 文件夹分组（spec §4.3）：头部 [名称][箭头] + 任务和历史会话混排的行。头部右侧常驻 +（在这个文件夹新建任务，纯历史文件夹会先把它加成项目）；
// + 左边同一个位置：折叠时是行数（组内有等待任务再加一个琥珀菱形），展开时换成 ⋯ 项目菜单（只有 studio 项目才有），两者交叉淡入淡出。
import { useRef } from "react";
import type { Project, TaskId } from "../../../../shared/ipc.ts";
import type { SidebarFolder } from "../../../../shared/ui/sidebar-model.ts";
import { Dots, Plus } from "../../icons.tsx";
import { IconButton } from "../../ui/controls.tsx";
import { Reveal } from "../../ui/Reveal.tsx";
import { useFlip } from "../../ui/flip.ts";
import { ChevronIcon } from "./icons.tsx";
import { ItemRow } from "./ItemRow.tsx";
import { folderNavId, moreNavId, showMoreStep, visibleItems } from "./list-view.ts";
import type { RowHandlers } from "./TaskRow.tsx";

interface FolderGroupProps {
  folder: SidebarFolder;
  open: boolean;
  /** 展开时先显示的行数上限（"显示更多"每次 +20）。 */
  limit: number;
  selectedTaskId: TaskId | null;
  tabStopId: string;
  renamingId: TaskId | null;
  unreadTaskIds?: ReadonlySet<string> | undefined;
  rows: RowHandlers;
  onToggle(folder: SidebarFolder, open: boolean): void;
  onShowMore(folder: SidebarFolder): void;
  onNewTask(folder: SidebarFolder): void;
  onOpenProjectMenu(project: Project, x: number, y: number, trigger: HTMLElement): void;
}

export function FolderGroup(props: FolderGroupProps) {
  const { folder, open, rows } = props;
  const { t } = rows;
  const { project } = folder;
  const navId = folderNavId(folder);
  const hasWaiting = folder.items.some((item) => item.kind === "task" && item.task.status === "needs_you");
  const hasRunning = folder.items.some(
    (item) => item.kind === "task" && (item.task.status === "running" || item.task.status === "starting"),
  );
  const hasUnread = folder.items.some(
    (item) => item.kind === "task" && (props.unreadTaskIds?.has(item.task.id) ?? false),
  );
  const { shown, remaining } = visibleItems(folder.items, props.limit, props.selectedTaskId);
  const moreId = moreNavId(folder.key);
  const body = useRef<HTMLDivElement>(null);
  useFlip(body);

  return (
    <section className="sb-folder" aria-label={folder.label} data-testid="sidebar-folder">
      <div
        className="sb-group-head"
        onContextMenu={(event) => {
          if (project === null) return;
          event.preventDefault();
          props.onOpenProjectMenu(
            project,
            event.clientX,
            event.clientY,
            event.currentTarget.querySelector<HTMLElement>(".sb-group-toggle") ?? event.currentTarget,
          );
        }}
      >
        <button
          type="button"
          className="sb-group-toggle"
          data-nav={navId}
          data-collapsed={!open}
          tabIndex={props.tabStopId === navId ? 0 : -1}
          aria-expanded={open}
          aria-label={t("sidebar.toggleProject", { project: folder.label })}
          title={folder.cwd}
          onFocus={() => rows.onFocusItem(navId)}
          onClick={() => props.onToggle(folder, !open)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" && open) {
              event.preventDefault();
              props.onToggle(folder, false);
            } else if (event.key === "ArrowRight" && !open) {
              event.preventDefault();
              props.onToggle(folder, true);
            }
          }}
        >
          <span className="sb-folder-icon" aria-hidden="true">
            {open ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M1.75 4.25A1.5 1.5 0 0 1 3.25 2.75h2.9a1.25 1.25 0 0 1 1 .5l.9 1.2h4.7a1.5 1.5 0 0 1 1.5 1.5v1.3" />
                <path d="M2.2 13.25h10.55a1.4 1.4 0 0 0 1.35-1.05l1.15-4.45H3.7L2.2 13.25Z" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2 4.25A1.5 1.5 0 0 1 3.5 2.75h2.85a1.25 1.25 0 0 1 1 .5l.9 1.2h4.25A1.5 1.5 0 0 1 14 5.95v5.8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.75v-7.5Z" />
              </svg>
            )}
          </span>
          <span className="sb-group-name">{folder.label}</span>
          <span className="sb-chevron">
            <ChevronIcon />
          </span>
          <span className="sb-group-count" data-shown={!open || undefined}>
            {hasWaiting && <span className="sb-waiting-diamond" role="img" aria-label={t("sidebar.waitingHere")} />}
            {!hasWaiting && hasRunning && (
              <span className="sb-running-dot" role="img" aria-label={t("sidebar.runningHere")} />
            )}
            {!hasWaiting && !hasRunning && hasUnread && (
              <span className="sb-unread-dot" role="img" aria-label={t("sidebar.unreadHere")} />
            )}
            {folder.items.length}
          </span>
        </button>
        <IconButton
          className="sb-group-action sb-group-new"
          testId="sidebar-project-new"
          tabIndex={-1}
          label={t("sidebar.newInProject")}
          onClick={() => props.onNewTask(folder)}
        >
          <Plus />
        </IconButton>
        {project !== null && (
          <IconButton
            className="sb-group-action sb-group-more"
            data-shown={open || undefined}
            tabIndex={-1}
            aria-hidden={!open || undefined}
            label={t("sidebar.projectMenu")}
            aria-haspopup="menu"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              props.onOpenProjectMenu(project, box.left, box.bottom + 4, event.currentTarget);
            }}
          >
            <Dots />
          </IconButton>
        )}
      </div>
      <Reveal open={open}>
        <div className="sb-group-body" ref={body}>
          {folder.items.length === 0 && <p className="sb-group-empty">{t("sidebar.empty")}</p>}
          {shown.map((item) => (
            <ItemRow
              key={item.key}
              item={item}
              selectedTaskId={props.selectedTaskId}
              tabStopId={props.tabStopId}
              renamingId={props.renamingId}
              unreadTaskIds={props.unreadTaskIds}
              rows={rows}
            />
          ))}
          {remaining > 0 && (
            <button
              type="button"
              className="sb-show-more"
              data-nav={moreId}
              data-testid="sidebar-history-more"
              tabIndex={props.tabStopId === moreId ? 0 : -1}
              onFocus={() => rows.onFocusItem(moreId)}
              onClick={() => props.onShowMore(folder)}
            >
              {t("sidebar.showMore", { n: Math.min(remaining, showMoreStep) })}
            </button>
          )}
        </div>
      </Reveal>
    </section>
  );
}
