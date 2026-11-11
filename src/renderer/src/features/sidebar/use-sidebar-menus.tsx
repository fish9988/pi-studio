// 任务行和项目头的菜单内容与动作（spec §4.2、§4.3）。返回要渲染的菜单元素和两个打开函数。
// 任务菜单和顶栏 ⋯ 是同一份（task-menu.tsx）。
import { useCallback, useState, type ReactNode } from "react";
import type { TFunction } from "../../../../shared/i18n/index.ts";
import type { Project, SessionSummary, TaskId, TaskState } from "../../../../shared/ipc.ts";
import { Branch, Folder, Trash } from "../../icons.tsx";
import { clearSelection } from "../../store/index.ts";
import { Menu, type MenuAnchor, type MenuEntry } from "../../ui/Menu.tsx";
import { cleanupOrphans } from "../git/git-actions.ts";
import { archivePending, commitPendingArchives } from "./archive-store.ts";
import { refreshProjects } from "./projects-store.ts";
import { attempt, buildSessionMenu, buildTaskMenu } from "./task-menu.tsx";
interface OpenMenu {
  anchor: MenuAnchor;
  items: MenuEntry[];
  label: string;
}

interface MenusOptions {
  t: TFunction;
  selectedTaskId: TaskId | null;
  /** 项目下侧栏知道的任务（含正在等撤销的归档）。 */
  projectTaskIds(project: Project): readonly TaskId[];
  onRename(task: TaskState): void;
}

export function useSidebarMenus({ t, selectedTaskId, projectTaskIds, onRename }: MenusOptions): {
  menu: ReactNode;
  openTaskMenu(task: TaskState, x: number, y: number, trigger: HTMLElement): void;
  openSessionMenu(session: SessionSummary, x: number, y: number, trigger: HTMLElement): void;
  openProjectMenu(project: Project, x: number, y: number, trigger: HTMLElement): void;
} {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const close = useCallback(() => setOpen(null), []);

  const openTaskMenu = (task: TaskState, x: number, y: number, trigger: HTMLElement) =>
    setOpen({
      anchor: { x, y, returnFocus: trigger },
      label: t("task.more"),
      items: buildTaskMenu({
        t,
        taskId: task.id,
        keepAlive: task.keepAlive,
        selectedTaskId,
        onRename: () => onRename(task),
      }),
    });

  const openSessionMenu = (session: SessionSummary, x: number, y: number, trigger: HTMLElement) =>
    setOpen({
      anchor: { x, y, returnFocus: trigger },
      label: t("task.more"),
      items: buildSessionMenu({ t, session }),
    });
  const openProjectMenu = (project: Project, x: number, y: number, trigger: HTMLElement) =>
    setOpen({
      anchor: { x, y, returnFocus: trigger },
      label: t("sidebar.projectMenu"),
      items: [
        {
          id: "reveal",
          label: t("project.reveal"),
          icon: <Folder />,
          onSelect: () => void attempt(t, () => window.studio.revealProject(project.id)),
        },
        {
          id: "cleanupWorktrees",
          label: t("git.menu.cleanup"),
          icon: <Branch />,
          onSelect: () => void cleanupOrphans(t, project.id),
        },
        { kind: "separator", id: "sep-remove" },
        {
          id: "remove",
          label: t("project.remove"),
          icon: <Trash />,
          tone: "danger",
          onSelect: () => {
            const taskIds = projectTaskIds(project);
            const activeTaskIds = taskIds.filter((taskId) => !archivePending(taskId));
            void attempt(t, async () => {
              if (selectedTaskId !== null && taskIds.includes(selectedTaskId)) {
                clearSelection();
              }
              await commitPendingArchives(taskIds, t);
              for (const taskId of activeTaskIds) {
                await window.studio.archiveTask(taskId);
              }
              await window.studio.removeProject(project.id);
              await refreshProjects();
            });
          },
        },
      ],
    });

  const menu =
    open === null ? null : <Menu anchor={open.anchor} items={open.items} label={open.label} onClose={close} />;
  return { menu, openTaskMenu, openSessionMenu, openProjectMenu };
}
