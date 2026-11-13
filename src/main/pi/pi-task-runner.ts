// Complete task runner implementation backed by `PiRpcClient` + `PiTspBridge`.
// Drop-in compatible with `TspRunner` (`src/main/tasks/tsp-runner.ts`) for `TaskPool`.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { appendFile, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import {
  applyBtwEvent,
  btwLimits,
  btwTurns,
  interruptBtw,
  isBtwRunning,
  type BtwHistoryRecord,
  type BtwUiEvent,
} from "../../shared/btw.ts";
import { fillFileSlots } from "../../shared/composer-files.ts";
import type {
  ContextReport,
  ModelKey,
  ModelOption,
  Project,
  PromptImage,
  PromptInput,
  RestoredDraft,
  RestoredQueue,
  SessionTreeView,
  TaskError,
  TaskId,
  TaskState,
  TspSessionExtras,
  TspSnapshot,
  TspSubagentRecord,
} from "../../shared/ipc.ts";
import { emptySessionToggles, type SessionToggles } from "../../shared/omp-output/toggles.ts";
import type {
  AvailableSlashCommand,
  ContextUsage,
  GoalOp,
  ThinkingLevel,
} from "../../shared/omp-wire/rpc-wire.generated.ts";
import type { ModeOp } from "../../shared/tsp/composer-facts.ts";
import { snapshotDocument, type DocBlob } from "../../shared/tsp/document.ts";
import { TSP_APPROVAL_DIALOG_ID, TSP_ASK_DIALOG_ID } from "../../shared/tsp/gate.ts";
import { deriveTaskStatus } from "../../shared/tsp/task-status.ts";
import type { TspEvent } from "../../shared/tsp/tsp.generated.ts";
import { stripIconGlyphs } from "../../shared/ui/clean-title.ts";
import { resolveNewTaskDefault } from "../../shared/ui/new-task-default.ts";
import { resolveComposerFiles } from "../files/composer-files.ts";
import { log } from "../log/log.ts";
import type { OmpLaunch } from "../omp/omp-connection.ts";
import { killProcessTree } from "../platform/process-tree.ts";
import { waitWithTimeout } from "../platform/wait-with-timeout.ts";
import { assignToOwnJob } from "../platform/win32/job-object.ts";
import { titleFromPrompt } from "../tasks/convert.ts";
import { initialMachineState, transition, type MachineInput, type MachineState } from "../tasks/task-machine.ts";
import type { TaskRecord } from "../tasks/task-registry.ts";
import { TooManyTasksError, type NewTaskDefaults, type TspRunnerHost } from "../tasks/tsp-runner.ts";
import { resolveTouchedWorkspaceDir, WorkspaceDirs } from "../tasks/workspace-dirs.ts";
import { holdSessionFile, readSessionFile, type SessionFileState } from "../tsp/session-files.ts";
import {
  buildTreeFromEntries,
  findUserEntry,
  isLabellableEntry,
  readSessionEntries,
  type LeafOverride,
  type RewindTarget,
} from "../tsp/session-tree-file.ts";
import { resolveAgentDir } from "../history/session-index.ts";
import {
  listPiMcpServers,
  listPiSkills,
  readPiSettingsObject,
  piSettingsFilePath,
  readPiSystemDoc,
} from "../pi-config/index.ts";
import { discoverPi, formatError as errorMessage, type PiLaunch } from "./discover.ts";
import { analyzeSessionBranchTokens, estTextTokens } from "./pi-context-estimate.ts";
import { revertSessionFileChangesFromFile } from "./revert-session-files.ts";
import { rewindSessionFileBefore } from "./pi-session-rewind.ts";
import {
  PiRpcClient,
  type PiAgentMessage,
  type PiImageContent,
  type PiRpcEvent,
  type PiSessionStats,
} from "./pi-rpc-client.ts";
import {
  extractEfforts,
  toAvailableSlashCommand,
  toModelOption,
  toThinkingLevel,
  toThinkingLevelsList,
} from "./pi-service.ts";
import { PI_SURFACE_ID, PiTspBridge } from "./pi-tsp-bridge.ts";

const execFileAsync = promisify(execFile);

const EXPORT_TIMEOUT_MS = 30_000;
const STDERR_LINES_IN_ERROR = 8;
/** `compaction.reserveTokens` 的 schema 默认值：全局、项目级与模型覆盖都没配时用它。 */
const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

const modelKeyOf = (model: ModelOption): string => `${model.key.provider}/${model.key.modelId}`;

/** 一个模型的身份 + 能力：档位（`thinkingLevelMap` 推出来的）或上下文变了，也算目录变了。 */
function modelSignature(model: ModelOption): string {
  return [
    modelKeyOf(model),
    model.reasoning ? "reasoning" : "plain",
    (model.thinkingEfforts ?? []).join(","),
    model.contextWindow ?? "",
    model.maxTokens ?? "",
  ].join("|");
}

/** 整份目录的指纹（按签名排序，和顺序无关）。 */
export function catalogSignature(models: readonly ModelOption[]): string {
  return models.map(modelSignature).sort().join("\n");
}

/** 服务进程（现读 models.json）的目录里，每个模型及其能力活进程都有：这个进程的模型快照还够新。 */
export function catalogCovers(processCatalog: readonly ModelOption[], freshCatalog: readonly ModelOption[]): boolean {
  const known = new Set(processCatalog.map(modelSignature));
  return freshCatalog.every((model) => known.has(modelSignature(model)));
}

/**
 * 进程还忙、不能重开时的选择器列表：现读的目录在前（新的 provider / 模型能看见、能力也对），
 * 活进程多出来的（比如 llama.cpp 按需加载的）接在后面。同一个 key 只留一份。
 */
export function mergeModelCatalogs(
  processCatalog: readonly ModelOption[],
  freshCatalog: readonly ModelOption[],
): ModelOption[] {
  const merged = [...freshCatalog];
  const keys = new Set(freshCatalog.map(modelKeyOf));
  for (const model of processCatalog) {
    if (!keys.has(modelKeyOf(model))) merged.push(model);
  }
  return merged;
}

