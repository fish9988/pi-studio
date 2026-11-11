// Pi Studio 专属斜杠命令纯逻辑规约（不依赖 DOM，供渲染进程 `pi-slash-table.ts` 与 Node 单元测试共用）。
import type { TFunction } from "../../../../shared/i18n/index.ts";
import type { ModelKey, ModelOption, ProjectId, TaskId } from "../../../../shared/ipc.ts";
import { PI_THINKING_LEVELS, type PiCloneResult, type PiThinkingLevel } from "../../../../shared/pi-config-types.ts";
import { pickerRequestFor, resolveModelCommand, type ModelPickerRequest } from "./slash-args.ts";
import type { StudioSlashCommand } from "./studio-slash.ts";

export type PiThinkingCommand = { kind: "picker" } | { kind: "set"; level: PiThinkingLevel } | { kind: "omp" };

/** 解析 `/thinking [off|minimal|low|medium|high|xhigh|max]`（不区分大小写）。 */
export function resolvePiThinkingCommand(args: string): PiThinkingCommand {
  const wanted = args.trim().toLowerCase();
  if (wanted === "") return { kind: "picker" };
  const hit = PI_THINKING_LEVELS.find((candidate) => candidate === wanted);
  return hit === undefined ? { kind: "omp" } : { kind: "set", level: hit };
}

export interface PiSlashDeps {
  openSettings(query: string): void;
  openSection(section: "models" | "providers" | "extensions" | "shortcuts" | "about"): void;
  openModelPicker(request?: ModelPickerRequest): void;
  openUsageDialog(): void;
  openSessionPicker(): void;
  startDraftForTask(taskId: TaskId): void;
  openRenameInline(): void;
  renameTask(taskId: TaskId, title: string): Promise<void> | void;
  listTaskModels(taskId: TaskId): Promise<ModelOption[]>;
  setTaskModel(taskId: TaskId, key: ModelKey): Promise<void>;
  setTaskThinkingLevel(taskId: TaskId, level: string): Promise<void>;
  openSessionInfo(taskId: TaskId): void;
  openSessionTree(taskId: TaskId): void;
  forkTask(taskId: TaskId): Promise<void> | void;
  cloneTask(taskId: TaskId): Promise<PiCloneResult | null>;
  selectTask(taskId: TaskId): Promise<void> | void;
  compactTask(taskId: TaskId, instructions?: string): Promise<void>;
  copyLastAnswer(taskId: TaskId, t: TFunction): Promise<void>;
  exportConversation(taskId: TaskId, t: TFunction): Promise<void> | void;
  reloadResources(taskId: TaskId | null, t: TFunction): Promise<void>;
  btwCommand: StudioSlashCommand;
  openGitChanges(taskId: TaskId): void;
  archiveWithUndo(taskId: TaskId, t: TFunction): Promise<void> | void;
  currentProjectId?(taskId: TaskId): ProjectId | null;
}

