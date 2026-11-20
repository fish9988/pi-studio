// Sidebar 的顶层标题在 Sidebar.tsx；这里渲染「项目 / 会话」分区与排列切换。
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { HistoryOrder, TaskId } from "../../../../shared/ipc.ts";
import type { SidebarFolder } from "../../../../shared/ui/sidebar-model.ts";
import { setHistoryOrder } from "../../app/shell-store.ts";
import { Plus } from "../../icons.tsx";
import { IconButton, Segmented } from "../../ui/controls.tsx";
import { useFlip } from "../../ui/flip.ts";
import { Reveal } from "../../ui/Reveal.tsx";
import { ChevronIcon } from "./icons.tsx";
import { FolderGroup } from "./FolderGroup.tsx";
import { ItemRow } from "./ItemRow.tsx";
import { initialPerFolder, moreNavId, showMoreStep, type visibleItems } from "./list-view.ts";
import type { RowHandlers } from "./TaskRow.tsx";

interface HistorySectionProps {
  order: HistoryOrder;
  /** 现代工作台：不渲染排列切换行（工具行里已有图标按钮），文件夹头直接钉在滚动区顶部。 */
  zcode: boolean;
  folders: readonly SidebarFolder[];
  flatItems: ReturnType<typeof visibleItems>;
  flatKey: string;
  conversationCount: number;
  unlimited: boolean;
  activeOnly: boolean;
  projectsOpen: boolean;
  conversationsOpen: boolean;
  onToggleSection(section: "projects" | "conversations"): void;
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
  onShowMore(key: string): void;
  onNewTask(folder: SidebarFolder): void;
  /** 分区头右侧的「添加项目文件夹」。 */
  onAddProject(): void;
  /** 分区头右侧的「新建对话」（默认目录里的草稿）。 */
  onCreateConversation(): void;
  onOpenProjectMenu(folder: SidebarFolder, x: number, y: number, trigger: HTMLElement): void;
  onCommitFolderRename?(folder: SidebarFolder, nextName: string | null): void;
}

/** 「项目」/「会话」分区的区块头：一行折叠开关（箭头 + 名称 + 数量），右侧动作悬停时浮现。 */
function FolderSection({
  label,
  count,
  sectionId,
  testId,
  open,
  onToggle,
  actions,
  children,
}: {
  label: string;
  count: number;
  sectionId: string;
  testId: string;
  open: boolean;
  onToggle(): void;
  actions?: ReactNode;
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
        {actions !== undefined && <div className="sb-section-actions">{actions}</div>}
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
  const { rows, order, unlimited, activeOnly, folders, projectsOpen, conversationsOpen, zcode } = props;
  const { t } = rows;
  // 文件夹头吸顶时钉在排列切换行下面：保留实际的亚像素高度，避免缩放时两行压住彼此。
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
  // 一个文件夹都没有时整块不渲染；但切成「时间」后若还有文件夹，头部得留着，否则空列表一片死白，再也切不回去
  const nothingAtAll = empty && !activeOnly && folders.length === 0;
  if (nothingAtAll) return null;

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
      style={
        { "--sb-sticky-top": zcode ? "0px" : `${Math.max(0, Math.floor(headHeight))}px` } as Record<string, string>
      }
    >
      {!zcode && (
        <div className="sb-history-head" ref={setHead}>
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
      )}
      {empty && activeOnly ? (
        <p className="sb-note" role="status">
          {t("sidebar.activeEmpty")}
        </p>
      ) : order === "time" ? (
        empty ? (
          <p className="sb-note" role="status">
            {t("sidebar.empty")}
          </p>
        ) : (
          <FlatRows {...props} />
        )
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
              actions={
                <IconButton
                  tabIndex={-1}
                  testId="sidebar-add-project"
                  label={t("sidebar.addProject")}
                  onClick={props.onAddProject}
                >
                  <Plus />
                </IconButton>
              }
            >
              {folders.map(renderFolder)}
            </FolderSection>
          )}
          {props.conversationCount > 0 && (
            <FolderSection
              label={t("sidebar.sectionConversations")}
              count={props.conversationCount}
              sectionId="conversations"
              testId="sidebar-section-conversations"
              open={conversationsOpen}
              onToggle={() => props.onToggleSection("conversations")}
              actions={
                <IconButton
                  tabIndex={-1}
                  testId="sidebar-new-conversation"
                  label={t("sidebar.newConversation")}
                  onClick={props.onCreateConversation}
                >
                  <Plus />
                </IconButton>
              }
            >
              <FlatRows {...props} />
            </FolderSection>
          )}
        </>
      )}
    </section>
  );
}
