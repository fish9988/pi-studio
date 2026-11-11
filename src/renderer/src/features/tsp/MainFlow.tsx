// 对话区的 main：omp 发来的子节点，加上 omp 终端里有、TSP 文档里留不住的状态行（切模型的 "Session-only model: …" 等）：
// 文档里记下来的（shared/tsp/status-notes.ts），停在它出现时前面的那个节点后面。那个节点没了（压缩、/tree、恢复会话
// 这类整段重建对话，omp 删掉旧节点重画）就不再画：终端里重建也会清掉状态行（omp 18.12.5 实录 session-tree-compacted.jsonl）。
// 状态行最多露两行：MCP 工具多时启动的 `xdev: xd://: mounted …` 会列出全部工具名，占满一屏（2026-11-06 仓库所有者），
// 多出的收进和工具输出一样的"N more lines"。
import { Fragment, memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskId } from "../../../../shared/ipc.ts";
import type { DocNode, DocSurface, TspDocument } from "../../../../shared/tsp/document.ts";
import type { StatusNote } from "../../../../shared/tsp/status-notes.ts";
import { useShellValue } from "../../app/shell-store.ts";
import { ChevronDown, Code, External, FileIcon, Globe } from "../../icons.tsx";
import { openReview } from "../../store/review-store.ts";
import { currentLocale } from "../../store/settings-store.ts";
import { openFilePreview, openInlineArtifact, type InlineArtifact } from "../file-preview/index.ts";
import { Clamp } from "./Clamp.tsx";
import { formatElapsed } from "./fmt.ts";
import { TspIcon } from "./icons.tsx";
import type { TspContext } from "./node-props.ts";
import { useSessionExtras } from "./session-extras-store.ts";
import { cleanGlyphs } from "./span-tokens.ts";
import { TspNode } from "./TspChildren.tsx";
import { peekTspNode, useTspDerived, useTspStatusNotes } from "./tsp-store.ts";
import { setNodesFolded } from "./use-fold.ts";
const STATUS_NOTE_LINES = 2;

type DeliverableCategory = "markdown" | "html" | "vector" | "image" | "pdf" | "data" | "style" | "code";
type LangBadgeKind = "ts" | "tsx" | "js" | "py" | "css" | "json" | "md" | "html" | "svg" | "img" | "pdf" | "code";

interface DeliverableItem {
  key: string;
  name: string;
  dirPath: string;
  category: DeliverableCategory;
  badge: "MD" | "HTML" | "SVG" | "IMG" | "PDF" | "JSON" | "CSS" | "CODE";
  langBadge: { label: string; kind: LangBadgeKind };
  subtitleZh: string;
  subtitleEn: string;
  operation: "write" | "edit" | "read";
  added: number;
  removed: number;
  bodyNodeId?: string;
  bodyKind?: "diff" | "code";
  filePath?: string;
  artifact?: InlineArtifact;
}
type MainSegment =
  | { kind: "item"; id: string; deliverables: readonly DeliverableItem[] }
  | {
      kind: "process";
      ids: readonly string[];
      thoughts: number;
      tools: number;
      durationMs: number;
      turnIndex: number;
      running: boolean;
      settled: boolean;
      deliverables: readonly DeliverableItem[];
    };

const EMPTY_SEGMENTS: readonly MainSegment[] = [];
const EMPTY_DELIVERABLES: readonly DeliverableItem[] = [];
function isThinkingSection(surface: DocSurface, id: string): boolean {
  const node = surface.nodes.get(id);
  const role = node?.p["role"];
  return typeof role === "string" && role.startsWith("omp.thinking");
}

function isHoistedProcessChild(surface: DocSurface, id: string): boolean {
  const node = surface.nodes.get(id);
  if (!node) return false;
  if (node.k === "media" || node.k === "image") return true;
  const role = node.p["role"];
  return typeof role === "string" && role.startsWith("omp.thinking");
}

function extractPlainText(surface: DocSurface, id: string): string {
  const node = surface.nodes.get(id);
  if (!node) return "";
  if (typeof node.p["text"] === "string") return node.p["text"];
  if (Array.isArray(node.p["spans"])) {
    return (node.p["spans"] as { t?: unknown }[]).map((s) => (typeof s?.t === "string" ? s.t : "")).join("");
  }
  return node.c.map((cid) => extractPlainText(surface, cid)).join("");
}

function parseDurationTextMs(text: string): number {
  const minSec = /\b(\d+)m\s*(\d+(?:\.\d+)?)s\b/i.exec(text);
  if (minSec) return (Number(minSec[1]) * 60 + Number(minSec[2])) * 1000;
  const sec = /\b(\d+(?:\.\d+)?)s\b/i.exec(text);
  if (sec) return Number(sec[1]) * 1000;
  const ms = /\b(\d+)ms\b/i.exec(text);
  if (ms) return Number(ms[1]);
  return 0;
}

function maxDescendantElapsedMs(surface: DocSurface, id: string): number {
  const node = surface.nodes.get(id);
  if (!node) return 0;
  if (node.k === "elapsed") {
    if (typeof node.p["stopped"] === "number" && node.p["stopped"] > 0) return node.p["stopped"];
  }
  let max = 0;
  for (const cid of node.c) {
    const childMax = maxDescendantElapsedMs(surface, cid);
    if (childMax > max) max = childMax;
  }
  return max;
}

// 只读取已结算的耗时（took / stopped / 已完成的 Thought for Ns），不读每 100ms 跳动的 age，
// 避免运行中每秒触发 10 次 MainFlow 重渲染导致过程栏滚动条断触卡顿。
function nodeDurationMs(surface: DocSurface, id: string): number {
  const node = surface.nodes.get(id);
  if (!node) return 0;
  if (typeof node.p["took"] === "number" && node.p["took"] > 0) return node.p["took"];
  if (node.k === "section") {
    const headId = typeof node.p["head"] === "string" ? node.p["head"] : `${id}/head`;
    const headText = extractPlainText(surface, headId);
    const parsed = parseDurationTextMs(headText);
    if (parsed > 0) return parsed;
  }
  return maxDescendantElapsedMs(surface, id);
}
function isProcessNodeRunning(surface: DocSurface, id: string): boolean {
  const node = surface.nodes.get(id);
  if (!node) return false;
  if (node.k === "tool") {
    return node.p["status"] === "running" || node.p["status"] === "pending";
  }
  if (node.k === "section") {
    if (node.p["role"] === "omp.thinking.live") return true;
    const headId = typeof node.p["head"] === "string" ? node.p["head"] : `${id}/head`;
    const headNode = surface.nodes.get(headId);
    return headNode?.k === "shimmer";
  }
  return false;
}

