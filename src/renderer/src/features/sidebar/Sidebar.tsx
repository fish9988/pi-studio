// 侧栏（spec §3.2、第 4 章）：顶部「任务列表」标题行 + 搜索、主动作导航（新任务 / 打开文件夹 / 扩展）、等待状态、
// 项目目录与默认 chatsDir 中的对话分开显示，底部是设置和新版本入口。
// 从顶栏下面开始，不画标题栏；底色 --bg-sidebar 与顶栏连成一片。宽度由外层容器给。
import { reportError } from "../../ui/errors.ts";
import { publishVisibleTaskIds } from "./visible-order-store.ts";
import { onStudioCommand } from "../palette/studio-command.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectId, TaskId, TaskState } from "../../../../shared/ipc.ts";
import { setHistoryOrder, useShellValue } from "../../app/shell-store.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import { shortcutLabel } from "../../app/platform-keys.ts";
import {
  selectTask,
  showView,
  useAppInfo,
  useAppInfoError,
  refreshAppInfo,
  useDownloadedVersion,
  useMainView,
  useSelectedTaskId,
  useTasksState,
} from "../../store/index.ts";
import { ChevronDown, Close, Puzzle } from "../../icons.tsx";
import { Button, IconButton, TextField } from "../../ui/controls.tsx";
import { OverlayScrollbar } from "../../ui/OverlayScrollbar.tsx";
import { Reveal } from "../../ui/Reveal.tsx";
import { useInstallUpdate } from "../settings/use-install-update.tsx";
import { archiveWithUndo, useHiddenTasks } from "./archive-store.ts";
import { FolderPlusIcon, GearIcon, PlusIcon, SearchIcon } from "./icons.tsx";
import { HistorySection } from "./HistorySection.tsx";
import { RunningFourDots } from "./StatusDot.tsx";
import {
  defaultOpen,
  folderNavId,
  initialByTime,
  initialPerFolder,
  looseLimitKey,
  moreNavId,
  showMoreStep,
  timeLimitKey,
  visibleItems,
} from "./list-view.ts";
import { refreshProjects, useProjectsState } from "./projects-store.ts";
import { addProjectAsDraft, startDraftInFolder } from "./sidebar-actions.ts";
import { startDraft } from "../empty/index.ts";
import { isDefaultFolder } from "../empty/default-folder.ts";
import {
  buildFolders,
  buildTimeline,
  nextWaitingTask,
  projectLabels,
  splitSidebarFolders,
  waitingTasks,
  type SidebarFolder,
} from "../../../../shared/ui/sidebar-model.ts";
import type { RowHandlers } from "./TaskRow.tsx";
import { useHistorySessions } from "./use-history-sessions.ts";
import { useSidebarMenus } from "./use-sidebar-menus.tsx";
import {
  folderAliasKey,
  setFolderAlias,
  useFolderAliases,
  useHiddenFolderKeys,
  usePinnedIds,
  useUnreadTaskIds,
} from "./sidebar-prefs-store.ts";
import "./sidebar.css";

/** 排列切换图标：中性排序字形（向下箭头 + 逐级缩短的行），不和项目文件夹图标撞脸。 */
function ViewGlyph() {
  return (
    <svg
      className="icon"
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
      <path d="M4.25 3.5v8.25M4.25 11.75 2.5 10M4.25 11.75 6 10" />
      <path d="M8.75 4.5h4.75M8.75 8h3.25M8.75 11.5H10" />
    </svg>
  );
}

function isActiveSidebarItem(item: SidebarFolder["items"][number]): boolean {
  return (
    item.kind === "task" &&
    (item.task.status === "running" || item.task.status === "starting" || item.task.status === "needs_you")
  );
}

