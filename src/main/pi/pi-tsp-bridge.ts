// Pure state & protocol converter bridging Pi session JSONL / RPC events ↔ TSP Document frames.
// Produces canonical `omp.*` TSP node shapes so `TspView`, `MainFlow`, `ComposerTop`, and
// shared `src/shared/tsp/*` selectors render Pi conversations with 100% visual & behavioral fidelity.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { applyMessage, createDocument, type TspDocMessage, type TspDocument } from "../../shared/tsp/document.ts";
import type { TspDiffHunk, TspEvent, TspNode, TspOp, TspProps } from "../../shared/tsp/tsp.generated.ts";
import { isRecord } from "../../shared/type-guards.ts";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiAssistantMessageEvent,
  PiContentBlock,
  PiExtensionUiRequestEvent,
  PiExtensionUiResponsePayload,
  PiImageContent,
  PiRpcEvent,
  PiTextContent,
  PiThinkingContent,
  PiToolCallContent,
  PiToolResultMessage,
  PiUsage,
} from "./pi-rpc-client.ts";

export const PI_SURFACE_ID = "s:1";

export interface PiTspBlobRecord {
  id: string;
  mime: string;
  bytes: Uint8Array;
  base64: string;
}

export type BridgeActionResult =
  | { kind: "extension_ui_response"; response: PiExtensionUiResponsePayload }
  | { kind: "interrupt" }
  | { kind: "rewind"; cardId: string; entryId?: string | undefined }
  | null;

interface LiveThinkingState {
  wrapperId: string;
  sectionId: string;
  headId: string;
  bodyId: string;
  startedAtMs: number;
  hasToolsAfter: boolean;
}

interface LiveTextState {
  containerId: string;
  mdId: string;
}

interface LiveToolState {
  nodeId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  startedAtMs: number;
  outputId: string | null;
  streamedOutput: string;
}

interface ActiveDialogState {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor";
  cardId: string;
  options: string[];
  selectedIndex: number;
  listId: string | null;
  optionIds: string[];
  inputId: string | null;
  draftText: string;
  cursor: number;
}

export interface HydrateSessionOptions {
  /** Override active leaf entry ID (`null` = empty root before first message). */
  leafId?: string | null | undefined;
}

export interface SessionHydrationMeta {
  sessionId: string | null;
  sessionName: string | null;
  cwd: string | null;
  leafId: string | null;
  labels: ReadonlyMap<string, string>;
}

// ───────── Diff & Formatting Helpers ─────────

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse an existing unified diff string into `TspDiffHunk[]` + `+A −R` counts. */
export function parseUnifiedDiffHunks(diffText: string): {
  hunks: TspDiffHunk[];
  added: number;
  removed: number;
} {
  const rawLines = diffText.replace(/\r\n/g, "\n").split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  const hunks: TspDiffHunk[] = [];
  let current: { oldStart: number; newStart: number; lines: string[] } | null = null;
  let added = 0;
  let removed = 0;

  const flush = (): void => {
    if (current !== null && current.lines.length > 0) {
      hunks.push({
        oldStart: current.oldStart,
        newStart: current.newStart,
        lines: current.lines,
      });
    }
    current = null;
  };

  for (const line of rawLines) {
    const match = HUNK_HEADER_RE.exec(line);
    if (match !== null) {
      flush();
      current = {
        oldStart: Number(match[1] ?? "1"),
        newStart: Number(match[2] ?? "1"),
        lines: [],
      };
      continue;
    }
    if (/^(?:diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) {
      continue;
    }
    if (current === null) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        current = { oldStart: 1, newStart: 1, lines: [] };
      } else {
        continue;
      }
    }
    current.lines.push(line);
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  flush();

  return { hunks, added, removed };
}

/**
 * Compute unified diff hunks (with up to 3 lines of context) between `oldText` and `newText`.
 * Uses LCS dynamic programming for moderate blocks and fast prefix/suffix trimming for large files.
 */