function cleanDeliverablePath(raw: string): string {
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\//i, ""));
    } catch {
      p = p.replace(/^file:\/\//i, "");
    }
    if (/^\/+[A-Za-z]:/.test(p)) p = p.replace(/^\/+/, "");
  } else {
    try {
      p = decodeURIComponent(p);
    } catch {
      // 保留原样
    }
  }
  return p
    .replace(/\\/g, "/")
    .replace(/^\/+(?=[A-Za-z]:\/)/, "")
    .replace(/#L\d+(?:-L?\d+)?.*$/i, "")
    .replace(/(?<!^[A-Za-z]):\d+(?:[:-]\d+)?$/, "")
    .trim();
}

function toWorkspaceRelative(normalizedPath: string, hrefClean: string): { filePath: string; dirPath: string } {
  const isAbs = /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith("/");
  const candidate = (!isAbs && normalizedPath !== "" ? normalizedPath : hrefClean || normalizedPath)
    .replace(/^\/+(?=[A-Za-z]:\/)/, "")
    .replace(/^\.\//, "");

  let displayRel = candidate;
  if (/probe-user|tern-probe/i.test(displayRel)) {
    const markerMatch = /\/((?:src|docs|test|tests|packages|public|scripts|resources|fixtures)\/.*)$/i.exec(displayRel);
    if (markerMatch?.[1]) {
      displayRel = markerMatch[1];
    } else {
      const parts = displayRel.split("/").filter(Boolean);
      displayRel = parts[parts.length - 1] ?? displayRel;
    }
  }
  const lastSlash = displayRel.lastIndexOf("/");
  const dirPath = lastSlash > 0 ? displayRel.slice(0, lastSlash) : "";
  const filePath = displayRel;
  return { filePath, dirPath };
}

function fileBadgeMeta(filePath: string): {
  category: DeliverableCategory;
  badge: DeliverableItem["badge"];
  langBadge: { label: string; kind: LangBadgeKind };
  subtitleZh: string;
  subtitleEn: string;
} {
  const lower = filePath.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  if (ext === "svg") {
    return {
      category: "vector",
      badge: "SVG",
      langBadge: { label: "SVG", kind: "svg" },
      subtitleZh: "SVG 矢量图形 · 点击缩放与源码预览",
      subtitleEn: "SVG vector graphic · Click to preview",
    };
  }
  if (ext === "html" || ext === "htm") {
    return {
      category: "html",
      badge: "HTML",
      langBadge: { label: "</>", kind: "html" },
      subtitleZh: "交互式网页 · 点击在沙箱中运行预览",
      subtitleEn: "Interactive HTML · Click to preview",
    };
  }
  if (ext === "md" || ext === "markdown" || ext === "mdx") {
    return {
      category: "markdown",
      badge: "MD",
      langBadge: { label: "M↓", kind: "md" },
      subtitleZh: "Markdown 文档 · 点击渲染排版预览",
      subtitleEn: "Markdown document · Click to preview",
    };
  }
  if (ext === "png" || ext === "webp" || ext === "jpg" || ext === "jpeg" || ext === "gif") {
    return {
      category: "image",
      badge: "IMG",
      langBadge: { label: "IMG", kind: "img" },
      subtitleZh: "图像资产 · 点击在侧栏画布查看",
      subtitleEn: "Image asset · Click to view",
    };
  }
  if (ext === "pdf") {
    return {
      category: "pdf",
      badge: "PDF",
      langBadge: { label: "PDF", kind: "pdf" },
      subtitleZh: "PDF 文档 · 点击打开预览",
      subtitleEn: "PDF document · Click to preview",
    };
  }
  if (ext === "css" || ext === "scss" || ext === "less") {
    return {
      category: "style",
      badge: "CSS",
      langBadge: { label: "CSS", kind: "css" },
      subtitleZh: "样式表 · 点击查看样式定义",
      subtitleEn: "Stylesheet · Click to view",
    };
  }
  if (ext === "json" || ext === "jsonc" || ext === "yaml" || ext === "yml" || ext === "toml") {
    return {
      category: "data",
      badge: "JSON",
      langBadge: { label: "{}", kind: "json" },
      subtitleZh: "配置与数据 · 点击查看结构",
      subtitleEn: "Config & data · Click to view",
    };
  }
  const langBadge: { label: string; kind: LangBadgeKind } =
    ext === "tsx" || ext === "jsx"
      ? { label: ext.toUpperCase(), kind: "tsx" }
      : ext === "ts" || ext === "mts" || ext === "cts"
        ? { label: "TS", kind: "ts" }
        : ext === "js" || ext === "mjs" || ext === "cjs"
          ? { label: "JS", kind: "js" }
          : ext === "py"
            ? { label: "PY", kind: "py" }
            : { label: ext ? ext.slice(0, 4).toUpperCase() : "CODE", kind: "code" };
  return {
    category: "code",
    badge: "CODE",
    langBadge,
    subtitleZh: "源码文件 · 点击在侧栏查看",
    subtitleEn: "Source code · Click to view",
  };
}

function isDeliverableDocPath(filePath: string): boolean {
  return /\.(svg|html?|md|markdown|mdx|png|webp|jpe?g|pdf)$/i.test(filePath);
}
function parseToolDiffStats(
  surface: DocSurface,
  node: DocNode,
): {
  added: number;
  removed: number;
  bodyNodeId?: string;
  bodyKind?: "diff" | "code";
} {
  let added = 0;
  let removed = 0;
  let bodyNodeId: string | undefined;
  let bodyKind: "diff" | "code" | undefined;

  if (Array.isArray(node.p["meta"])) {
    for (const entry of node.p["meta"]) {
      if (typeof entry !== "string") continue;
      const addMatch = /\+(\d+)/.exec(entry);
      const delMatch = /[-−](\d+)/.exec(entry);
      const linesMatch = /^(\d+)\s+lines?$/i.exec(entry.trim());
      if (addMatch) added += Number(addMatch[1]);
      if (delMatch) removed += Number(delMatch[1]);
      if (linesMatch && node.p["name"] === "write") added += Number(linesMatch[1]);
    }
  }

  for (const cid of node.c) {
    const child = surface.nodes.get(cid);
    if (!child) continue;
    if (child.k === "diff") {
      bodyNodeId = cid;
      bodyKind = "diff";
      if (added === 0 && removed === 0 && Array.isArray(child.p["hunks"])) {
        for (const hunk of child.p["hunks"] as { lines?: unknown }[]) {
          if (!Array.isArray(hunk?.lines)) continue;
          for (const line of hunk.lines) {
            if (typeof line !== "string") continue;
            if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
            else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
          }
        }
      }
      break;
    }
    if (child.k === "code") {
      bodyNodeId = cid;
      bodyKind = "code";
      if (added === 0 && node.p["name"] === "write" && typeof child.p["text"] === "string") {
        added = child.p["text"].split("\n").length;
      }
    }
  }
  return {
    added,
    removed,
    ...(bodyNodeId !== undefined ? { bodyNodeId } : {}),
    ...(bodyKind !== undefined ? { bodyKind } : {}),
  };
}

function extractNodeDeliverables(surface: DocSurface, id: string): DeliverableItem[] {
  const node = surface.nodes.get(id);
  if (!node) return [];
  const items: DeliverableItem[] = [];

  const pushFile = (
    rawPath: string,
    hrefPath: string | undefined,
    operation: "write" | "edit" | "read",
    stats: { added: number; removed: number; bodyNodeId?: string; bodyKind?: "diff" | "code" },
  ) => {
    const cleaned = cleanDeliverablePath(rawPath);
    if (cleaned === "") return;
    if (operation === "read" && !isDeliverableDocPath(cleaned)) return;
    const normalized = cleaned.replace(/\\/g, "/");
    const hrefClean = hrefPath ? cleanDeliverablePath(hrefPath).replace(/\\/g, "/") : "";
    // 跳过 rawPath 自身指向系统临时目录（AppData/Local/Temp 或 /tmp）及 ~ 开头的外部临时截图文件
    if (normalized.startsWith("~") || /AppData\/Local\/Temp|\/tmp\//i.test(normalized)) {
      return;
    }
    const { filePath, dirPath } = toWorkspaceRelative(normalized, hrefClean);
    const parts = filePath.split("/").filter(Boolean);
    const baseName = parts[parts.length - 1] ?? filePath;
    const meta = fileBadgeMeta(filePath);
    items.push({
      key: `file:${filePath.toLowerCase()}`,
      name: baseName,
      dirPath,
      category: meta.category,
      badge: meta.badge,
      langBadge: meta.langBadge,
      subtitleZh: meta.subtitleZh,
      subtitleEn: meta.subtitleEn,
      operation,
      added: stats.added,
      removed: stats.removed,
      ...(stats.bodyNodeId !== undefined ? { bodyNodeId: stats.bodyNodeId } : {}),
      ...(stats.bodyKind !== undefined ? { bodyKind: stats.bodyKind } : {}),
      filePath,
    });
  };

  if (node.k === "tool" && node.p["status"] === "done") {
    const toolName = node.p["name"];
    if (toolName === "write" || toolName === "edit") {
      const op: "write" | "edit" = toolName === "write" ? "write" : "edit";
      const stats = parseToolDiffStats(surface, node);
      const hrefStr = typeof node.p["href"] === "string" ? node.p["href"] : undefined;
      if (typeof node.p["target"] === "string" && node.p["targetKind"] === "path") {
        pushFile(node.p["target"], hrefStr, op, stats);
      } else if (hrefStr !== undefined) {
        pushFile(hrefStr, hrefStr, op, stats);
      }
      for (const cid of node.c) {
        const child = surface.nodes.get(cid);
        if (child?.p["role"] === "omp.tool.file") {
          const childHref = typeof child.p["href"] === "string" ? child.p["href"] : hrefStr;
          if (typeof child.p["title"] === "string") pushFile(child.p["title"], childHref, op, stats);
          else if (childHref !== undefined) pushFile(childHref, childHref, op, stats);
          for (const gcid of child.c) {
            const gc = surface.nodes.get(gcid);
            const gcHref = typeof gc?.p["href"] === "string" ? gc.p["href"] : childHref;
            if (typeof gc?.p["title"] === "string") pushFile(gc.p["title"], gcHref, op, stats);
            else if (gcHref !== undefined) pushFile(gcHref, gcHref, op, stats);
            else if (typeof gc?.p["text"] === "string") pushFile(gc.p["text"], gcHref, op, stats);
          }
        }
      }
    }
  }
  if (node.k === "col" && node.p["role"] === "omp.assistant") {
    let blockIdx = 0;
    for (const cid of node.c) {
      const child = surface.nodes.get(cid);
      if (child?.k === "md" && child.p["role"] === undefined && typeof child.p["text"] === "string") {
        const text = child.p["text"];
        const fenceRegex = /```(html|htm|svg|markdown|md)\b[^\r\n]*\r?\n([\s\S]*?)```/gi;
        let match: RegExpExecArray | null;
        while ((match = fenceRegex.exec(text)) !== null) {
          const rawLang = (match[1] ?? "").toLowerCase();
          const body = (match[2] ?? "").trim();
          if (body.length < 16) continue;
          blockIdx += 1;
          const ext: "html" | "svg" | "md" =
            rawLang === "html" || rawLang === "htm" ? "html" : rawLang === "svg" ? "svg" : "md";
          const name =
            ext === "html"
              ? `index-${blockIdx}.html`
              : ext === "svg"
                ? `diagram-${blockIdx}.svg`
                : `document-${blockIdx}.md`;
          const artifactId = `${id}-${blockIdx}`;
          const meta = fileBadgeMeta(name);
          items.push({
            key: `art:${artifactId}`,
            name,
            dirPath: "",
            category: meta.category,
            badge: meta.badge,
            langBadge: meta.langBadge,
            subtitleZh: meta.subtitleZh,
            subtitleEn: meta.subtitleEn,
            operation: "write",
            added: body.split("\n").length,
            removed: 0,
            artifact: { id: artifactId, name, ext, content: body },
          });
        }
      }
    }
  }
  return items;
}

function dedupeDeliverables(list: readonly DeliverableItem[]): readonly DeliverableItem[] {
  if (list.length === 0) return EMPTY_DELIVERABLES;
  const map = new Map<string, DeliverableItem>();
  for (const item of list) {
    const prev = map.get(item.key);
    if (!prev) {
      map.set(item.key, item);
    } else {
      // 同一文件的多次操作合并（对齐 dsh-claude-style file-row-merge.ts）：累加 +M -N，保留最新 Diff 节点与最高写操作级别
      const nextOp =
        item.operation === "write" || prev.operation === "write"
          ? "write"
          : item.operation === "edit" || prev.operation === "edit"
            ? "edit"
            : "read";
      map.set(item.key, {
        ...prev,
        ...item,
        operation: nextOp,
        added: prev.added + item.added,
        removed: prev.removed + item.removed,
        ...(item.bodyNodeId !== undefined
          ? { bodyNodeId: item.bodyNodeId, bodyKind: item.bodyKind }
          : prev.bodyNodeId !== undefined
            ? { bodyNodeId: prev.bodyNodeId, bodyKind: prev.bodyKind }
            : {}),
      });
    }
  }
  return [...map.values()];
}

function buildSurfaceSegments(surface: DocSurface): readonly MainSegment[] {
  const main = surface.nodes.get("main");
  if (!main) return EMPTY_SEGMENTS;
  const out: MainSegment[] = [];
  let runIds: string[] = [];
  let runThoughts = 0;
  let runTools = 0;
  let runDurationMs = 0;
  let runRunning = false;
  // 同一轮用户对话（从一条 omp.user 到下一条 omp.user）内的全部交付文件与代码变更统一收集，
  // 仅在该轮最终回答末尾唯一输出一次，绝不在中途重复打断对话流！
  let turnDeliverables: DeliverableItem[] = [];
  let currentTurnIndex = -1;

  const flushProcess = (fallbackTurnMs = 0, hasFollowingAnswer = false) => {
    if (runIds.length === 0) return;
    if (runThoughts + runTools >= 1) {
      out.push({
        kind: "process",
        ids: runIds,
        thoughts: runThoughts,
        tools: runTools,
        durationMs: runDurationMs > 0 ? runDurationMs : fallbackTurnMs,
        turnIndex: currentTurnIndex,
        running: runRunning,
        settled: !runRunning && hasFollowingAnswer,
        deliverables: EMPTY_DELIVERABLES,
      });
    } else {
      for (const id of runIds) out.push({ kind: "item", id, deliverables: EMPTY_DELIVERABLES });
    }
    runIds = [];
    runThoughts = 0;
    runTools = 0;
    runDurationMs = 0;
    runRunning = false;
  };

  const attachTurnDeliverablesToLast = () => {
    if (turnDeliverables.length === 0 || out.length === 0) {
      turnDeliverables = [];
      return;
    }
    const lastIdx = out.length - 1;
    const last = out[lastIdx]!;
    // 仅当本轮已产生正式回答（或过程组已结束）时，把整轮汇总的交付物与 Diff 面板挂在最末尾的块上
    if (last.kind === "item" || (last.kind === "process" && !last.running)) {
      out[lastIdx] = {
        ...last,
        deliverables: dedupeDeliverables([...last.deliverables, ...turnDeliverables]),
      };
    }
    turnDeliverables = [];
  };

  // 预先找出每一轮用户对话（从 omp.user 到下一个 omp.user）里最后一个「过程节点」（工具调用或含思考的节点）在 main.c 中的下标：
  // 只要还没越过本轮最后一个过程节点，中途出现的思考、工具调用、过渡说明文字全部归拢在同一个 ProcessGroup 里（对齐 DSH claude-style），
  // 绝不拆成多段零碎框，也绝不在中途塞入 usage 脚注行！
  const lastProcessIdxForTurn = new Map<number, number>();
  {
    let scanTurn = -1;
    for (let idx = 0; idx < main.c.length; idx++) {
      const cid = main.c[idx]!;
      const cnode = surface.nodes.get(cid);
      if (!cnode) continue;
      if (cnode.k === "card" && cnode.p["role"] === "omp.user") {
        scanTurn += 1;
        continue;
      }
      if (cnode.k === "tool" && cnode.p["role"] !== "omp.tool.ask") {
        lastProcessIdxForTurn.set(scanTurn, idx);
      } else if (cnode.k === "col" && cnode.p["role"] === "omp.assistant") {
        if (cnode.c.some((subId) => isThinkingSection(surface, subId))) {
          lastProcessIdxForTurn.set(scanTurn, idx);
        }
      }
    }
  }

  for (let idx = 0; idx < main.c.length; idx++) {
    const id = main.c[idx]!;
    const node = surface.nodes.get(id);
    if (!node) continue;
    if (node.k === "card" && node.p["role"] === "omp.user") {
      flushProcess(0, true);
      attachTurnDeliverablesToLast();
      currentTurnIndex += 1;
      out.push({
        kind: "item",
        id,
        deliverables: EMPTY_DELIVERABLES,
      });
      continue;
    }
    // 1. 工具读取图片产生的顶层 media / image 节点：已有对应的 Read 工具行，跳过冗余胶囊且绝不拆断过程组！
    if (node.k === "media" || node.k === "image") {
      continue;
    }
    // 2. 工具调用（除 ask 外）：全部收进当前过程组。
    if (node.k === "tool" && node.p["role"] !== "omp.tool.ask") {
      runIds.push(id);
      runTools += 1;
      runDurationMs += nodeDurationMs(surface, id);
      if (isProcessNodeRunning(surface, id)) runRunning = true;
      turnDeliverables.push(...extractNodeDeliverables(surface, id));
      continue;
    }
    // 3. 助手容器（omp.assistant）：把其中的 omp.thinking 子节点提取进过程组（忽略冗余 media/image 子节点）；
    //    如果本轮后面还有工具调用或思考步骤，中途的过渡文本也一并收进当前过程组，保证整轮只有一个合并过程卡片！
    if (node.k === "col" && node.p["role"] === "omp.assistant") {
      const thinkingIds = node.c.filter((cid) => isThinkingSection(surface, cid));
      const otherIds = node.c.filter((cid) => !isHoistedProcessChild(surface, cid));
      if (thinkingIds.length > 0) {
        runIds.push(...thinkingIds);
        runThoughts += thinkingIds.length;
        for (const tid of thinkingIds) {
          runDurationMs += nodeDurationMs(surface, tid);
          if (isProcessNodeRunning(surface, tid)) runRunning = true;
        }
      }
      turnDeliverables.push(...extractNodeDeliverables(surface, id));

      const nonUsageContentIds = otherIds.filter((oid) => {
        const onode = surface.nodes.get(oid);
        if (!onode || onode.p["role"] === "omp.turn.usage") return false;
        if (onode.k === "md") {
          return typeof onode.p["text"] === "string" && onode.p["text"].trim() !== "";
        }
        return true;
      });
      const hasMoreProcessInTurn = idx < (lastProcessIdxForTurn.get(currentTurnIndex) ?? -1);

      if (nonUsageContentIds.length === 0) {
        // 纯思考、空流式占位或仅含中途 usage 的中间助手容器：留在当前过程组里继续往后合并，绝不打断过程组！
        continue;
      }
      if (hasMoreProcessInTurn) {
        // 本轮后面还有工具调用或思考：把中途过渡说明节点也收进同一个过程组，不拆断过程组！
        runIds.push(...nonUsageContentIds);
        continue;
      }
      let turnUsageMs = 0;
      for (const oid of otherIds) {
        const onode = surface.nodes.get(oid);
        if (onode?.p["role"] === "omp.turn.usage") {
          turnUsageMs = parseDurationTextMs(extractPlainText(surface, oid));
        }
      }
      flushProcess(turnUsageMs, true);
      out.push({
        kind: "item",
        id,
        deliverables: EMPTY_DELIVERABLES,
      });
      continue;
    }
    flushProcess();
    turnDeliverables.push(...extractNodeDeliverables(surface, id));
    out.push({
      kind: "item",
      id,
      deliverables: EMPTY_DELIVERABLES,
    });
  }
  flushProcess();
  attachTurnDeliverablesToLast();
  return out;
}

function deriveSegmentsBySurface(doc: TspDocument): ReadonlyMap<string, readonly MainSegment[]> {
  const map = new Map<string, readonly MainSegment[]>();
  for (const [sfId, surface] of doc.surfaces) {
    map.set(sfId, buildSurfaceSegments(surface));
  }
  return map;
}

function sameDeliverables(a: readonly DeliverableItem[], b: readonly DeliverableItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item.key === b[i]?.key);
}