export function Sidebar() {
  const t = useT();
  const locale = useLocale();
  const listRef = useRef<HTMLDivElement>(null);
  // 现代工作台风格：一级导航排在顶部，搜索框平时收起（工具行里只留一个图标按钮），排列切换也收到工具行里。
  const zcode = useShellValue("uiStyle") === "zcode";
  const view = useMainView();
  const selectedTaskId = useSelectedTaskId();
  const tasksState = useTasksState();
  const downloadedVersion = useDownloadedVersion();
  const installing = useInstallUpdate();
  const projectsState = useProjectsState();
  const hidden = useHiddenTasks();
  const appInfo = useAppInfo();
  const chatsDir = appInfo?.chatsDir ?? null;
  const appInfoError = useAppInfoError();
  const defaultLabel = t("empty.defaultFolder");
  const pinnedIds = usePinnedIds();
  const unreadTaskIds = useUnreadTaskIds();
  const hiddenFolderKeys = useHiddenFolderKeys();
  const folderAliases = useFolderAliases();
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [tabStop, setTabStop] = useState("");
  const [renamingId, setRenamingId] = useState<TaskState["id"] | null>(null);
  const [renamingFolderKey, setRenamingFolderKey] = useState<string | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [openSections, setOpenSections] = useState({ projects: true, conversations: true });
  // 斜杠命令 /rename（不带新名字）：当前任务的行进入就地改名；侧栏收起时 App 同时把它展开。
  useEffect(
    () =>
      onStudioCommand((command) => {
        if (command === "rename" && selectedTaskId !== null) setRenamingId(selectedTaskId);
      }),
    [selectedTaskId],
  );
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  // 收起状态的搜索框：点工具行图标、按 Ctrl F 或收到 studio:open-sidebar-search 时展开并聚焦。
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusSeq, setSearchFocusSeq] = useState(0);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const searchToggle = useRef<HTMLButtonElement | null>(null);
  const searchShown = searchOpen || query !== "";
  useEffect(() => {
    if (searchFocusSeq === 0) return;
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [searchFocusSeq]);
  useEffect(() => {
    const open = () => {
      setSearchOpen(true);
      setSearchFocusSeq((current) => current + 1);
    };
    window.addEventListener("studio:open-sidebar-search", open);
    return () => window.removeEventListener("studio:open-sidebar-search", open);
  }, []);
  // 命令面板 / 快捷键系统不用知道搜索框是不是收起着：这里先展开，App 的两帧后 querySelector 就能拿到输入框。
  useEffect(() => {
    if (!zcode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "f") return;
      setSearchOpen(true);
      setSearchFocusSeq((current) => current + 1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [zcode]);
  const toggleSearch = () => {
    if (searchOpen) {
      setSearchOpen(false);
      // 收起后把焦点还给工具行的搜索图标，键盘用户不会掉到文档开头。
      if (query === "") searchToggle.current?.focus();
      return;
    }
    setSearchOpen(true);
    setSearchFocusSeq((current) => current + 1);
  };
  // 任务列表变了（新建、恢复、第一轮结束后会话挂上任务）就重取历史会话，挂上任务的会话从历史里消失。
  const historyKey = useMemo(
    () => tasksState.list.map((task) => `${task.id}:${task.lastTurn === null ? 0 : 1}`).join(","),
    [tasksState.list],
  );

  useEffect(() => {
    void refreshProjects();
    // 拖入文件夹时主进程已经把它加入项目。
    return window.studio.onProjectDropped(() => void refreshProjects());
  }, []);
  // 恢复历史会话会让主进程自动加入新项目：任务指向列表里没有的项目时重新取一次。
  const unknownProject = useMemo(
    () =>
      projectsState.loaded &&
      tasksState.list.some((task) => !projectsState.list.some((project) => project.id === task.projectId)),
    [projectsState, tasksState.list],
  );
  useEffect(() => {
    if (unknownProject) void refreshProjects();
  }, [unknownProject]);

  const order = useShellValue("historyOrder");
  const sessions = useHistorySessions(searching, historyKey);
  const activeCount = useMemo(
    () =>
      tasksState.list.filter(
        (task) =>
          !hidden.has(task.id) &&
          (task.status === "running" || task.status === "starting" || task.status === "needs_you"),
      ).length,
    [tasksState.list, hidden],
  );
  // 按「项目 / 会话」分区：默认 chatsDir 内平铺为会话，其他工作目录（含只有历史记录的目录）按目录列在项目中。
  const folders = useMemo(() => {
    const built = buildFolders({
      projects: projectsState.list,
      tasks: tasksState.list,
      sessions,
      hidden,
      query,
      defaultCwd: chatsDir,
      pinnedIds,
    })
      .filter(
        (folder) =>
          searching ||
          folder.project !== null ||
          !hiddenFolderKeys.has(folder.key) ||
          folder.items.some((item) => item.kind === "task" && item.task.id === selectedTaskId),
      )
      .map((folder) => {
        const alias = folderAliases[folderAliasKey(folder.cwd)];
        if (alias !== undefined) return { ...folder, label: alias };
        return isDefaultFolder(folder.cwd, chatsDir) ? { ...folder, label: defaultLabel } : folder;
      });
    if (!activeOnly) return built;
    return built
      .map((folder) => ({ ...folder, items: folder.items.filter(isActiveSidebarItem) }))
      .filter((folder) => folder.items.length > 0);
  }, [
    projectsState.list,
    tasksState.list,
    sessions,
    hidden,
    query,
    chatsDir,
    defaultLabel,
    pinnedIds,
    searching,
    hiddenFolderKeys,
    selectedTaskId,
    folderAliases,
    activeOnly,
  ]);
  const grouping = useMemo(() => splitSidebarFolders(folders, chatsDir), [folders, chatsDir]);
  const projectFolders = grouping.projects;
  const conversations = grouping.conversations;
  const timeline = useMemo(() => {
    if (order !== "time") return [];
    const built = buildTimeline({
      projects: projectsState.list,
      tasks: tasksState.list,
      sessions,
      hidden,
      query,
      pinnedIds,
    }).map((item) => {
      const cwd = item.kind === "task" ? item.task.cwd : item.session.cwd;
      const alias = folderAliases[folderAliasKey(cwd)];
      return alias !== undefined ? { ...item, projectLabel: alias } : item;
    });
    return activeOnly ? built.filter(isActiveSidebarItem) : built;
  }, [order, projectsState.list, tasksState.list, sessions, hidden, query, pinnedIds, folderAliases, activeOnly]);
  const waiting = useMemo(() => waitingTasks(tasksState.list, hidden), [tasksState.list, hidden]);
  const labelOf = (projectId: ProjectId) => {
    const project = projectsState.list.find((candidate) => candidate.id === projectId);
    if (project === undefined) return "";
    const alias = folderAliases[folderAliasKey(project.path)];
    if (alias !== undefined) return alias;
    return isDefaultFolder(project.path, chatsDir)
      ? defaultLabel
      : (projectLabels(projectsState.list).get(projectId) ?? "");
  };

  // 搜索和进行中筛选临时展开匹配结果，不改用户的折叠设置。
  const unlimited = searching || activeOnly;
  const projectsOpen = unlimited || openSections.projects;
  const conversationsOpen = unlimited || openSections.conversations;
  const isOpen = useCallback(
    (folder: SidebarFolder) => unlimited || (openOverride[folder.key] ?? defaultOpen(folder, selectedTaskId)),
    [unlimited, openOverride, selectedTaskId],
  );
  // 因为选中 / 在跑 / 等你确认而展开的文件夹记成"展开"：任务跑完、换了选中项都不再自己收起，只有用户点了才折叠。
  const autoOpened = useMemo(
    () =>
      projectFolders
        .filter((folder) => openOverride[folder.key] === undefined && defaultOpen(folder, selectedTaskId))
        .map((folder) => folder.key)
        .join("\n"),
    [projectFolders, openOverride, selectedTaskId],
  );
  useEffect(() => {
    if (autoOpened === "") return;
    setOpenOverride((current) => {
      const next = { ...current };
      for (const key of autoOpened.split("\n")) next[key] ??= true;
      return next;
    });
  }, [autoOpened]);

  const { menu, openTaskMenu, openSessionMenu, openProjectMenu } = useSidebarMenus({
    t,
    locale,
    selectedTaskId,
    chatsDir,
    projectTaskIds: (project) => tasksState.list.filter((task) => task.projectId === project.id).map((task) => task.id),
    onRename: (taskId) => setRenamingId(taskId),
    onRenameFolder: (folderKey) => setRenamingFolderKey(folderKey),
  });

  // 行的回调：一份稳定的对象（只在语言变了时换新），回调里读最新的选中任务和菜单，任务行的 memo 才有用。
  const latest = useRef({ selectedTaskId, openTaskMenu, openSessionMenu });
  latest.current = { selectedTaskId, openTaskMenu, openSessionMenu };
  const rows = useMemo<RowHandlers>(
    () => ({
      t,
      locale,
      onSelect: (task, viaKeyboard) =>
        void selectTask(task.id)
          .then(() => {
            // 键盘 Enter 选中才进输入框；方向键浏览时焦点留在侧栏。
            if (viaKeyboard) document.querySelector<HTMLElement>("[data-composer-input]")?.focus();
          })
          .catch((error: unknown) => reportError(t, error)),
      onFocusItem: setTabStop,
      onOpenMenu: (task, x, y, trigger) => latest.current.openTaskMenu(task, x, y, trigger),
      onOpenSessionMenu: (session, x, y, trigger) => latest.current.openSessionMenu(session, x, y, trigger),
      onStartRename: (task) => setRenamingId(task.id),
      onCommitRename: (task, title) => {
        setRenamingId(null);
        const next = title?.trim() ?? "";
        if (next !== "" && next !== task.title)
          void window.studio.renameTask(task.id, next).catch((error: unknown) => reportError(t, error));
      },
      onArchive: (task) => archiveWithUndo(task.id, latest.current.selectedTaskId, t),
    }),
    [t, locale],
  );

  const flatKey = order === "time" ? timeLimitKey : looseLimitKey;
  const flatLimit = unlimited ? Infinity : (limits[flatKey] ?? (order === "time" ? initialByTime : initialPerFolder));
  const flatItems = useMemo(
    () => visibleItems(order === "time" ? timeline : conversations, flatLimit, selectedTaskId),
    [order, timeline, conversations, flatLimit, selectedTaskId],
  );
  // roving tabindex 和任务快捷跳转共用实际呈现的行序；收起的分区不参与导航。
  const navIds = useMemo(() => {
    const flatIds = [
      ...flatItems.shown.map((item) => item.key),
      ...(flatItems.remaining > 0 ? [moreNavId(flatKey)] : []),
    ];
    if (order === "time") return flatIds;
    const projectIds = projectsOpen
      ? projectFolders.flatMap((folder) => {
          if (!isOpen(folder)) return [folderNavId(folder)];
          const { shown, remaining } = visibleItems(
            folder.items,
            unlimited ? Infinity : (limits[folder.key] ?? initialPerFolder),
            selectedTaskId,
          );
          return [
            folderNavId(folder),
            ...shown.map((item) => item.key),
            ...(remaining > 0 ? [moreNavId(folder.key)] : []),
          ];
        })
      : [];
    return conversationsOpen ? [...projectIds, ...flatIds] : projectIds;
  }, [
    order,
    flatItems,
    flatKey,
    projectsOpen,
    projectFolders,
    isOpen,
    unlimited,
    limits,
    selectedTaskId,
    conversationsOpen,
  ]);
  const selectedNav = selectedTaskId === null ? "" : `task:${selectedTaskId}`;
  const tabStopId = navIds.includes(tabStop) ? tabStop : navIds.includes(selectedNav) ? selectedNav : (navIds[0] ?? "");
  const visibleTaskKey = useMemo(
    () =>
      navIds
        .filter((id) => id.startsWith("task:"))
        .map((id) => id.slice("task:".length))
        .join("\n"),
    [navIds],
  );
  useEffect(() => {
    publishVisibleTaskIds(visibleTaskKey === "" ? [] : (visibleTaskKey.split("\n") as TaskId[]));
  }, [visibleTaskKey]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav]")].filter((item) =>
      navIds.includes(item.dataset.nav ?? ""),
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    event.preventDefault();
    const to =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : Math.min(items.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
    items[to]?.focus();
  };

  const firstWaiting = nextWaitingTask(waiting, selectedTaskId);
  const anyFolderOpen = projectsOpen && projectFolders.some(isOpen);
  const canToggleAll = order === "folder" && !unlimited && projectFolders.length > 1;
  const setAllFoldersOpen = (open: boolean) => {
    if (open) setOpenSections((current) => ({ ...current, projects: true }));
    setOpenOverride((current) => {
      const next = { ...current };
      for (const folder of projectFolders) next[folder.key] = open;
      return next;
    });
  };

  const searchField = (
    <TextField
      size="sm"
      width="100%"
      role="searchbox"
      testId="sidebar-search"
      ref={searchInput}
      value={query}
      placeholder={t("sidebar.search")}
      aria-label={t("sidebar.search")}
      leading={<SearchIcon />}
      trailing={
        query !== "" ? (
          <IconButton className="sb-search-clear" label={t("sidebar.clearSearch")} onClick={() => setQuery("")}>
            <Close size={12} />
          </IconButton>
        ) : (
          <span className="ui-affix" aria-hidden="true">
            {shortcutLabel("Ctrl F")}
          </span>
        )
      }
      onChange={setQuery}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          if (query !== "") {
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
          } else if (zcode) {
            // 现代工作台：空搜索时 Esc 收起搜索框，把焦点还给工具行的图标按钮。
            event.preventDefault();
            event.stopPropagation();
            setSearchOpen(false);
            searchToggle.current?.focus();
          }
        } else if (event.key === "ArrowDown") {
          // 从搜索框直接进结果列表。
          const first = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [])].find(
            (item) => item.dataset.nav === navIds[0],
          );
          if (first) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    />
  );

  const navActions = (
    <>
      <button
        type="button"
        className="sb-new"
        data-testid="sidebar-new-task"
        // 草稿页（没选任务的对话区）就是"新任务"：和任务行的选中一样用 aria-current 标出来。
        aria-current={view === "conversation" && selectedTaskId === null ? "page" : undefined}
        onClick={() => startDraft(null)}
      >
        <PlusIcon />
        <span className="sb-new-label">{t("sidebar.newTask")}</span>
        <span className="sb-new-hint" aria-hidden="true">
          {shortcutLabel("Ctrl N")}
        </span>
      </button>

      <button
        type="button"
        className="sb-new"
        data-testid="sidebar-open-folder"
        onClick={() => void addProjectAsDraft(t)}
      >
        <FolderPlusIcon />
        <span className="sb-new-label">{t("sidebar.openFolder")}</span>
        <span className="sb-new-hint" aria-hidden="true">
          {shortcutLabel("Ctrl Shift O")}
        </span>
      </button>

      <button
        type="button"
        className="sb-new"
        data-testid="sidebar-plugins"
        onClick={() => showView("settings", { section: "extensions" })}
      >
        <Puzzle size={15} className="icon" strokeWidth={1.5} />
        <span className="sb-new-label">{t("settings.extensions")}</span>
      </button>
    </>
  );

  return (
    <nav className="sb" aria-label={t("sidebar.label")} data-testid="sidebar">
      {/* 现代工作台：一级导航排在最上面（三条干净的无框按钮），任务列表工具行在它下面。 */}
      {zcode && <div className="sb-actions">{navActions}</div>}
      {zcode && <div className="sb-head-divider" aria-hidden="true" />}

      {/* 工具行：左「任务列表」，右搜索 / 活跃筛选 / 全部折叠 / 排列切换（现代工作台只留安静的图标按钮）。 */}
      <div className="sb-head">
        <p className="sb-head-title">{t("sidebar.listTitle")}</p>
        <div className="sb-head-tools">
          {zcode && (
            <IconButton
              ref={searchToggle}
              testId="sidebar-search-toggle"
              label={t("sidebar.search")}
              tip={`${t("sidebar.search")} · ${shortcutLabel("Ctrl F")}`}
              pressed={searchShown}
              onClick={toggleSearch}
            >
              <SearchIcon />
            </IconButton>
          )}
          <button
            type="button"
            className="sb-active-filter"
            data-active={activeOnly || undefined}
            data-has-active={activeCount > 0 || undefined}
            aria-pressed={activeOnly}
            data-testid="sidebar-filter-active"
            title={t("sidebar.activeFilterTip")}
            onClick={() => setActiveOnly((current) => !current)}
          >
            <RunningFourDots size="sm" active={activeCount > 0} />
            <span className="sb-active-filter-label">{t("sidebar.activeOnly")}</span>
            {activeCount > 0 && <span className="sb-active-filter-count">{activeCount}</span>}
          </button>
          {canToggleAll && (
            <IconButton
              className="sb-toggle-all"
              testId="sidebar-toggle-all-folders"
              label={t(anyFolderOpen ? "sidebar.collapseAll" : "sidebar.expandAll")}
              data-collapsed={!anyFolderOpen}
              onClick={() => setAllFoldersOpen(!anyFolderOpen)}
            >
              <ChevronDown size={12} />
            </IconButton>
          )}
          {zcode && (
            <IconButton
              testId="sidebar-view-toggle"
              label={t("sidebar.historyOrder")}
              tip={t(order === "folder" ? "sidebar.viewByFolderTip" : "sidebar.viewByTimeTip")}
              onClick={() => setHistoryOrder(order === "folder" ? "time" : "folder")}
            >
              <ViewGlyph />
            </IconButton>
          )}
        </div>
      </div>

      {zcode ? (
        // 搜索框平时收起：展开时贴着工具行下方平滑长出，不占顶部 240px 的可视面积。
        <Reveal open={searchShown}>
          <div className="sb-search">{searchField}</div>
        </Reveal>
      ) : (
        <div className="sb-actions">
          {searchField}
          {navActions}
        </div>
      )}

      {/* 只有一个在等时带上项目名；项目找不到（名字为空）时不写空的"· "（2026-10-29：原来是"1 个任务在等你 ·"） */}
      {firstWaiting !== null && (
        <button
          type="button"
          className="sb-waiting"
          data-testid="waiting-strip"
          onClick={() => void selectTask(firstWaiting.id).catch((error: unknown) => reportError(t, error))}
        >
          <span className="sb-waiting-diamond" aria-hidden="true" />
          <span className="sb-waiting-text">
            {waiting.length !== 1
              ? t("sidebar.waitingMany", { n: waiting.length })
              : labelOf(firstWaiting.projectId) === ""
                ? t("sidebar.waitingOneBare")
                : t("sidebar.waitingOne", { project: labelOf(firstWaiting.projectId) })}
          </span>
        </button>
      )}

      <div className="sb-list-host">
        <div className="sb-list" ref={listRef} onKeyDown={onListKeyDown}>
          {tasksState.error !== null && (
            <p className="sb-note sb-note-error">{t("sidebar.loadFailed", { message: tasksState.error })}</p>
          )}
          {projectsState.error !== null && (
            <div className="sb-no-projects">
              <p className="sb-note sb-note-error">{t("sidebar.projectsFailed", { message: projectsState.error })}</p>
              <Button size="sm" onClick={() => void refreshProjects()}>
                {t("common.retry")}
              </Button>
            </div>
          )}
          {order === "folder" && !grouping.ready ? (
            appInfoError !== null ? (
              <div className="sb-no-projects" role="alert">
                <p className="sb-note sb-note-error">{t("sidebar.appInfoFailed", { message: appInfoError })}</p>
                <Button size="sm" onClick={refreshAppInfo}>
                  {t("common.retry")}
                </Button>
              </div>
            ) : (
              <p className="sb-note" role="status">
                {t("sidebar.loadingGroups")}
              </p>
            )
          ) : (
            <HistorySection
              order={order}
              zcode={zcode}
              folders={projectFolders}
              flatItems={flatItems}
              flatKey={flatKey}
              conversationCount={conversations.length}
              unlimited={unlimited}
              activeOnly={activeOnly}
              projectsOpen={projectsOpen}
              conversationsOpen={conversationsOpen}
              onToggleSection={(section) =>
                setOpenSections((current) => ({ ...current, [section]: !current[section] }))
              }
              isOpen={isOpen}
              limits={limits}
              selectedTaskId={selectedTaskId}
              tabStopId={tabStopId}
              renamingId={renamingId}
              renamingFolderKey={renamingFolderKey}
              unreadTaskIds={unreadTaskIds}
              rows={rows}
              onToggle={(folder, open) => setOpenOverride((current) => ({ ...current, [folder.key]: open }))}
              onShowMore={(key) =>
                setLimits((current) => ({
                  ...current,
                  [key]: (current[key] ?? (key === timeLimitKey ? initialByTime : initialPerFolder)) + showMoreStep,
                }))
              }
              onNewTask={(folder) => void startDraftInFolder(folder, t, chatsDir)}
              onAddProject={() => void addProjectAsDraft(t)}
              onCreateConversation={() => startDraft(null)}
              onOpenProjectMenu={openProjectMenu}
              onCommitFolderRename={(folder, nextName) => {
                setRenamingFolderKey(null);
                if (nextName === null) return;
                const trimmed = nextName.trim();
                if (trimmed === folder.label) return;
                setFolderAlias(folder.cwd, trimmed === "" ? null : trimmed);
              }}
            />
          )}
          {searching && folders.length === 0 && timeline.length === 0 && (order === "time" || grouping.ready) && (
            <p className="sb-note" role="status">
              {t("sidebar.searchNone")}
            </p>
          )}
        </div>
        <OverlayScrollbar target={listRef} />
      </div>

      <div className="sb-bottom">
        <button
          type="button"
          className="sb-settings"
          data-active={view === "settings"}
          aria-pressed={view === "settings"}
          // 再点一次退出设置，回到进入前的对话（同设置页里的 Esc）。
          onClick={() => showView(view === "settings" ? "conversation" : "settings")}
        >
          <GearIcon />
          <span>{t("sidebar.settings")}</span>
        </button>
        {downloadedVersion !== null && (
          <button
            type="button"
            className="sb-update"
            title={t("sidebar.updateTip")}
            disabled={installing.busy}
            onClick={installing.requestInstall}
            data-testid="sidebar-update"
          >
            <span className="sb-update-dot" aria-hidden="true" />
            <span className="sb-update-text">{t("sidebar.update", { version: downloadedVersion })}</span>
          </button>
        )}
      </div>
      {installing.dialog}
      {menu}
    </nav>
  );
}
