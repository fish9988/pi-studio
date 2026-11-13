// Subprocess JSONL RPC client for `pi --mode rpc`.
// Implements strict LF (`\n`) record framing (stripping optional `\r`, never splitting on U+2028/U+2029),
// Win32 Job Object containment (`assignToOwnJob`), and process-tree teardown (`killProcessTree`).
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "../../shared/type-guards.ts";
import { killProcessTree } from "../platform/process-tree.ts";
import { assignToOwnJob } from "../platform/win32/job-object.ts";
import { formatError, type PiLaunch } from "./discover.ts";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const MAX_STDERR_CHARS = 8_192;

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiTextContent {
  type: "text";
  text: string;
  textSignature?: string | undefined;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string | undefined;
  redacted?: boolean | undefined;
}

export interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string | undefined;
}

export type PiContentBlock = PiTextContent | PiThinkingContent | PiToolCallContent | PiImageContent;

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number | undefined;
  cost?:
    | {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      }
    | undefined;
}

export interface PiUserMessage {
  role: "user";
  content: string | (PiTextContent | PiImageContent)[];
  timestamp?: number | undefined;
}

export interface PiAssistantMessage {
  role: "assistant";
  content: (PiTextContent | PiThinkingContent | PiToolCallContent)[];
  api?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  responseId?: string | undefined;
  usage?: PiUsage | undefined;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | (string & {}) | undefined;
  errorMessage?: string | undefined;
  timestamp?: number | undefined;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (PiTextContent | PiImageContent)[];
  details?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
  timestamp?: number | undefined;
}

export interface PiBashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number | null | undefined;
  cancelled?: boolean | undefined;
  truncated?: boolean | undefined;
  fullOutputPath?: string | undefined;
  timestamp?: number | undefined;
  excludeFromContext?: boolean | undefined;
}

export interface PiCustomAgentMessage {
  role: "custom" | "branchSummary" | "compactionSummary";
  customType?: string | undefined;
  content?: string | (PiTextContent | PiImageContent)[] | undefined;
  summary?: string | undefined;
  fromId?: string | undefined;
  tokensBefore?: number | undefined;
  display?: boolean | undefined;
  details?: unknown;
  timestamp?: number | undefined;
}

export type PiAgentMessage =
  PiUserMessage | PiAssistantMessage | PiToolResultMessage | PiBashExecutionMessage | PiCustomAgentMessage;

export interface PiModelInfo {
  id: string;
  name: string;
  api?: string | undefined;
  provider: string;
  baseUrl?: string | undefined;
  reasoning?: boolean | undefined;
  /** Pi 档位 → 发给上游的值；null = 这一档明确不支持。`get_available_models` 原样返回它。 */
  thinkingLevelMap?: Record<string, string | null | undefined> | undefined;
  input?: ("text" | "image")[] | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  cost?:
    | {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      }
    | undefined;
}

export interface PiStateData {
  model?: PiModelInfo | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string | undefined;
  sessionId: string;
  sessionName?: string | undefined;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface PiCommandInfo {
  name: string;
  description?: string | undefined;
  source: "extension" | "prompt" | "skill" | (string & {});
  sourceInfo?:
    | {
        path: string;
        source: string;
        scope: "user" | "project" | "temporary" | (string & {});
        origin: string;
        baseDir?: string | undefined;
      }
    | undefined;
}

export interface PiSessionStats {
  sessionFile?: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?:
    | {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      }
    | undefined;
}

export interface PiCompactResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number | undefined;
  usage?: PiUsage | undefined;
  details?: Record<string, unknown> | undefined;
}

export interface PiTreeNode {
  entry: Record<string, unknown>;
  children: PiTreeNode[];
  label?: string | undefined;
}