function sameSegment(a: MainSegment, b: MainSegment): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "item" && b.kind === "item") {
    return a.id === b.id && sameDeliverables(a.deliverables, b.deliverables);
  }
  if (a.kind === "process" && b.kind === "process") {
    return (
      a.thoughts === b.thoughts &&
      a.tools === b.tools &&
      a.durationMs === b.durationMs &&
      a.running === b.running &&
      a.settled === b.settled &&
      a.ids.length === b.ids.length &&
      a.ids.every((id, i) => id === b.ids[i]) &&
      sameDeliverables(a.deliverables, b.deliverables)
    );
  }
  return false;
}

function sameSegmentsBySurface(
  a: ReadonlyMap<string, readonly MainSegment[]>,
  b: ReadonlyMap<string, readonly MainSegment[]>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [sf, listA] of a) {
    const listB = b.get(sf);
    if (!listB || listA.length !== listB.length) return false;
    if (!listA.every((seg, i) => sameSegment(seg, listB[i]!))) return false;
  }
  return true;
}

function formatProcessSummary(thoughts: number, tools: number): string {
  const zh = currentLocale() === "zh-CN";
  const parts: string[] = [];
  if (thoughts > 0) {
    parts.push(zh ? `执行 ${thoughts} 次思考` : `${thoughts} ${thoughts === 1 ? "thought" : "thoughts"}`);
  }
  if (tools > 0) {
    parts.push(zh ? `调用 ${tools} 次工具` : `${tools} ${tools === 1 ? "tool call" : "tool calls"}`);
  }
  return parts.join(zh ? "，" : ", ");
}

