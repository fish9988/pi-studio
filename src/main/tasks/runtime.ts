// 任务池单例和它的 Electron 接线：userData 路径、测试用 pi 注入、事件出口、退出时关子进程。
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { app, nativeTheme, Notification, shell } from "electron";
import { t } from "../../shared/i18n/index.ts";
import { closeTaskBrowser, getBrowserManager, setTaskBrowserOmpRunning } from "../browser/runtime.ts";
import { SetupConsent } from "../git/setup-consent.ts";
import { createWorktree, removeWorktree } from "../git/worktree.ts";
import { appHandlers } from "../ipc/app-handlers.ts";
import { forgetDraft } from "../ipc/draft-handlers.ts";
import { emitEvent } from "../ipc/events.ts";
import { readProjectModelDefaults } from "../ipc/omp-handlers.ts";
import { log } from "../log/log.ts";
import { setTestPiOverride } from "../pi/discover.ts";
import { readyPiLaunch } from "../pi/runtime-singleton.ts";
import { listModelOptions, readDefaultModel } from "../service/default-model.ts";
import { listSlashCommands } from "../service/slash-commands-instance.ts";
import { startupCache } from "../service/startup-cache-instance.ts";
import { getSettings, onSettingsChanged, resolveLocale } from "../settings/settings-store.ts";
import { closeTaskTerminal } from "../terminal/active.ts";
import { getMainWindow } from "../window/main-window.ts";
import { showMainWindow } from "../window/show-window.ts";
import { registerShutdownHook } from "../window/shutdown.ts";
import { refreshTaskbarProgress } from "../window/taskbar-progress.ts";
import { refreshTray } from "../window/tray.ts";
import { forgetExport } from "./export-record.ts";
import { GateNotifier, retainNotification } from "./gate-notifier.ts";
import { TaskPool, type WorktreeOps } from "./task-pool.ts";
import { TaskRegistry } from "./task-registry.ts";
import { tspFeed } from "./tsp-feed-instance.ts";

const execFileAsync = promisify(execFile);

let consent: SetupConsent | null = null;
/** setup 脚本的确认记录（userData/setup-consent.json）；要在 app ready 之后调用。 */
export function getSetupConsent(): SetupConsent {
  consent ??= new SetupConsent(path.join(app.getPath("userData"), "setup-consent.json"));
  return consent;
}

const worktreeOps: WorktreeOps = {
  create: async (project) => {
    const worktreeOmpOverride = app.isPackaged ? undefined : process.env["STUDIO_TEST_WORKTREE_OMP"];
    const created = await createWorktree(project.path, {
      ...(worktreeOmpOverride ? { ompPath: worktreeOmpOverride } : {}),
      approveSetup: (script) => getSetupConsent().isApproved(project.path, script.sha256),
    });
    return { path: created.path, branch: created.branch, base: created.baseBranch };
  },
  remove: async (project, worktreePath, branch) => {
    await removeWorktree(project.path, worktreePath, branch);
  },
};

async function exportPiSessionHtml(sessionFile: string, outputPath: string, cwd: string): Promise<void> {
  const launch = await readyPiLaunch();
  await execFileAsync(launch.command, [...launch.prefixArgs, "--export", sessionFile, outputPath], {
    cwd,
    env: { ...process.env, ...launch.env },
    windowsHide: true,
    timeout: 60_000,
  });
}

let pool: Promise<TaskPool> | null = null;
const heldNotifications = new Set<Notification>();

function createPool(): Promise<TaskPool> {
  const registry = new TaskRegistry(path.join(app.getPath("userData"), "tasks.json"));
  const testPi = process.env["STUDIO_TEST_PI"] ?? process.env["STUDIO_TEST_OMP"];
  if (!app.isPackaged && testPi) setTestPiOverride(testPi);

  const notifier = new GateNotifier({
    notifyEnabled: async () => true,
    soundEnabled: async () => (await appHandlers.getSettings()).soundOnDone,
    playSound: () => shell.beep(),
    locale: resolveLocale,
    windowFocused: () => getMainWindow()?.isFocused() ?? false,
    windowHidden: () => !(getMainWindow()?.isVisible() ?? false),
    projectName: (task) => registry.findProject(task.projectId)?.name ?? "",
    show: (content, onClick) => {
      const notification = new Notification(content);
      retainNotification(heldNotifications, notification);
      notification.on("click", onClick);
      notification.show();
    },
    onClick: (id) => {
      const existed = getMainWindow() !== null;
      const window = showMainWindow();
      if (existed) emitEvent("focusTask", id);
      else window.webContents.once("did-finish-load", () => setTimeout(() => emitEvent("focusTask", id), 500));
    },
  });

  const taskPool = new TaskPool({
    registry,
    getSettings: () => appHandlers.getSettings(),
    worktrees: worktreeOps,
    beforeTaskClose: closeTaskTerminal,
    forkTitle: (title) => t(resolveLocale(), "task.forkTitle", { title }),
    knownModels: () => startupCache().models(),
    listModels: (refresh) => listModelOptions(refresh),
    newTaskDefaults: async (project) => {
      const cache = startupCache().snapshot();
      const defaults = cache.modelDefaults?.[project.id] ?? (await readProjectModelDefaults(project.id, project.path));
      const ompDefault = defaults.model !== null ? null : await readDefaultModel(false);
      return { model: defaults.model, thinkingLevel: defaults.thinkingLevel, ompDefault };
    },
    listSlashCommands,
    exportSession: exportPiSessionHtml,
    pi: {
      buildPiLaunch: async (record) => {
        const [launch, browserCdp] = await Promise.all([readyPiLaunch(), getBrowserManager().endpoint(record.id)]);
        return {
          ...launch,
          env: {
            ...launch.env,
            STUDIO_BROWSER_CDP: browserCdp,
          },
        };
      },
    },
    events: {
      state: (state) => {
        emitEvent("taskState", state);
        void notifier.onState(state);
        setTaskBrowserOmpRunning(state.id, state.status !== "stopped" && state.status !== "error");
        const tasks = taskPool.listTasks();
        refreshTray(tasks);
        refreshTaskbarProgress(tasks);
      },
      tspBatch: (batch) => tspFeed().push(batch),
      notice: (notice) => emitEvent("taskNotice", notice),
      taskRemoved: (id) => {
        forgetExport(id);
        notifier.forget(id);
        tspFeed().release(id);
        void closeTaskBrowser(id).catch((error: unknown) => {
          log.warn(`close browser of ${id} failed`, { error: error instanceof Error ? error.message : String(error) });
        });
        void forgetDraft(id).catch((error: unknown) => {
          log.warn(`forget draft of ${id} failed`, { error: error instanceof Error ? error.message : String(error) });
        });
        emitEvent("taskRemoved", id);
        const tasks = taskPool.listTasks();
        refreshTray(tasks);
        refreshTaskbarProgress(tasks);
      },
      btw: (taskId, event) => emitEvent("btw", { taskId, event }),
      composerPrefill: (taskId, draft) => emitEvent("composerPrefill", { taskId, draft }),
    },
  });

  const syncAppearance = () =>
    taskPool.setAppearance({ dark: nativeTheme.shouldUseDarkColors, reduceMotion: getSettings().reduceMotion });
  nativeTheme.on("updated", syncAppearance);
  onSettingsChanged(syncAppearance);
  registerShutdownHook(() => taskPool.shutdown());
  return taskPool.init().then(() => taskPool);
}

export function getTaskPool(): Promise<TaskPool> {
  pool ??= createPool();
  return pool;
}
