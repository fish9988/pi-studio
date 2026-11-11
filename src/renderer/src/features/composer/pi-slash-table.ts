// Pi Studio 专属斜杠命令表（针对 @earendil-works/pi-coding-agent 1.5.2 设计，移除所有 OMP 专有斜杠命令）。
// 结构与 StudioSlashCommand 完全一致，可直接接入 SlashMenu.tsx 与 studio-slash.ts。
import type { TaskId } from "../../../../shared/ipc.ts";
import type { ThinkingLevel } from "../../../../shared/omp-wire/rpc-wire.generated.ts";
import { lastAnswerText } from "../../../../shared/tsp/last-answer.ts";
import { getTask, selectTask, setPaletteOpen, setSettingsQuery, showView } from "../../store/index.ts";
import { btwSlash } from "../btw/btw-slash.ts";
import { forkFromMessage } from "../conversation/fork-actions.ts";
import { openSessionTree } from "../conversation/session-tree-store.ts";
import { pushToast } from "../dialogs/index.ts";
import { startDraft } from "../empty/index.ts";
import { emitStudioCommand } from "../palette/studio-command.ts";
import { openSessionInfo } from "../session-info/session-info-store.ts";
import { archiveWithUndo } from "../sidebar/archive-store.ts";
import { peekTspDocument } from "../tsp/tsp-store.ts";
import { openChangesPanel } from "../workbench/workbench-store.ts";
import { exportConversation } from "./export-html.ts";
import { buildPiSlashCommands, resolvePiThinkingCommand, type PiThinkingCommand } from "./pi-slash-spec.ts";
import type { StudioSlashCommand } from "./studio-slash.ts";
import { setUsageDialogOpen } from "./usage-store.ts";

export { resolvePiThinkingCommand, type PiThinkingCommand };
export type StudioSlashSpec = StudioSlashCommand;

export const PI_STUDIO_SLASH_COMMANDS: readonly StudioSlashCommand[] = buildPiSlashCommands({
  openSettings(query) {
    showView("settings");
    if (query !== "") setSettingsQuery(query);
  },
  openSection(section) {
    showView("settings", { section });
  },
  openModelPicker(request) {
    emitStudioCommand("model", request);
  },
  openUsageDialog() {
    setUsageDialogOpen(true);
  },
  openSessionPicker() {
    setPaletteOpen(true);
  },
  startDraftForTask(taskId) {
    startDraft(getTask(taskId)?.projectId ?? null);
  },
  openRenameInline() {
    emitStudioCommand("rename");
  },
  renameTask(taskId, title) {
    return window.studio.renameTask(taskId, title);
  },
  listTaskModels(taskId) {
    return window.studio.listTaskModels(taskId);
  },
  setTaskModel(taskId, key) {
    return window.studio.setTaskModel(taskId, key);
  },
  setTaskThinkingLevel(taskId, level) {
    return (window.studio.setTaskThinkingLevel as (id: TaskId, next: ThinkingLevel) => Promise<void>)(
      taskId,
      level as ThinkingLevel,
    );
  },
  openSessionInfo(taskId) {
    openSessionInfo(taskId, "info");
  },
  openSessionTree(taskId) {
    openSessionTree(taskId);
  },
  forkTask(taskId) {
    return forkFromMessage(taskId, null);
  },
  cloneTask(taskId) {
    return window.studio.cloneTask(taskId);
  },
  selectTask(taskId) {
    return selectTask(taskId);
  },
  compactTask(taskId, instructions) {
    return instructions === undefined
      ? window.studio.compactTask(taskId)
      : window.studio.compactTask(taskId, instructions);
  },
  async copyLastAnswer(taskId, t) {
    const doc = peekTspDocument(taskId);
    const answer = doc === null ? null : lastAnswerText(doc);
    if (answer === null) {
      pushToast({ message: t("cmd.copyLastEmpty") });
      return;
    }
    await navigator.clipboard.writeText(answer);
    pushToast({ message: t("common.copied") });
  },
  exportConversation(taskId, t) {
    return exportConversation(taskId, t);
  },
  async reloadResources(taskId, t) {
    await window.studio.refreshModels();
    await window.studio.listSlashCommands(taskId);
    pushToast({ level: "info", message: t("slash.reloadPluginsDone") });
  },
  btwCommand: btwSlash,
  openGitChanges(taskId) {
    openChangesPanel(taskId);
  },
  archiveWithUndo(taskId, t) {
    return archiveWithUndo(taskId, taskId, t);
  },
});

export const studioPiSlashCommands = PI_STUDIO_SLASH_COMMANDS;