function StatusLine({ note }: { note: StatusNote }) {
  return (
    <div className="tsp-status-note" data-testid="tsp-status-note">
      <Clamp lines={STATUS_NOTE_LINES}>{cleanGlyphs(note.text)}</Clamp>
    </div>
  );
}

/**
 * 图 6 反重力（Antigravity）风格的单文件变更行：
 * - 左侧语言类型徽标（M↓ / </> / {} / JS / TS / PY）+ 粗体文件名（点击直接在右侧栏打开预览）+ 浅灰目录路径
 * - 右侧 +added（绿） -removed（红）行数统计
 * - 单个文件的内联 Diff 默认不展开（expanded = false），点击该行任意空白处即可展开/收起该文件的 Diff！
 */
function AntigravityFileRow({ item, ctx }: { item: DeliverableItem; ctx: TspContext }) {
  const zh = currentLocale() === "zh-CN";
  const hasBody = item.bodyNodeId !== undefined;
  // 单个文件 DIFF 默认不展开，点击行时展开
  const [expanded, setExpanded] = useState(false);

  const openInSidebar = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (item.filePath !== undefined) openFilePreview(ctx.taskId, item.filePath);
    else if (item.artifact !== undefined) openInlineArtifact(ctx.taskId, item.artifact);
  };

  return (
    <div
      className="tsp-ag-file"
      data-operation={item.operation}
      data-badge={item.badge}
      data-expanded={expanded && hasBody ? "" : undefined}
      data-testid="tsp-deliverable-card"
    >
      <div
        className="tsp-ag-file-row"
        onClick={() => {
          if (hasBody) setExpanded((prev) => !prev);
          else if (item.filePath !== undefined) openFilePreview(ctx.taskId, item.filePath);
          else if (item.artifact !== undefined) openInlineArtifact(ctx.taskId, item.artifact);
        }}
      >
        <span className="tsp-ag-file-badge" data-kind={item.langBadge.kind} aria-hidden="true">
          {item.langBadge.label}
        </span>
        <button
          type="button"
          className="tsp-ag-file-name"
          onClick={openInSidebar}
          title={zh ? "点击在右侧栏打开查看" : "Click to open in sidebar"}
        >
          {item.name}
        </button>
        {item.dirPath !== "" && <span className="tsp-ag-file-dir">{item.dirPath}</span>}
        <span className="tsp-dsh-file-suffix" data-testid="tsp-deliverable-diff-stats">
          <span className="tsp-dsh-file-stat tsp-dsh-file-add">+{item.added}</span>
          <span className="tsp-dsh-file-stat tsp-dsh-file-del">-{item.removed}</span>
        </span>
        {hasBody && (
          <>
            <button
              type="button"
              className="tsp-ag-diff-btn"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              title={zh ? "展开/收起内联改动对比 (Diff)" : "Toggle inline Diff"}
              data-testid="tsp-ag-file-diff-btn"
            >
              {zh ? "对比" : "Diff"}
            </button>
            <span className="tsp-dsh-file-chev" data-open={expanded ? "" : undefined} aria-hidden="true">
              <ChevronDown />
            </span>
          </>
        )}
      </div>
      {hasBody && expanded && item.bodyNodeId !== undefined && (
        <div className="tsp-dsh-file-body" onClick={(e) => e.stopPropagation()} data-testid="tsp-deliverable-diff-body">
          <TspNode id={item.bodyNodeId} ctx={ctx} />
        </div>
      )}
    </div>
  );
}

