// 任务行和项目文件夹头的右键上下文菜单（DSH × Antigravity 完整目录操作集）：
// - 文件夹右键菜单包含：新建任务、在右侧打开文件树、在内置终端中打开、重命名显示名称、复制目录路径、在资源管理器中显示、清理无主 worktree、从列表移除。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { TFunction } from "../../../../shared/i18n/index.ts";
import {
  draftKey,
  type Locale,
  type Project,
  type ProjectId,
  type SessionSummary,
  type TaskId,
  type TaskState,
  type TerminalKey,
} from "../../../../shared/ipc.ts";
import type { SidebarFolder } from "../../../../shared/ui/sidebar-model.ts";
import { Branch, CopyIcon, FileIcon, Folder, Pencil, Plus, Terminal, Trash } from "../../icons.tsx";
import { clearSelection, selectTask, showView } from "../../store/index.ts";
import { Menu, type MenuAnchor, type MenuEntry } from "../../ui/Menu.tsx";
import { pushToast } from "../dialogs/index.ts";
import { isDefaultFolder } from "../empty/default-folder.ts";
import { startDraft } from "../empty/index.ts";
import { openFilesPanel } from "../file-preview/preview-store.ts";
import { cleanupOrphans } from "../git/git-actions.ts";
import { setTerminalOpen } from "../terminal/terminal-store.ts";
import { openDshToolTab } from "../workbench/dsh-workbench-store.ts";
import { archivePending, commitPendingArchives } from "./archive-store.ts";
import { refreshProjects } from "./projects-store.ts";
import { startDraftInFolder } from "./sidebar-actions.ts";
import { hideFolderKey } from "./sidebar-prefs-store.ts";
import { attempt, buildSessionMenu, buildTaskMenu } from "./task-menu.tsx";

interface OpenMenu {
  anchor: MenuAnchor;
  items: MenuEntry[];
  label: string;
}

interface MenusOptions {
  t: TFunction;
  locale: Locale;
  selectedTaskId: TaskId | null;
  chatsDir: string | null;
  /** 项目下侧栏知道的任务（含正在等撤销的归档）。 */
  projectTaskIds(project: Project): readonly TaskId[];
  onRename(taskId: TaskId): void;
  onRenameFolder(folderKey: string): void;
}

async function resolveFolderProject(folder: SidebarFolder, chatsDir: string | null): Promise<Project | null> {
  if (folder.project !== null) return folder.project;
  if (chatsDir !== null && isDefaultFolder(folder.cwd, chatsDir)) {
    const project = await window.studio.ensureChatsProject();
    await refreshProjects();
    return project;
  }
  const sessionItem = folder.items.find((item) => item.kind === "session");
  if (sessionItem?.kind === "session") {
    const project = await window.studio.ensureSessionProject(sessionItem.session.id);
    await refreshProjects();
    return project;
  }
  const taskItem = folder.items.find((item) => item.kind === "task");
  if (taskItem?.kind === "task") {
    const projects = await window.studio.listProjects();
    const matched = projects.find((p) => p.id === taskItem.task.projectId);
    if (matched) return matched;
  }
  return null;
}

/** 激活对应目录上下文（优先复用当前已选中的该目录任务，否则选中最新任务或进入该目录草稿）并返回右侧工作台的 TerminalKey。 */
async function activateFolderPanelKey(
  folder: SidebarFolder,
  selectedTaskId: TaskId | null,
  chatsDir: string | null,
): Promise<TerminalKey> {
  if (selectedTaskId !== null && folder.items.some((item) => item.kind === "task" && item.task.id === selectedTaskId)) {
    showView("conversation");
    return selectedTaskId;
  }
  const firstTask = folder.items.find((item) => item.kind === "task");
  if (firstTask?.kind === "task") {
    await selectTask(firstTask.task.id);
    showView("conversation");
    return firstTask.task.id;
  }
  const project = await resolveFolderProject(folder, chatsDir);
  const projectId = chatsDir !== null && isDefaultFolder(folder.cwd, chatsDir) ? null : (project?.id ?? null);
  startDraft(projectId);
  return draftKey(projectId);
}