export type PiAssistantMessageEvent =
  | { type: "start"; partial?: PiAssistantMessage | undefined }
  | { type: "text_start"; contentIndex: number; partial?: PiAssistantMessage | undefined }
  | { type: "text_delta"; contentIndex: number; delta: string; partial?: PiAssistantMessage | undefined }
  | { type: "text_end"; contentIndex: number; content: string; partial?: PiAssistantMessage | undefined }
  | { type: "thinking_start"; contentIndex: number; partial?: PiAssistantMessage | undefined }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial?: PiAssistantMessage | undefined }
  | { type: "thinking_end"; contentIndex: number; content: string; partial?: PiAssistantMessage | undefined }
  | {
      type: "toolcall_start";
      contentIndex: number;
      id?: string | undefined;
      toolName?: string | undefined;
      partial?: PiAssistantMessage | undefined;
    }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial?: PiAssistantMessage | undefined }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: PiToolCallContent;
      partial?: PiAssistantMessage | undefined;
    }
  | { type: "done"; reason?: string | undefined; message?: PiAssistantMessage | undefined }
  | { type: "error"; reason?: string | undefined; error?: PiAssistantMessage | undefined };

export interface PiExtensionUiRequestEvent {
  type: "extension_ui_request";
  id: string;
  method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text"
    | (string & {});
  title?: string | undefined;
  message?: string | undefined;
  options?: string[] | undefined;
  placeholder?: string | undefined;
  prefill?: string | undefined;
  timeout?: number | undefined;
  notifyType?: "info" | "warning" | "error" | undefined;
  statusKey?: string | undefined;
  statusText?: string | undefined;
  widgetKey?: string | undefined;
  widgetLines?: string[] | undefined;
  widgetPlacement?: "aboveEditor" | "belowEditor" | undefined;
  text?: string | undefined;
}

export type PiExtensionUiResponsePayload =
  { id: string; value: string } | { id: string; confirmed: boolean } | { id: string; cancelled: true };

export type PiRpcEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: PiAgentMessage[] | undefined; willRetry?: boolean | undefined }
  | { type: "agent_settled"; aborted: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: PiAssistantMessage | undefined; toolResults?: PiToolResultMessage[] | undefined }
  | { type: "message_start"; message: PiAgentMessage }
  | {
      type: "message_update";
      message?: PiAssistantMessage | undefined;
      usage?: PiUsage | undefined;
      assistantMessageEvent: PiAssistantMessageEvent;
    }
  | { type: "message_end"; message: PiAgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: {
        content?: (PiTextContent | PiImageContent)[] | undefined;
        details?: Record<string, unknown> | undefined;
      };
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: {
        content?: (PiTextContent | PiImageContent)[] | undefined;
        details?: Record<string, unknown> | undefined;
      };
      isError: boolean;
      durationMs?: number | undefined;
    }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" | (string & {}) }
  | {
      type: "compaction_end";
      reason: "manual" | "threshold" | "overflow" | (string & {});
      result?: PiCompactResult | null | undefined;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string | undefined;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string | undefined;
    }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | PiExtensionUiRequestEvent
  | { type: "extension_error"; extensionPath: string; event: string; error: string }
  | { type: "session_info_changed"; name?: string | undefined }
  | { type: "thinking_level_changed"; level: string }
  | { type: "bash_execution_update"; id?: string | undefined; chunk: string; fullOutput: string; truncated: boolean }
  | {
      type: "summarization_retry_scheduled";
      source: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "summarization_retry_attempt_start"; source: string; attempt: number; maxAttempts: number }
  | {
      type: "summarization_retry_finished";
      source: string;
      success: boolean;
      attempt: number;
      aborted: boolean;
      finalError?: string | undefined;
    };

export class PiRpcError extends Error {
  readonly command: string;
  readonly requestId: string | undefined;

  constructor(message: string, command: string, requestId?: string) {
    super(message);
    this.name = "PiRpcError";
    this.command = command;
    this.requestId = requestId;
  }
}

export interface PiRpcSpawnOptions {
  launch: PiLaunch;
  cwd: string;
  sessionFile?: string | undefined;
  sessionDir?: string | undefined;
  forkFrom?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  thinkingLevel?: string | undefined;
  noSession?: boolean | undefined;
  sessionName?: string | undefined;
  extraArgs?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  defaultTimeoutMs?: number | undefined;
}

