// 侧栏的「任务列表」（spec §4.2–§4.5）：studio 任务和 omp 里还没挂在任务上的会话合在这一个列表里。
// 文件夹视图下，只有已绑定的非默认项目有目录头；通用对话和未归属项目的历史会话在「任务」里平铺。
// 时间视图下，所有任务和会话平铺一列。搜索和筛选临时展开匹配结果，不改变用户的折叠设置。
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { HistoryOrder, TaskId } from "../../../../shared/ipc.ts";
import type { SidebarFolder } from "../../../../shared/ui/sidebar-model.ts";
import { setHistoryOrder } from "../../app/shell-store.ts";
import { ChevronDown } from "../../icons.tsx";
import { IconButton, Segmented } from "../../ui/controls.tsx";
import { useFlip } from "../../ui/flip.ts";
import { Reveal } from "../../ui/Reveal.tsx";
import { ChevronIcon } from "./icons.tsx";
import { FolderGroup } from "./FolderGroup.tsx";
import { ItemRow } from "./ItemRow.tsx";
import { initialPerFolder, moreNavId, showMoreStep, type visibleItems } from "./list-view.ts";
import { RunningFourDots } from "./StatusDot.tsx";
import type { RowHandlers } from "./TaskRow.tsx";

interface HistorySectionProps {
  order: HistoryOrder;
  folders: readonly SidebarFolder[];
  flatItems: ReturnType<typeof visibleItems>;
  flatKey: string;
  looseCount: number;
  unlimited: boolean;
  activeOnly: boolean;
  activeCount: number;
  projectsOpen: boolean;
  tasksOpen: boolean;
  onToggleSection(section: "projects" | "tasks"): void;
  isOpen(folder: SidebarFolder): boolean;
  /** 已展开的行数上限，键是文件夹 key 或 timeLimitKey。 */
  limits: Readonly<Record<string, number>>;
  selectedTaskId: TaskId | null;
  tabStopId: string;
  renamingId: TaskId | null;
  renamingFolderKey?: string | null | undefined;
  unreadTaskIds?: ReadonlySet<string> | undefined;
  rows: RowHandlers;
  onToggle(folder: SidebarFolder, open: boolean): void;
  onSetAllOpen?(open: boolean): void;
  onToggleActiveOnly?(next: boolean): void;
  onShowMore(key: string): void;
  onNewTask(folder: SidebarFolder): void;
  onOpenProjectMenu(folder: SidebarFolder, x: number, y: number, trigger: HTMLElement): void;
  onCommitFolderRename?(folder: SidebarFolder, nextName: string | null): void;
}

/** 「项目」/「任务」两个分区的区块头：一行折叠开关（箭头 + 名称 + 数量）。 */
function FolderSection({
  label,
  count,
  sectionId,
  testId,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  sectionId: string;
  testId: string;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <div className="sb-section" data-section={sectionId}>
      <div className="sb-section-head">
        <button
          type="button"
          className="sb-section-toggle"
          data-testid={testId}
          data-collapsed={!open}
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="sb-section-chevron" aria-hidden="true">
            <ChevronIcon />
          </span>
          <span className="sb-section-name">{label}</span>
          <span className="sb-section-count">{count}</span>
        </button>
      </div>
      <Reveal open={open}>
        <div className="sb-section-body" inert={!open}>
          {children}
        </div>
      </Reveal>
    </div>
  );
}

function FlatRows({
  flatItems,
  flatKey,
  order,
  selectedTaskId,
  tabStopId,
  renamingId,
  unreadTaskIds,
  rows,
  onShowMore,
}: HistorySectionProps) {
  const body = useRef<HTMLDivElement>(null);
  useFlip(body);
  const moreId = moreNavId(flatKey);
  return (
    <div ref={body}>
      {flatItems.shown.map((item) => (
        <ItemRow
          key={item.key}
          item={item}
          selectedTaskId={selectedTaskId}
          tabStopId={tabStopId}
          renamingId={renamingId}
          unreadTaskIds={unreadTaskIds}
          showProjectLabel={order === "time"}
          rows={rows}
        />
      ))}
      {flatItems.remaining > 0 && (
        <button
          type="button"
          className="sb-show-more sb-show-more-flat"
          data-nav={moreId}
          data-testid="sidebar-history-more"
          tabIndex={tabStopId === moreId ? 0 : -1}
          onFocus={() => rows.onFocusItem(moreId)}
          onClick={() => onShowMore(flatKey)}
        >
          {rows.t("sidebar.showMore", { n: Math.min(flatItems.remaining, showMoreStep) })}
        </button>
      )}
    </div>
  );
}