export function useSidebarMenus({
  t,
  locale,
  selectedTaskId,
  chatsDir,
  projectTaskIds,
  onRename,
  onRenameFolder,
}: MenusOptions): {
  menu: ReactNode;
  openTaskMenu(task: TaskState, x: number, y: number, trigger: HTMLElement): void;
  openSessionMenu(session: SessionSummary, x: number, y: number, trigger: HTMLElement): void;
  openProjectMenu(folder: SidebarFolder, x: number, y: number, trigger: HTMLElement): void;
} {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    const host = open?.anchor.returnFocus?.closest<HTMLElement>(".sb-row, .sb-group-head");
    if (!host) return;
    host.setAttribute("data-menu-open", "true");
    host.dispatchEvent(new CustomEvent("studio:menu-open-change", { detail: true }));
    return () => {
      host.removeAttribute("data-menu-open");
      host.dispatchEvent(new CustomEvent("studio:menu-open-change", { detail: false }));
    };
  }, [open]);

  const openTaskMenu = (task: TaskState, x: number, y: number, trigger: HTMLElement) =>
    setOpen({
      anchor: { x, y, returnFocus: trigger },
      label: t("task.more"),
      items: buildTaskMenu({
        t,
        taskId: task.id,
        keepAlive: task.keepAlive,
        selectedTaskId,
        onRename: () => onRename(task.id),
      }),
    });

  const openSessionMenu = (session: SessionSummary, x: number, y: number, trigger: HTMLElement) =>
    setOpen({
      anchor: { x, y, returnFocus: trigger },
      label: t("task.more"),
      items: buildSessionMenu({
        t,
        session,
        onRenamedToTask: (taskId) => onRename(taskId),
      }),
    });

  const openProjectMenu = (folder: SidebarFolder, x: number, y: number, trigger: HTMLElement) => {
    const zh = locale === "zh-CN";
    setOpen({
      anchor: { x, y, returnFocus: trigger },
      label: t("sidebar.projectMenu"),
      items: [
        {
          id: "newTaskInFolder",
          label: t("menu.newTask"),
          icon: <Plus />,
          onSelect: () => void startDraftInFolder(folder, t, chatsDir),
        },
        {
          id: "openFilesTree",
          label: zh ? "在右侧打开文件树" : "Open File Tree on Right",
          icon: <FileIcon />,
          onSelect: () =>
            void attempt(t, async () => {
              const key = await activateFolderPanelKey(folder, selectedTaskId, chatsDir);
              openFilesPanel(key);
              openDshToolTab(key, "files");
            }),
        },
        {
          id: "openInTerminal",
          label: zh ? "在内置终端中打开" : "Open in Integrated Terminal",
          icon: <Terminal />,
          onSelect: () =>
            void attempt(t, async () => {
              const key = await activateFolderPanelKey(folder, selectedTaskId, chatsDir);
              setTerminalOpen(key, true, { focus: true });
              openDshToolTab(key, "terminal");
            }),
        },
        { kind: "separator", id: "sep-meta" },
        {
          id: "renameFolder",
          label: zh ? "重命名显示名称" : "Rename Display Name",
          icon: <Pencil />,
          onSelect: () => onRenameFolder(folder.key),
        },
        {
          id: "copyFolderPath",
          label: zh ? "复制目录路径" : "Copy Folder Path",
          icon: <CopyIcon />,
          onSelect: () =>
            void attempt(t, async () => {
              await navigator.clipboard.writeText(folder.cwd);
              pushToast({
                level: "info",
                message: zh ? "已复制目录路径" : "Copied folder path",
              });
            }),
        },
        {
          id: "reveal",
          label: t("project.reveal"),
          icon: <Folder />,
          onSelect: () =>
            void attempt(t, async () => {
              const project = await resolveFolderProject(folder, chatsDir);
              if (project !== null) {
                await window.studio.revealProject(project.id);
              }
            }),
        },
        { kind: "separator", id: "sep-remove" },
        {
          id: "cleanupWorktrees",
          label: t("git.menu.cleanup"),
          icon: <Branch />,
          onSelect: () =>
            void attempt(t, async () => {
              const project = await resolveFolderProject(folder, chatsDir);
              if (project !== null) {
                await cleanupOrphans(t, project.id);
              }
            }),
        },
        {
          id: "remove",
          label: t("project.remove"),
          icon: <Trash />,
          tone: "danger",
          onSelect: () => {
            const { project } = folder;
            const itemTaskIds = folder.items.filter((item) => item.kind === "task").map((item) => item.task.id);
            const folderTaskIds = Array.from(
              new Set([...(project !== null ? projectTaskIds(project) : []), ...itemTaskIds]),
            );
            const activeTaskIds = folderTaskIds.filter((taskId) => !archivePending(taskId));
            const projectIdsToRemove = new Set<ProjectId>();
            if (project !== null) projectIdsToRemove.add(project.id);
            for (const item of folder.items) {
              if (item.kind === "task") projectIdsToRemove.add(item.task.projectId);
            }
            void attempt(t, async () => {
              if (selectedTaskId !== null && folderTaskIds.includes(selectedTaskId)) {
                clearSelection();
              }
              await commitPendingArchives(folderTaskIds, t);
              for (const taskId of activeTaskIds) {
                await window.studio.archiveTask(taskId);
              }
              if (projectIdsToRemove.size > 0) {
                for (const pid of projectIdsToRemove) {
                  await window.studio.removeProject(pid).catch(() => {});
                }
                await refreshProjects();
              }
              // 若该目录仍有历史会话（或纯历史目录），将目录 key 加入隐藏列表，避免再次在侧栏露出。
              hideFolderKey(folder.key);
            });
          },
        },
      ],
    });
  };

  const menu =
    open === null ? null : <Menu anchor={open.anchor} items={open.items} label={open.label} onClose={close} />;
  return { menu, openTaskMenu, openSessionMenu, openProjectMenu };
}
