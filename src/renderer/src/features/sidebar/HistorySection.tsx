// 侧栏的"会话"列表（spec §4.2–§4.5）：studio 任务和 omp 里还没挂在任务上的会话合在这一个列表里。
// 两种排列，标题右边切换，选择记在外壳状态里（historyOrder）：
// - 按文件夹：studio 项目和会话的 cwd 合并成文件夹，文件夹里任务和会话按最近活动混排；
// - 按时间：任务和会话平铺一列，按最近活动从新到旧。
// 搜索时只列匹配的行，按文件夹时有匹配的文件夹全部展开。点会话行 = 恢复成任务。
import type { TaskId } from "../../../../shared/ipc.ts";
import type { SidebarFolder, SidebarItem } from "../../../../shared/ui/sidebar-model.ts";
import { setHistoryOrder, useShellValue } from "../../app/shell-store.ts";
import { ChevronDown } from "../../icons.tsx";
import { IconButton, Segmented } from "../../ui/controls.tsx";
import { FolderGroup } from "./FolderGroup.tsx";
import { ItemRow } from "./ItemRow.tsx";
import { initialPerFolder, moreNavId, showMoreStep, timeLimitKey, visibleItems, initialByTime } from "./list-view.ts";
import { RunningFourDots } from "./StatusDot.tsx";
import type { RowHandlers } from "./TaskRow.tsx";

interface HistorySectionProps {
  folders: readonly SidebarFolder[];
  timeline: readonly SidebarItem[];
  searching: boolean;
  activeOnly: boolean;
  activeCount: number;
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

export function HistorySection(props: HistorySectionProps) {
  const { rows, searching, activeOnly } = props;
  const { t, locale } = rows;
  const order = useShellValue("historyOrder");
  const empty = order === "time" ? props.timeline.length === 0 : props.folders.length === 0;
  if (empty && !activeOnly) return null;

  const unlimited = searching || activeOnly;
  const timeLimit = unlimited ? Infinity : (props.limits[timeLimitKey] ?? initialByTime);
  const time = visibleItems(props.timeline, timeLimit, props.selectedTaskId);
  const timeMoreId = moreNavId(timeLimitKey);
  const anyOpen = props.folders.some((folder) => props.isOpen(folder));
  const canToggleAll = order === "folder" && !unlimited && props.folders.length > 1 && props.onSetAllOpen !== undefined;

  return (
    <section className="sb-group sb-history" aria-label={t("sidebar.searchHistory")} data-testid="sidebar-history">
      <div className="sb-history-head">
        <div className="sb-history-top">
          <p className="sb-group-title">{t("sidebar.searchHistory")}</p>
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
        props.folders.map((folder) => (
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
        ))
      )}
    </section>
  );
}
