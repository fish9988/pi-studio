// 侧栏的「任务列表」（spec §4.2–§4.5）：studio 任务和 omp 里还没挂在任务上的会话合在这一个列表里。
// 两种排列，标题行里切换，选择记在外壳状态里（historyOrder）：
// - 按文件夹：真正绑定了项目目录的文件夹归入「项目」区，默认文件夹（通用对话）和其它纯历史目录归入「任务」区；
//   两个区各自可折叠，文件夹头吸顶钉在标题行下面，滚长列表时不会丢掉"现在在哪个项目里"；
// - 按时间：任务和会话平铺一列，按最近活动从新到旧。
// 搜索时只列匹配的行，按文件夹时有匹配的文件夹全部展开。点会话行 = 恢复成任务。
import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import type { TaskId } from "../../../../shared/ipc.ts";
import type { SidebarFolder, SidebarItem } from "../../../../shared/ui/sidebar-model.ts";
import { setHistoryOrder, useShellValue } from "../../app/shell-store.ts";
import { ChevronDown } from "../../icons.tsx";
import { IconButton, Segmented } from "../../ui/controls.tsx";
import { Reveal } from "../../ui/Reveal.tsx";
import { isDefaultFolder } from "../empty/default-folder.ts";
import { ChevronIcon } from "./icons.tsx";
import { FolderGroup } from "./FolderGroup.tsx";
import { ItemRow } from "./ItemRow.tsx";
import { initialByTime, initialPerFolder, moreNavId, showMoreStep, timeLimitKey, visibleItems } from "./list-view.ts";
import { RunningFourDots } from "./StatusDot.tsx";
import type { RowHandlers } from "./TaskRow.tsx";

interface HistorySectionProps {
  folders: readonly SidebarFolder[];
  timeline: readonly SidebarItem[];
  searching: boolean;
  activeOnly: boolean;
  activeCount: number;
  /** 默认文件夹（AppInfo.chatsDir）：它里面的通用对话归「任务」区，不算项目。 */
  chatsDir: string | null;
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
        <div className="sb-section-body">{children}</div>
      </Reveal>
    </div>
  );
}

export function HistorySection(props: HistorySectionProps) {
  const { rows, searching, activeOnly, chatsDir } = props;
  const { t, locale } = rows;
  const order = useShellValue("historyOrder");
  // 文件夹头吸顶时钉在标题行下面：量出标题行的实际高度写进 --sb-sticky-top（换语言、出现「进行中」计数都会变高）。
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const [headHeight, setHeadHeight] = useState(0);
  useLayoutEffect(() => {
    if (head === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeadHeight(Math.round(head.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(head);
    return () => observer.disconnect();
  }, [head]);
  const [openSections, setOpenSections] = useState({ projects: true, tasks: true });
  // 真实绑定项目目录的文件夹进「项目」；默认文件夹里的通用对话和只在历史里出现的目录进「任务」。
  const groups = useMemo(() => {
    const projects: SidebarFolder[] = [];
    const tasks: SidebarFolder[] = [];
    for (const folder of props.folders) {
      const isProject = folder.project !== null && !isDefaultFolder(folder.cwd, chatsDir);
      (isProject ? projects : tasks).push(folder);
    }
    return { projects, tasks };
  }, [props.folders, chatsDir]);

  const empty = order === "time" ? props.timeline.length === 0 : props.folders.length === 0;
  if (empty && !activeOnly) return null;

  const unlimited = searching || activeOnly;
  const timeLimit = unlimited ? Infinity : (props.limits[timeLimitKey] ?? initialByTime);
  const time = visibleItems(props.timeline, timeLimit, props.selectedTaskId);
  const timeMoreId = moreNavId(timeLimitKey);
  const anyOpen = props.folders.some((folder) => props.isOpen(folder));
  const canToggleAll = order === "folder" && !unlimited && props.folders.length > 1 && props.onSetAllOpen !== undefined;

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
        <>
          {time.shown.map((item) => (
            <ItemRow
              key={item.key}
              item={item}
              selectedTaskId={props.selectedTaskId}
              tabStopId={props.tabStopId}
              renamingId={props.renamingId}
              unreadTaskIds={props.unreadTaskIds}
              showProjectLabel
              rows={rows}
            />
          ))}
          {time.remaining > 0 && (
            <button
              type="button"
              className="sb-show-more sb-show-more-flat"
              data-nav={timeMoreId}
              data-testid="sidebar-history-more"
              tabIndex={props.tabStopId === timeMoreId ? 0 : -1}
              onFocus={() => rows.onFocusItem(timeMoreId)}
              onClick={() => props.onShowMore(timeLimitKey)}
            >
              {t("sidebar.showMore", { n: Math.min(time.remaining, showMoreStep) })}
            </button>
          )}
        </>
      ) : (
        <>
          {groups.projects.length > 0 && (
            <FolderSection
              label={t("sidebar.sectionProjects")}
              count={groups.projects.length}
              sectionId="projects"
              testId="sidebar-section-projects"
              open={openSections.projects}
              onToggle={() => setOpenSections((current) => ({ ...current, projects: !current.projects }))}
            >
              {groups.projects.map(renderFolder)}
            </FolderSection>
          )}
          {groups.tasks.length > 0 && (
            <FolderSection
              label={t("sidebar.sectionTasks")}
              count={groups.tasks.length}
              sectionId="tasks"
              testId="sidebar-section-tasks"
              open={openSections.tasks}
              onToggle={() => setOpenSections((current) => ({ ...current, tasks: !current.tasks }))}
            >
              {groups.tasks.map(renderFolder)}
            </FolderSection>
          )}
        </>
      )}
    </section>
  );
}