function DeliverableCardVisual({ item }: { item: DeliverableItem }) {
  if (item.category === "vector" && item.artifact?.ext === "svg") {
    const svgUrl = `data:image/svg+xml;utf8,${encodeURIComponent(item.artifact.content)}`;
    return (
      <span className="tsp-dsh-card-thumb" data-category={item.category} aria-hidden="true">
        <img src={svgUrl} alt="" loading="lazy" draggable={false} />
      </span>
    );
  }
  return (
    <span className="tsp-dsh-card-icon" data-category={item.category} data-badge={item.badge} aria-hidden="true">
      {item.category === "html" ? (
        <Globe size={18} />
      ) : item.category === "markdown" ? (
        <TspIcon name="markdown" size={18} />
      ) : item.category === "vector" ? (
        <TspIcon name="sparkle" size={18} />
      ) : item.category === "image" ? (
        <TspIcon name="image" size={18} />
      ) : item.category === "code" || item.category === "style" || item.category === "data" ? (
        <Code size={18} />
      ) : (
        <FileIcon size={18} />
      )}
    </span>
  );
}

/**
 * 图 5 DSH 风格的多类型交付文件卡片（针对 Markdown / HTML / SVG / 图片 / PDF 等不同类型呈现差异化视觉）：
 * - 左侧 40×40 类型专属圆角着色图标块（或 SVG 实时缩略图）
 * - 中间粗体文件名 + 类型胶囊徽标（MD / HTML / SVG / IMG / PDF）+ 目录与类型描述
 * - 右侧 [侧栏打开] 与 [v 内联预览] 两个精致方框按钮
 */