/** Pi 的 `set_model` 在进程的模型表里找不到这个模型时回的错（`Model not found: provider/id`）。 */
function isUnknownModelError(error: unknown): boolean {
  return error instanceof Error && /model not found/i.test(error.message);
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `compaction.modelOverrides`：键是精确的 `provider/modelId`。 */
function compactionModelOverrides(compaction: unknown): Record<string, unknown> {
  return objectOrNull(objectOrNull(compaction)?.["modelOverrides"]) ?? {};
}

/**
 * 合并生效的压缩预留 token 数：全局 `compaction` → 项目级 `compaction` 覆盖 →
 * 命中当前模型的 `modelOverrides["provider/modelId"]` 再覆盖。都是纯函数，方便单测。
 */
export function resolveCompactionReserveTokens(
  globalCompaction: unknown,
  projectCompaction: unknown,
  modelKey: ModelKey | null,
): number {
  const overrides = { ...compactionModelOverrides(globalCompaction), ...compactionModelOverrides(projectCompaction) };
  const modelOverride = modelKey === null ? null : overrides[`${modelKey.provider}/${modelKey.modelId}`];
  return (
    nonNegativeNumber(objectOrNull(modelOverride)?.["reserveTokens"]) ??
    nonNegativeNumber(objectOrNull(projectCompaction)?.["reserveTokens"]) ??
    nonNegativeNumber(objectOrNull(globalCompaction)?.["reserveTokens"]) ??
    DEFAULT_COMPACTION_RESERVE_TOKENS
  );
}

/**
 * 自动压缩触发点（已用上下文占窗口的百分比）：窗口减掉预留后还剩多少可用比例。
 * 窗口或预留不可用（非数字、窗口 ≤ 0、预留 < 0 或 ≥ 窗口）时返回 null，不编一个假刻度。
 */
export function autoCompactionPercent(contextWindow: number, reserveTokens: number): number | null {
  if (!Number.isFinite(contextWindow) || !Number.isFinite(reserveTokens)) return null;
  if (contextWindow <= 0 || reserveTokens < 0 || reserveTokens >= contextWindow) return null;
  return Math.max(1, Math.min(99, Math.round(((contextWindow - reserveTokens) / contextWindow) * 100)));
}

export interface PiTaskRunnerHost extends Omit<TspRunnerHost, "buildLaunch" | "session"> {
  buildPiLaunch?(record: TaskRecord, project: Project): Promise<PiLaunch>;
  buildLaunch?(record: TaskRecord, project: Project): Promise<OmpLaunch>;
  session?: TspRunnerHost["session"] | undefined;
}

class StartError extends Error {
  readonly taskError: TaskError;

  constructor(taskError: TaskError) {
    super(taskError.message);
    this.taskError = taskError;
  }
}

interface ActiveBtwProcess {
  recordId: string;
  child: ChildProcess;
  releaseJob: () => void;
  cancelled: boolean;
}

export class PiTaskRunner {
  readonly id: TaskId;
  #record: TaskRecord;
  readonly #project: Project;
  readonly #host: PiTaskRunnerHost;

  #machine: MachineState = initialMachineState("stopped");
  readonly #bridge: PiTspBridge;
  #client: PiRpcClient | null = null;
  #gen = 0;
  #starting: Promise<void> | null = null;
  #closing = false;
  #disposed = false;
  #snapshotReleased = false;

  #lastActiveAt = Date.now();
  #runStartedAt = 0;
  #activityAt: number;
  #stopRequested = false;
  #lastStopAborted = false;
  #lastRunError: string | null = null;
  #agentLifecycleSeq = 0;
  #publishedRestartable = true;

  #model: ModelOption | null;
  #thinkingLevel: ThinkingLevel | null;
  #thinkingLevels: ThinkingLevel[] = ["off"];
  #contextUsage: ContextUsage | null = null;
  #postCompactionTokens: number | null = null;
  #compactionState: "running" | "ready" | null = null;
  #sessionUsage: TaskState["sessionUsage"] = null;
  #autoCompactionEnabled = true;
  /** readContext 时刷新的合并后预留 token 数（全局 → 项目级 → 当前模型覆盖）；null = 还没算过。 */
  #compactionReserveTokens: number | null = null;
  #catalog: ModelOption[] = [];
  /** 为了哪份目录指纹重开过进程：同一份目录重开后还差（例如按需发现的模型）就不再反复重开。 */
  #restartedCatalog: string | null = null;
  #newTaskDefault: { model: ModelOption | null; thinkingLevel: ThinkingLevel | null } = {
    model: null,
    thinkingLevel: null,
  };

  readonly #toggles: SessionToggles = emptySessionToggles();
  readonly #workspace = new WorkspaceDirs();
  #extStatuses: string[] = [];
  #fallbackModel: string | null = null;
  #credentialPins: Readonly<Record<string, string>> = {};

  #sessionFile: string | null | undefined = undefined;
  #persistingSessionFile = false;
  #heldSessionFile: { file: string; release: () => void } | null = null;
  #leafOverride: LeafOverride | null = null;
  #provisionalTitle: string | null = null;
  #adoptedTitle: string | null = null;
  #initialHydration: Promise<void> | null = null;

  #btwRecords: readonly BtwHistoryRecord[] = [];
  #activeBtw: ActiveBtwProcess | null = null;

  constructor(record: TaskRecord, project: Project, host: PiTaskRunnerHost) {
    this.id = record.id;
    this.#record = record;
    this.#activityAt = record.updatedAt;
    this.#project = project;
    this.#host = host;

    const key = record.model;
    this.#model = key
      ? (host.knownModels?.().find((m) => m.key.provider === key.provider && m.key.modelId === key.modelId) ?? {
          key,
          name: key.modelId,
          contextWindow: null,
          reasoning: false,
          acceptsImages: false,
          maxTokens: null,
          thinkingEfforts: null,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          intelligence: null,
          catalogTps: null,
        })
      : null;
    this.#thinkingLevel = record.thinkingLevel;
    if (this.#model?.thinkingEfforts && this.#model.thinkingEfforts.length > 0) {
      this.#thinkingLevels = ["off", ...this.#model.thinkingEfforts];
    }

    this.#bridge = new PiTspBridge(record.title !== "" ? record.title : "pi");

    // Forward incremental TSP frames to TaskPool / renderer!
    this.#bridge.onFrames((messages, firstSeq) => {
      if (this.#disposed || messages.length === 0) return;
      this.#snapshotReleased = false;
      this.#host.onTspBatch({
        taskId: this.id,
        firstSeq,
        messages,
      });
      this.#syncDialogAndWorkingFromDoc();
    });

    this.#bridge.onEditorPrefill((text) => {
      if (!this.#disposed) {
        this.#host.onComposerPrefill?.(this.id, { text });
      }
    });

    this.#bridge.onTitleChange((title) => {
      this.#adoptTitle(title);
    });

    this.#bridge.onTouchedPath((targetPath) => {
      if (this.#disposed) return;
      const wsDir = resolveTouchedWorkspaceDir(targetPath, this.cwd);
      if (wsDir !== null && this.#workspace.addDir(wsDir, this.cwd)) {
        this.#publish();
      }
    });

    // Hydrate immediately from `record.sessionFile` on construction so stopped tasks render history right away!
    if (record.sessionFile !== null && record.sessionFile !== "") {
      this.#initialHydration = this.#hydrateInitialSession(record.sessionFile);
    }
  }

  async #hydrateInitialSession(sessionFile: string): Promise<void> {
    try {
      await this.#bridge.hydrateFromSessionFile(sessionFile);
      await this.#readSessionFile();
    } catch (error) {
      log.warn(`task ${this.id} initial session hydration failed`, { message: errorMessage(error) });
    }
  }

  // ───────── Public Getters ─────────

  get record(): TaskRecord {
    return this.#record;
  }

  get status(): TaskState["status"] {
    return this.#machine.status;
  }

  get hasProcess(): boolean {
    return this.#client !== null && this.#client.alive;
  }

  get lastActiveAt(): number {
    return this.#lastActiveAt;
  }

  get keepAlive(): boolean {
    return this.#record.keepAlive === true;
  }

  get recyclable(): boolean {
    return (
      this.hasProcess &&
      this.#machine.status === "idle" &&
      this.#machine.dialogs.length === 0 &&
      !isBtwRunning(this.#btwRecords)
    );
  }

  get restartable(): boolean {
    const status = this.#machine.status;
    return status === "stopped" || status === "error" || this.recyclable;
  }

  get prNumber(): number | null {
    return null;
  }

  get cwd(): string {
    return this.#record.cwd ?? this.#record.worktreePath ?? this.#project.path;
  }

  get workspaceDirs(): readonly string[] {
    return this.#workspace.dirs;
  }

  get state(): TaskState {
    const m = this.#machine;
    return {
      id: this.id,
      projectId: this.#record.projectId,
      title: this.#record.title,
      status: m.status,
      unread: m.unread,
      lastTurn: m.lastTurn,
      error: m.error,
      createdAt: this.#record.createdAt,
      updatedAt: this.#activityAt,
      model: this.#model ?? this.#newTaskDefault.model,
      thinkingLevel: this.#thinkingLevel ?? this.#record.thinkingLevel ?? this.#newTaskDefault.thinkingLevel,
      thinkingLevels: this.#thinkingLevels,
      contextUsage: this.#contextUsage,
      sessionUsage: this.#sessionUsage,
      dialogs: m.dialogs,
      todoPhases: [],
      workspaceDirs: this.#workspace.dirs,
      cwd: this.cwd,
      worktreeBranch: this.#record.worktreeBranch,
      runStartedAt: m.working ? this.#runStartedAt : null,
      fastMode: { enabled: false, active: false },
      slowMode: { supported: false, enabled: false, scope: null },
      sessionToggles: this.#toggles,
      goal: null,
      restartable: this.restartable,
      loaderText: null,
      prNumber: null,
      contextCompaction: this.#autoCompactionEnabled ? this.#contextCompactionInfo() : null,
      composerMode: null,
      extStatuses: this.#extStatuses,
      keepAlive: this.keepAlive,
      fallbackModel: this.#fallbackModel,
      credentialPins: this.#credentialPins,
    };
  }

  get hasSnapshot(): boolean {
    return !this.hasProcess && !this.#snapshotReleased && this.#bridge.seq > 2;
  }

  releaseSnapshot(): void {
    if (!this.hasProcess) {
      this.#snapshotReleased = true;
    }
  }

  tspSnapshot(): TspSnapshot {
    this.#snapshotReleased = false;
    return {
      taskId: this.id,
      seq: this.#bridge.seq,
      document: snapshotDocument(this.#bridge.document),
    };
  }

  tspSeq(): number {
    return this.#bridge.seq;
  }

  tspBlob(id: string): DocBlob | null {
    return this.#bridge.document.blobs.get(id.toLowerCase()) ?? null;
  }

  markRead(): void {
    this.#apply({ type: "mark_read" });
  }

  // ───────── Lifecycle (`start`, `close`, `restart`, `dispose`) ─────────

  start(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("task was removed"));
    if (this.#client !== null && this.#client.alive && this.#machine.status !== "starting") {
      return Promise.resolve();
    }
    this.#starting ??= this.#startInternal().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #startInternal(): Promise<void> {
    if (this.#machine.status !== "stopped" && this.#machine.status !== "error") {
      throw new Error(`cannot start a task that is ${this.#machine.status}`);
    }
    this.#closing = false;
    this.#stopRequested = false;
    this.#lastStopAborted = false;
    this.#lastRunError = null;
    this.#agentLifecycleSeq = 0;
    this.#apply({ type: "start" });

    let client: PiRpcClient | null = null;
    try {
      if (this.#initialHydration !== null) {
        await this.#initialHydration;
        this.#initialHydration = null;
      }

      const worktreePath = this.#record.worktreePath;
      if (
        worktreePath !== null &&
        !(await stat(worktreePath).then(
          () => true,
          () => false,
        ))
      ) {
        throw new StartError({ kind: "worktree_missing", message: "the task's worktree no longer exists" });
      }

      const sessionFile = this.#record.sessionFile;
      if (
        sessionFile !== null &&
        !(await stat(sessionFile).then(
          () => true,
          () => false,
        ))
      ) {
        throw new StartError({ kind: "session_missing", message: "the task's session file no longer exists" });
      }

      const movedTo = this.#record.cwd;
      if (
        movedTo != null &&
        !(await stat(movedTo).then(
          (info) => info.isDirectory(),
          () => false,
        ))
      ) {
        this.#record = await this.#host.persist(this.id, { cwd: null });
      }

      const defaultsPromise = this.#loadNewTaskDefaults();
      await this.#host.acquireSlot(this.id);
      this.#assertNotClosing();

      const launch = await this.#resolvePiLaunch();
      this.#assertNotClosing();

      const gen = ++this.#gen;
      const effectiveThinking =
        this.#record.thinkingLevel !== null && this.#record.thinkingLevel !== "inherit"
          ? this.#record.thinkingLevel
          : undefined;

      client = new PiRpcClient({
        launch,
        cwd: this.cwd,
        sessionFile: this.#record.forkFrom ? undefined : (this.#record.sessionFile ?? undefined),
        forkFrom: this.#record.forkFrom ?? undefined,
        provider: this.#record.model?.provider,
        model: this.#record.model?.modelId,
        thinkingLevel: effectiveThinking,
        sessionName:
          this.#record.title !== "" && !/^[A-Za-z]:?$/.test(this.#record.title.trim()) ? this.#record.title : undefined,
      });

      client.onEvent((event) => {
        if (gen !== this.#gen || this.#disposed) return;
        this.#handleRpcEvent(event);
      });

      client.onExit((exit) => {
        if (gen !== this.#gen) return;
        this.#handleRpcExit(client, exit);
      });

      this.#client = client;

      const state = await client.getState();
      this.#assertNotClosing();

      await this.#applyRpcState(client, state);

      // Hydrate history if starting from `--fork` or if bridge has no user cards yet.
      if (this.#record.forkFrom || this.#bridge.seq <= 2) {
        if (state.sessionFile !== undefined && state.sessionFile !== "") {
          const exists = await stat(state.sessionFile).then(
            () => true,
            () => false,
          );
          if (exists) {
            await this.#bridge.hydrateFromSessionFile(state.sessionFile);
            await this.#readSessionFile();
          } else if (state.messageCount > 0) {
            const { messages } = await client.getMessages();
            this.#bridge.hydrateFromMessages(messages);
          }
        } else if (state.messageCount > 0) {
          const { messages } = await client.getMessages();
          this.#bridge.hydrateFromMessages(messages);
        }
      }

      await defaultsPromise;
      this.#assertNotClosing();

      this.#apply({ type: "ready" });
      if (state.isStreaming) {
        this.#apply({ type: "agent_start" });
      }
      this.#syncDialogAndWorkingFromDoc();
      void this.#refreshCatalog(false);
    } catch (error) {
      if (client !== null) {
        if (this.#client === client) this.#client = null;
        await client.close(500);
      }
      if (this.#closing || this.#disposed) {
        this.#apply({ type: "stopped" });
        throw error;
      }
      const taskError = this.#classifyStartError(error);
      log.warn(`task ${this.id} failed to start pi RPC`, taskError);
      this.#apply({ type: "start_failed", error: taskError });
      throw error;
    }
  }

  async close(timeoutMs = 5_000): Promise<void> {
    this.#closing = true;
    const starting = this.#starting;
    if (starting !== null) {
      await waitWithTimeout(starting, timeoutMs);
    }
    const client = this.#client;
    if (client === null) {
      if (this.#machine.status !== "stopped") {
        this.#apply({ type: "stopped" });
      }
      return;
    }
    await this.#persistSessionFile();
    await client.close(timeoutMs);
  }

  async restart(): Promise<void> {
    if (!this.restartable) {
      throw new Error("the task is busy; restart it when it is idle");
    }
    await this.close();
    await this.start();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.cancelBtw();
    await this.close(1_500);
    this.#heldSessionFile?.release();
    this.#heldSessionFile = null;
  }

  async setArchived(archived: boolean): Promise<void> {
    this.#record = await this.#host.persist(this.id, { archived });
  }

  async setKeepAlive(keepAlive: boolean): Promise<void> {
    this.#record = await this.#host.persist(this.id, { keepAlive });
    this.#publish();
  }

  async rename(title: string): Promise<void> {
    this.#provisionalTitle = null;
    this.#adoptedTitle = null;
    this.#record = await this.#host.persist(this.id, { title });
    this.#publish();
    const client = this.#client;
    if (client !== null && client.alive) {
      try {
        await client.setSessionName(title);
        return;
      } catch (error) {
        log.warn(`task ${this.id} set_session_name failed`, { message: errorMessage(error) });
      }
    }
    const sessionFile = this.#sessionFile ?? this.#record.sessionFile;
    if (sessionFile !== null && sessionFile !== undefined && sessionFile !== "") {
      const entryLine = `${JSON.stringify({
        type: "session_info",
        id: randomUUID().slice(0, 8),
        timestamp: new Date().toISOString(),
        name: title,
      })}\n`;
      await appendFile(sessionFile, entryLine, "utf8").catch(() => {});
    }
  }

  // ───────── Prompting, Stopping, TSP Events & Keys ─────────

  async sendPrompt(input: PromptInput): Promise<void> {
    const resolvedFiles = input.fileIds ? await resolveComposerFiles(input.fileIds) : [];
    const body = fillFileSlots(input.text, resolvedFiles);

    if (this.#machine.error?.kind === "session_missing") {
      this.#record = await this.#host.persist(this.id, { sessionFile: null });
      this.#sessionFile = undefined;
    }

    await this.start();
    const client = this.#requireClient();

    if (this.#record.title === "") {
      this.#provisionalTitle = titleFromPrompt(body);
      this.#record = await this.#host.persist(this.id, { title: this.#provisionalTitle });
      this.#publish();
      void client.setSessionName(this.#provisionalTitle).catch(() => {});
    }

    const piImages: PiImageContent[] =
      input.images?.map((img) => ({
        type: "image",
        data: img.data,
        mimeType: img.mimeType,
      })) ?? [];

    const now = Date.now();
    this.#touch(now);
    this.#lastActiveAt = now;
    this.#leafOverride = null;

    // If an interactive extension dialog is open in `dock.dialog`, answer/deny it first.
    if (this.#bridge.hasActiveDialog) {
      this.sendTspEvent({ ev: "send", sf: PI_SURFACE_ID, id: "composer", text: body });
      if (!this.#machine.working) return;
    }

    const isBusy = this.#machine.working;
    if (!isBusy) {
      this.#stopRequested = false;
      this.#lastStopAborted = false;
      this.#lastRunError = null;
      this.#bridge.appendOptimisticUserMessage(body, piImages);
      const lifecycleBefore = this.#agentLifecycleSeq;
      const ack = await client.prompt(body, { images: piImages });
      // On POSIX pipes, `response`, `agent_start`, and `agent_end` can coalesce into a single stdout chunk
      // and run synchronously before `await client.prompt(...)` resumes its microtask. Only apply optimistic
      // `agent_start` if no lifecycle event has fired since issuing `prompt`.
      if (
        this.#agentLifecycleSeq === lifecycleBefore &&
        (ack?.disposition === undefined || ack.disposition === "started") &&
        !this.#machine.working
      ) {
        this.#apply({ type: "agent_start" });
      }
      return;
    }

    // Agent is streaming: dispatch extension commands via `prompt` with `streamingBehavior`,
    // and regular user prompts via `followUp` or `steer`.
    if (body.trimStart().startsWith("/")) {
      await client.prompt(body, {
        images: piImages,
        streamingBehavior: input.whenBusy,
      });
    } else if (input.whenBusy === "followUp") {
      await client.followUp(body, { images: piImages });
    } else {
      await client.steer(body, { images: piImages });
    }
  }

  async stop(): Promise<RestoredQueue> {
    const client = this.#client;
    const steering: RestoredDraft[] = [];
    const followUp: RestoredDraft[] = [];

    if (client !== null && client.alive) {
      this.#stopRequested = true;
      if (this.#bridge.hasActiveDialog) {
        this.sendTspKeys("\x1b");
      }
      try {
        const cleared = await client.clearQueue();
        for (const text of cleared.steering) steering.push({ text });
        for (const text of cleared.followUp) followUp.push({ text });
      } catch {
        // Ignore queue clear errors if idle.
      }
      if (this.#machine.working) {
        try {
          await client.abort();
        } catch (error) {
          log.warn(`task ${this.id} abort failed`, { message: errorMessage(error) });
        }
      }
    }

    return {
      steering,
      followUp,
      imagesDropped: false,
      truncated: false,
      aborted: true,
      backgroundWork: false,
    };
  }

  sendTspEvent(event: TspEvent): void {
    this.#lastActiveAt = Date.now();
    const res = this.#bridge.handleTspEventDetailed(event);
    if (res === null) return;

    if (res.kind === "extension_ui_response") {
      this.#client?.sendExtensionUiResponse(res.response);
      this.#syncDialogAndWorkingFromDoc();
    } else if (res.kind === "interrupt") {
      void this.stop();
    } else if (res.kind === "rewind" && res.entryId !== undefined) {
      void this.rewindTo(res.entryId).then(({ text, images }) => {
        if (text !== "" || (images !== undefined && images.length > 0)) {
          this.#host.onComposerPrefill?.(this.id, {
            text,
            ...(images !== undefined && images.length > 0 ? { images } : {}),
          });
        }
      });
    }
  }

  sendTspKeys(data: string): void {
    this.#lastActiveAt = Date.now();
    const response = this.#bridge.handleTspKeys(data);
    if (response !== null) {
      this.#client?.sendExtensionUiResponse(response);
      this.#syncDialogAndWorkingFromDoc();
    }
  }

  resizeTsp(_cols: number): void {
    // Pure JSONL RPC requires no PTY column resize.
  }

  setAppearance(_next: { dark: boolean; reduceMotion: boolean }): void {
    // Theme/motion styling is handled natively in React `TspView`.
  }

  // ───────── Models, Thinking, Context & Slash Commands ─────────

  /**
   * 这个任务的模型选择器列表。Pi 进程只在启动时读一次 `models.json`（`ModelRuntime.create` → `ModelConfig.load`），
   * `get_available_models` 是那一刻的快照：新增了 provider / 模型（或者给模型补了 xhigh/max 的 thinkingLevelMap）之后，
   * 还跑着的旧会话只能看到旧目录。这里拿服务进程现读的目录比一下，空闲就把进程重开（同一个会话文件）。
   */
  async listModels(): Promise<ModelOption[]> {
    const client = this.#client;
    if (client === null || !client.alive) return this.#refreshCatalog(true);

    const processCatalog = await this.#readProcessCatalog(client);
    if (processCatalog === null) return this.#refreshCatalog(true);

    // 先拿启动缓存里的目录比（指纹没变就不起服务进程）；缓存没盯上变化时（刚改完 models.json）再现读。
    const cached = await this.#refreshCatalog(false);
    if (cached.length > 0 && catalogCovers(processCatalog, cached)) {
      this.#catalog = processCatalog;
      return processCatalog;
    }

    const fresh = await this.#refreshCatalog(true);
    if (fresh.length === 0 || catalogCovers(processCatalog, fresh)) {
      this.#catalog = processCatalog;
      return processCatalog;
    }

    const signature = catalogSignature(fresh);
    if (this.restartable && this.#restartedCatalog !== signature) {
      try {
        await this.restart();
        this.#restartedCatalog = signature;
        const restarted = this.#client;
        const reloaded = restarted !== null && restarted.alive ? await this.#readProcessCatalog(restarted) : null;
        if (reloaded !== null) {
          this.#catalog = mergeModelCatalogs(reloaded, fresh);
          return this.#catalog;
        }
      } catch (error) {
        log.warn(`task ${this.id} restart to pick up new models failed`, { message: errorMessage(error) });
      }
    }

    // 还在跑（不能重开），或者同一份目录重开过一次还是差：先把现读的目录显示出来，选新模型时会再重开一次。
    this.#catalog = mergeModelCatalogs(processCatalog, fresh);
    return this.#catalog;
  }

  async #readProcessCatalog(client: PiRpcClient): Promise<ModelOption[] | null> {
    try {
      const { models } = await client.getAvailableModels();
      return models.map((m) => toModelOption(m));
    } catch (error) {
      log.warn(`task ${this.id} get_available_models failed`, { message: errorMessage(error) });
      return null;
    }
  }

  async setModel(key: ModelKey): Promise<void> {
    await this.start();
    let client = this.#requireClient();
    let updated;
    try {
      updated = await client.setModel(key.provider, key.modelId);
    } catch (error) {
      // 进程启动后才加的模型：Pi 的模型表是启动时读的，set_model 会说 Model not found。
      // 空闲时重开进程（同一个会话文件）再设一次；正在跑时不动进程（会让当前回复失败）。
      if (!isUnknownModelError(error) || !this.restartable) throw error;
      await this.restart();
      client = this.#requireClient();
      updated = await client.setModel(key.provider, key.modelId);
    }
    const { levels } = await client.getAvailableThinkingLevels();
    const efforts = extractEfforts(levels);
    this.#model = toModelOption(updated, efforts);
    this.#thinkingLevels = toThinkingLevelsList(levels, updated);
    this.#record = await this.#host.persist(this.id, { model: key });
    await this.#syncStats(client);
    this.#publish();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.start();
    const client = this.#requireClient();
    const wireLevel = level === "inherit" ? "medium" : level;
    await client.setThinkingLevel(wireLevel);
    this.#thinkingLevel = level;
    this.#record = await this.#host.persist(this.id, { thinkingLevel: level });
    this.#publish();
  }

  async sessionExtras(): Promise<TspSessionExtras> {
    try {
      const state = await this.#readSessionFile();
      return state?.extras.result() ?? { turns: [], tokensPerSecond: null };
    } catch {
      return { turns: [], tokensPerSecond: null };
    }
  }

  /** 自动压缩刻度：按当前模型窗口与合并后的 reserveTokens 算；刻度算不出时仍保留 summary 状态。 */
  #contextCompactionInfo(): NonNullable<TaskState["contextCompaction"]> | null {
    const percent = autoCompactionPercent(
      this.#fallbackContextWindow(),
      this.#compactionReserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS,
    );
    if (percent === null && this.#compactionState === null) return null;
    return { autoAtPercent: percent, summaryStartsAtPercent: null, summary: this.#compactionState };
  }

  #fallbackContextWindow(): number {
    const explicit =
      this.#contextUsage?.contextWindow ?? this.#model?.contextWindow ?? this.#newTaskDefault.model?.contextWindow ?? 0;
    if (explicit > 0) return explicit;
    const modelId = (
      this.#model?.key.modelId ??
      this.#record.model?.modelId ??
      this.#newTaskDefault.model?.key.modelId ??
      ""
    ).toLowerCase();
    if (modelId.includes("gemini")) return 1_000_000;
    return 200_000;
  }

  async readContext(): Promise<ContextReport | null> {
    if (this.#client !== null && this.#client.alive) {
      await this.#syncStats(this.#client);
    }
    const windowSize = this.#fallbackContextWindow();
    if (windowSize <= 0) {
      return null;
    }

    const estTokens = estTextTokens;
    const agentDir = resolveAgentDir();

    // 1. 系统提示词、指令文档 (AGENTS.md / SYSTEM.md)、Skills 与工具定义估算
    let sysTokens = 1180;
    let skillsTokens = 0;
    let builtInToolsTokens = 1520;
    let customToolsTokens = 0;
    let configuredReserve = DEFAULT_COMPACTION_RESERVE_TOKENS;

    try {
      const hasProjectDir = this.cwd.trim() !== "";
      const [globalSettings, projectSettings, globalAgents, projAgents, globalSys, skills, mcpServers] =
        await Promise.all([
          readPiSettingsObject(piSettingsFilePath(agentDir, "global"), false),
          hasProjectDir
            ? readPiSettingsObject(piSettingsFilePath(agentDir, "project", this.cwd), false).catch(() => ({
                exists: false,
                data: {} as Record<string, unknown>,
              }))
            : Promise.resolve({ exists: false, data: {} as Record<string, unknown> }),
          readPiSystemDoc(agentDir, null, "global", "AGENTS.md"),
          readPiSystemDoc(agentDir, this.cwd, "project", "AGENTS.md").catch(() => ({ content: "" })),
          readPiSystemDoc(agentDir, null, "global", "SYSTEM.md"),
          listPiSkills(agentDir, this.cwd).catch(() => []),
          listPiMcpServers(agentDir, this.cwd).catch(() => []),
        ]);
      sysTokens += estTokens(globalAgents.content) + estTokens(projAgents.content) + estTokens(globalSys.content);
      const enabledSkills = skills.filter((s) => !s.disabled);
      skillsTokens = enabledSkills.reduce((acc, s) => acc + 24 + estTokens(s.name) + estTokens(s.description ?? ""), 0);
      const enabledMcp = mcpServers.filter((m) => m.enabled && m.exposure !== "hidden");
      customToolsTokens = enabledMcp.length * 260;
      // 生效配置：全局 compaction → 项目级 compaction 覆盖 → 当前模型 modelOverrides 再覆盖。
      const currentModel = this.#model ?? this.#newTaskDefault.model ?? null;
      const modelKey: ModelKey | null = currentModel?.key ?? this.#record.model ?? null;
      configuredReserve = resolveCompactionReserveTokens(
        globalSettings.data["compaction"],
        projectSettings.data["compaction"],
        modelKey,
      );
      this.#compactionReserveTokens = configuredReserve;
    } catch {
      // ignore config read errors
    }

    // 2. 会话消息与工具调用拆解（兼容 dsh-compact / /compact 压缩摘要及未启动 RPC 的历史会话）
    let userTokens = 0;
    let assistantTokens = 0;
    let thinkingTokens = 0;
    let toolCallTokens = 0;
    let toolOutputTokens = 0;
    let compactionTokens = 0;

    const baseOverhead = sysTokens + skillsTokens + builtInToolsTokens + customToolsTokens;
    let branchAnalysisTokens = 0;

    if (this.#client !== null && this.#client.alive) {
      let messages: PiAgentMessage[] = [];
      try {
        const res = await this.#client.getMessages();
        messages = res.messages;
      } catch {
        messages = [];
      }

      for (const msg of messages) {
        if (msg.role === "user") {
          if (typeof msg.content === "string") {
            userTokens += estTokens(msg.content);
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text") userTokens += estTokens(part.text);
              else if (part.type === "image") userTokens += 850;
            }
          }
        } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "text") assistantTokens += estTokens(part.text);
            else if (part.type === "thinking") thinkingTokens += estTokens(part.thinking);
            else if (part.type === "toolCall") {
              toolCallTokens += 16 + estTokens(part.name) + estTokens(JSON.stringify(part.arguments ?? {}));
            }
          }
        } else if (msg.role === "toolResult" && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "text") toolOutputTokens += estTokens(part.text);
            else if (part.type === "image") toolOutputTokens += 850;
          }
        } else if (msg.role === "bashExecution") {
          if (!msg.excludeFromContext) {
            toolOutputTokens += estTokens(msg.command) + estTokens(msg.output);
          }
        } else if (msg.role === "compactionSummary" || msg.role === "branchSummary") {
          compactionTokens += estTokens(msg.summary ?? "");
        } else if (msg.role === "custom") {
          if (typeof msg.content === "string") {
            userTokens += estTokens(msg.content);
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text") userTokens += estTokens(part.text);
            }
          }
        }
      }
      if (compactionTokens === 0) {
        const branch = await analyzeSessionBranchTokens(this.#currentSessionFile(), baseOverhead);
        if (branch !== null && branch.compactionTokens > 0) {
          compactionTokens = branch.compactionTokens;
          branchAnalysisTokens = branch.estimatedTotalTokens;
        }
      }
    } else {
      const branch = await analyzeSessionBranchTokens(this.#currentSessionFile(), baseOverhead);
      if (branch !== null) {
        userTokens = branch.userTokens;
        assistantTokens = branch.assistantTokens;
        thinkingTokens = branch.thinkingTokens;
        toolCallTokens = branch.toolCallTokens;
        toolOutputTokens = branch.toolOutputTokens;
        compactionTokens = branch.compactionTokens;
        branchAnalysisTokens = branch.estimatedTotalTokens;
      }
    }

    const rawUsed =
      baseOverhead +
      compactionTokens +
      userTokens +
      assistantTokens +
      thinkingTokens +
      toolCallTokens +
      toolOutputTokens;

    const reportedUsed = Math.max(0, this.#contextUsage?.tokens ?? branchAnalysisTokens);
    const used = reportedUsed > 0 ? reportedUsed : rawUsed;
    const scale = reportedUsed > 0 && rawUsed > 0 ? reportedUsed / rawUsed : 1;
    const scaled = (v: number) => Math.round(v * scale);

    const reserve = this.#autoCompactionEnabled ? Math.min(Math.max(0, windowSize - used), configuredReserve) : 0;
    const free = Math.max(0, windowSize - used - reserve);

    return {
      rows: [
        { key: "piSystemPrompt", label: "系统提示词与指令", tokens: scaled(sysTokens) },
        { key: "piSkills", label: "Skills 索引", tokens: scaled(skillsTokens) },
        { key: "builtInTools", label: "内置工具定义", tokens: scaled(builtInToolsTokens) },
        ...(customToolsTokens > 0
          ? [{ key: "customTools", label: "MCP 与扩展工具", tokens: scaled(customToolsTokens) }]
          : []),
        ...(compactionTokens > 0
          ? [{ key: "compactionSummary", label: "压缩摘要", tokens: scaled(compactionTokens) }]
          : []),
        { key: "userMessages", label: "用户消息", tokens: scaled(userTokens) },
        { key: "assistantMessages", label: "助手回复", tokens: scaled(assistantTokens) },
        ...(thinkingTokens > 0
          ? [{ key: "assistantThinking", label: "思考过程", tokens: scaled(thinkingTokens) }]
          : []),
        { key: "toolCalls", label: "工具调用", tokens: scaled(toolCallTokens) },
        { key: "toolOutput", label: "工具返回结果", tokens: scaled(toolOutputTokens) },
        { key: "free", label: "Free context", tokens: free },
        ...(reserve > 0 ? [{ key: "buffer", label: "Auto-compaction buffer", tokens: reserve }] : []),
      ],
      used,
      window: windowSize,
    };
  }

  async listSlashCommands(): Promise<AvailableSlashCommand[]> {
    const client = this.#client;
    if (client !== null && client.alive) {
      try {
        const { commands } = await client.getCommands();
        return commands.map(toAvailableSlashCommand);
      } catch {
        // Fall back to host service.
      }
    }
    if (this.#host.listSlashCommands !== undefined) {
      return this.#host.listSlashCommands(this.cwd);
    }
    return [];
  }

  async compact(customInstructions?: string): Promise<void> {
    await this.start();
    const client = this.#requireClient();
    await client.compact(customInstructions);
    await this.#syncStats(client);
    await this.#persistSessionFile();
  }

  async exportHtml(outputPath: string): Promise<string> {
    if (!path.isAbsolute(outputPath)) {
      throw new Error("export path must be absolute");
    }
    const client = this.#client;
    if (client !== null && client.alive) {
      const res = await client.exportHtml(outputPath);
      return res.path;
    }

    const file = this.#currentSessionFile();
    if (file === null) {
      throw new Error("this task has no session file yet");
    }

    if (this.#host.exportSession !== undefined) {
      await this.#host.exportSession(file, outputPath, this.cwd);
      return outputPath;
    }

    const launch = await this.#resolvePiLaunch();
    await execFileAsync(launch.command, [...launch.prefixArgs, "--export", file, outputPath], {
      cwd: this.cwd,
      env: { ...process.env, ...launch.env },
      windowsHide: true,
      timeout: EXPORT_TIMEOUT_MS,
    });
    return outputPath;
  }

  // ───────── Session Tree, Fork, Rewind, Clone & Labels ─────────

  async getSessionTree(): Promise<SessionTreeView> {
    const file = this.#currentSessionFile();
    if (file === null) {
      return { nodes: [] };
    }
    const entries = await readSessionEntries(file);
    return { nodes: buildTreeFromEntries(entries, this.#leafOverride) };
  }

  async prepareFork(entryId: string | null): Promise<{ sourceFile: string; entryId: string; target: RewindTarget }> {
    this.#assertTurnFinished();
    const sourceFile = this.#currentSessionFile();
    if (sourceFile === null) {
      throw new Error("this task has no session file yet");
    }
    const entries = await readSessionEntries(sourceFile);
    let resolvedEntryId = entryId;
    if (resolvedEntryId === null) {
      const nodes = buildTreeFromEntries(entries, this.#leafOverride);
      const lastUser = nodes.findLast((n) => n.kind === "user" && n.onCurrentBranch);
      if (lastUser === undefined) {
        throw new Error("no user message found in session to fork from");
      }
      resolvedEntryId = lastUser.entryId;
    }
    const target = findUserEntry(entries, resolvedEntryId);
    if (target === null) {
      throw new Error(`entry "${resolvedEntryId}" is not a user message`);
    }
    return { sourceFile, entryId: resolvedEntryId, target };
  }

  async rewindTo(
    entryId: string,
    known?: RewindTarget,
    _summarize = false,
    revertFiles = false,
  ): Promise<{ text: string; images?: PromptImage[]; summarized: boolean }> {
    this.#assertTurnFinished();
    await this.start();
    const client = this.#requireClient();

    const beforeFile = this.#currentSessionFile();
    const targetBefore =
      known ??
      (beforeFile !== null
        ? await readSessionEntries(beforeFile)
            .then((entries) => findUserEntry(entries, entryId))
            .catch(() => null)
        : null);

    if (revertFiles && beforeFile !== null) {
      const leafOverride = this.#leafOverride !== null ? this.#leafOverride.leafId : undefined;
      await revertSessionFileChangesFromFile(beforeFile, entryId, this.cwd, leafOverride).catch((err: unknown) => {
        log.warn("revertSessionFileChangesFromFile failed", err);
      });
    }

    if (beforeFile === null) {
      throw new Error("this task has no session file yet");
    }

    // 就地回退（不是分叉）：把会话文件截到这条用户消息之前，再让 pi 重新读同一个文件。
    // pi 的 `fork` 会复制出一份新会话文件，那就是“多出一个一模一样的会话”，不是回退。
    await rewindSessionFileBefore(beforeFile, entryId);
    this.#leafOverride = null;
    const switched = await client.switchSession(beforeFile);
    if (switched.cancelled) {
      throw new Error("rewind was cancelled by an extension");
    }

    const state = await client.getState();
    await this.#applyRpcState(client, state);
    await this.#persistSessionFile();

    const newFile = this.#currentSessionFile();
    if (newFile !== null) {
      await this.#bridge.hydrateFromSessionFile(newFile);
    } else {
      const { messages } = await client.getMessages();
      this.#bridge.hydrateFromMessages(messages);
    }

    const restoredImages = targetBefore?.images;
    return {
      text: targetBefore?.text ?? "",
      ...(restoredImages !== undefined && restoredImages.length > 0 ? { images: restoredImages } : {}),
      summarized: false,
    };
  }

  async clone(): Promise<{ cancelled: boolean; sessionFile: string | null }> {
    this.#assertTurnFinished();
    await this.start();
    const client = this.#requireClient();
    const res = await client.clone();
    if (!res.cancelled) {
      const state = await client.getState();
      await this.#applyRpcState(client, state);
      await this.#persistSessionFile();
    }
    return {
      cancelled: res.cancelled,
      sessionFile: this.#currentSessionFile(),
    };
  }

  async labelEntry(entryId: string, label: string | null): Promise<void> {
    this.#assertTurnFinished();
    const file = this.#currentSessionFile();
    if (file === null) {
      throw new Error("this task has no session file yet");
    }
    const entries = await readSessionEntries(file);
    if (!isLabellableEntry(entries, entryId)) {
      throw new Error(`entry "${entryId}" cannot be labelled`);
    }
    const parentId = entries[entries.length - 1]?.id ?? null;
    const trimmed = label?.trim() ?? "";
    const record: Record<string, unknown> = {
      type: "label",
      id: randomUUID().replace(/-/g, "").slice(0, 8),
      parentId,
      timestamp: new Date().toISOString(),
      targetId: entryId,
      ...(trimmed !== "" ? { label: trimmed } : {}),
    };
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  }

  // ───────── Side-Questions (`/btw`) via `pi -p --no-session --no-tools` ─────────

  async askBtw(question: string, recordId?: string): Promise<string> {
    const trimmed = question.trim();
    if (trimmed === "") {
      throw new Error("side question cannot be empty");
    }
    if (trimmed.length > btwLimits.questionChars) {
      throw new Error(`side question exceeds ${btwLimits.questionChars} characters`);
    }
    if (this.#activeBtw !== null || isBtwRunning(this.#btwRecords)) {
      throw new Error("another side question is already running");
    }

    const launch = await this.#resolvePiLaunch();
    const now = Date.now();
    let topicId: string;
    let promptText = trimmed;

    if (recordId !== undefined) {
      const existing = this.#btwRecords.find((r) => r.id === recordId);
      if (existing === undefined) {
        throw new Error(`side-question topic "${recordId}" not found`);
      }
      topicId = existing.id;
      const priorContext = btwTurns(existing)
        .map((t) => `User: ${t.question}\nAssistant: ${t.answer}`)
        .join("\n\n");
      promptText = `${priorContext}\n\nUser: ${trimmed}`;
      const updatedRecord: BtwHistoryRecord = {
        ...existing,
        updatedAt: now,
        followUps: [
          ...(existing.followUps ?? []),
          {
            question: trimmed,
            answer: "",
            status: "running",
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      this.#emitBtw({ type: "record", record: updatedRecord });
    } else {
      topicId = `btw_${randomUUID().slice(0, 8)}`;
      const createdRecord: BtwHistoryRecord = {
        id: topicId,
        leafId: this.#bridge.hydrationMeta.leafId,
        question: trimmed,
        answer: "",
        status: "running",
        createdAt: now,
        updatedAt: now,
      };
      this.#emitBtw({ type: "record", record: createdRecord });
    }

    const args: string[] = [...launch.prefixArgs, "-p", "--no-session", "--no-tools"];
    const activeModel = this.#model ?? this.#newTaskDefault.model;
    if (activeModel !== null) {
      args.push("--provider", activeModel.key.provider, "--model", activeModel.key.modelId);
    }
    args.push("--", promptText);

    const child = spawn(launch.command, args, {
      cwd: this.cwd,
      env: { ...process.env, ...launch.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const releaseJob = assignToOwnJob(child.pid);
    const active: ActiveBtwProcess = {
      recordId: topicId,
      child,
      releaseJob,
      cancelled: false,
    };
    this.#activeBtw = active;
    this.#syncRestartable();

    const stdoutDecoder = new StringDecoder("utf8");
    let stderrText = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      if (active.cancelled || this.#disposed) return;
      const text = stdoutDecoder.write(chunk);
      if (text !== "") {
        this.#emitBtw({ type: "delta", recordId: topicId, delta: text });
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
      if (stderrText.length > 4_096) {
        stderrText = stderrText.slice(-4_096);
      }
    });

    child.on("close", (code) => {
      const tail = stdoutDecoder.end();
      if (tail !== "" && !active.cancelled && !this.#disposed) {
        this.#emitBtw({ type: "delta", recordId: topicId, delta: tail });
      }
      active.releaseJob();
      if (this.#activeBtw === active) {
        this.#activeBtw = null;
      }

      const current = this.#btwRecords.find((r) => r.id === topicId);
      if (current !== undefined) {
        const finishedAt = Date.now();
        const status = active.cancelled ? "cancelled" : code === 0 ? "complete" : "error";
        const errDetail = status === "error" ? stderrText.trim() || `pi exited with code ${String(code)}` : undefined;

        let finalized: BtwHistoryRecord;
        if (current.followUps && current.followUps.length > 0) {
          const lastIdx = current.followUps.length - 1;
          finalized = {
            ...current,
            updatedAt: finishedAt,
            followUps: current.followUps.map((t, idx) =>
              idx === lastIdx
                ? {
                    ...t,
                    status,
                    updatedAt: finishedAt,
                    ...(errDetail !== undefined ? { error: errDetail } : {}),
                  }
                : t,
            ),
          };
        } else {
          finalized = {
            ...current,
            status,
            updatedAt: finishedAt,
            ...(errDetail !== undefined ? { error: errDetail } : {}),
          };
        }
        this.#emitBtw({ type: "record", record: finalized });
      }
      this.#syncRestartable();
    });

    child.on("error", (err) => {
      active.releaseJob();
      if (this.#activeBtw === active) {
        this.#activeBtw = null;
      }
      const current = this.#btwRecords.find((r) => r.id === topicId);
      if (current !== undefined) {
        const finishedAt = Date.now();
        this.#emitBtw({
          type: "record",
          record: {
            ...current,
            status: "error",
            updatedAt: finishedAt,
            error: errorMessage(err),
          },
        });
      }
      this.#syncRestartable();
    });

    return topicId;
  }

  async cancelBtw(recordId?: string): Promise<boolean> {
    const active = this.#activeBtw;
    if (active === null) return false;
    if (recordId !== undefined && active.recordId !== recordId) return false;

    active.cancelled = true;
    this.#activeBtw = null;
    if (active.child.pid !== undefined) {
      await killProcessTree(active.child.pid);
    }
    active.releaseJob();
    this.#syncRestartable();
    return true;
  }

  getBtw(): Promise<BtwHistoryRecord[]> {
    return Promise.resolve([...this.#btwRecords]);
  }

  // ───────── OMP-Only Compatibility Stubs ─────────

  async runSessionCommand(text: string, _success?: (toast: string) => boolean): Promise<string> {
    const trimmed = text.trim();
    if (/^\/(?:dirs|add-dir|remove-dir)(?:\s|$)/i.test(trimmed)) {
      return this.#handleWorkspaceSlashCommand(trimmed);
    }
    await this.sendPrompt({ text, whenBusy: "steer" });
    return "";
  }

  async runQuietCommand(text: string): Promise<string> {
    const trimmed = text.trim();
    if (/^\/(?:dirs|add-dir|remove-dir)(?:\s|$)/i.test(trimmed)) {
      return this.#handleWorkspaceSlashCommand(trimmed);
    }
    await this.sendPrompt({ text, whenBusy: "steer" });
    return "";
  }

  #handleWorkspaceSlashCommand(trimmed: string): string {
    const addMatch = /^\/add-dir\s+([\s\S]+)$/i.exec(trimmed);
    const removeMatch = /^\/remove-dir\s+([\s\S]+)$/i.exec(trimmed);
    const current = [...this.#workspace.dirs];
    let notice = "";
    if (addMatch) {
      const arg = (addMatch[1] ?? "").trim().replace(/^["']|["']$/g, "");
      if (arg === "") {
        notice = "Usage: /add-dir <path>\n";
      } else {
        const resolved = path.resolve(this.cwd, arg);
        const isDir = existsSync(resolved) && statSync(resolved).isDirectory();
        if (!isDir) {
          return `Directory does not exist: ${arg}`;
        }
        if (
          resolved.toLowerCase() === path.resolve(this.cwd).toLowerCase() ||
          current.some((d) => path.resolve(d).toLowerCase() === resolved.toLowerCase())
        ) {
          return `Already in the workspace: ${resolved}`;
        }
        current.push(resolved);
        notice = `Added ${resolved}.\n`;
      }
    } else if (removeMatch) {
      const arg = (removeMatch[1] ?? "").trim().replace(/^["']|["']$/g, "");
      if (arg === "") {
        return "Usage: /remove-dir <path>";
      }
      const resolvedArg = path.resolve(this.cwd, arg).toLowerCase();
      const idx = current.findIndex(
        (d) => d.toLowerCase() === arg.toLowerCase() || path.resolve(d).toLowerCase() === resolvedArg,
      );
      if (idx === -1) {
        return `Not a workspace directory: ${arg}`;
      }
      const [removed] = current.splice(idx, 1);
      notice = `Removed ${removed}.\n`;
    } else if (/^\/add-dir$/i.test(trimmed)) {
      notice = "Usage: /add-dir <path>\n";
    } else if (/^\/remove-dir$/i.test(trimmed)) {
      return "Usage: /remove-dir <path>";
    }
    const lines = ["Workspace directories:", `  ${this.cwd} (working directory)`, ...current.map((dir) => `  ${dir}`)];
    return `${notice}${lines.join("\n")}`;
  }

  handoff(): Promise<void> {
    return Promise.reject(new Error("handoff is not supported by pi; use Fork or Clone instead"));
  }

  runTodoCommand(_text: string): Promise<string> {
    return Promise.reject(new Error("todo commands are not supported by pi"));
  }

  runModeCommand(_op: ModeOp, _text: string): Promise<string> {
    return Promise.reject(new Error("mode switching is not supported by pi"));
  }

  goal(op: GoalOp, _objective?: string): Promise<TaskState["goal"]> {
    if (op === "get") return Promise.resolve(null);
    return Promise.reject(new Error("goal mode is not supported by pi"));
  }

  applyWorkspaceDirsOutput(text: string): void {
    if (this.#workspace.apply(text)) {
      this.#publish();
    }
  }

  setFastMode(_enabled: boolean): Promise<void> {
    return Promise.reject(new Error("/fast mode is not supported by pi"));
  }

  setSlowMode(_enabled: boolean): Promise<void> {
    return Promise.reject(new Error("/slow mode is not supported by pi"));
  }

  subagentRecord(name: string): Promise<TspSubagentRecord> {
    // Pi 的子代理用 `--no-session` 跑，不落盘；只有 subagent 工具的 toolResult.details 里有它们的完整对话，
    // 桥接层在流式 / 结束时把它记下来，这里按名字取。
    const record = this.#bridge.getSubagentRecord(name);
    if (record === null) {
      return Promise.resolve({
        messages: null,
        truncated: false,
        output: null,
        unavailable: "no_session",
        error: null,
        fallbackModel: null,
      });
    }
    return Promise.resolve({
      messages: (record.messages ?? null) as unknown as TspSubagentRecord["messages"],
      truncated: false,
      output: record.output,
      unavailable: null,
      error: null,
      fallbackModel: null,
    });
  }

  focusSubagent(_name: string): Promise<void> {
    return Promise.reject(new Error("subagent hub is not supported by pi"));
  }

  steerSubagent(_name: string, _text: string): Promise<void> {
    return Promise.reject(new Error("subagent steering is not supported by pi"));
  }

  killSubagent(_name: string): Promise<void> {
    return Promise.resolve();
  }

  reviveSubagent(_name: string): Promise<void> {
    return Promise.reject(new Error("subagent revival is not supported by pi"));
  }

  // ───────── Internal RPC & State Synchronization ─────────

  #handleRpcEvent(event: PiRpcEvent): void {
    if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason === "error" && typeof event.message.errorMessage === "string") {
        this.#lastRunError = event.message.errorMessage;
      } else if (event.message.stopReason === "aborted") {
        this.#lastStopAborted = true;
      } else if (event.message.stopReason === "stop" || event.message.stopReason === "toolUse") {
        this.#lastRunError = null;
        if (event.message.usage !== undefined) {
          this.#postCompactionTokens = null;
        }
      }
    } else if (event.type === "auto_retry_end" && !event.success && typeof event.finalError === "string") {
      this.#lastRunError = event.finalError;
    } else if (event.type === "thinking_level_changed") {
      const next = toThinkingLevel(event.level);
      if (next !== null && next !== this.#thinkingLevel) {
        this.#thinkingLevel = next;
        this.#publish();
      }
    } else if (event.type === "extension_ui_request" && event.method === "setStatus") {
      if (typeof event.statusText === "string" && event.statusText.trim() !== "") {
        this.#extStatuses = [event.statusText.trim()];
      } else {
        this.#extStatuses = [];
      }
      this.#publish();
    }

    if (event.type === "compaction_start") {
      this.#compactionState = "running";
      this.#publish();
    } else if (event.type === "compaction_end") {
      if (!event.aborted && event.result !== undefined && event.result !== null) {
        const projectedMsgTokens =
          typeof event.result.estimatedTokensAfter === "number" && event.result.estimatedTokensAfter > 0
            ? event.result.estimatedTokensAfter
            : estTextTokens(event.result.summary ?? "");
        const estimatedTotal = 2700 + projectedMsgTokens;
        this.#postCompactionTokens = estimatedTotal;
        this.#compactionState = "ready";
        const win = this.#fallbackContextWindow();
        if (win > 0) {
          this.#contextUsage = {
            tokens: estimatedTotal,
            contextWindow: win,
            percent: Math.min(100, (estimatedTotal / win) * 100),
          };
        }
      } else {
        this.#compactionState = null;
      }
      this.#publish();
    }

    this.#bridge.handleRpcEvent(event);

    if (event.type === "agent_start") {
      this.#agentLifecycleSeq += 1;
      this.#lastActiveAt = Date.now();
      this.#lastRunError = null;
      this.#lastStopAborted = false;
      if (!this.#machine.working) {
        this.#apply({ type: "agent_start" });
      }
    } else if (event.type === "turn_end" || event.type === "compaction_end") {
      const client = this.#client;
      if (client !== null && client.alive) {
        void this.#syncStats(client);
      }
      void this.#persistSessionFile();
    } else if ((event.type === "agent_end" && event.willRetry !== true) || event.type === "agent_settled") {
      this.#agentLifecycleSeq += 1;
      const endedAt = Date.now();
      this.#touch(endedAt);
      const eventAborted = event.type === "agent_settled" ? event.aborted : this.#lastStopAborted;
      const wasAborted = eventAborted || this.#stopRequested;
      const runErr = this.#lastRunError;

      if (this.#machine.working) {
        this.#stopRequested = false;
        this.#lastStopAborted = false;
        this.#lastRunError = null;
        if (wasAborted) {
          this.#apply({
            type: "prompt_result",
            status: "aborted",
            at: endedAt,
            foreground: this.#host.isForeground(this.id),
          });
        } else if (runErr !== null) {
          this.#apply({
            type: "prompt_result",
            status: "error",
            error: { message: runErr, retryable: false },
            at: endedAt,
            foreground: this.#host.isForeground(this.id),
          });
        } else {
          this.#apply({
            type: "prompt_result",
            status: "completed",
            at: endedAt,
            foreground: this.#host.isForeground(this.id),
          });
        }
      }

      const client = this.#client;
      if (client !== null && client.alive) {
        void client
          .getState()
          .then((st) => this.#applyRpcState(client, st))
          .catch(() => {});
      }
      void this.#persistSessionFile();
      void this.#readSessionFile();
    }
  }

  #syncDialogAndWorkingFromDoc(): void {
    if (this.#machine.status === "starting" || this.#machine.status === "stopped" || this.#machine.status === "error") {
      return;
    }

    const derived = deriveTaskStatus(this.#bridge.document);
    const openDialog = this.#machine.dialogs.find((d) => d.id === TSP_ASK_DIALOG_ID || d.id === TSP_APPROVAL_DIALOG_ID);

    if (derived.ask !== null) {
      const dialogId = derived.ask.approval ? TSP_APPROVAL_DIALOG_ID : TSP_ASK_DIALOG_ID;
      if (openDialog !== undefined && openDialog.id !== dialogId) {
        this.#apply({ type: "dialog_close", id: openDialog.id });
      }
      if (openDialog === undefined || openDialog.id !== dialogId || openDialog.title !== derived.ask.title) {
        if (!this.#machine.working) {
          this.#apply({ type: "agent_start" });
        }
        this.#apply({
          type: "dialog_open",
          request: {
            id: dialogId,
            kind: "confirm",
            title: derived.ask.title,
            message: "",
            receivedAt: Date.now(),
          },
        });
      }
    } else if (openDialog !== undefined) {
      this.#apply({ type: "dialog_close", id: openDialog.id });
    }
  }

  async #applyRpcState(client: PiRpcClient, state: Awaited<ReturnType<PiRpcClient["getState"]>>): Promise<void> {
    this.#autoCompactionEnabled = state.autoCompactionEnabled;

    if (state.sessionFile !== undefined && state.sessionFile !== "") {
      this.#sessionFile = state.sessionFile;
      void this.#persistSessionFile();
    }

    if (state.sessionName !== undefined && state.sessionName.trim() !== "") {
      this.#adoptTitle(state.sessionName.trim());
    }

    try {
      const { levels } = await client.getAvailableThinkingLevels();
      const efforts = extractEfforts(levels);
      if (state.model !== undefined) {
        this.#model = toModelOption(state.model, efforts);
      }
      this.#thinkingLevels = toThinkingLevelsList(levels, state.model);
    } catch {
      if (state.model !== undefined) {
        this.#model = toModelOption(state.model);
      }
    }

    const lvl = toThinkingLevel(state.thinkingLevel);
    if (lvl !== null) {
      this.#thinkingLevel = lvl;
    }

    await this.#syncStats(client);
    this.#publish();
  }

  async #syncStats(client: PiRpcClient): Promise<void> {
    try {
      const stats: PiSessionStats = await client.getSessionStats();
      if (stats.sessionFile !== undefined && stats.sessionFile !== "") {
        this.#sessionFile = stats.sessionFile;
      }

      const contextWindow =
        stats.contextUsage !== undefined && stats.contextUsage.contextWindow > 0
          ? stats.contextUsage.contextWindow
          : this.#fallbackContextWindow();

      if (
        stats.contextUsage !== undefined &&
        stats.contextUsage.tokens !== null &&
        stats.contextUsage.tokens > 0 &&
        contextWindow > 0
      ) {
        this.#postCompactionTokens = null;
        this.#contextUsage = {
          tokens: stats.contextUsage.tokens,
          contextWindow,
          percent: stats.contextUsage.percent ?? (stats.contextUsage.tokens / contextWindow) * 100,
        };
      } else if (contextWindow > 0) {
        let fallbackTokens = this.#postCompactionTokens;
        if (fallbackTokens === null) {
          const branch = await analyzeSessionBranchTokens(this.#currentSessionFile());
          if (branch !== null) {
            fallbackTokens = branch.estimatedTotalTokens;
            if (branch.hasCompaction && this.#compactionState === null) {
              this.#compactionState = "ready";
            }
          }
        }
        const safeTokens = Math.max(0, fallbackTokens ?? 0);
        this.#contextUsage = {
          tokens: safeTokens,
          contextWindow,
          percent: Math.min(100, (safeTokens / contextWindow) * 100),
        };
      }

      this.#sessionUsage = {
        tokens: {
          input: stats.tokens.input,
          output: stats.tokens.output,
          cacheRead: stats.tokens.cacheRead,
          cacheWrite: stats.tokens.cacheWrite,
          total: stats.tokens.total,
        },
        cost: stats.cost,
        premiumRequests: 0,
        requests: stats.assistantMessages,
      };
      this.#publish();
    } catch {
      // Ignore transient stats errors during shutdown.
    }
  }

  #handleRpcExit(
    client: PiRpcClient | null,
    exit: { code: number | null; signal: NodeJS.Signals | null; stderr: string },
  ): void {
    if (client === null || this.#client !== client) return;
    this.#client = null;
    this.#extStatuses = [];
    this.#stopRequested = false;

    if (isBtwRunning(this.#btwRecords)) {
      this.#btwRecords = interruptBtw(this.#btwRecords, Date.now());
      this.#host.onBtw?.(this.id, { type: "records", records: [...this.#btwRecords] });
    }

    void this.#persistSessionFile();

    if (this.#closing) {
      this.#apply({ type: "stopped" });
      return;
    }
    if (this.#machine.status === "starting") return;

    const tailLines = exit.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-STDERR_LINES_IN_ERROR).join("\n");
    const baseMsg = `pi exited unexpectedly (${exit.code ?? exit.signal ?? "unknown"})`;
    const message = tailLines !== "" ? `${baseMsg}\n${tailLines}` : baseMsg;
    log.warn(`task ${this.id} pi exited unexpectedly`, { message });
    this.#apply({ type: "failed", error: { kind: "exited", message } });
  }

  async #resolvePiLaunch(): Promise<PiLaunch> {
    try {
      if (this.#host.buildPiLaunch !== undefined) {
        return await this.#host.buildPiLaunch(this.#record, this.#project);
      }
      const discovered = await discoverPi();
      if (discovered !== null) {
        return discovered;
      }
      if (this.#host.buildLaunch !== undefined) {
        const ompLaunch = await this.#host.buildLaunch(this.#record, this.#project);
        const envOut: Record<string, string> = {};
        if (ompLaunch.env !== undefined) {
          for (const [k, v] of Object.entries(ompLaunch.env)) {
            if (typeof v === "string") envOut[k] = v;
          }
        }
        return {
          command: ompLaunch.command,
          prefixArgs: [],
          env: envOut,
          displayPath: ompLaunch.command,
        };
      }
      throw new Error("pi CLI not found in PATH");
    } catch (error) {
      throw new StartError({
        kind: "omp_unavailable",
        message: errorMessage(error),
      });
    }
  }

  #classifyStartError(error: unknown): TaskError {
    if (error instanceof StartError) return error.taskError;
    if (error instanceof TooManyTasksError) return { kind: "too_many_tasks", message: error.message };
    return { kind: "handshake_failed", message: errorMessage(error) };
  }

  #assertNotClosing(): void {
    if (this.#closing || this.#disposed) {
      throw new Error("task was stopped while starting");
    }
  }

  #assertTurnFinished(): void {
    if (this.#machine.working || this.#machine.dialogs.length > 0) {
      throw new Error("the session is busy; wait for the current turn to finish");
    }
  }

  #requireClient(): PiRpcClient {
    if (this.#client === null || !this.#client.alive) {
      throw new Error("the pi RPC process is not running");
    }
    return this.#client;
  }

  #currentSessionFile(): string | null {
    return this.#sessionFile === undefined ? this.#record.sessionFile : this.#sessionFile;
  }

  async #persistSessionFile(): Promise<void> {
    const file = this.#sessionFile;
    if (!file || file === this.#record.sessionFile || this.#persistingSessionFile) return;
    this.#persistingSessionFile = true;
    try {
      const exists = await stat(file).then(
        () => true,
        () => false,
      );
      if (exists && !this.#disposed && file !== this.#record.sessionFile) {
        this.#record = await this.#host.persist(this.id, {
          sessionFile: file,
          ...((this.#record.forkFrom ?? null) !== null ? { forkFrom: null } : {}),
        });
        this.#publish();
      }
    } catch (error) {
      log.warn(`task ${this.id} persisting sessionFile failed`, { message: errorMessage(error) });
    } finally {
      this.#persistingSessionFile = false;
    }
  }

  async #readSessionFile(): Promise<SessionFileState | null> {
    const file = this.#currentSessionFile();
    if (file === null) return null;
    if (!this.#disposed && this.#heldSessionFile?.file !== file) {
      this.#heldSessionFile?.release();
      this.#heldSessionFile = { file, release: holdSessionFile(file) };
    }
    const state = await readSessionFile(file);
    if (!this.#disposed && file === this.#currentSessionFile()) {
      const rawTitle = state.title.current();
      if (rawTitle !== null) {
        this.#adoptTitle(rawTitle);
      }
      const fallback = state.fallback.current();
      const pins = state.pins.current();
      if (fallback !== this.#fallbackModel || pins !== this.#credentialPins) {
        this.#fallbackModel = fallback;
        this.#credentialPins = pins;
        this.#publish();
      }
      if (this.#sessionUsage === null) {
        const summary = state.usage.summary();
        if (summary.models.length > 0) {
          let input = 0;
          let output = 0;
          let cacheRead = 0;
          let cacheWrite = 0;
          let total = 0;
          let cost = 0;
          let requests = 0;
          for (const m of summary.models) {
            input += m.input;
            output += m.output;
            cacheRead += m.cacheRead;
            cacheWrite += m.cacheWrite;
            total += m.total;
            cost += m.cost;
            requests += m.requests;
          }
          this.#sessionUsage = {
            tokens: { input, output, cacheRead, cacheWrite, total },
            cost,
            premiumRequests: 0,
            requests,
          };
          this.#publish();
        }
      }
      if (this.#client === null || !this.#client.alive) {
        const branch = await analyzeSessionBranchTokens(file);
        if (branch !== null && !this.#disposed && file === this.#currentSessionFile()) {
          if (branch.hasCompaction && this.#compactionState === null) {
            this.#compactionState = "ready";
          }
          const win = this.#fallbackContextWindow();
          if (win > 0) {
            this.#contextUsage = {
              tokens: branch.estimatedTotalTokens,
              contextWindow: win,
              percent: Math.min(100, (branch.estimatedTotalTokens / win) * 100),
            };
            this.#publish();
          }
        }
      }
    }
    return state;
  }

  #adoptTitle(raw: string): void {
    const cleaned = titleFromPrompt(stripIconGlyphs(raw)).trim();
    if (cleaned === "" || cleaned === "pi" || /^[A-Za-z]:?$/.test(cleaned)) return;
    const current = this.#record.title;
    if (cleaned === current) {
      this.#adoptedTitle = cleaned;
      return;
    }
    const isCorruptedCurrent = /^[A-Za-z]:?$/.test(current.trim());
    if (!isCorruptedCurrent && current !== "" && current !== this.#provisionalTitle && current !== this.#adoptedTitle) {
      return;
    }
    this.#adoptedTitle = cleaned;
    this.#host
      .persist(this.id, { title: cleaned })
      .then((updated) => {
        this.#record = updated;
        this.#publish();
      })
      .catch(() => {});
  }

  async #loadNewTaskDefaults(): Promise<void> {
    const load: ((project: Project) => Promise<NewTaskDefaults>) | undefined = this.#host.newTaskDefaults;
    if (load === undefined || this.#record.model !== null) return;
    try {
      const defaults = await load(this.#project);
      const catalog = this.#catalog.length > 0 ? this.#catalog : await this.#refreshCatalog(false);
      const { model, thinkingLevel } = resolveNewTaskDefault(defaults, defaults.ompDefault, catalog);
      this.#newTaskDefault = { model, thinkingLevel };
      if (!this.#disposed) this.#publish();
    } catch {
      // Non-fatal.
    }
  }

  async #refreshCatalog(refresh: boolean): Promise<ModelOption[]> {
    if (this.#host.listModels === undefined) return this.#catalog;
    try {
      this.#catalog = await this.#host.listModels(refresh);
    } catch {
      // Keep last known catalog.
    }
    this.#adoptCatalogModel();
    return this.#catalog;
  }

  /**
   * 没有活进程时（还没起 / 已经关掉），胶囊上的模型和档位按最新的模型目录来：目录里给模型补了 xhigh/max
   * 或改了能力，旧会话也要显示对的档位。有进程时以 Pi 的 `get_available_thinking_levels` 为准，不拿目录盖它。
   */
  #adoptCatalogModel(): void {
    const client = this.#client;
    if (client !== null && client.alive) return;
    const key = this.#model?.key ?? this.#record.model;
    if (key === undefined || key === null) return;
    const model = this.#catalog.find((m) => m.key.provider === key.provider && m.key.modelId === key.modelId);
    if (model === undefined) return;
    const levels: ThinkingLevel[] = model.reasoning ? ["off", ...(model.thinkingEfforts ?? [])] : ["off"];
    if (this.#model === model && this.#thinkingLevels.join() === levels.join()) return;
    this.#model = model;
    this.#thinkingLevels = levels;
    this.#publish();
  }

  #emitBtw(event: BtwUiEvent): void {
    this.#btwRecords = applyBtwEvent(this.#btwRecords, event);
    if (!this.#disposed) {
      this.#host.onBtw?.(this.id, event);
    }
  }

  #touch(at: number): void {
    this.#activityAt = at;
    this.#host.persist(this.id, { updatedAt: at }).catch(() => {});
  }

  #apply(input: MachineInput): void {
    const next = transition(this.#machine, input);
    if (next === this.#machine) return;
    if (next.working && !this.#machine.working) {
      this.#runStartedAt = Date.now();
    }
    this.#machine = next;
    this.#publish();
  }

  #publish(): void {
    if (this.#disposed) return;
    const current = this.state;
    this.#publishedRestartable = current.restartable;
    this.#host.onState(current);
  }

  #syncRestartable(): void {
    if (this.restartable !== this.#publishedRestartable) {
      this.#publish();
    }
  }
}