interface PendingCommand {
  command: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

type RpcChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export class PiRpcClient {
  private readonly child: RpcChildProcess;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly eventListeners = new Set<(event: PiRpcEvent) => void>();
  private readonly exitListeners = new Set<
    (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void
  >();
  private readonly parseErrorListeners = new Set<(error: string) => void>();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stderrRing = "";
  private nextRequestId = 0;
  private exited = false;
  private closingPromise: Promise<void> | null = null;
  private releaseJobHandle: (() => void) | null = null;

  constructor(options: PiRpcSpawnOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

    const args: string[] = [...options.launch.prefixArgs, "--mode", "rpc"];
    if (options.noSession === true) {
      args.push("--no-session");
    } else if (options.forkFrom !== undefined && options.forkFrom !== "") {
      args.push("--fork", options.forkFrom);
    } else if (options.sessionFile !== undefined && options.sessionFile !== "") {
      args.push("--session", options.sessionFile);
    }
    if (options.sessionDir !== undefined && options.sessionDir !== "") {
      args.push("--session-dir", options.sessionDir);
    }
    if (options.provider !== undefined && options.provider !== "") {
      args.push("--provider", options.provider);
    }
    if (options.model !== undefined && options.model !== "") {
      args.push("--model", options.model);
    }
    if (options.thinkingLevel !== undefined && options.thinkingLevel !== "") {
      args.push("--thinking", options.thinkingLevel);
    }
    if (options.sessionName !== undefined && options.sessionName !== "") {
      args.push("--name", options.sessionName);
    }
    if (options.extraArgs !== undefined && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      ...options.launch.env,
    };

    const child = spawn(options.launch.command, args, {
      cwd: options.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    this.child = child;
    this.releaseJobHandle = assignToOwnJob(child.pid);

    child.stdin.on("error", () => {
      // Ignore EPIPE / EOF on stdin when child exits asynchronously.
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdoutChunk(this.stdoutDecoder.write(chunk));
    });

    child.stdout.on("end", () => {
      const tail = this.stdoutDecoder.end();
      if (tail.length > 0) {
        this.consumeStdoutChunk(tail);
      }
      this.flushTrailingStdoutLine();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrRing += chunk.toString("utf8");
      if (this.stderrRing.length > MAX_STDERR_CHARS) {
        this.stderrRing = this.stderrRing.slice(this.stderrRing.length - MAX_STDERR_CHARS);
      }
    });

    child.on("error", (err) => {
      this.failAllPending(new Error(`Failed to spawn pi RPC process: ${formatError(err)}`));
    });

    child.on("close", (code, signal) => {
      this.exited = true;
      this.releaseJob();
      const stderrSummary = this.stderrRing.trim();
      const detail = stderrSummary !== "" ? `: ${stderrSummary}` : "";
      this.failAllPending(new Error(`pi RPC process exited (code=${String(code)}, signal=${String(signal)})${detail}`));
      for (const listener of this.exitListeners) {
        listener({ code, signal, stderr: stderrSummary });
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.exited && this.closingPromise === null;
  }

  get stderrTail(): string {
    return this.stderrRing;
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onExit(listener: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  onParseError(listener: (error: string) => void): () => void {
    this.parseErrorListeners.add(listener);
    return () => {
      this.parseErrorListeners.delete(listener);
    };
  }

  /**
   * Send an arbitrary RPC command and correlate its `response` record by unique `id`.
   */
  request<T = unknown>(
    type: string,
    params?: Readonly<Record<string, unknown>>,
    timeoutMs: number | null = this.defaultTimeoutMs,
  ): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error(`Cannot send "${type}": pi RPC process has already exited`));
    }

    const id = `req_${++this.nextRequestId}`;
    const record: Record<string, unknown> = {
      ...params,
      id,
      type,
    };

    const payload = `${JSON.stringify(record)}\n`;

    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs !== null && timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new PiRpcError(`RPC command "${type}" timed out after ${timeoutMs}ms`, type, id));
            }, timeoutMs)
          : null;

      this.pending.set(id, {
        command: type,
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });

      try {
        this.child.stdin.write(payload, "utf8", (writeErr) => {
          if (writeErr !== null && writeErr !== undefined) {
            const entry = this.pending.get(id);
            if (entry !== undefined) {
              this.pending.delete(id);
              if (entry.timer !== null) clearTimeout(entry.timer);
              entry.reject(new Error(`Failed to write RPC command "${type}": ${formatError(writeErr)}`));
            }
          }
        });
      } catch (err) {
        this.pending.delete(id);
        if (timer !== null) clearTimeout(timer);
        reject(new Error(`Failed to write RPC command "${type}": ${formatError(err)}`));
      }
    });
  }

  // ───────── Typed Command Helpers ─────────

  getState(): Promise<PiStateData> {
    return this.request<PiStateData>("get_state");
  }

  getMessages(): Promise<{ messages: PiAgentMessage[] }> {
    return this.request<{ messages: PiAgentMessage[] }>("get_messages");
  }

  getAvailableModels(): Promise<{ models: PiModelInfo[] }> {
    return this.request<{ models: PiModelInfo[] }>("get_available_models");
  }

  getAvailableThinkingLevels(): Promise<{ levels: string[] }> {
    return this.request<{ levels: string[] }>("get_available_thinking_levels");
  }

  getCommands(): Promise<{ commands: PiCommandInfo[] }> {
    return this.request<{ commands: PiCommandInfo[] }>("get_commands");
  }

  getSessionStats(): Promise<PiSessionStats> {
    return this.request<PiSessionStats>("get_session_stats");
  }

  prompt(
    message: string,
    options?: {
      images?: readonly PiImageContent[] | undefined;
      streamingBehavior?: "steer" | "followUp" | undefined;
    },
  ): Promise<{ disposition: "started" | "queued" | "handled" }> {
    return this.request<{ disposition: "started" | "queued" | "handled" }>("prompt", {
      message,
      ...(options?.images !== undefined && options.images.length > 0 ? { images: options.images } : {}),
      ...(options?.streamingBehavior !== undefined ? { streamingBehavior: options.streamingBehavior } : {}),
    });
  }

  steer(
    message: string,
    options?: { images?: readonly PiImageContent[] | undefined },
  ): Promise<{ disposition: "handled" | "queued" }> {
    return this.request<{ disposition: "handled" | "queued" }>("steer", {
      message,
      ...(options?.images !== undefined && options.images.length > 0 ? { images: options.images } : {}),
    });
  }

  followUp(
    message: string,
    options?: { images?: readonly PiImageContent[] | undefined },
  ): Promise<{ disposition: "handled" | "queued" }> {
    return this.request<{ disposition: "handled" | "queued" }>("follow_up", {
      message,
      ...(options?.images !== undefined && options.images.length > 0 ? { images: options.images } : {}),
    });
  }

  async abort(): Promise<void> {
    await this.request("abort", undefined, 30_000);
  }

  clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.request<{ steering: string[]; followUp: string[] }>("clear_queue");
  }

  newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>(
      "new_session",
      parentSession !== undefined ? { parentSession } : undefined,
    );
  }

  switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>("switch_session", { sessionPath });
  }

  setModel(provider: string, modelId: string): Promise<PiModelInfo> {
    return this.request<PiModelInfo>("set_model", { provider, modelId });
  }

  cycleModel(): Promise<{ model: PiModelInfo; thinkingLevel: string; isScoped: boolean } | null> {
    return this.request<{ model: PiModelInfo; thinkingLevel: string; isScoped: boolean } | null>("cycle_model");
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request("set_thinking_level", { level });
  }

  cycleThinkingLevel(): Promise<{ level: string } | null> {
    return this.request<{ level: string } | null>("cycle_thinking_level");
  }

  compact(customInstructions?: string): Promise<PiCompactResult> {
    return this.request<PiCompactResult>(
      "compact",
      customInstructions !== undefined && customInstructions !== "" ? { customInstructions } : undefined,
      null,
    );
  }

  exportHtml(outputPath?: string): Promise<{ path: string }> {
    return this.request<{ path: string }>(
      "export_html",
      outputPath !== undefined && outputPath !== "" ? { outputPath } : undefined,
    );
  }

  fork(entryId: string): Promise<{ text?: string | undefined; cancelled: boolean }> {
    return this.request<{ text?: string | undefined; cancelled: boolean }>("fork", { entryId });
  }

  clone(): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>("clone");
  }

  getForkMessages(): Promise<{ messages: { entryId: string; text: string }[] }> {
    return this.request<{ messages: { entryId: string; text: string }[] }>("get_fork_messages");
  }

  getTree(): Promise<{ tree: PiTreeNode[]; leafId: string | null }> {
    return this.request<{ tree: PiTreeNode[]; leafId: string | null }>("get_tree");
  }

  getEntries(): Promise<{ entries: Record<string, unknown>[] }> {
    return this.request<{ entries: Record<string, unknown>[] }>("get_entries");
  }

  getLastAssistantText(): Promise<{ text: string | null }> {
    return this.request<{ text: string | null }>("get_last_assistant_text");
  }

  async setSessionName(name: string): Promise<void> {
    await this.request("set_session_name", { name });
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.request("set_steering_mode", { mode });
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.request("set_follow_up_mode", { mode });
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.request("set_auto_compaction", { enabled });
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.request("set_auto_retry", { enabled });
  }

  async abortRetry(): Promise<void> {
    await this.request("abort_retry");
  }

  bash(
    command: string,
    excludeFromContext?: boolean,
  ): Promise<{
    output: string;
    exitCode: number;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string | undefined;
  }> {
    return this.request(
      "bash",
      {
        command,
        ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
      },
      null,
    );
  }

  async abortBash(): Promise<void> {
    await this.request("abort_bash");
  }

  /**
   * Send an `extension_ui_response` back to Pi. Per `docs/rpc.md`, this record
   * uses the `id` from `extension_ui_request` and does NOT emit a `response` record.
   */
  sendExtensionUiResponse(response: PiExtensionUiResponsePayload): void {
    if (this.exited) return;
    const record = {
      type: "extension_ui_response",
      ...response,
    };
    try {
      this.child.stdin.write(`${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Ignore write failures during shutdown.
    }
  }

  /**
   * Close stdin for graceful shutdown, then force-kill the process tree if still running after `timeoutMs`.
   */
  close(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<void> {
    if (this.exited) {
      this.releaseJob();
      return Promise.resolve();
    }
    this.closingPromise ??= this.performClose(timeoutMs);
    return this.closingPromise;
  }

  private async performClose(timeoutMs: number): Promise<void> {
    const pid = this.child.pid;

    if (timeoutMs <= 0) {
      try {
        this.child.stdin.destroy();
      } catch {
        // Ignore.
      }
      if (pid !== undefined && !this.exited) {
        await killProcessTree(pid);
      }
      this.releaseJob();
      return;
    }

    const exitPromise = new Promise<boolean>((resolve) => {
      if (this.exited) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        this.child.removeListener("close", onClose);
        resolve(false);
      }, timeoutMs);
      const onClose = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.child.once("close", onClose);
    });

    try {
      this.child.stdin.end();
    } catch {
      // Ignore.
    }

    const exitedCleanly = await exitPromise;
    if (!exitedCleanly && pid !== undefined && !this.exited) {
      await killProcessTree(pid);
    }
    this.releaseJob();
  }

  // ───────── Strict LF Framing & Dispatch ─────────

  private consumeStdoutChunk(chunkText: string): void {
    this.stdoutBuffer += chunkText;
    let lfIndex = this.stdoutBuffer.indexOf("\n");
    while (lfIndex !== -1) {
      let line = this.stdoutBuffer.slice(0, lfIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(lfIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        this.handleStdoutLine(line);
      }
      lfIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private flushTrailingStdoutLine(): void {
    let line = this.stdoutBuffer;
    this.stdoutBuffer = "";
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.length > 0) {
      this.handleStdoutLine(line);
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
      return;
    }

    if (parsed["type"] === "response") {
      const id = typeof parsed["id"] === "string" ? parsed["id"] : undefined;
      const command = typeof parsed["command"] === "string" ? parsed["command"] : "unknown";
      const success = parsed["success"] === true;
      const errText = typeof parsed["error"] === "string" ? parsed["error"] : `RPC command "${command}" failed`;

      if (id !== undefined) {
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          this.pending.delete(id);
          if (pending.timer !== null) clearTimeout(pending.timer);
          if (success) {
            pending.resolve(parsed["data"]);
          } else {
            pending.reject(new PiRpcError(errText, command, id));
          }
        }
      } else if (!success) {
        for (const listener of this.parseErrorListeners) {
          listener(errText);
        }
      }
      return;
    }

    const event = parsed as unknown as PiRpcEvent;
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private releaseJob(): void {
    const release = this.releaseJobHandle;
    this.releaseJobHandle = null;
    if (release !== null) {
      release();
    }
  }
}
