// Complete task runner implementation backed by `PiRpcClient` + `PiTspBridge`.
// Drop-in compatible with `TspRunner` (`src/main/tasks/tsp-runner.ts`) for `TaskPool`.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { WorkspaceDirs } from "../tasks/workspace-dirs.ts";
import { holdSessionFile, readSessionFile, type SessionFileState } from "../tsp/session-files.ts";
import {
  buildTreeFromEntries,
  findUserEntry,
  isLabellableEntry,
  readSessionEntries,
  type LeafOverride,
  type RewindTarget,
} from "../tsp/session-tree-file.ts";
import { discoverPi, formatError as errorMessage, type PiLaunch } from "./discover.ts";
import { PiRpcClient, type PiImageContent, type PiRpcEvent, type PiSessionStats } from "./pi-rpc-client.ts";
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
  #publishedRestartable = true;

  #model: ModelOption | null;
  #thinkingLevel: ThinkingLevel | null;
  #thinkingLevels: ThinkingLevel[] = ["off"];
  #contextUsage: ContextUsage | null = null;
  #sessionUsage: TaskState["sessionUsage"] = null;
  #autoCompactionEnabled = true;
  #catalog: ModelOption[] = [];
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
      contextCompaction: this.#autoCompactionEnabled
        ? { autoAtPercent: 85, summaryStartsAtPercent: null, summary: null }
        : null,
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
        sessionName: this.#record.title !== "" ? this.#record.title : undefined,
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
    this.#record = await this.#host.persist(this.id, { title });
    this.#publish();
    const client = this.#client;
    if (client !== null && client.alive) {
      try {
        await client.setSessionName(title);
      } catch (error) {
        log.warn(`task ${this.id} set_session_name failed`, { message: errorMessage(error) });
      }
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
      const ack = await client.prompt(body, { images: piImages });
      if ((ack?.disposition === undefined || ack.disposition === "started") && !this.#machine.working) {
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
      void this.rewindTo(res.entryId).then(({ text }) => {
        if (text !== "") {
          this.#host.onComposerPrefill?.(this.id, { text });
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

  async listModels(): Promise<ModelOption[]> {
    const client = this.#client;
    if (client !== null && client.alive) {
      try {
        const { models } = await client.getAvailableModels();
        this.#catalog = models.map((m) => toModelOption(m));
        return this.#catalog;
      } catch (error) {
        log.warn(`task ${this.id} get_available_models failed`, { message: errorMessage(error) });
      }
    }
    return this.#refreshCatalog(true);
  }

  async setModel(key: ModelKey): Promise<void> {
    await this.start();
    const client = this.#requireClient();
    const updated = await client.setModel(key.provider, key.modelId);
    const { levels } = await client.getAvailableThinkingLevels();
    const efforts = extractEfforts(levels);
    this.#model = toModelOption(updated, efforts);
    this.#thinkingLevels = toThinkingLevelsList(levels, updated.reasoning === true);
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

  async readContext(): Promise<ContextReport | null> {
    if (this.#client !== null && this.#client.alive) {
      await this.#syncStats(this.#client);
    }
    const ctx = this.#contextUsage;
    if (ctx === null || ctx.contextWindow <= 0) {
      return null;
    }
    const used = Math.max(0, ctx.tokens);
    const reserve = this.#autoCompactionEnabled
      ? Math.min(ctx.contextWindow - used, Math.max(16_384, Math.round(ctx.contextWindow * 0.15)))
      : 0;
    const free = Math.max(0, ctx.contextWindow - used - Math.max(0, reserve));
    return {
      rows: [
        { key: "messages", label: "Conversation & context", tokens: used },
        ...(reserve > 0 ? [{ key: "buffer", label: "Auto-compaction buffer", tokens: reserve }] : []),
        { key: "free", label: "Free context", tokens: free },
      ],
      used,
      window: ctx.contextWindow,
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
  ): Promise<{ text: string; summarized: boolean }> {
    this.#assertTurnFinished();
    await this.start();
    const client = this.#requireClient();

    const forkRes = await client.fork(entryId);
    if (forkRes.cancelled) {
      throw new Error("rewind/fork was cancelled by an extension");
    }

    const state = await client.getState();
    await this.#applyRpcState(client, state);
    await this.#persistSessionFile();

    const newFile = this.#currentSessionFile();
    if (newFile !== null) {
      const exists = await stat(newFile).then(
        () => true,
        () => false,
      );
      if (exists) {
        await this.#bridge.hydrateFromSessionFile(newFile);
      } else {
        const { messages } = await client.getMessages();
        this.#bridge.hydrateFromMessages(messages);
      }
    } else {
      const { messages } = await client.getMessages();
      this.#bridge.hydrateFromMessages(messages);
    }

    return {
      text: forkRes.text ?? known?.text ?? "",
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
    await this.sendPrompt({ text, whenBusy: "steer" });
    return "";
  }

  async runQuietCommand(text: string): Promise<string> {
    await this.sendPrompt({ text, whenBusy: "steer" });
    return "";
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

  subagentRecord(_name: string): Promise<TspSubagentRecord> {
    return Promise.resolve({
      messages: null,
      truncated: false,
      output: null,
      unavailable: "no_session",
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

    this.#bridge.handleRpcEvent(event);

    if (event.type === "agent_start") {
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
      this.#thinkingLevels = toThinkingLevelsList(levels, state.model?.reasoning === true);
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

      if (stats.contextUsage !== undefined) {
        this.#contextUsage = {
          tokens: stats.contextUsage.tokens ?? 0,
          contextWindow: stats.contextUsage.contextWindow,
          percent: stats.contextUsage.percent ?? 0,
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
    this.#workspace.reset();
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
    }
    return state;
  }

  #adoptTitle(raw: string): void {
    const cleaned = stripIconGlyphs(raw).trim();
    if (cleaned === "" || cleaned === "pi") return;
    const current = this.#record.title;
    if (cleaned === current) {
      this.#adoptedTitle = cleaned;
      return;
    }
    if (current !== "" && current !== this.#provisionalTitle && current !== this.#adoptedTitle) {
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
    return this.#catalog;
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
