// 文件夹分组（DSH × Antigravity 低噪点规范）：
// - 头部平时右侧仅弱化显示会话数量（透明度 0.4），隐藏常驻的 `+` 与 `⋯`；
// - 鼠标悬停（Hover）、键盘聚焦或打开菜单时，会话数量淡出，平滑浮现 `⋯`（更多菜单）与 `+`（在此目录新建任务）；
// - 支持右键菜单触发文件夹显示名称就地重命名。
import { useRef } from "react";
import { limits, type TaskId } from "../../../../shared/ipc.ts";
import type { SidebarFolder } from "../../../../shared/ui/sidebar-model.ts";
import { Dots, Plus } from "../../icons.tsx";
import { IconButton } from "../../ui/controls.tsx";
import { Reveal } from "../../ui/Reveal.tsx";
import { useFlip } from "../../ui/flip.ts";
import { ChevronIcon } from "./icons.tsx";
import { ItemRow } from "./ItemRow.tsx";
import { folderNavId, moreNavId, showMoreStep, visibleItems } from "./list-view.ts";
import { RunningFourDots } from "./StatusDot.tsx";
import type { RowHandlers } from "./TaskRow.tsx";

interface FolderGroupProps {
  folder: SidebarFolder;
  open: boolean;
  /** 展开时先显示的行数上限（"显示更多"每次 +20）。 */
  limit: number;
  selectedTaskId: TaskId | null;
  tabStopId: string;
  renamingId: TaskId | null;
  renamingFolder?: boolean | undefined;
  unreadTaskIds?: ReadonlySet<string> | undefined;
  rows: RowHandlers;
  onToggle(folder: SidebarFolder, open: boolean): void;
  onShowMore(folder: SidebarFolder): void;
  onNewTask(folder: SidebarFolder): void;
  onOpenProjectMenu(folder: SidebarFolder, x: number, y: number, trigger: HTMLElement): void;
  onCommitFolderRename?: ((folder: SidebarFolder, nextName: string | null) => void) | undefined;
}

function FolderRenameInput({ folder, onDone }: { folder: SidebarFolder; onDone(value: string | null): void }) {
  const settled = useRef(false);
  const finish = (value: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(value);
  };
  return (
    <div className="sb-group-head sb-group-editing">
      <span className="sb-group-toggle">
        <span className="sb-folder-icon" aria-hidden="true">
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
        </span>
        <input
          className="sb-rename"
          aria-label={folder.label}
          defaultValue={folder.label}
          maxLength={limits.titleMaxChars}
          spellCheck={false}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              finish(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finish(null);
            }
          }}
          onBlur={(event) => finish(event.currentTarget.value)}
        />
      </span>
    </div>
  );
}

export function FolderGroup(props: FolderGroupProps) {
  const { folder, open, rows } = props;
  const { t } = rows;
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
      {props.renamingFolder ? (
        <FolderRenameInput folder={folder} onDone={(value) => props.onCommitFolderRename?.(folder, value)} />
      ) : (
        <div
          className="sb-group-head"
          onContextMenu={(event) => {
            event.preventDefault();
            props.onOpenProjectMenu(
              folder,
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
            <span className="sb-group-count" data-shown={folder.items.length > 0 || undefined}>
              {hasWaiting && <span className="sb-waiting-diamond" role="img" aria-label={t("sidebar.waitingHere")} />}
              {!hasWaiting && hasRunning && <RunningFourDots size="sm" active label={t("sidebar.runningHere")} />}
              {!hasWaiting && !hasRunning && hasUnread && (
                <span className="sb-unread-dot" role="img" aria-label={t("sidebar.unreadHere")} />
              )}
              {folder.items.length}
            </span>
          </button>
          <IconButton
            className="sb-group-action sb-group-more"
            tabIndex={-1}
            label={t("sidebar.projectMenu")}
            aria-haspopup="menu"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              props.onOpenProjectMenu(folder, box.left, box.bottom + 4, event.currentTarget);
            }}
          >
            <Dots />
          </IconButton>
          <IconButton
            className="sb-group-action sb-group-new"
            testId="sidebar-project-new"
            tabIndex={-1}
            label={t("sidebar.newInProject")}
            onClick={() => props.onNewTask(folder)}
          >
            <Plus />
          </IconButton>
        </div>
      )}
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
