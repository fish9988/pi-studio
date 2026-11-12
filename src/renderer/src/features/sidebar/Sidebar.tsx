// 侧栏（spec §3.2、第 4 章）：竖排三行（搜索 / 新任务 / 打开文件夹）、"等你确认"条、按项目分组的任务、底部是设置和（更新下载好后才有的）新版本标签。
// 从顶栏下面开始，不画标题栏；底色 --bg-sidebar 与顶栏连成一片。宽度由外层容器给。
import { reportError } from "../../ui/errors.ts";
import { publishVisibleTaskIds } from "./visible-order-store.ts";
import { onStudioCommand } from "../palette/studio-command.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectId, TaskId, TaskState } from "../../../../shared/ipc.ts";
import { useShellValue } from "../../app/shell-store.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import { shortcutLabel } from "../../app/platform-keys.ts";
import {
  selectTask,
  showView,
  useAppInfo,
  useDownloadedVersion,
  useMainView,
  useSelectedTaskId,
  useTasksState,
} from "../../store/index.ts";
import { Close, Puzzle } from "../../icons.tsx";
import { Button, IconButton, TextField } from "../../ui/controls.tsx";
import { OverlayScrollbar } from "../../ui/OverlayScrollbar.tsx";
import { useInstallUpdate } from "../settings/use-install-update.tsx";
import { archiveWithUndo, useHiddenTasks } from "./archive-store.ts";
import { FolderPlusIcon, GearIcon, PlusIcon, SearchIcon } from "./icons.tsx";
import { HistorySection } from "./HistorySection.tsx";
import {
  defaultOpen,
  folderNavId,
  initialByTime,
  initialPerFolder,
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
  const view = useMainView();
  const selectedTaskId = useSelectedTaskId();
  const tasksState = useTasksState();
  const downloadedVersion = useDownloadedVersion();
  const installing = useInstallUpdate();
  const projectsState = useProjectsState();
  const hidden = useHiddenTasks();
  const chatsDir = useAppInfo()?.chatsDir ?? null;
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
  // 任务和会话合成一个列表（搜索同时过滤两者）；默认文件夹（chats 目录）叫"默认文件夹"，并应用用户重命名的目录别名。
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

  // 搜索或筛选进行中会话时忽略折叠，匹配的行都要看得见；否则用户点过的优先，没点过的看有没有选中/在跑/等你确认的任务。
  const isOpen = useCallback(
    (folder: SidebarFolder) =>
      searching || activeOnly || (openOverride[folder.key] ?? defaultOpen(folder, selectedTaskId)),
    [searching, activeOnly, openOverride, selectedTaskId],
  );
  // 因为选中 / 在跑 / 等你确认而展开的文件夹记成"展开"：任务跑完、换了选中项都不再自己收起，只有用户点了才折叠。
  const autoOpened = useMemo(
    () =>
      folders
        .filter((folder) => openOverride[folder.key] === undefined && defaultOpen(folder, selectedTaskId))
        .map((folder) => folder.key)
        .join("\n"),
    [folders, openOverride, selectedTaskId],
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

  // roving tabindex：整个列表一个停靠点，记住的那个已不存在时回到选中的任务，再不行是第一项。
  const navIds = useMemo(() => {
    if (order === "time") {
      const { shown, remaining } = visibleItems(
        timeline,
        searching ? Infinity : (limits[timeLimitKey] ?? initialByTime),
        selectedTaskId,
      );
      return [...shown.map((item) => item.key), ...(remaining > 0 ? [moreNavId(timeLimitKey)] : [])];
    }
    return folders.flatMap((folder) => {
      if (!isOpen(folder)) return [folderNavId(folder)];
      const { shown, remaining } = visibleItems(
        folder.items,
        searching ? Infinity : (limits[folder.key] ?? initialPerFolder),
        selectedTaskId,
      );
      return [folderNavId(folder), ...shown.map((item) => item.key), ...(remaining > 0 ? [moreNavId(folder.key)] : [])];
    });
  }, [order, timeline, folders, searching, limits, isOpen, selectedTaskId]);
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
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav]")];
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

  return (
    <nav className="sb" aria-label={t("sidebar.label")} data-testid="sidebar">
      <div className="sb-actions">
        <TextField
          size="sm"
          width="100%"
          role="searchbox"
          testId="sidebar-search"
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
            if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            } else if (event.key === "ArrowDown") {
              // 从搜索框直接进结果列表。
              const first = listRef.current?.querySelector<HTMLElement>("[data-nav]");
              if (first) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
        />

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
      </div>

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
          <HistorySection
            folders={folders}
            timeline={timeline}
            searching={searching}
            activeOnly={activeOnly}
            activeCount={activeCount}
            isOpen={isOpen}
            limits={limits}
            selectedTaskId={selectedTaskId}
            tabStopId={tabStopId}
            renamingId={renamingId}
            renamingFolderKey={renamingFolderKey}
            unreadTaskIds={unreadTaskIds}
            rows={rows}
            onToggle={(folder, open) => setOpenOverride((current) => ({ ...current, [folder.key]: open }))}
            onSetAllOpen={(open) =>
              setOpenOverride((current) => {
                const next = { ...current };
                for (const folder of folders) next[folder.key] = open;
                return next;
              })
            }
            onToggleActiveOnly={setActiveOnly}
            onShowMore={(key) =>
              setLimits((current) => ({
                ...current,
                [key]: (current[key] ?? (key === timeLimitKey ? initialByTime : initialPerFolder)) + showMoreStep,
              }))
            }
            onNewTask={(folder) => void startDraftInFolder(folder, t, chatsDir)}
            onOpenProjectMenu={openProjectMenu}
            onCommitFolderRename={(folder, nextName) => {
              setRenamingFolderKey(null);
              if (nextName === null) return;
              const trimmed = nextName.trim();
              if (trimmed === folder.label) return;
              setFolderAlias(folder.cwd, trimmed === "" ? null : trimmed);
            }}
          />
          {searching && folders.length === 0 && timeline.length === 0 && (
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