export function HistorySection(props: HistorySectionProps) {
  const { rows, order, unlimited, activeOnly, folders, projectsOpen, tasksOpen } = props;
  const { t, locale } = rows;
  // 文件夹头吸顶时钉在标题行下面：保留实际的亚像素高度，避免缩放时两行压住彼此。
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const [headHeight, setHeadHeight] = useState(0);
  useLayoutEffect(() => {
    if (head === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeadHeight(head.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(head);
    return () => observer.disconnect();
  }, [head]);
  const empty = props.flatItems.shown.length === 0 && (order === "time" || folders.length === 0);
  if (empty && !activeOnly) return null;

  const anyOpen = projectsOpen && folders.some(props.isOpen);
  const canToggleAll = order === "folder" && !unlimited && folders.length > 1 && props.onSetAllOpen !== undefined;

  const renderFolder = (folder: SidebarFolder) => (
    <FolderGroup
      key={folder.key}
      folder={folder}
      open={props.isOpen(folder)}
      limit={unlimited ? Infinity : (props.limits[folder.key] ?? initialPerFolder)}
      selectedTaskId={props.selectedTaskId}
      tabStopId={props.tabStopId}
      renamingId={props.renamingId}
      renamingFolder={props.renamingFolderKey === folder.key}
      unreadTaskIds={props.unreadTaskIds}
      rows={rows}
      onToggle={props.onToggle}
      onShowMore={(target) => props.onShowMore(target.key)}
      onNewTask={props.onNewTask}
      onOpenProjectMenu={props.onOpenProjectMenu}
      onCommitFolderRename={props.onCommitFolderRename}
    />
  );

  return (
    <section
      className="sb-group sb-history"
      aria-label={t("sidebar.listTitle")}
      data-testid="sidebar-history"
      style={{ "--sb-sticky-top": `${headHeight}px` } as Record<string, string>}
    >
      <div className="sb-history-head" ref={setHead}>
        <div className="sb-history-top">
          <p className="sb-group-title">{t("sidebar.listTitle")}</p>
          <div className="sb-history-meta">
            <button
              type="button"
              className="sb-active-filter"
              data-active={activeOnly || undefined}
              data-has-active={props.activeCount > 0 || undefined}
              aria-pressed={activeOnly}
              data-testid="sidebar-filter-active"
              title={locale === "zh-CN" ? "仅显示进行中或待确认的活跃会话" : "Show active sessions only"}
              onClick={() => props.onToggleActiveOnly?.(!activeOnly)}
            >
              <RunningFourDots size="sm" active={props.activeCount > 0} />
              <span>{locale === "zh-CN" ? "进行中" : "Active"}</span>
              {props.activeCount > 0 && <span className="sb-active-filter-count">{props.activeCount}</span>}
            </button>
            {canToggleAll && (
              <IconButton
                className="sb-toggle-all"
                testId="sidebar-toggle-all-folders"
                label={t(anyOpen ? "sidebar.collapseAll" : "sidebar.expandAll")}
                data-collapsed={!anyOpen}
                onClick={() => props.onSetAllOpen?.(!anyOpen)}
              >
                <ChevronDown size={12} />
              </IconButton>
            )}
          </div>
        </div>
        <div className="sb-history-order-row">
          <Segmented
            size="sm"
            label={t("sidebar.historyOrder")}
            testId="sidebar-history-by"
            value={order}
            options={[
              { value: "folder", label: t("sidebar.historyByFolder") },
              { value: "time", label: t("sidebar.historyByTime") },
            ]}
            onChange={setHistoryOrder}
          />
        </div>
      </div>
      {empty && activeOnly ? (
        <p className="sb-note" role="status">
          {locale === "zh-CN" ? "暂无进行中的会话" : "No active sessions"}
        </p>
      ) : order === "time" ? (
        <FlatRows {...props} />
      ) : (
        <>
          {folders.length > 0 && (
            <FolderSection
              label={t("sidebar.sectionProjects")}
              count={folders.length}
              sectionId="projects"
              testId="sidebar-section-projects"
              open={projectsOpen}
              onToggle={() => props.onToggleSection("projects")}
            >
              {folders.map(renderFolder)}
            </FolderSection>
          )}
          {props.looseCount > 0 && (
            <FolderSection
              label={t("sidebar.sectionTasks")}
              count={props.looseCount}
              sectionId="tasks"
              testId="sidebar-section-tasks"
              open={tasksOpen}
              onToggle={() => props.onToggleSection("tasks")}
            >
              <FlatRows {...props} />
            </FolderSection>
          )}
        </>
      )}
    </section>
  );
}