function DshDeliverableCard({ item, ctx }: { item: DeliverableItem; ctx: TspContext }) {
  const zh = currentLocale() === "zh-CN";
  const hasBody = item.bodyNodeId !== undefined;
  const [expanded, setExpanded] = useState(false);

  const openInSidebar = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (item.filePath !== undefined) openFilePreview(ctx.taskId, item.filePath);
    else if (item.artifact !== undefined) openInlineArtifact(ctx.taskId, item.artifact);
  };

  return (
    <div className="tsp-dsh-card-wrap" data-category={item.category}>
      <div
        className="tsp-dsh-card"
        data-category={item.category}
        data-badge={item.badge}
        data-testid="tsp-deliverable-card"
        onClick={openInSidebar}
      >
        <DeliverableCardVisual item={item} />
        <span className="tsp-dsh-card-main">
          <span className="tsp-dsh-card-title-row">
            <span className="tsp-dsh-card-title">{item.name}</span>
            <span className="tsp-dsh-card-pill" data-category={item.category}>
              {item.badge}
            </span>
          </span>
          <span className="tsp-dsh-card-sub">
            {item.dirPath ? `${item.dirPath} · ` : ""}
            {zh ? item.subtitleZh : item.subtitleEn}
          </span>
        </span>
        <span className="tsp-dsh-card-actions">
          <button
            type="button"
            className="tsp-dsh-card-btn"
            onClick={openInSidebar}
            title={zh ? "在侧边栏预览打开" : "Open in sidebar preview"}
            aria-label={zh ? "在侧边栏预览打开" : "Open in sidebar preview"}
          >
            <External size={13} />
          </button>
          {hasBody && (
            <button
              type="button"
              className="tsp-dsh-card-btn"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              title={zh ? "展开/收起内联内容" : "Toggle inline preview"}
              aria-expanded={expanded}
            >
              <span className="tsp-dsh-file-chev" data-open={expanded ? "" : undefined}>
                <ChevronDown />
              </span>
            </button>
          )}
        </span>
      </div>
      {hasBody && expanded && item.bodyNodeId !== undefined && (
        <div className="tsp-dsh-file-body" onClick={(e) => e.stopPropagation()}>
          <TspNode id={item.bodyNodeId} ctx={ctx} />
        </div>
      )}
    </div>
  );
}
/**
 * 结合图 5（DSH 双列交付物卡片）与图 6（反重力 Antigravity 可展开/可搜索的「N files changed +M -K」变更面板）：
 * - 面板整体默认展开（panelOpen = true），支持按文件名/路径搜索过滤，右侧带「评审」按钮；
 * - 面板内每个单文件行默认收起 Diff（点击行展开单文件 Diff，点击文件名直接在右侧栏预览）；
 * - 可预览的交付文档（SVG / HTML / MD）同时提供图 5 风格的双列交付卡片。
 */