export function computeTextDiffHunks(
  oldText: string,
  newText: string,
  contextLines = 3,
): { hunks: TspDiffHunk[]; added: number; removed: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length === 0 && b.length === 0) {
    return { hunks: [], added: 0, removed: 0 };
  }

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  if (midA.length === 0 && midB.length === 0) {
    return { hunks: [], added: 0, removed: 0 };
  }

  type EditOp = { kind: "ctx" | "del" | "add"; line: string; oldLine: number; newLine: number };
  const ops: EditOp[] = [];

  for (let i = 0; i < prefix; i += 1) {
    ops.push({ kind: "ctx", line: a[i]!, oldLine: i + 1, newLine: i + 1 });
  }

  const dpLimit = 600;
  if (midA.length <= dpLimit && midB.length <= dpLimit && midA.length * midB.length <= 160_000) {
    const m = midA.length;
    const n = midB.length;
    const cols = n + 1;
    const dp = new Int32Array((m + 1) * cols);
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        if (midA[i] === midB[j]) {
          dp[i * cols + j] = (dp[(i + 1) * cols + (j + 1)] ?? 0) + 1;
        } else {
          const down = dp[(i + 1) * cols + j] ?? 0;
          const right = dp[i * cols + (j + 1)] ?? 0;
          dp[i * cols + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    let oldNo = prefix + 1;
    let newNo = prefix + 1;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: "ctx", line: midA[i]!, oldLine: oldNo++, newLine: newNo++ });
        i += 1;
        j += 1;
      } else if ((dp[(i + 1) * cols + j] ?? 0) >= (dp[i * cols + (j + 1)] ?? 0)) {
        ops.push({ kind: "del", line: midA[i]!, oldLine: oldNo++, newLine: newNo });
        i += 1;
      } else {
        ops.push({ kind: "add", line: midB[j]!, oldLine: oldNo, newLine: newNo++ });
        j += 1;
      }
    }
    while (i < m) {
      ops.push({ kind: "del", line: midA[i]!, oldLine: oldNo++, newLine: newNo });
      i += 1;
    }
    while (j < n) {
      ops.push({ kind: "add", line: midB[j]!, oldLine: oldNo, newLine: newNo++ });
      j += 1;
    }
  } else {
    let oldNo = prefix + 1;
    let newNo = prefix + 1;
    for (const line of midA) {
      ops.push({ kind: "del", line, oldLine: oldNo++, newLine: newNo });
    }
    for (const line of midB) {
      ops.push({ kind: "add", line, oldLine: oldNo, newLine: newNo++ });
    }
  }

  for (let i = 0; i < suffix; i += 1) {
    const idxA = a.length - suffix + i;
    const idxB = b.length - suffix + i;
    ops.push({ kind: "ctx", line: a[idxA]!, oldLine: idxA + 1, newLine: idxB + 1 });
  }

  let added = 0;
  let removed = 0;
  const changeIndices: number[] = [];
  for (let idx = 0; idx < ops.length; idx += 1) {
    const op = ops[idx]!;
    if (op.kind === "add") {
      added += 1;
      changeIndices.push(idx);
    } else if (op.kind === "del") {
      removed += 1;
      changeIndices.push(idx);
    }
  }

  if (changeIndices.length === 0) {
    return { hunks: [], added: 0, removed: 0 };
  }

  const ranges: { start: number; end: number }[] = [];
  for (const ci of changeIndices) {
    const start = Math.max(0, ci - contextLines);
    const end = Math.min(ops.length - 1, ci + contextLines);
    const prev = ranges[ranges.length - 1];
    if (prev !== undefined && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const hunks: TspDiffHunk[] = ranges.map((range) => {
    const first = ops[range.start]!;
    const lines: string[] = [];
    for (let k = range.start; k <= range.end; k += 1) {
      const op = ops[k]!;
      if (op.kind === "add") lines.push(`+${op.line}`);
      else if (op.kind === "del") lines.push(`-${op.line}`);
      else lines.push(` ${op.line}`);
    }
    return {
      oldStart: Math.max(1, first.oldLine),
      newStart: Math.max(1, first.newLine),
      lines,
    };
  });

  return { hunks, added, removed };
}

function formatCompactCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

function formatUsageFooter(usage: PiUsage | undefined, model?: string): string | null {
  if (usage === undefined) return null;
  const parts: string[] = [];
  const totalTokens =
    usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (totalTokens > 0) {
    parts.push(`${formatCompactCount(totalTokens)} tok`);
  }
  const cost = usage.cost?.total;
  if (typeof cost === "number" && cost > 0) {
    parts.push(cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`);
  }
  if (typeof model === "string" && model !== "") {
    parts.push(model);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatClockTime(timestamp: number | undefined): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function extractContentTextAndImages(content: string | readonly PiContentBlock[] | undefined): {
  text: string;
  images: PiImageContent[];
} {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (!Array.isArray(content)) {
    return { text: "", images: [] };
  }
  const textParts: string[] = [];
  const images: PiImageContent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      textParts.push(block["text"]);
    } else if (
      block["type"] === "image" &&
      typeof block["data"] === "string" &&
      typeof block["mimeType"] === "string"
    ) {
      images.push({
        type: "image",
        data: block["data"],
        mimeType: block["mimeType"],
      });
    }
  }
  return { text: textParts.join("\n"), images };
}

function capitalizeToolTitle(name: string): string {
  switch (name) {
    case "bash":
      return "Bash";
    case "powershell":
      return "PowerShell";
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
    case "grep":
      return "Grep";
    case "find":
      return "Find";
    case "ls":
      return "List";
    case "codemode":
      return "Codemode";
    case "tool_search":
      return "Tool Search";
    default:
      return name.charAt(0).toUpperCase() + name.slice(1);
  }
}

function workingLabelForTool(toolName: string, args: Readonly<Record<string, unknown>>): string {
  const pathArg =
    typeof args["path"] === "string"
      ? args["path"]
      : typeof args["file_path"] === "string"
        ? args["file_path"]
        : undefined;
  const cmdArg = typeof args["command"] === "string" ? (args["command"].trim().split(/\r?\n/)[0] ?? "") : undefined;

  if ((toolName === "bash" || toolName === "powershell") && cmdArg !== undefined && cmdArg !== "") {
    const shortCmd = cmdArg.length > 64 ? `${cmdArg.slice(0, 61)}…` : cmdArg;
    return `Running ${toolName}: ${shortCmd}`;
  }
  if (toolName === "edit" && pathArg !== undefined) return `Editing ${pathArg}`;
  if (toolName === "write" && pathArg !== undefined) return `Writing ${pathArg}`;
  if (toolName === "read" && pathArg !== undefined) return `Reading ${pathArg}`;
  if (pathArg !== undefined) return `${capitalizeToolTitle(toolName)}: ${pathArg}`;
  return `Running ${toolName}…`;
}

// ───────── Bridge Class ─────────

export class PiTspBridge {
  private readonly doc: TspDocument = createDocument();
  private readonly blobs = new Map<string, PiTspBlobRecord>();
  private readonly frameListeners = new Set<(messages: TspDocMessage[], firstSeq: number) => void>();
  private readonly notifyListeners = new Set<
    (info: { message: string; level: "info" | "warning" | "error" }) => void
  >();
  private readonly editorPrefillListeners = new Set<(text: string) => void>();
  private readonly titleListeners = new Set<(title: string) => void>();

  private frameCounter = 0;
  private seqCounter = 0;
  private idCounter = 0;

  private hudActive = false;
  private liveThinking = new Map<number, LiveThinkingState>();
  private liveText = new Map<number, LiveTextState>();
  private liveTools = new Map<string, LiveToolState>();
  private lastStreamAssistantId: string | null = null;
  private pendingOptimisticUsers: string[] = [];
  private activeDialog: ActiveDialogState | null = null;
  private lastHydrationMeta: SessionHydrationMeta = {
    sessionId: null,
    sessionName: null,
    cwd: null,
    leafId: null,
    labels: new Map(),
  };

  constructor(title = "pi") {
    this.initSurface(title);
  }

  get document(): TspDocument {
    return this.doc;
  }

  get seq(): number {
    return this.seqCounter;
  }

  get frameNumber(): number {
    return this.frameCounter;
  }

  get hydrationMeta(): SessionHydrationMeta {
    return this.lastHydrationMeta;
  }

  get hasActiveDialog(): boolean {
    return this.activeDialog !== null;
  }

  onFrames(listener: (messages: TspDocMessage[], firstSeq: number) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  onNotify(listener: (info: { message: string; level: "info" | "warning" | "error" }) => void): () => void {
    this.notifyListeners.add(listener);
    return () => {
      this.notifyListeners.delete(listener);
    };
  }

  onEditorPrefill(listener: (text: string) => void): () => void {
    this.editorPrefillListeners.add(listener);
    return () => {
      this.editorPrefillListeners.delete(listener);
    };
  }

  onTitleChange(listener: (title: string) => void): () => void {
    this.titleListeners.add(listener);
    return () => {
      this.titleListeners.delete(listener);
    };
  }

  getBlob(id: string): PiTspBlobRecord | null {
    return this.blobs.get(id) ?? null;
  }

  // ───────── Surface Initialization & Frame Emission ─────────

  private initSurface(title: string): TspDocMessage[] {
    const openMsg: TspDocMessage = {
      verb: "o",
      body: {
        id: PI_SURFACE_ID,
        mode: "inline",
        title,
        role: "omp.session",
      },
    };
    applyMessage(this.doc, openMsg);
    this.seqCounter += 1;

    const initOps: TspOp[] = [
      ["add", "main", PI_SURFACE_ID, null, { id: "main", k: "col", p: { gap: "md" } }],
      [
        "add",
        "dock",
        PI_SURFACE_ID,
        null,
        {
          id: "dock",
          k: "col",
          p: { gap: "xs" },
          c: [
            { id: "dock.hud", k: "col", p: { gap: "xs" } },
            { id: "dock.dialog", k: "col", p: { gap: "xs" } },
          ],
        },
      ],
      ["add", "layer", PI_SURFACE_ID, null, { id: "layer", k: "col" }],
    ];

    const initFrame: TspDocMessage = {
      verb: "f",
      body: {
        sf: PI_SURFACE_ID,
        s: ++this.frameCounter,
        ops: initOps,
      },
    };
    applyMessage(this.doc, initFrame);
    this.seqCounter += 1;
    return [openMsg, initFrame];
  }

  private nextId(prefix: string): string {
    return `${prefix}_${++this.idCounter}`;
  }

  private emitBlob(image: PiImageContent): { blobId: string; msg: TspDocMessage | null } {
    const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
    const blobId = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
    if (this.blobs.has(blobId)) {
      return { blobId, msg: null };
    }
    this.blobs.set(blobId, {
      id: blobId,
      mime: image.mimeType,
      bytes,
      base64: image.data,
    });
    const msg: TspDocMessage = {
      verb: "b",
      id: blobId,
      mime: image.mimeType,
      data: image.data,
    };
    return { blobId, msg };
  }

  private emitOps(ops: TspOp[], preMessages: TspDocMessage[] = []): TspDocMessage[] {
    const out: TspDocMessage[] = [];
    for (const pre of preMessages) {
      applyMessage(this.doc, pre);
      out.push(pre);
    }
    if (ops.length > 0) {
      const frame: TspDocMessage = {
        verb: "f",
        body: {
          sf: PI_SURFACE_ID,
          s: ++this.frameCounter,
          ops,
        },
      };
      applyMessage(this.doc, frame);
      out.push(frame);
    }
    if (out.length > 0) {
      const firstSeq = this.seqCounter + 1;
      this.seqCounter += out.length;
      for (const listener of this.frameListeners) {
        listener(out, firstSeq);
      }
    }
    return out;
  }

  private nodeExists(id: string): boolean {
    return this.doc.surfaces.get(PI_SURFACE_ID)?.nodes.has(id) === true;
  }

  private appendClearChildrenOps(ops: TspOp[], containerId: string): void {
    const children = this.doc.surfaces.get(PI_SURFACE_ID)?.nodes.get(containerId)?.c;
    if (children === undefined || children.length === 0) return;
    for (const childId of children) {
      ops.push(["del", childId]);
    }
  }

  private appendReplaceNodeOps(ops: TspOp[], nodeId: string, newNode: TspNode, fallbackParent = "main"): void {
    const surface = this.doc.surfaces.get(PI_SURFACE_ID);
    const existing = surface?.nodes.get(nodeId);
    if (existing !== undefined && existing.parent !== null && surface !== undefined) {
      const siblings = surface.nodes.get(existing.parent)?.c ?? [];
      const idx = siblings.indexOf(nodeId);
      const before = idx >= 0 && idx + 1 < siblings.length ? (siblings[idx + 1] ?? null) : null;
      ops.push(["del", nodeId], ["add", nodeId, existing.parent, before, newNode]);
      return;
    }
    ops.push(["add", nodeId, fallbackParent, null, newNode]);
  }

  // ───────── Node Builders ─────────

  private buildUserCardNode(params: {
    cardId: string;
    text: string;
    images: readonly PiImageContent[];
    entryId?: string | undefined;
    timestamp?: number | undefined;
    blobMessagesOut: TspDocMessage[];
  }): TspNode {
    const { cardId, text, images, entryId, timestamp, blobMessagesOut } = params;
    const toolsRowChildren: TspNode[] = [
      {
        id: `${cardId}/copy`,
        k: "row",
        p: {
          role: "omp.btn",
          actions: { click: "copy-message" },
        },
        c: [{ id: `${cardId}/copy.i`, k: "icon", p: { name: "copy", tone: "muted" } }],
      },
      {
        id: `${cardId}/rewind`,
        k: "row",
        p: {
          role: "omp.btn",
          actions: { click: "rewind" },
        },
        c: [{ id: `${cardId}/rewind.i`, k: "icon", p: { name: "undo", tone: "muted" } }],
      },
    ];

    const clock = formatClockTime(timestamp);
    if (clock !== null) {
      toolsRowChildren.push({
        id: `${cardId}/time`,
        k: "text",
        p: { spans: [{ t: clock, s: "muted" }] },
      });
    }

    const cardChildren: TspNode[] = [
      {
        id: `${cardId}/tools`,
        k: "row",
        p: {
          role: "omp.user.tools",
          gap: "xs",
          align: "center",
          justify: "end",
        },
        c: toolsRowChildren,
      },
    ];

    if (text !== "" || images.length === 0) {
      cardChildren.push({
        id: `${cardId}/md`,
        k: "md",
        p: { text },
      });
    }

    images.forEach((img, idx) => {
      const { blobId, msg } = this.emitBlob(img);
      if (msg !== null) blobMessagesOut.push(msg);
      cardChildren.push({
        id: `${cardId}/img.${idx}`,
        k: "image",
        p: {
          blob: blobId,
          alt: `Image ${idx + 1}`,
          max: { h: "16lines" },
        },
      });
    });

    return {
      id: cardId,
      k: "card",
      p: {
        role: "omp.user",
        tone: "user",
        ...(entryId !== undefined && entryId !== "" ? { key: entryId } : {}),
      },
      c: cardChildren,
    };
  }

  private buildThinkingSectionNode(params: {
    sectionId: string;
    thinkingText: string;
    live: boolean;
    durationSec?: number | undefined;
  }): { section: TspNode; headId: string; bodyId: string } {
    const { sectionId, thinkingText, live, durationSec } = params;
    const headId = `${sectionId}/head`;
    const bodyId = `${sectionId}/body`;

    const label = live
      ? "Thinking…"
      : durationSec !== undefined && durationSec > 0
        ? `Thought for ${durationSec.toFixed(1)}s`
        : "Thought";

    const headNode: TspNode = live
      ? { id: headId, k: "shimmer", p: { text: label } }
      : { id: headId, k: "text", p: { text: label } };

    const section: TspNode = {
      id: sectionId,
      k: "section",
      p: {
        role: live ? "omp.thinking.live" : "omp.thinking",
        collapsible: true,
        collapsed: !live,
        head: headId,
        ...(!live && durationSec !== undefined && durationSec > 0 ? { took: Math.round(durationSec * 1000) } : {}),
      },
      c: [
        headNode,
        {
          id: bodyId,
          k: "md",
          p: {
            role: "omp.thinking.body",
            text: thinkingText,
            ...(live ? { stream: true } : {}),
          },
        },
      ],
    };

    return { section, headId, bodyId };
  }

  private buildToolNode(params: {
    nodeId: string;
    toolCallId: string;
    toolName: string;
    args: Readonly<Record<string, unknown>>;
    status: "pending" | "running" | "done" | "error" | "cancelled";
    outputText: string;
    images?: readonly PiImageContent[] | undefined;
    details?: Readonly<Record<string, unknown>> | undefined;
    durationMs?: number | undefined;
    blobMessagesOut: TspDocMessage[];
  }): { node: TspNode; outputId: string | null } {
    const {
      nodeId,
      toolCallId,
      toolName,
      args,
      status,
      outputText,
      images = [],
      details,
      durationMs,
      blobMessagesOut,
    } = params;

    const title = capitalizeToolTitle(toolName);
    const props: TspProps<"tool"> = {
      role: `omp.tool.${toolName}`,
      key: toolCallId,
      name: toolName,
      title,
      status,
      frame: "card",
      collapsible: true,
      collapsed: true,
      preview: "children",
    };

    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
      props.took = Math.round(durationMs);
    }

    const children: TspNode[] = [];
    let outputId: string | null = null;

    if (toolName === "bash" || toolName === "powershell") {
      const command = typeof args["command"] === "string" ? args["command"] : "";
      if (command !== "") {
        props.command = command;
        const lines = command
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l !== "");
        const commentLine = lines.find((l) => /^#\s*\S/.test(l));
        const meaningfulLine =
          commentLine !== undefined
            ? commentLine.replace(/^#+\s*/, "")
            : (lines.find(
                (l) =>
                  !/^(?:Set-Location|cd|pushd|\$ErrorActionPreference\s*=|export\s+\w+=)/i.test(l) &&
                  !l.startsWith("#"),
              ) ??
              lines[0] ??
              command);
        props.target = meaningfulLine.slice(0, 120);
        props.targetKind = "command";
      }
      const lang = toolName === "powershell" ? "powershell" : "bash";
      const outId = `${nodeId}/out`;
      outputId = outId;
      children.push({
        id: `${nodeId}/run`,
        k: "col",
        p: { role: "omp.run", gap: "xs" },
        c: [
          {
            id: `${nodeId}/cmd`,
            k: "code",
            p: {
              role: "omp.tool.bash.command",
              lang,
              text: command,
            },
          },
          {
            id: outId,
            k: "ansi",
            p: {
              role: "omp.tool.bash.output",
              text: outputText,
              preview: { lines: 6 },
            },
          },
        ],
      });
    } else if (toolName === "edit" || toolName === "write" || toolName === "read") {
      const targetPath =
        typeof args["path"] === "string"
          ? args["path"]
          : typeof args["file_path"] === "string"
            ? args["file_path"]
            : "";
      if (targetPath !== "") {
        props.target = targetPath;
        props.targetKind = "path";
      }

      if (toolName === "edit") {
        let diffInfo: { hunks: TspDiffHunk[]; added: number; removed: number } | null = null;
        if (details !== undefined && typeof details["diff"] === "string" && details["diff"].trim() !== "") {
          diffInfo = parseUnifiedDiffHunks(details["diff"]);
        } else {
          const oldText =
            typeof args["oldText"] === "string"
              ? args["oldText"]
              : typeof args["old_str"] === "string"
                ? args["old_str"]
                : undefined;
          const newText =
            typeof args["newText"] === "string"
              ? args["newText"]
              : typeof args["new_str"] === "string"
                ? args["new_str"]
                : undefined;
          if (oldText !== undefined && newText !== undefined) {
            diffInfo = computeTextDiffHunks(oldText, newText);
          } else if (Array.isArray(args["edits"])) {
            const combinedHunks: TspDiffHunk[] = [];
            let totalAdd = 0;
            let totalRem = 0;
            for (const editItem of args["edits"]) {
              if (
                isRecord(editItem) &&
                typeof editItem["oldText"] === "string" &&
                typeof editItem["newText"] === "string"
              ) {
                const sub = computeTextDiffHunks(editItem["oldText"], editItem["newText"]);
                combinedHunks.push(...sub.hunks);
                totalAdd += sub.added;
                totalRem += sub.removed;
              }
            }
            if (combinedHunks.length > 0 || totalAdd > 0 || totalRem > 0) {
              diffInfo = { hunks: combinedHunks, added: totalAdd, removed: totalRem };
            }
          }
        }

        if (diffInfo !== null && (diffInfo.hunks.length > 0 || diffInfo.added > 0 || diffInfo.removed > 0)) {
          props.meta = [`+${diffInfo.added} −${diffInfo.removed}`];
          children.push({
            id: `${nodeId}/diff`,
            k: "diff",
            p: {
              path: targetPath,
              hunks: diffInfo.hunks,
            },
          });
        }
        if (status === "error" && outputText !== "") {
          const outId = `${nodeId}/out`;
          outputId = outId;
          children.push({
            id: outId,
            k: "ansi",
            p: { text: outputText, preview: { lines: 6 } },
          });
        }
      } else if (toolName === "write") {
        const content = typeof args["content"] === "string" ? args["content"] : undefined;
        if (content !== undefined) {
          const lines = splitLines(content);
          const addedCount = lines.length === 0 && content.length > 0 ? 1 : lines.length;
          props.meta = [`+${addedCount} −0`];
          const hunkLines = (lines.length > 0 ? lines : [content]).map((l) => `+${l}`);
          children.push({
            id: `${nodeId}/diff`,
            k: "diff",
            p: {
              path: targetPath,
              hunks: [{ oldStart: 1, newStart: 1, lines: hunkLines }],
            },
          });
        }
        if (status === "error" && outputText !== "") {
          const outId = `${nodeId}/out`;
          outputId = outId;
          children.push({
            id: outId,
            k: "ansi",
            p: { text: outputText, preview: { lines: 6 } },
          });
        }
      } else {
        // read
        const lineCount = splitLines(outputText).length;
        if (lineCount > 0) {
          props.meta = [`${lineCount} lines`];
        }
        const outId = `${nodeId}/code`;
        outputId = outId;
        children.push({
          id: outId,
          k: "code",
          p: {
            text: outputText,
            preview: { lines: 6 },
          },
        });
      }
    } else {
      const queriesList = Array.isArray(args["queries"])
        ? (args["queries"] as unknown[]).filter((q): q is string => typeof q === "string" && q.trim() !== "")
        : [];
      const urlsList = Array.isArray(args["urls"])
        ? (args["urls"] as unknown[]).filter((u): u is string => typeof u === "string" && u.trim() !== "")
        : [];
      const targetCandidate =
        typeof args["path"] === "string"
          ? args["path"]
          : typeof args["pattern"] === "string"
            ? args["pattern"]
            : typeof args["query"] === "string"
              ? args["query"]
              : queriesList.length > 0
                ? queriesList.slice(0, 2).join(" · ")
                : typeof args["url"] === "string"
                  ? args["url"]
                  : urlsList.length > 0
                    ? urlsList[0]
                    : typeof args["claim"] === "string"
                      ? args["claim"]
                      : typeof args["tool"] === "string"
                        ? args["tool"]
                        : typeof args["search"] === "string"
                          ? args["search"]
                          : typeof args["server"] === "string"
                            ? args["server"]
                            : typeof args["memory"] === "string"
                              ? args["memory"]
                              : typeof args["findText"] === "string"
                                ? args["findText"]
                                : undefined;
      if (targetCandidate !== undefined && targetCandidate !== "") {
        props.target = targetCandidate;
        if (typeof args["path"] === "string") {
          props.targetKind = "path";
        }
      }
      const outId = `${nodeId}/out`;
      outputId = outId;
      children.push({
        id: outId,
        k: "ansi",
        p: {
          text: outputText,
          preview: { lines: 6 },
        },
      });
    }

    images.forEach((img, idx) => {
      const { blobId, msg } = this.emitBlob(img);
      if (msg !== null) blobMessagesOut.push(msg);
      children.push({
        id: `${nodeId}/img.${idx}`,
        k: "image",
        p: {
          blob: blobId,
          alt: `${toolName} image ${idx + 1}`,
          max: { h: "16lines" },
        },
      });
    });

    return {
      node: {
        id: nodeId,
        k: "tool",
        p: props,
        c: children,
      },
      outputId,
    };
  }

  private buildUsageRowNode(rowId: string, usageText: string): TspNode {
    return {
      id: rowId,
      k: "row",
      p: {
        role: "omp.turn.usage",
        gap: "xs",
        align: "center",
      },
      c: [
        { id: `${rowId}/icon`, k: "icon", p: { name: "time", tone: "muted" } },
        { id: `${rowId}/text`, k: "text", p: { spans: [{ t: usageText, s: "muted" }] } },
      ],
    };
  }

  private buildErrorCardNode(cardId: string, errorMessageText: string): TspNode {
    return {
      id: cardId,
      k: "card",
      p: {
        role: "omp.error",
        tone: "error",
      },
      c: [
        {
          id: `${cardId}/head`,
          k: "row",
          p: { gap: "xs", align: "center" },
          c: [
            { id: `${cardId}/icon`, k: "icon", p: { name: "error", tone: "error" } },
            { id: `${cardId}/title`, k: "text", p: { spans: [{ t: "Error", s: "error strong" }] } },
          ],
        },
        {
          id: `${cardId}/body`,
          k: "md",
          p: { role: "omp.error.body", text: errorMessageText },
        },
      ],
    };
  }

  private buildCompactionSectionNode(sectionId: string, summary: string, tokensBefore?: number | undefined): TspNode {
    const headId = `${sectionId}/head`;
    const label =
      typeof tokensBefore === "number" && tokensBefore > 0
        ? `Compacted context · ${formatCompactCount(tokensBefore)} tokens`
        : "Compacted context";
    return {
      id: sectionId,
      k: "section",
      p: {
        role: "omp.compaction",
        collapsible: true,
        collapsed: true,
        head: headId,
      },
      c: [
        {
          id: headId,
          k: "row",
          p: { gap: "xs", align: "center" },
          c: [
            { id: `${headId}/icon`, k: "icon", p: { name: "compress", tone: "muted" } },
            { id: `${headId}/text`, k: "text", p: { spans: [{ t: label, s: "muted" }] } },
          ],
        },
        {
          id: `${sectionId}/body`,
          k: "md",
          p: { role: "omp.compaction.body", text: summary || "(Empty summary)" },
        },
      ],
    };
  }

  private buildBranchSummarySectionNode(sectionId: string, summary: string): TspNode {
    const headId = `${sectionId}/head`;
    return {
      id: sectionId,
      k: "section",
      p: {
        role: "omp.branch_summary",
        collapsible: true,
        collapsed: true,
        head: headId,
      },
      c: [
        {
          id: headId,
          k: "row",
          p: { gap: "xs", align: "center" },
          c: [
            { id: `${headId}/icon`, k: "icon", p: { name: "branch", tone: "muted" } },
            { id: `${headId}/text`, k: "text", p: { spans: [{ t: "Branch summary", s: "muted" }] } },
          ],
        },
        {
          id: `${sectionId}/body`,
          k: "md",
          p: { role: "omp.branch_summary.body", text: summary || "(Empty branch summary)" },
        },
      ],
    };
  }

  // ───────── Optimistic User Prompt Helper ─────────

  appendOptimisticUserMessage(text: string, images: readonly PiImageContent[] = [], entryId?: string): TspDocMessage[] {
    this.pendingOptimisticUsers.push(text.trim());
    const blobMessages: TspDocMessage[] = [];
    const cardId = this.nextId("user");
    const card = this.buildUserCardNode({
      cardId,
      text,
      images,
      entryId,
      timestamp: Date.now(),
      blobMessagesOut: blobMessages,
    });
    return this.emitOps([["add", cardId, "main", null, card]], blobMessages);
  }

  // ───────── Session File & Message History Hydration ─────────

  async hydrateFromSessionFile(sessionFile: string, options?: HydrateSessionOptions): Promise<TspDocMessage[]> {
    let content: string;
    try {
      content = await readFile(sessionFile, "utf8");
    } catch {
      return [];
    }
    return this.hydrateFromSessionJsonl(content, options);
  }

  hydrateFromSessionJsonl(jsonlContent: string, options?: HydrateSessionOptions): TspDocMessage[] {
    const rawLines = jsonlContent.split("\n");
    const entries: Record<string, unknown>[] = [];
    let header: Record<string, unknown> | null = null;

    for (let raw of rawLines) {
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      if (raw.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || typeof parsed["type"] !== "string") continue;
        if (parsed["type"] === "session" && header === null) {
          header = parsed;
        } else {
          entries.push(parsed);
        }
      } catch {
        // Ignore malformed/partial trailing JSONL line.
      }
    }

    const sessionId = typeof header?.["id"] === "string" ? header["id"] : null;
    const cwd = typeof header?.["cwd"] === "string" ? header["cwd"] : null;
    let sessionName: string | null = null;
    const labels = new Map<string, string>();

    const hasTreeIds = entries.some((e) => typeof e["id"] === "string");
    let activeEntries: Record<string, unknown>[] = [];
    let resolvedLeafId: string | null = null;

    if (!hasTreeIds) {
      activeEntries = entries;
    } else {
      const byId = new Map<string, Record<string, unknown>>();
      let lastTreeEntryId: string | null = null;
      for (const entry of entries) {
        const id = typeof entry["id"] === "string" ? entry["id"] : null;
        if (id !== null) {
          byId.set(id, entry);
          lastTreeEntryId = id;
        }
        if (entry["type"] === "session_info" && typeof entry["name"] === "string") {
          const trimmedName = entry["name"].trim();
          sessionName = trimmedName !== "" ? trimmedName : null;
        } else if (entry["type"] === "label" && typeof entry["targetId"] === "string") {
          const lbl = typeof entry["label"] === "string" ? entry["label"].trim() : "";
          if (lbl !== "") labels.set(entry["targetId"], lbl);
          else labels.delete(entry["targetId"]);
        }
      }

      if (options?.leafId === null) {
        resolvedLeafId = null;
        activeEntries = [];
      } else {
        const candidateLeaf =
          options?.leafId !== undefined && byId.has(options.leafId) ? options.leafId : lastTreeEntryId;
        resolvedLeafId = candidateLeaf;
        if (candidateLeaf !== null) {
          const chain: Record<string, unknown>[] = [];
          const visited = new Set<string>();
          let curId: string | null = candidateLeaf;
          while (curId !== null && !visited.has(curId)) {
            visited.add(curId);
            const node = byId.get(curId);
            if (node === undefined) break;
            chain.push(node);
            curId = typeof node["parentId"] === "string" ? node["parentId"] : null;
          }
          chain.reverse();
          activeEntries = chain;
        }
      }
    }

    this.lastHydrationMeta = {
      sessionId,
      sessionName,
      cwd,
      leafId: resolvedLeafId,
      labels,
    };

    if (sessionName !== null) {
      for (const listener of this.titleListeners) {
        listener(sessionName);
      }
    }

    return this.renderHydratedBranch(activeEntries);
  }

  hydrateFromMessages(messages: readonly PiAgentMessage[]): TspDocMessage[] {
    const syntheticEntries: Record<string, unknown>[] = messages.map((message, index) => ({
      type: "message",
      id: `msg_${index + 1}`,
      parentId: index === 0 ? null : `msg_${index}`,
      message,
    }));
    return this.renderHydratedBranch(syntheticEntries);
  }

  private renderHydratedBranch(branchEntries: readonly Record<string, unknown>[]): TspDocMessage[] {
    this.resetStreamingState();

    // Index toolResult messages by toolCallId so assistant toolCalls pair cleanly.
    const toolResults = new Map<string, PiToolResultMessage>();
    for (const entry of branchEntries) {
      if (entry["type"] === "message" && isRecord(entry["message"])) {
        const msg = entry["message"] as unknown as PiAgentMessage;
        if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
          toolResults.set(msg.toolCallId, msg);
        }
      }
    }

    const blobMessages: TspDocMessage[] = [];
    const ops: TspOp[] = [];
    this.appendClearChildrenOps(ops, "main");
    this.appendClearChildrenOps(ops, "dock.hud");
    this.appendClearChildrenOps(ops, "dock.dialog");

    const consumedToolResults = new Set<string>();

    for (const entry of branchEntries) {
      const entryType = entry["type"];
      const entryId = typeof entry["id"] === "string" ? entry["id"] : undefined;

      if (entryType === "compaction") {
        const secId = this.nextId("compact");
        const summary = typeof entry["summary"] === "string" ? entry["summary"] : "";
        const tokensBefore = typeof entry["tokensBefore"] === "number" ? entry["tokensBefore"] : undefined;
        ops.push(["add", secId, "main", null, this.buildCompactionSectionNode(secId, summary, tokensBefore)]);
        continue;
      }

      if (entryType === "branch_summary") {
        const secId = this.nextId("branch");
        const summary = typeof entry["summary"] === "string" ? entry["summary"] : "";
        ops.push(["add", secId, "main", null, this.buildBranchSummarySectionNode(secId, summary)]);
        continue;
      }

      if (entryType === "custom_message") {
        if (entry["display"] === false) continue;
        const { text } = extractContentTextAndImages(
          entry["content"] as string | readonly PiContentBlock[] | undefined,
        );
        if (text.trim() !== "") {
          const cardId = this.nextId("custom");
          ops.push([
            "add",
            cardId,
            "main",
            null,
            {
              id: cardId,
              k: "card",
              p: { role: "omp.custom" },
              c: [{ id: `${cardId}/md`, k: "md", p: { text } }],
            },
          ]);
        }
        continue;
      }

      if (entryType !== "message" || !isRecord(entry["message"])) {
        continue;
      }

      const msg = entry["message"] as unknown as PiAgentMessage;

      if (msg.role === "user") {
        const { text, images } = extractContentTextAndImages(msg.content);
        const cardId = this.nextId("user");
        const card = this.buildUserCardNode({
          cardId,
          text,
          images,
          entryId,
          timestamp: msg.timestamp,
          blobMessagesOut: blobMessages,
        });
        ops.push(["add", cardId, "main", null, card]);
      } else if (msg.role === "assistant") {
        this.appendHydratedAssistantMessage(msg, toolResults, consumedToolResults, ops, blobMessages);
      } else if (msg.role === "toolResult") {
        if (consumedToolResults.has(msg.toolCallId)) continue;
        consumedToolResults.add(msg.toolCallId);
        const { text, images } = extractContentTextAndImages(msg.content);
        const nodeId = this.nextId("tool");
        const { node } = this.buildToolNode({
          nodeId,
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          args: {},
          status: msg.isError === true ? "error" : "done",
          outputText: text,
          images,
          details: msg.details,
          blobMessagesOut: blobMessages,
        });
        ops.push(["add", nodeId, "main", null, node]);
      } else if (msg.role === "bashExecution") {
        const nodeId = this.nextId("bash");
        const isError = typeof msg.exitCode === "number" && msg.exitCode !== 0;
        const { node } = this.buildToolNode({
          nodeId,
          toolCallId: nodeId,
          toolName: "bash",
          args: { command: msg.command },
          status: msg.cancelled === true ? "cancelled" : isError ? "error" : "done",
          outputText: msg.output ?? "",
          blobMessagesOut: blobMessages,
        });
        ops.push(["add", nodeId, "main", null, node]);
      } else if (msg.role === "compactionSummary") {
        const secId = this.nextId("compact");
        ops.push([
          "add",
          secId,
          "main",
          null,
          this.buildCompactionSectionNode(secId, msg.summary ?? "", msg.tokensBefore),
        ]);
      } else if (msg.role === "branchSummary") {
        const secId = this.nextId("branch");
        ops.push(["add", secId, "main", null, this.buildBranchSummarySectionNode(secId, msg.summary ?? "")]);
      } else if (msg.role === "custom" && msg.display !== false) {
        const { text } = extractContentTextAndImages(msg.content);
        if (text.trim() !== "") {
          const cardId = this.nextId("custom");
          ops.push([
            "add",
            cardId,
            "main",
            null,
            {
              id: cardId,
              k: "card",
              p: { role: "omp.custom" },
              c: [{ id: `${cardId}/md`, k: "md", p: { text } }],
            },
          ]);
        }
      }
    }

    return this.emitOps(ops, blobMessages);
  }

  private appendHydratedAssistantMessage(
    msg: PiAssistantMessage,
    toolResults: ReadonlyMap<string, PiToolResultMessage>,
    consumedToolResults: Set<string>,
    ops: TspOp[],
    blobMessages: TspDocMessage[],
  ): void {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const textPieces: string[] = [];

    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block["type"] === "thinking") {
        const tb = block as unknown as PiThinkingContent;
        const rawThinking = typeof tb.thinking === "string" ? tb.thinking : "";
        if (rawThinking.trim() === "" && tb.redacted !== true) continue;
        const wrapId = this.nextId("asst_th");
        const secId = `${wrapId}/sec`;
        const { section } = this.buildThinkingSectionNode({
          sectionId: secId,
          thinkingText: rawThinking.trim() !== "" ? rawThinking : "(Redacted thinking)",
          live: false,
        });
        ops.push([
          "add",
          wrapId,
          "main",
          null,
          {
            id: wrapId,
            k: "col",
            p: { role: "omp.assistant", gap: "sm" },
            c: [section],
          },
        ]);
      } else if (block["type"] === "toolCall") {
        const tc = block as unknown as PiToolCallContent;
        const paired = toolResults.get(tc.id);
        if (paired !== undefined) consumedToolResults.add(tc.id);
        const extracted = paired !== undefined ? extractContentTextAndImages(paired.content) : { text: "", images: [] };
        const durationMs =
          typeof msg.timestamp === "number" &&
          typeof paired?.timestamp === "number" &&
          paired.timestamp >= msg.timestamp
            ? paired.timestamp - msg.timestamp
            : undefined;
        const nodeId = this.nextId("tool");
        const { node } = this.buildToolNode({
          nodeId,
          toolCallId: tc.id,
          toolName: tc.name,
          args: isRecord(tc.arguments) ? tc.arguments : {},
          status: paired?.isError === true ? "error" : "done",
          outputText: extracted.text,
          images: extracted.images,
          details: paired?.details,
          durationMs,
          blobMessagesOut: blobMessages,
        });
        ops.push(["add", nodeId, "main", null, node]);
      } else if (block["type"] === "text") {
        const tx = block as unknown as PiTextContent;
        if (typeof tx.text === "string" && tx.text !== "") {
          textPieces.push(tx.text);
        }
      }
    }

    const answerText = textPieces.join("\n\n");
    const isErrorStop = msg.stopReason === "error" && typeof msg.errorMessage === "string" && msg.errorMessage !== "";
    const usageSummary = !isErrorStop ? formatUsageFooter(msg.usage, msg.model) : null;

    if (answerText !== "" || isErrorStop || (usageSummary !== null && blocks.every((b) => b.type !== "toolCall"))) {
      const colId = this.nextId("asst");
      const children: TspNode[] = [];
      if (answerText !== "") {
        children.push({
          id: `${colId}/md`,
          k: "md",
          p: { text: answerText },
        });
      }
      if (isErrorStop && msg.errorMessage !== undefined) {
        children.push(this.buildErrorCardNode(`${colId}/err`, msg.errorMessage));
      } else if (usageSummary !== null && answerText !== "") {
        children.push(this.buildUsageRowNode(`${colId}/usage`, usageSummary));
      }
      if (children.length > 0) {
        ops.push([
          "add",
          colId,
          "main",
          null,
          {
            id: colId,
            k: "col",
            p: { role: "omp.assistant", gap: "sm" },
            c: children,
          },
        ]);
      }
    }
  }

  // ───────── Live Streaming RPC Event Handler ─────────

  handleRpcEvent(event: PiRpcEvent): TspDocMessage[] {
    switch (event.type) {
      case "agent_start":
        return this.ensureWorkingHud("Working…");

      case "turn_start":
        this.liveThinking.clear();
        this.liveText.clear();
        this.lastStreamAssistantId = null;
        return this.ensureWorkingHud("Working…");

      case "message_start":
        return this.handleMessageStart(event.message);

      case "message_update":
        return this.handleMessageUpdate(event.assistantMessageEvent);

      case "tool_execution_start":
        return this.handleToolExecutionStart(event.toolCallId, event.toolName, event.args);

      case "tool_execution_update":
        return this.handleToolExecutionUpdate(event.toolCallId, event.toolName, event.args, event.partialResult);

      case "tool_execution_end":
        return this.handleToolExecutionEnd(
          event.toolCallId,
          event.toolName,
          event.result,
          event.isError,
          event.durationMs,
        );

      case "message_end":
        return this.handleMessageEnd(event.message);

      case "compaction_start":
        return this.ensureWorkingHud("Compacting context…");

      case "compaction_end": {
        const ops: TspOp[] = [];
        if (!event.aborted && event.result !== undefined && event.result !== null) {
          const secId = this.nextId("compact");
          ops.push([
            "add",
            secId,
            "main",
            null,
            this.buildCompactionSectionNode(secId, event.result.summary, event.result.tokensBefore),
          ]);
        }
        if (!event.willRetry) {
          this.appendClearHudOps(ops);
        }
        return this.emitOps(ops);
      }

      case "auto_retry_start":
        return this.ensureWorkingHud(`Retrying (${event.attempt}/${event.maxAttempts})…`);

      case "auto_retry_end":
        if (!event.success && typeof event.finalError === "string" && event.finalError !== "") {
          const colId = this.nextId("asst_err");
          const ops: TspOp[] = [
            [
              "add",
              colId,
              "main",
              null,
              {
                id: colId,
                k: "col",
                p: { role: "omp.assistant", gap: "sm" },
                c: [this.buildErrorCardNode(`${colId}/err`, event.finalError)],
              },
            ],
          ];
          this.appendClearHudOps(ops);
          return this.emitOps(ops);
        }
        return [];

      case "extension_ui_request":
        return this.handleExtensionUiRequest(event);

      case "session_info_changed":
        if (typeof event.name === "string" && event.name.trim() !== "") {
          for (const listener of this.titleListeners) {
            listener(event.name.trim());
          }
        }
        return [];

      case "agent_end":
        if (event.willRetry === true) {
          return [];
        }
        return this.clearWorkingHud();

      case "agent_settled": {
        this.liveThinking.clear();
        this.liveText.clear();
        this.lastStreamAssistantId = null;
        return this.clearWorkingHud();
      }

      default:
        return [];
    }
  }

  private ensureWorkingHud(label: string): TspDocMessage[] {
    const ops: TspOp[] = [];
    this.appendWorkingHudOps(ops, label);
    return this.emitOps(ops);
  }

  private appendWorkingHudOps(ops: TspOp[], label: string): void {
    const activityId = "dock.hud.activity";
    const labelId = "dock.hud.working.label";
    if (!this.hudActive || !this.nodeExists(activityId)) {
      this.hudActive = true;
      this.appendClearChildrenOps(ops, "dock.hud");
      ops.push([
        "add",
        activityId,
        "dock.hud",
        null,
        {
          id: activityId,
          k: "col",
          p: { role: "omp.hud.activity", gap: "xs" },
          c: [
            {
              id: "dock.hud.working",
              k: "row",
              p: { role: "omp.working", gap: "xs", align: "center" },
              c: [
                { id: "dock.hud.working.spin", k: "spinner", p: { tone: "accent" } },
                {
                  id: labelId,
                  k: "shimmer",
                  p: { role: "omp.working.label", spans: [{ t: label, s: "muted" }] },
                },
                { id: "dock.hud.working.elapsed", k: "elapsed", p: { age: 0 } },
                {
                  id: "dock.hud.working.stop",
                  k: "row",
                  p: { role: "omp.working.stop", actions: { click: "interrupt" } },
                  c: [{ id: "dock.hud.working.stop.t", k: "text", p: { text: "Stop" } }],
                },
              ],
            },
          ],
        },
      ]);
    } else if (this.nodeExists(labelId)) {
      ops.push(["set", labelId, { spans: [{ t: label, s: "muted" }] }]);
    }
  }

  private clearWorkingHud(): TspDocMessage[] {
    const ops: TspOp[] = [];
    this.appendClearHudOps(ops);
    return this.emitOps(ops);
  }

  private appendClearHudOps(ops: TspOp[]): void {
    if (this.hudActive || (this.doc.surfaces.get(PI_SURFACE_ID)?.nodes.get("dock.hud")?.c.length ?? 0) > 0) {
      this.hudActive = false;
      this.appendClearChildrenOps(ops, "dock.hud");
    }
  }

  private handleMessageStart(message: PiAgentMessage): TspDocMessage[] {
    if (message.role === "user") {
      const { text, images } = extractContentTextAndImages(message.content);
      const trimmed = text.trim();
      const optIdx = this.pendingOptimisticUsers.indexOf(trimmed);
      if (optIdx !== -1) {
        this.pendingOptimisticUsers.splice(optIdx, 1);
        return [];
      }
      // Also deduplicate if the very last node in `main` is already an `omp.user` card with identical text.
      const surface = this.doc.surfaces.get(PI_SURFACE_ID);
      const mainNode = surface?.nodes.get("main");
      const lastMainChildId = mainNode?.c[mainNode.c.length - 1];
      if (lastMainChildId !== undefined && surface !== undefined) {
        const lastNode = surface.nodes.get(lastMainChildId);
        if (lastNode?.k === "card" && lastNode.p["role"] === "omp.user") {
          for (const cid of lastNode.c) {
            const cnode = surface.nodes.get(cid);
            if (cnode?.k === "md" && typeof cnode.p["text"] === "string" && cnode.p["text"].trim() === trimmed) {
              return [];
            }
          }
        }
      }

      const blobMessages: TspDocMessage[] = [];
      const cardId = this.nextId("user");
      const card = this.buildUserCardNode({
        cardId,
        text,
        images,
        timestamp: message.timestamp ?? Date.now(),
        blobMessagesOut: blobMessages,
      });
      return this.emitOps([["add", cardId, "main", null, card]], blobMessages);
    }

    if (message.role === "assistant") {
      this.liveThinking.clear();
      this.liveText.clear();
      this.lastStreamAssistantId = null;
    }
    return [];
  }

  private handleMessageUpdate(sub: PiAssistantMessageEvent): TspDocMessage[] {
    const ops: TspOp[] = [];

    switch (sub.type) {
      case "thinking_start": {
        const wrapId = this.nextId("asst_th");
        const secId = `${wrapId}/sec`;
        const { section, headId, bodyId } = this.buildThinkingSectionNode({
          sectionId: secId,
          thinkingText: "",
          live: true,
        });
        this.liveThinking.set(sub.contentIndex, {
          wrapperId: wrapId,
          sectionId: secId,
          headId,
          bodyId,
          startedAtMs: Date.now(),
          hasToolsAfter: false,
        });
        this.appendWorkingHudOps(ops, "Thinking…");
        ops.push([
          "add",
          wrapId,
          "main",
          null,
          {
            id: wrapId,
            k: "col",
            p: { role: "omp.assistant", gap: "sm" },
            c: [section],
          },
        ]);
        return this.emitOps(ops);
      }

      case "thinking_delta": {
        let state = this.liveThinking.get(sub.contentIndex);
        if (state === undefined) {
          this.handleMessageUpdate({ type: "thinking_start", contentIndex: sub.contentIndex });
          state = this.liveThinking.get(sub.contentIndex);
        }
        if (state !== undefined && sub.delta !== "") {
          ops.push(["text", state.bodyId, "append", sub.delta]);
        }
        return this.emitOps(ops);
      }

      case "thinking_end": {
        const state = this.liveThinking.get(sub.contentIndex);
        if (state !== undefined) {
          const durationSec = Math.max(0.1, (Date.now() - state.startedAtMs) / 1000);
          this.appendReplaceNodeOps(
            ops,
            state.headId,
            { id: state.headId, k: "text", p: { text: `Thought for ${durationSec.toFixed(1)}s` } },
            state.sectionId,
          );
          ops.push(
            ["set", state.sectionId, { role: "omp.thinking", collapsed: true, took: Math.round(durationSec * 1000) }],
            [
              "set",
              state.bodyId,
              {
                stream: null,
                ...(typeof sub.content === "string" && sub.content !== "" ? { text: sub.content } : {}),
              },
            ],
          );
          this.liveThinking.delete(sub.contentIndex);
        }
        return this.emitOps(ops);
      }

      case "toolcall_start": {
        const tcId = sub.id ?? `tc_${sub.contentIndex}`;
        const tcName = sub.toolName ?? "tool";
        for (const th of this.liveThinking.values()) {
          th.hasToolsAfter = true;
        }
        if (!this.liveTools.has(tcId)) {
          const nodeId = this.nextId("tool");
          const { node, outputId } = this.buildToolNode({
            nodeId,
            toolCallId: tcId,
            toolName: tcName,
            args: {},
            status: "pending",
            outputText: "",
            blobMessagesOut: [],
          });
          this.liveTools.set(tcId, {
            nodeId,
            toolCallId: tcId,
            toolName: tcName,
            args: {},
            startedAtMs: Date.now(),
            outputId,
            streamedOutput: "",
          });
          this.appendWorkingHudOps(ops, `Preparing ${tcName}…`);
          ops.push(["add", nodeId, "main", null, node]);
        }
        return this.emitOps(ops);
      }

      case "toolcall_end": {
        const tc = sub.toolCall;
        const existing = this.liveTools.get(tc.id);
        const args = isRecord(tc.arguments) ? tc.arguments : {};
        if (existing !== undefined) {
          existing.toolName = tc.name;
          existing.args = args;
          const blobMsgs: TspDocMessage[] = [];
          const { node, outputId } = this.buildToolNode({
            nodeId: existing.nodeId,
            toolCallId: tc.id,
            toolName: tc.name,
            args,
            status: "pending",
            outputText: existing.streamedOutput,
            blobMessagesOut: blobMsgs,
          });
          existing.outputId = outputId;
          this.appendReplaceNodeOps(ops, existing.nodeId, node);
          return this.emitOps(ops, blobMsgs);
        }
        return [];
      }

      case "text_start": {
        const colId = this.nextId("asst");
        const mdId = `${colId}/md`;
        this.liveText.set(sub.contentIndex, { containerId: colId, mdId });
        this.lastStreamAssistantId = colId;
        this.appendWorkingHudOps(ops, "Writing response…");
        ops.push([
          "add",
          colId,
          "main",
          null,
          {
            id: colId,
            k: "col",
            p: { role: "omp.assistant", gap: "sm" },
            c: [
              {
                id: mdId,
                k: "md",
                p: { text: "", stream: true },
              },
            ],
          },
        ]);
        return this.emitOps(ops);
      }

      case "text_delta": {
        let state = this.liveText.get(sub.contentIndex);
        if (state === undefined) {
          this.handleMessageUpdate({ type: "text_start", contentIndex: sub.contentIndex });
          state = this.liveText.get(sub.contentIndex);
        }
        if (state !== undefined && sub.delta !== "") {
          ops.push(["text", state.mdId, "append", sub.delta]);
        }
        return this.emitOps(ops);
      }

      case "text_end": {
        const state = this.liveText.get(sub.contentIndex);
        if (state !== undefined) {
          ops.push([
            "set",
            state.mdId,
            {
              stream: null,
              ...(typeof sub.content === "string" && sub.content !== "" ? { text: sub.content } : {}),
            },
          ]);
          this.liveText.delete(sub.contentIndex);
        }
        return this.emitOps(ops);
      }

      default:
        return [];
    }
  }

  private handleToolExecutionStart(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): TspDocMessage[] {
    const ops: TspOp[] = [];
    const blobMsgs: TspDocMessage[] = [];
    this.appendWorkingHudOps(ops, workingLabelForTool(toolName, args));

    const existing = this.liveTools.get(toolCallId);
    if (existing !== undefined) {
      existing.toolName = toolName;
      existing.args = args;
      existing.startedAtMs = Date.now();
      const { node, outputId } = this.buildToolNode({
        nodeId: existing.nodeId,
        toolCallId,
        toolName,
        args,
        status: "running",
        outputText: existing.streamedOutput,
        blobMessagesOut: blobMsgs,
      });
      existing.outputId = outputId;
      this.appendReplaceNodeOps(ops, existing.nodeId, node);
    } else {
      const nodeId = this.nextId("tool");
      const { node, outputId } = this.buildToolNode({
        nodeId,
        toolCallId,
        toolName,
        args,
        status: "running",
        outputText: "",
        blobMessagesOut: blobMsgs,
      });
      this.liveTools.set(toolCallId, {
        nodeId,
        toolCallId,
        toolName,
        args,
        startedAtMs: Date.now(),
        outputId,
        streamedOutput: "",
      });
      ops.push(["add", nodeId, "main", null, node]);
    }

    return this.emitOps(ops, blobMsgs);
  }

  private handleToolExecutionUpdate(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    partialResult: {
      content?: (PiTextContent | PiImageContent)[] | undefined;
      details?: Record<string, unknown> | undefined;
    },
  ): TspDocMessage[] {
    let existing = this.liveTools.get(toolCallId);
    if (existing === undefined) {
      this.handleToolExecutionStart(toolCallId, toolName, args);
      existing = this.liveTools.get(toolCallId);
    }
    if (existing === undefined) return [];

    const { text } = extractContentTextAndImages(partialResult.content);
    existing.streamedOutput = text;
    if (existing.outputId !== null && this.nodeExists(existing.outputId)) {
      return this.emitOps([["set", existing.outputId, { text }]]);
    }
    return [];
  }

  private handleToolExecutionEnd(
    toolCallId: string,
    toolName: string,
    result: { content?: (PiTextContent | PiImageContent)[] | undefined; details?: Record<string, unknown> | undefined },
    isError: boolean,
    durationMs?: number,
  ): TspDocMessage[] {
    const existing = this.liveTools.get(toolCallId);
    const { text, images } = extractContentTextAndImages(result.content);
    const blobMsgs: TspDocMessage[] = [];
    const ops: TspOp[] = [];

    const tookMs = durationMs ?? (existing !== undefined ? Math.max(0, Date.now() - existing.startedAtMs) : undefined);
    const nodeId = existing?.nodeId ?? this.nextId("tool");
    const args = existing?.args ?? {};

    const { node } = this.buildToolNode({
      nodeId,
      toolCallId,
      toolName,
      args,
      status: isError ? "error" : "done",
      outputText: text,
      images,
      details: result.details,
      durationMs: tookMs,
      blobMessagesOut: blobMsgs,
    });

    if (existing !== undefined && this.nodeExists(nodeId)) {
      this.appendReplaceNodeOps(ops, nodeId, node);
    } else {
      ops.push(["add", nodeId, "main", null, node]);
    }
    this.liveTools.delete(toolCallId);
    this.appendWorkingHudOps(ops, "Working…");

    return this.emitOps(ops, blobMsgs);
  }

  private handleMessageEnd(message: PiAgentMessage): TspDocMessage[] {
    if (message.role !== "assistant") return [];

    const ops: TspOp[] = [];
    // Finalize any unclosed live thinking or text blocks.
    for (const [, th] of this.liveThinking) {
      this.appendReplaceNodeOps(ops, th.headId, { id: th.headId, k: "text", p: { text: "Thought" } }, th.sectionId);
      ops.push(["set", th.sectionId, { role: "omp.thinking", collapsed: true }], ["set", th.bodyId, { stream: null }]);
    }
    this.liveThinking.clear();

    for (const [, tx] of this.liveText) {
      ops.push(["set", tx.mdId, { stream: null }]);
    }
    this.liveText.clear();

    const isErrorStop =
      message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.trim() !== "";

    if (isErrorStop && message.errorMessage !== undefined) {
      const targetContainer = this.lastStreamAssistantId;
      if (targetContainer !== null && this.nodeExists(targetContainer)) {
        const errId = `${targetContainer}/err`;
        ops.push(["add", errId, targetContainer, null, this.buildErrorCardNode(errId, message.errorMessage)]);
      } else {
        const colId = this.nextId("asst_err");
        ops.push([
          "add",
          colId,
          "main",
          null,
          {
            id: colId,
            k: "col",
            p: { role: "omp.assistant", gap: "sm" },
            c: [this.buildErrorCardNode(`${colId}/err`, message.errorMessage)],
          },
        ]);
      }
      this.lastStreamAssistantId = null;
      return this.emitOps(ops);
    }

    const hasToolCalls =
      message.stopReason === "toolUse" ||
      (Array.isArray(message.content) && message.content.some((b) => isRecord(b) && b["type"] === "toolCall"));
    const textBlocks = Array.isArray(message.content)
      ? message.content
          .filter((b): b is PiTextContent => isRecord(b) && b["type"] === "text" && typeof b["text"] === "string")
          .map((b) => b.text)
          .filter((t) => t.trim() !== "")
      : [];

    // If an assistant message arrived without prior `text_start` deltas (e.g. direct one-shot message_end), ensure text is present.
    let containerId = this.lastStreamAssistantId;
    if (containerId !== null && textBlocks.length === 0) {
      if (this.nodeExists(containerId)) {
        ops.push(["del", containerId]);
      }
      containerId = null;
    } else if (containerId === null && textBlocks.length > 0) {
      containerId = this.nextId("asst");
      ops.push([
        "add",
        containerId,
        "main",
        null,
        {
          id: containerId,
          k: "col",
          p: { role: "omp.assistant", gap: "sm" },
          c: [{ id: `${containerId}/md`, k: "md", p: { text: textBlocks.join("\n\n") } }],
        },
      ]);
    }

    const usageSummary = !hasToolCalls ? formatUsageFooter(message.usage, message.model) : null;
    if (usageSummary !== null && containerId !== null) {
      const usageRowId = `${containerId}/usage`;
      ops.push(["add", usageRowId, containerId, null, this.buildUsageRowNode(usageRowId, usageSummary)]);
    }

    this.lastStreamAssistantId = null;
    return this.emitOps(ops);
  }

  // ───────── Extension UI Requests (`dock.dialog`) & TSP Event Resolution ─────────

  private handleExtensionUiRequest(req: PiExtensionUiRequestEvent): TspDocMessage[] {
    switch (req.method) {
      case "select":
        return this.openSelectDialog(req);
      case "confirm":
        return this.openConfirmDialog(req);
      case "input":
        return this.openInputDialog(req, "input");
      case "editor":
        return this.openInputDialog(req, "editor");
      case "notify": {
        const level = req.notifyType ?? "info";
        if (typeof req.message === "string" && req.message !== "") {
          for (const listener of this.notifyListeners) {
            listener({ message: req.message, level });
          }
        }
        return [];
      }
      case "setStatus": {
        if (typeof req.statusText === "string" && req.statusText.trim() !== "" && this.hudActive) {
          return this.ensureWorkingHud(req.statusText.trim());
        }
        return [];
      }
      case "setTitle": {
        if (typeof req.title === "string" && req.title.trim() !== "") {
          for (const listener of this.titleListeners) {
            listener(req.title.trim());
          }
        }
        return [];
      }
      case "set_editor_text": {
        if (typeof req.text === "string") {
          for (const listener of this.editorPrefillListeners) {
            listener(req.text);
          }
        }
        return [];
      }
      default:
        return [];
    }
  }

  private openSelectDialog(req: PiExtensionUiRequestEvent): TspDocMessage[] {
    const options = Array.isArray(req.options) ? req.options.map(String) : [];
    const cardId = `dlg_${req.id}`;
    const listId = `${cardId}/list`;
    const optionIds = options.map((_, i) => `${cardId}/opt.${i}`);
    const firstOptId = optionIds[0] ?? null;

    this.activeDialog = {
      requestId: req.id,
      method: "select",
      cardId,
      options,
      selectedIndex: 0,
      listId,
      optionIds,
      inputId: null,
      draftText: "",
      cursor: 0,
    };

    const askChildren: TspNode[] = [
      {
        id: `${cardId}/title`,
        k: "text",
        p: {
          role: "omp.ask.question",
          spans: [{ t: req.title ?? "Select an option", s: "strong" }],
        },
      },
    ];
    if (typeof req.message === "string" && req.message !== "") {
      askChildren.push({
        id: `${cardId}/msg`,
        k: "text",
        p: { spans: [{ t: req.message, s: "muted" }] },
      });
    }
    askChildren.push(
      {
        id: listId,
        k: "list",
        p: {
          role: "omp.ask.options",
          ...(firstOptId !== null ? { selected: firstOptId } : {}),
          max: { lines: 10 },
        },
        c: options.map((opt, idx) => ({
          id: optionIds[idx]!,
          k: "item",
          p: {
            role: "omp.ask.option",
            label: opt,
          },
        })),
      },
      {
        id: `${cardId}/btns`,
        k: "row",
        p: { gap: "sm", justify: "end" },
        c: [
          {
            id: `${cardId}/cancel`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "cancel" } },
            c: [
              { id: `${cardId}/cancel.t`, k: "text", p: { text: "Cancel" } },
              { id: `${cardId}/cancel.k`, k: "kbd", p: { keys: ["Esc"] } },
            ],
          },
          {
            id: `${cardId}/submit`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "submit" } },
            c: [
              { id: `${cardId}/submit.t`, k: "text", p: { text: "Select" } },
              { id: `${cardId}/submit.k`, k: "kbd", p: { keys: ["Enter"] } },
            ],
          },
        ],
      },
    );

    const card: TspNode = {
      id: cardId,
      k: "card",
      p: {
        role: "omp.editor.ask",
      },
      c: [
        {
          id: `${cardId}/ask`,
          k: "col",
          p: { role: "omp.ask", gap: "sm" },
          c: askChildren,
        },
      ],
    };

    const ops: TspOp[] = [];
    this.appendClearChildrenOps(ops, "dock.dialog");
    ops.push(["add", cardId, "dock.dialog", null, card], ["focus", listId]);
    return this.emitOps(ops);
  }

  private openConfirmDialog(req: PiExtensionUiRequestEvent): TspDocMessage[] {
    const cardId = `dlg_${req.id}`;
    const listId = `${cardId}/list`;
    const approveId = `${cardId}/approve`;
    const denyId = `${cardId}/deny`;

    this.activeDialog = {
      requestId: req.id,
      method: "confirm",
      cardId,
      options: ["Approve", "Deny"],
      selectedIndex: 0,
      listId,
      optionIds: [approveId, denyId],
      inputId: null,
      draftText: "",
      cursor: 0,
    };

    const children: TspNode[] = [
      {
        id: `${cardId}/title`,
        k: "text",
        p: {
          role: "omp.approval.title",
          spans: [{ t: req.title ?? "Confirm action", s: "strong" }],
        },
      },
    ];
    if (typeof req.message === "string" && req.message !== "") {
      children.push({
        id: `${cardId}/msg`,
        k: "text",
        p: { text: req.message },
      });
    }
    children.push(
      {
        id: listId,
        k: "list",
        p: { selected: approveId },
        c: [
          {
            id: approveId,
            k: "item",
            p: { label: "Confirm", detail: "Approve and continue" },
          },
          {
            id: denyId,
            k: "item",
            p: { label: "Cancel", detail: "Decline this action" },
          },
        ],
      },
      {
        id: `${cardId}/btns`,
        k: "row",
        p: { gap: "sm", justify: "end" },
        c: [
          {
            id: `${cardId}/btn.deny`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "deny" } },
            c: [{ id: `${cardId}/btn.deny.t`, k: "text", p: { text: "Deny" } }],
          },
          {
            id: `${cardId}/btn.approve`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "approve" } },
            c: [{ id: `${cardId}/btn.approve.t`, k: "text", p: { text: "Approve" } }],
          },
        ],
      },
    );

    const card: TspNode = {
      id: cardId,
      k: "card",
      p: {
        role: "omp.editor.ask.approval",
      },
      c: [
        {
          id: `${cardId}/body`,
          k: "col",
          p: { gap: "sm" },
          c: children,
        },
      ],
    };

    const ops: TspOp[] = [];
    this.appendClearChildrenOps(ops, "dock.dialog");
    ops.push(["add", cardId, "dock.dialog", null, card], ["focus", listId]);
    return this.emitOps(ops);
  }

  private openInputDialog(req: PiExtensionUiRequestEvent, method: "input" | "editor"): TspDocMessage[] {
    const cardId = `dlg_${req.id}`;
    const inputId = `${cardId}/input`;
    const initial = req.prefill ?? "";

    this.activeDialog = {
      requestId: req.id,
      method,
      cardId,
      options: [],
      selectedIndex: 0,
      listId: null,
      optionIds: [],
      inputId,
      draftText: initial,
      cursor: initial.length,
    };

    const askChildren: TspNode[] = [
      {
        id: `${cardId}/title`,
        k: "text",
        p: {
          role: "omp.ask.question",
          spans: [{ t: req.title ?? (method === "editor" ? "Edit text" : "Input required"), s: "strong" }],
        },
      },
    ];
    if (typeof req.message === "string" && req.message !== "") {
      askChildren.push({
        id: `${cardId}/msg`,
        k: "text",
        p: { spans: [{ t: req.message, s: "muted" }] },
      });
    }
    askChildren.push(
      {
        id: inputId,
        k: method === "editor" ? "editor" : "input",
        p: {
          text: initial,
          cursor: initial.length,
          placeholder: req.placeholder ?? "",
          ...(method === "editor" ? { maxLines: 12 } : {}),
        },
      },
      {
        id: `${cardId}/btns`,
        k: "row",
        p: { gap: "sm", justify: "end" },
        c: [
          {
            id: `${cardId}/cancel`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "cancel" } },
            c: [
              { id: `${cardId}/cancel.t`, k: "text", p: { text: "Cancel" } },
              { id: `${cardId}/cancel.k`, k: "kbd", p: { keys: ["Esc"] } },
            ],
          },
          {
            id: `${cardId}/submit`,
            k: "row",
            p: { role: "omp.btn", actions: { click: "submit" } },
            c: [
              { id: `${cardId}/submit.t`, k: "text", p: { text: "Submit" } },
              {
                id: `${cardId}/submit.k`,
                k: "kbd",
                p: { keys: method === "editor" ? ["Ctrl", "Enter"] : ["Enter"] },
              },
            ],
          },
        ],
      },
    );

    const card: TspNode = {
      id: cardId,
      k: "card",
      p: {
        role: "omp.editor.ask",
      },
      c: [
        {
          id: `${cardId}/ask`,
          k: "col",
          p: { role: "omp.ask", gap: "sm" },
          c: askChildren,
        },
      ],
    };

    const ops: TspOp[] = [];
    this.appendClearChildrenOps(ops, "dock.dialog");
    ops.push(["add", cardId, "dock.dialog", null, card], ["focus", inputId]);
    return this.emitOps(ops);
  }

  private closeActiveDialog(): void {
    this.activeDialog = null;
    const ops: TspOp[] = [];
    this.appendClearChildrenOps(ops, "dock.dialog");
    ops.push(["focus", null]);
    this.emitOps(ops);
  }

  /**
   * Resolve a renderer-originated `TspEvent` against active `dock.dialog` or surface actions.
   * Returns an `extension_ui_response` payload when an extension dialog completes!
   */
  handleTspEvent(event: TspEvent): PiExtensionUiResponsePayload | null {
    const detailed = this.handleTspEventDetailed(event);
    return detailed?.kind === "extension_ui_response" ? detailed.response : null;
  }

  handleTspEventDetailed(event: TspEvent): BridgeActionResult {
    if (event.ev === "action") {
      if (event.act === "interrupt") {
        return { kind: "interrupt" };
      }
      if (event.act === "rewind") {
        const cardId = event.id.split("/")[0] ?? event.id;
        const cardNode = this.doc.surfaces.get(PI_SURFACE_ID)?.nodes.get(cardId);
        const entryId = typeof cardNode?.p["key"] === "string" ? cardNode.p["key"] : undefined;
        return { kind: "rewind", cardId, entryId };
      }
    }

    const dlg = this.activeDialog;
    if (dlg === null) {
      if (event.ev === "focus") {
        this.emitOps([["focus", event.id]]);
      }
      return null;
    }

    if (event.ev === "focus") {
      this.emitOps([["focus", event.id]]);
      return null;
    }

    if (event.ev === "edit" && dlg.inputId !== null && event.id === dlg.inputId) {
      const from = Math.max(0, Math.min(dlg.draftText.length, event.from));
      const to = Math.max(from, Math.min(dlg.draftText.length, event.to));
      dlg.draftText = `${dlg.draftText.slice(0, from)}${event.text}${dlg.draftText.slice(to)}`;
      dlg.cursor = Math.max(0, Math.min(dlg.draftText.length, event.cursor));
      this.emitOps([
        [
          "set",
          dlg.inputId,
          {
            text: dlg.draftText,
            cursor: dlg.cursor,
            anchor: null,
          },
        ],
      ]);
      return null;
    }

    if (event.ev === "select" || event.ev === "activate") {
      const idx = dlg.optionIds.indexOf(event.item);
      if (idx !== -1) {
        dlg.selectedIndex = idx;
        if (dlg.method === "select") {
          const chosen = dlg.options[idx];
          if (chosen !== undefined) {
            const reqId = dlg.requestId;
            this.closeActiveDialog();
            return { kind: "extension_ui_response", response: { id: reqId, value: chosen } };
          }
        } else if (dlg.method === "confirm") {
          const reqId = dlg.requestId;
          const confirmed = idx === 0;
          this.closeActiveDialog();
          return { kind: "extension_ui_response", response: { id: reqId, confirmed } };
        }
      }
      return null;
    }

    if (event.ev === "send") {
      const reqId = dlg.requestId;
      if (dlg.method === "input" || dlg.method === "editor" || dlg.method === "select") {
        this.closeActiveDialog();
        return { kind: "extension_ui_response", response: { id: reqId, value: event.text } };
      }
      if (dlg.method === "confirm") {
        this.closeActiveDialog();
        return { kind: "extension_ui_response", response: { id: reqId, confirmed: false } };
      }
    }

    if (event.ev === "action") {
      const reqId = dlg.requestId;
      switch (event.act) {
        case "cancel":
          this.closeActiveDialog();
          return { kind: "extension_ui_response", response: { id: reqId, cancelled: true } };

        case "approve":
        case "confirm":
          this.closeActiveDialog();
          return { kind: "extension_ui_response", response: { id: reqId, confirmed: true } };

        case "deny":
        case "reject":
          this.closeActiveDialog();
          return { kind: "extension_ui_response", response: { id: reqId, confirmed: false } };

        case "submit": {
          if (dlg.method === "confirm") {
            const confirmed = dlg.selectedIndex === 0;
            this.closeActiveDialog();
            return { kind: "extension_ui_response", response: { id: reqId, confirmed } };
          }
          if (dlg.method === "select") {
            const chosen = dlg.options[dlg.selectedIndex] ?? dlg.options[0];
            this.closeActiveDialog();
            return chosen !== undefined
              ? { kind: "extension_ui_response", response: { id: reqId, value: chosen } }
              : { kind: "extension_ui_response", response: { id: reqId, cancelled: true } };
          }
          const value = dlg.draftText;
          this.closeActiveDialog();
          return { kind: "extension_ui_response", response: { id: reqId, value } };
        }

        default:
          return null;
      }
    }

    return null;
  }

  /**
   * Handle terminal key sequences sent by `AskGateCol`, `List`, or `Editor` (`ctx.keys(data)`).
   */
  handleTspKeys(data: string): PiExtensionUiResponsePayload | null {
    const dlg = this.activeDialog;
    if (dlg === null || data === "") return null;

    // Escape cancels any active dialog.
    if (data === "\x1b") {
      const reqId = dlg.requestId;
      this.closeActiveDialog();
      return { id: reqId, cancelled: true };
    }

    // Ctrl+Enter (`\x1b[13;5u` or `\x1b\r`) submits/approves any dialog.
    if (data === "\x1b[13;5u" || data === "\x1b[13;2u") {
      const reqId = dlg.requestId;
      if (dlg.method === "confirm") {
        this.closeActiveDialog();
        return { id: reqId, confirmed: true };
      }
      if (dlg.method === "select") {
        const chosen = dlg.options[dlg.selectedIndex] ?? dlg.options[0];
        this.closeActiveDialog();
        return chosen !== undefined ? { id: reqId, value: chosen } : { id: reqId, cancelled: true };
      }
      const value = dlg.draftText;
      this.closeActiveDialog();
      return { id: reqId, value };
    }

    if (dlg.method === "select" || dlg.method === "confirm") {
      if (data === "\x1b[A" && dlg.optionIds.length > 0) {
        dlg.selectedIndex = (dlg.selectedIndex - 1 + dlg.optionIds.length) % dlg.optionIds.length;
        if (dlg.listId !== null) {
          this.emitOps([["set", dlg.listId, { selected: dlg.optionIds[dlg.selectedIndex] }]]);
        }
        return null;
      }
      if (data === "\x1b[B" && dlg.optionIds.length > 0) {
        dlg.selectedIndex = (dlg.selectedIndex + 1) % dlg.optionIds.length;
        if (dlg.listId !== null) {
          this.emitOps([["set", dlg.listId, { selected: dlg.optionIds[dlg.selectedIndex] }]]);
        }
        return null;
      }
      if (data === "\r" || data === "\n") {
        const reqId = dlg.requestId;
        if (dlg.method === "confirm") {
          const confirmed = dlg.selectedIndex === 0;
          this.closeActiveDialog();
          return { id: reqId, confirmed };
        }
        const chosen = dlg.options[dlg.selectedIndex] ?? dlg.options[0];
        this.closeActiveDialog();
        return chosen !== undefined ? { id: reqId, value: chosen } : { id: reqId, cancelled: true };
      }
      return null;
    }

    // `input` / `editor` keystroke handling
    if (dlg.inputId === null) return null;

    if ((data === "\r" || data === "\n") && dlg.method === "input") {
      const reqId = dlg.requestId;
      const value = dlg.draftText;
      this.closeActiveDialog();
      return { id: reqId, value };
    }

    // Bracketed paste: `\x1b[200~...\x1b[201~`
    let textToInsert: string | null = null;
    if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
      textToInsert = data.slice(6, -6);
    } else if (data === "\x7f" || data === "\b") {
      if (dlg.cursor > 0) {
        dlg.draftText = `${dlg.draftText.slice(0, dlg.cursor - 1)}${dlg.draftText.slice(dlg.cursor)}`;
        dlg.cursor -= 1;
        this.emitOps([["set", dlg.inputId, { text: dlg.draftText, cursor: dlg.cursor }]]);
      }
      return null;
    } else if ((data === "\r" || data === "\n") && dlg.method === "editor") {
      textToInsert = "\n";
    } else if (!data.startsWith("\x1b") && data >= " ") {
      textToInsert = data;
    }

    if (textToInsert !== null && textToInsert !== "") {
      const sanitized = dlg.method === "input" ? textToInsert.replace(/[\r\n]+/g, " ") : textToInsert;
      dlg.draftText = `${dlg.draftText.slice(0, dlg.cursor)}${sanitized}${dlg.draftText.slice(dlg.cursor)}`;
      dlg.cursor += sanitized.length;
      this.emitOps([["set", dlg.inputId, { text: dlg.draftText, cursor: dlg.cursor }]]);
    }
    return null;
  }

  private resetStreamingState(): void {
    this.hudActive = false;
    this.liveThinking.clear();
    this.liveText.clear();
    this.liveTools.clear();
    this.lastStreamAssistantId = null;
    this.pendingOptimisticUsers = [];
    this.activeDialog = null;
  }
}
