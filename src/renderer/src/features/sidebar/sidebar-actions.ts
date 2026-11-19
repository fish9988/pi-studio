// 侧栏和命令面板共用的动作。数据都直接问主进程（listTasks / listProjects），不依赖组件里的 hook，
// 所以全局快捷键（Ctrl N、Ctrl J）也能直接调。失败一律用 toast 说出来，不吞掉。
import { reportError } from "../../ui/errors.ts";
import type { TFunction } from "../../../../shared/i18n/index.ts";
import type { SessionSummary, TaskId } from "../../../../shared/ipc.ts";
import { isDefaultFolder } from "../empty/default-folder.ts";
import { selectTask } from "../../store/index.ts";
import { startDraft } from "../empty/index.ts";
import { refreshProjects } from "./projects-store.ts";
import { nextWaitingTask, waitingTasks, type SidebarFolder } from "../../../../shared/ui/sidebar-model.ts";

/** 弹系统文件夹选择器加入项目，并把它设为新任务草稿的项目（不创建任务）。取消时什么也不做。 */
export async function addProjectAsDraft(t: TFunction): Promise<void> {
  try {
    const project = await window.studio.addProject();
    if (project === null) return;
    await refreshProjects();
    startDraft(project.id);
  } catch (error) {
    reportError(t, error);
  }
}

/**
 * 文件夹头部的 +：studio 项目直接开草稿；只在历史会话里出现的文件夹先加成项目（主进程按会话 id 查它的 cwd）再开草稿。
 * 加成项目不创建任务，草稿不发消息就不会留下任何东西。
 */
export async function startDraftInFolder(
  folder: SidebarFolder,
  t: TFunction,
  defaultCwd?: string | null,
): Promise<void> {
  if (folder.project !== null) {
    startDraft(folder.project.id);
    return;
  }
  const item = folder.items.find((item) => item.kind === "session");
  if (item !== undefined) await startDraftInSessionFolder(item.session, t, defaultCwd ?? null);
}

/** 从历史会话的菜单在它原来的工作目录开新任务。 */
export async function startDraftInSessionFolder(
  session: SessionSummary,
  t: TFunction,
  chatsDir: string | null,
): Promise<void> {
  if (isDefaultFolder(session.cwd, chatsDir)) {
    startDraft(null);
    return;
  }
  try {
    const project = await window.studio.ensureSessionProject(session.id);
    await refreshProjects();
    startDraft(project.id);
  } catch (error) {
    reportError(t, error);
  }
}

/** Ctrl J：跳到等你确认的任务；已在其中一个时跳到下一个。没有等待的任务时什么也不做。 */
export async function jumpToWaitingTask(current: TaskId | null, t: TFunction): Promise<void> {
  try {
    const target = nextWaitingTask(waitingTasks(await window.studio.listTasks(), new Set()), current);
    if (target !== null) await selectTask(target.id);
  } catch (error) {
    reportError(t, error);
  }
}