function DeliverableShelf({ ctx, items }: { ctx: TspContext; items: readonly DeliverableItem[] }) {
  const [panelOpen, setPanelOpen] = useState(true);
  const [query, setQuery] = useState("");
  const zh = currentLocale() === "zh-CN";
  if (items.length === 0) return null;

  const changedFiles = items.filter((i) => i.operation === "write" || i.operation === "edit");
  const deliverableDocs = items.filter((i) => i.operation === "read" || isDeliverableDocPath(i.name));

  const totalAdded = changedFiles.reduce((acc, i) => acc + i.added, 0);
  const totalRemoved = changedFiles.reduce((acc, i) => acc + i.removed, 0);
  const q = query.trim().toLowerCase();
  const filteredChanged =
    q === ""
      ? changedFiles
      : changedFiles.filter((i) => i.name.toLowerCase().includes(q) || i.dirPath.toLowerCase().includes(q));

  return (
    <div className="tsp-deliverables-host" data-testid="tsp-deliverables">
      {deliverableDocs.length > 0 && (
        <div className="tsp-dsh-cards-grid">
          {deliverableDocs.map((item) => (
            <DshDeliverableCard key={`doc:${item.key}`} item={item} ctx={ctx} />
          ))}
        </div>
      )}
      {changedFiles.length > 0 && (
        <div className="tsp-ag-panel" data-testid="tsp-ag-changes-panel">
          <div className="tsp-ag-head">
            <button
              type="button"
              className="tsp-ag-toggle"
              aria-expanded={panelOpen}
              onClick={() => setPanelOpen((v) => !v)}
              data-testid="tsp-ag-changes-toggle"
            >
              <span className="tsp-ag-count">
                {changedFiles.length} {changedFiles.length === 1 ? "file changed" : "files changed"}
              </span>
              <span className="tsp-ag-totals">
                <span className="tsp-dsh-file-stat tsp-dsh-file-add">+{totalAdded}</span>
                <span className="tsp-dsh-file-stat tsp-dsh-file-del">-{totalRemoved}</span>
              </span>
              <span className="tsp-dsh-file-chev" data-open={panelOpen ? "" : undefined} aria-hidden="true">
                <ChevronDown />
              </span>
            </button>
            {panelOpen && (
              <input
                type="search"
                className="tsp-ag-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={zh ? "搜索变更文件或 Diff…" : "Search changed files…"}
                aria-label={zh ? "搜索变更文件" : "Search changed files"}
                data-testid="tsp-ag-changes-search"
              />
            )}
            <button
              type="button"
              className="tsp-ag-review-btn"
              onClick={() => {
                const hasDiskFile = changedFiles.some((item) => item.filePath !== undefined);
                if (hasDiskFile) {
                  openReview(ctx.taskId);
                  return;
                }
                const first = changedFiles[0];
                if (first?.artifact !== undefined) openInlineArtifact(ctx.taskId, first.artifact);
              }}
              data-testid="tsp-ag-changes-review"
            >
              <FileIcon size={12} />
              <span>{zh ? "评审" : "Review"}</span>
            </button>
          </div>
          {panelOpen && (
            <div className="tsp-ag-list">
              {filteredChanged.map((item) => (
                <AntigravityFileRow key={`chg:${item.key}`} item={item} ctx={ctx} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ProcessActivityKind = "read" | "search" | "edit" | "command" | "web" | "subagent" | "plan";

function classifyToolActivity(name: string): ProcessActivityKind | null {
  const n = name.toLowerCase();
  if (n === "read" || n === "read_file" || n === "view") return "read";
  if (n === "grep" || n === "glob" || n === "find" || n === "ls" || n === "search") return "search";
  if (n === "edit" || n === "write" || n === "ast_edit" || n === "apply_patch") return "edit";
  if (n === "bash" || n === "eval" || n === "shell") return "command";
  if (n === "web_search" || n === "fetch" || n === "browse") return "web";
  if (n === "task" || n === "subagent") return "subagent";
  if (n === "todo") return "plan";
  return null;
}

function activityLabel(kind: ProcessActivityKind, zh: boolean): string {
  switch (kind) {
    case "read":
      return zh ? "读取" : "Read";
    case "search":
      return zh ? "搜索" : "Search";
    case "edit":
      return zh ? "编辑" : "Edit";
    case "command":
      return zh ? "命令" : "Command";
    case "web":
      return zh ? "网络" : "Web";
    case "subagent":
      return zh ? "子代理" : "Subagent";
    case "plan":
      return zh ? "待办" : "Plan";
  }
}

type ProcessRenderItem =
  | { kind: "single"; id: string }
  | {
      kind: "explore-group";
      key: string;
      ids: readonly string[];
      reads: number;
      searches: number;
      previewNames: string;
    };

function foldExplorationIds(
  taskId: TaskId,
  sf: string,
  ids: readonly string[],
  enabled: boolean,
): { items: readonly ProcessRenderItem[]; hasExploreRuns: boolean } {
  const isExploreTool = (id: string): "read" | "search" | null => {
    const node = peekTspNode(taskId, sf, id);
    if (!node || node.k !== "tool" || node.p["status"] !== "done") return null;
    const name = typeof node.p["name"] === "string" ? node.p["name"].toLowerCase() : "";
    if (name === "read" || name === "read_file") return "read";
    if (name === "grep" || name === "glob" || name === "find" || name === "ls") return "search";
    return null;
  };
  const isThought = (id: string): boolean => {
    const node = peekTspNode(taskId, sf, id);
    const role = node?.p["role"];
    return typeof role === "string" && role.startsWith("omp.thinking");
  };

  let hasExploreRuns = false;
  const out: ProcessRenderItem[] = [];
  let i = 0;
  while (i < ids.length) {
    const firstKind = isExploreTool(ids[i]!);
    if (firstKind === null) {
      out.push({ kind: "single", id: ids[i]! });
      i += 1;
      continue;
    }
    let j = i;
    let lastToolIdx = i;
    while (j < ids.length && (isExploreTool(ids[j]!) !== null || isThought(ids[j]!))) {
      if (isExploreTool(ids[j]!) !== null) lastToolIdx = j;
      j += 1;
    }
    const runIds = ids.slice(i, lastToolIdx + 1);
    let reads = 0;
    let searches = 0;
    const names: string[] = [];
    for (const rid of runIds) {
      const k = isExploreTool(rid);
      if (k === "read") {
        reads += 1;
        const node = peekTspNode(taskId, sf, rid);
        const target = typeof node?.p["target"] === "string" ? node.p["target"] : "";
        const clean = target.replace(/(?::\d+(?:[-:]\d+)?|\s+\(\d+.*\))$/, "").trim();
        const parts = clean.split(/[\\/]/).filter(Boolean);
        const base = parts[parts.length - 1];
        if (base && !names.includes(base)) names.push(base);
      } else if (k === "search") {
        searches += 1;
      }
    }
    if (reads + searches >= 2) {
      hasExploreRuns = true;
      if (enabled) {
        const previewNames = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
        out.push({
          kind: "explore-group",
          key: `exp-${runIds[0]}`,
          ids: runIds,
          reads,
          searches,
          previewNames,
        });
        i = lastToolIdx + 1;
        continue;
      }
    }
    out.push({ kind: "single", id: ids[i]! });
    i += 1;
  }
  return { items: out, hasExploreRuns };
}

function ExplorationGroupRow({
  item,
  after,
  ctx,
}: {
  item: Extract<ProcessRenderItem, { kind: "explore-group" }>;
  after: ReadonlyMap<string, StatusNote[]>;
  ctx: TspContext;
}) {
  const [open, setOpen] = useState(false);
  const zh = currentLocale() === "zh-CN";
  const parts: string[] = [];
  if (item.reads > 0) parts.push(zh ? `读取 ${item.reads} 个文件` : `Read ${item.reads} files`);
  if (item.searches > 0) parts.push(zh ? `搜索 ${item.searches} 次` : `${item.searches} searches`);
  return (
    <div className="tsp-explore-group" data-open={open || undefined} data-testid="tsp-explore-group">
      <button type="button" className="tsp-explore-group-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="tsp-explore-group-title">{parts.join(zh ? " · " : " · ")}</span>
        {item.previewNames !== "" && <span className="tsp-explore-group-preview">{item.previewNames}</span>}
        <span className="tsp-chev" data-collapsed={!open || undefined}>
          <ChevronDown size={12} />
        </span>
      </button>
      {open && (
        <div className="tsp-explore-group-children">
          {item.ids.map((id) => (
            <Fragment key={id}>
              <TspNode id={id} ctx={ctx} />
              {(after.get(id) ?? []).map((note, i) => (
                <StatusLine key={`s-${id}-${i}`} note={note} />
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function ProcessGroup({
  ids,
  thoughts,
  tools,
  durationMs,
  turnIndex,
  running,
  deliverables,
  after,
  ctx,
}: {
  ids: readonly string[];
  thoughts: number;
  tools: number;
  durationMs: number;
  turnIndex: number;
  running: boolean;
  deliverables: readonly DeliverableItem[];
  after: ReadonlyMap<string, StatusNote[]>;
  ctx: TspContext;
}) {
  const [folded, setFolded] = useState(false);
  const [foldExplore, setFoldExplore] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const layout = useShellValue("processRows") ?? "column";
  const conversationView = useShellValue("conversationView") ?? "chat";
  const isTrajectory = conversationView === "trajectory";
  const effectiveFolded = isTrajectory ? false : folded;
  const effectiveFoldExplore = isTrajectory ? false : foldExplore;
  const zh = currentLocale() === "zh-CN";
  const label = formatProcessSummary(thoughts, tools);
  const extraTurnMs = useSessionExtras(ctx.taskId, (extras) =>
    turnIndex >= 0 ? (extras.turns[turnIndex]?.elapsedMs ?? 0) : 0,
  );
  const effectiveMs = durationMs > 0 ? durationMs : extraTurnMs;
  const durationText =
    effectiveMs >= 100 ? formatElapsed(effectiveMs, effectiveMs >= 1000 ? "seconds" : "short") : null;

  const activitiesText = (() => {
    const counts = new Map<ProcessActivityKind, number>();
    for (const id of ids) {
      const node = peekTspNode(ctx.taskId, ctx.sf, id);
      if (node?.k === "tool" && typeof node.p["name"] === "string") {
        const k = classifyToolActivity(node.p["name"]);
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => activityLabel(k, zh))
      .join(" · ");
  })();

  const { items: renderItems, hasExploreRuns } = foldExplorationIds(ctx.taskId, ctx.sf, ids, effectiveFoldExplore);

  const applyDetailsFold = useCallback(
    (expand: boolean) => {
      const targets: { node: DocNode; initialCollapsed: boolean }[] = [];
      for (const id of ids) {
        const node = peekTspNode(ctx.taskId, ctx.sf, id);
        if (!node || node.p["collapsible"] !== true) continue;
        const role = node.p["role"];
        const isThinking = typeof role === "string" && role.startsWith("omp.thinking");
        const headId = typeof node.p["head"] === "string" ? node.p["head"] : null;
        const headNode = headId !== null ? peekTspNode(ctx.taskId, ctx.sf, headId) : null;
        const thoughtDone = isThinking && headNode?.k === "text";
        const initialCollapsed = node.p["collapsed"] === true || thoughtDone;
        targets.push({ node, initialCollapsed });
      }
      setNodesFolded(ctx.taskId, ctx.sf, targets, !expand);
    },
    [ctx.taskId, ctx.sf, ids],
  );

  const prevTrajectory = useRef(isTrajectory);
  useEffect(() => {
    if (prevTrajectory.current === isTrajectory) {
      if (isTrajectory) applyDetailsFold(true);
      return;
    }
    prevTrajectory.current = isTrajectory;
    setDetailsExpanded(isTrajectory);
    applyDetailsFold(isTrajectory);
  }, [isTrajectory, applyDetailsFold]);

  const onToggleAllDetails = (event: React.MouseEvent) => {
    event.stopPropagation();
    const nextExpanded = !detailsExpanded;
    setDetailsExpanded(nextExpanded);
    if (folded && nextExpanded) setFolded(false);
    applyDetailsFold(nextExpanded);
  };

  useEffect(() => {
    if (effectiveFolded || isTrajectory || !stickRef.current) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [effectiveFolded, isTrajectory, ids.length]);

  return (
    <div
      className="tsp-process-group"
      data-layout={layout}
      data-trajectory={isTrajectory ? "" : undefined}
      data-testid="tsp-process-group"
    >
      <div className="tsp-process-head-row">
        <button
          type="button"
          className="tsp-process-summary"
          data-running={running || undefined}
          aria-expanded={!effectiveFolded}
          onClick={() => {
            if (!isTrajectory) setFolded((f) => !f);
          }}
          data-testid="tsp-process-summary"
        >
          <span className="tsp-process-summary-text">{label}</span>
          {effectiveFolded && activitiesText !== "" && (
            <>
              <span className="tsp-process-summary-sep" aria-hidden="true">
                ·
              </span>
              <span className="tsp-process-summary-acts">{activitiesText}</span>
            </>
          )}
          {durationText !== null && (
            <>
              <span className="tsp-process-summary-sep" aria-hidden="true">
                ·
              </span>
              <span className="tsp-process-summary-time" data-testid="tsp-process-summary-time">
                {durationText}
              </span>
            </>
          )}
          {!isTrajectory && (
            <span className="tsp-process-summary-chev" aria-hidden="true">
              <ChevronDown />
            </span>
          )}
        </button>
        {!effectiveFolded && (
          <div className="tsp-process-controls">
            {hasExploreRuns && !isTrajectory && (
              <button
                type="button"
                className="tsp-process-ctrl-btn"
                aria-pressed={effectiveFoldExplore}
                onClick={() => setFoldExplore((v) => !v)}
                title={zh ? "将连续的读取与搜索步骤聚合成单行摘要" : "Fold consecutive read/search steps"}
                data-testid="tsp-process-fold-explore"
              >
                {zh
                  ? effectiveFoldExplore
                    ? "展开读取"
                    : "聚合读取"
                  : effectiveFoldExplore
                    ? "Unfold reads"
                    : "Fold reads"}
              </button>
            )}
            <button
              type="button"
              className="tsp-process-ctrl-btn"
              aria-pressed={detailsExpanded}
              onClick={onToggleAllDetails}
              title={zh ? "一键展开或收起本轮所有思考与工具详情" : "Expand or collapse all step details"}
              data-testid="tsp-process-bulk-toggle"
            >
              {zh ? (detailsExpanded ? "收起详情" : "展开详情") : detailsExpanded ? "Collapse all" : "Expand all"}
            </button>
          </div>
        )}
      </div>
      {!effectiveFolded && (
        <div
          ref={bodyRef}
          className="tsp-process-group-body"
          data-layout={layout}
          data-trajectory={isTrajectory ? "" : undefined}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {renderItems.map((item) =>
            item.kind === "explore-group" ? (
              <ExplorationGroupRow key={item.key} item={item} after={after} ctx={ctx} />
            ) : (
              <Fragment key={item.id}>
                <TspNode id={item.id} ctx={ctx} />
                {(after.get(item.id) ?? []).map((note, i) => (
                  <StatusLine key={`s-${item.id}-${i}`} note={note} />
                ))}
              </Fragment>
            ),
          )}
        </div>
      )}
      <DeliverableShelf ctx={ctx} items={deliverables} />
    </div>
  );
}

// memo：外层（SurfaceBody）每次重渲染都新建 header / tail 等元素，这里的 props（任务、surface、memo 过的 ctx）不变就不重建整条对话。
export const MainFlow = memo(function MainFlow({ taskId, sf, ctx }: { taskId: TaskId; sf: string; ctx: TspContext }) {
  const bySurface = useTspDerived(taskId, deriveSegmentsBySurface, sameSegmentsBySurface);
  const notes = useTspStatusNotes(taskId, sf);
  const segments = bySurface?.get(sf);
  if (!segments || segments.length === 0) return null;

  // 锚点节点没了的状态行不画：下面只按 main.c 里的 id 取。
  const atStart: StatusNote[] = [];
  const after = new Map<string, StatusNote[]>();
  for (const note of notes) {
    if (note.anchor === null) atStart.push(note);
    else after.set(note.anchor, [...(after.get(note.anchor) ?? []), note]);
  }

  const out: ReactNode[] = atStart.map((note, i) => <StatusLine key={`s-start-${i}`} note={note} />);
  for (const seg of segments) {
    if (seg.kind === "process") {
      out.push(
        <ProcessGroup
          key={`pg-${seg.ids[0]}`}
          ids={seg.ids}
          thoughts={seg.thoughts}
          tools={seg.tools}
          durationMs={seg.durationMs}
          turnIndex={seg.turnIndex}
          running={seg.running}
          deliverables={seg.deliverables}
          after={after}
          ctx={ctx}
        />,
      );
    } else {
      out.push(<TspNode key={seg.id} id={seg.id} ctx={ctx} />);
      if (seg.deliverables.length > 0) {
        out.push(<DeliverableShelf key={`dl-${seg.id}`} ctx={ctx} items={seg.deliverables} />);
      }
      (after.get(seg.id) ?? []).forEach((note, i) => out.push(<StatusLine key={`s-${seg.id}-${i}`} note={note} />));
    }
  }
  return <>{out}</>;
});