export function buildPiSlashCommands(deps: PiSlashDeps): readonly StudioSlashCommand[] {
  const openModelsSettings = () => deps.openSection("models");
  const openProvidersSettings = () => deps.openSection("providers");
  const openExtensionsSettings = () => deps.openSection("extensions");
  const openShortcutsSettings = () => deps.openSection("shortcuts");
  const openAboutSettings = () => deps.openSection("about");

  return [
    {
      name: "settings",
      descKey: "slash.settingsDesc",
      run: (_taskId, args) => deps.openSettings(args),
      draft: (args) => deps.openSettings(args),
    },
    {
      name: "model",
      descKey: "slash.modelDesc",
      run: async (taskId, args) => {
        const action = resolveModelCommand(args, await deps.listTaskModels(taskId));
        if (action.kind === "omp") return "omp";
        if (action.kind === "picker") return deps.openModelPicker(action.request);
        await deps.setTaskModel(taskId, action.key);
        if (action.level !== null) {
          await deps.setTaskThinkingLevel(taskId, action.level);
        }
      },
      draft: (args) => deps.openModelPicker(pickerRequestFor(args)),
    },
    {
      name: "thinking",
      aliases: ["effort"],
      descKey: "slash.effortDesc",
      run: async (taskId, args) => {
        const action = resolvePiThinkingCommand(args);
        if (action.kind === "omp") return "omp";
        if (action.kind === "picker") return deps.openModelPicker();
        await deps.setTaskThinkingLevel(taskId, action.level);
      },
      draft: () => deps.openModelPicker(),
    },
    {
      name: "scoped-models",
      descKey: "model.scopes",
      run: openModelsSettings,
      draft: openModelsSettings,
    },
    {
      name: "mcp",
      descKey: "integrations.slash.mcp",
      run: openExtensionsSettings,
      draft: openExtensionsSettings,
    },
    {
      name: "login",
      descKey: "login.signIn",
      run: openProvidersSettings,
      draft: openProvidersSettings,
    },
    {
      name: "logout",
      descKey: "login.signOut",
      run: openProvidersSettings,
      draft: openProvidersSettings,
    },
    {
      name: "new",
      descKey: "slash.newDesc",
      run: (taskId) => deps.startDraftForTask(taskId),
    },
    {
      name: "resume",
      descKey: "slash.resumeDesc",
      run: () => deps.openSessionPicker(),
      draft: () => deps.openSessionPicker(),
    },
    {
      name: "name",
      aliases: ["rename"],
      descKey: "slash.renameDesc",
      run: (taskId, args) => (args === "" ? deps.openRenameInline() : deps.renameTask(taskId, args)),
    },
    {
      name: "session",
      descKey: "sessionInfo.slash.session",
      run: (taskId) => deps.openSessionInfo(taskId),
    },
    {
      name: "usage",
      descKey: "slash.usageDesc",
      run: () => deps.openUsageDialog(),
      draft: () => deps.openUsageDialog(),
    },
    {
      name: "tree",
      descKey: "slash.treeDesc",
      run: (taskId) => deps.openSessionTree(taskId),
    },
    {
      name: "fork",
      descKey: "slash.forkDesc",
      run: (taskId) => deps.forkTask(taskId),
    },
    {
      name: "clone",
      descKey: "tree.fork",
      run: async (taskId) => {
        const res = await deps.cloneTask(taskId);
        if (res !== null) {
          await deps.selectTask(res.task.id);
          return;
        }
        await deps.forkTask(taskId);
      },
    },
    {
      name: "compact",
      descKey: "cmd.compact",
      run: async (taskId, args) => {
        if (args === "") await deps.compactTask(taskId);
        else await deps.compactTask(taskId, args);
      },
    },
    {
      name: "copy",
      descKey: "cmd.copyLast",
      run: (taskId, _args, t) => deps.copyLastAnswer(taskId, t),
    },
    {
      name: "export",
      descKey: "slash.exportDesc",
      run: (taskId, _args, t) => deps.exportConversation(taskId, t),
    },
    {
      name: "reload",
      descKey: "slash.reloadPluginsDesc",
      run: (taskId, _args, t) => deps.reloadResources(taskId, t),
      draft: (_args, t) => deps.reloadResources(null, t),
    },
    deps.btwCommand,
    {
      name: "git",
      descKey: "slash.gitDesc",
      run: (taskId) => deps.openGitChanges(taskId),
    },
    {
      name: "hotkeys",
      descKey: "slash.hotkeysDesc",
      run: openShortcutsSettings,
      draft: openShortcutsSettings,
    },
    {
      name: "changelog",
      descKey: "integrations.slash.changelog",
      run: openAboutSettings,
      draft: openAboutSettings,
    },
    {
      name: "delete",
      descKey: "slash.deleteDesc",
      run: (taskId, _args, t) => deps.archiveWithUndo(taskId, t),
    },
  ];
}
