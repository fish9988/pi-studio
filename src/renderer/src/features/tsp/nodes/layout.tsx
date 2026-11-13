// 布局类节点：col、row、card、section、rule、spacer（规范 Layout）。
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ASK_BUTTON_ROLE, ASK_GATE_ROLE } from "../../../../../shared/tsp/ask-gate.ts";
import type { TaskId } from "../../../../../shared/ipc.ts";
import type { TspSpace, TspText } from "../../../../../shared/tsp/tsp.generated.ts";
import { Check, ChevronDown, Comment, CopyIcon } from "../../../icons.tsx";
import { AskButtonRow, AskGateCol } from "../interactive/AskGate.tsx";
import { ERROR_CARD_ROLE } from "../../../../../shared/tsp/error-turn.ts";
import { RetryButton } from "../../session-info/RetryButton.tsx";
import { Clamp } from "../Clamp.tsx";
import { keyboardFocused } from "../../../ui/input-modality.ts";
import { FoldCtx, NO_FOLD, OPEN_FOLD, useFoldState } from "../fold-context.ts";
import { resolveIconName, toolIconName } from "../icon-names.ts";
import { useEntrance } from "../entrance.ts";
import { TspIcon } from "../icons.tsx";
import { labels } from "../labels.ts";
import { nodeDomProps } from "../node-dom.ts";
import type { NodeProps } from "../node-props.ts";
import { TspSpans } from "../spans.tsx";
import { previewToLines } from "../props-util.ts";
import { TspChildren, TspNode } from "../TspChildren.tsx";
import { useFold } from "../use-fold.ts";
import { ownsReadingPosition, subscribeReadingChanges } from "../reading-hold.ts";
import {
  peekTspDocument,
  peekTspNode,
  useBareTurnIndex,
  useIsLatestRecap,
  useTspNode,
  useTspNoVisibleChild,
} from "../tsp-store.ts";
import { runOutputSpan } from "../../../../../shared/tsp/run-output.ts";
import { useSessionExtras } from "../session-extras-store.ts";
import { useTaskValue } from "../../../store/index.ts";
import { formatTurnFooter } from "../turn-footer.ts";
import { copyText } from "../actions.ts";
import { quoteToComposer } from "../../composer/quote.ts";
import { currentLocale } from "../../../store/settings-store.ts";
import { UserMessageActions } from "../UserMessageActions.tsx";
const GAPS: ReadonlySet<TspSpace> = new Set(["none", "xs", "sm", "md", "lg"]);

function stackClasses(p: Readonly<Record<string, unknown>>): string {
  const classes: string[] = [];
  if (typeof p.gap === "string" && GAPS.has(p.gap as TspSpace)) classes.push(`tsp-gap-${p.gap}`);
  if (typeof p.align === "string") classes.push(`tsp-al-${p.align}`);
  if (p.justify === "between" || p.justify === "end") classes.push(`tsp-js-${p.justify}`);
  if (p.wrap === true) classes.push("tsp-wrap");
  return classes.join(" ");
}

/** col / row 没有可显示的子节点（不占位也不产生间距，data-blank）；有 `grow` 的撑开空间，不收起；`extra` = 还有 children 之外的元素。 */
function useBlank({ node, ctx }: NodeProps, extra = false): boolean {
  const grows = typeof node.p.grow === "number" && node.p.grow > 0;
  return useTspNoVisibleChild(ctx.taskId, ctx.sf, node.c, grows || extra ? "off" : "container");
}

/** 搜索来源（omp.tool.files 里是 omp.tool.source 行）：整列排成卡片网格，见 tsp.css。 */
function hasSourceRows({ node, ctx }: NodeProps): boolean {
  if (node.p.role !== "omp.tool.files") return false;
  return node.c.some((id) => {
    const child = peekTspNode(ctx.taskId, ctx.sf, id);
    return child?.k === "row" && child.p.role === "omp.tool.source";
  });
}

/** wait / Task 卡里的作业磁贴（shared/tsp/jobs.ts 的 omp.job.tile）：同一批出现的错开入场。 */
function TileCol(props: NodeProps) {
  const entrance = useEntrance(props.ctx.taskId, props.ctx.sf, props.node.id);
  const blank = useBlank(props);
  return (
    <div
      {...nodeDomProps(props, "tsp-col", {
        className: [stackClasses(props.node.p), entrance?.className].filter(Boolean).join(" "),
        style: entrance?.style,
        blank,
      })}
      data-enter={entrance?.["data-enter"]}
    >
      <TspChildren {...props} />
    </div>
  );
}

export function Col(props: NodeProps) {
  if (props.node.p.role === "omp.job.tile") return <TileCol {...props} />;
  if (props.node.p.role === "omp.assistant") return <AssistantCol {...props} />;
  if (props.node.p.role === ASK_GATE_ROLE) return <GateCol {...props} />;
  if (props.node.p.role === "omp.run") return <RunCol {...props} />;
  return <PlainCol {...props} />;
}

/**
 * eval 的一个 cell：输出被 JSON 视图切成几段时（shared/tsp/run-output.ts），折叠中把这几段合成一段，
 * 一起只露末尾几行（和单段输出一样），里面各段不再各自夹紧。展开、只有一段时照常。
 */
function RunCol(props: NodeProps) {
  const { node, ctx } = props;
  const fold = useFoldState();
  const blank = useBlank(props);
  const span = fold.collapsed === true ? runOutputSpan(node.c.map((id) => peekTspNode(ctx.taskId, ctx.sf, id))) : null;
  if (span === null) return <PlainCol {...props} />;
  const child = (id: string) => <TspNode key={id} id={id} ctx={ctx} />;
  return (
    <div {...nodeDomProps(props, "tsp-col", { className: stackClasses(node.p), blank })}>
      {node.c.slice(0, span.start).map(child)}
      <Clamp lines={span.lines} tail onExpand={fold.expand} className="tsp-run-outputs">
        <FoldCtx.Provider value={OPEN_FOLD}>{node.c.slice(span.start, span.end).map(child)}</FoldCtx.Provider>
      </Clamp>
      {node.c.slice(span.end).map(child)}
    </div>
  );
}

function GateCol(props: NodeProps) {
  const blank = useBlank(props);
  return (
    <AskGateCol {...props} dom={nodeDomProps(props, "tsp-col", { className: stackClasses(props.node.p), blank })} />
  );
}

function PlainCol(props: NodeProps) {
  const blank = useBlank(props);
  return (
    <div
      {...nodeDomProps(props, "tsp-col", { className: stackClasses(props.node.p), blank })}
      data-cards={hasSourceRows(props) ? "" : undefined}
    >
      <TspChildren {...props} />
    </div>
  );
}

/**
 * omp 的助手消息容器。恢复会话时 omp 不重发每轮末尾的用量行（实测 18.12.4），这里在一轮的最后一个助手消息后面
 * 补一行（数据来自会话文件，见 main/tsp/session-extras.ts）；实时的轮 omp 自己带这一行，不补；还在跑的那一轮也不补（useBareTurnIndex）。
 */
const AssistantCopyCtx = createContext<string>("");

function AssistantCopyIconBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const zh = currentLocale() === "zh-CN";
  return (
    <button
      type="button"
      className="tsp-assistant-copy-btn"
      data-copied={copied || undefined}
      data-testid="tsp-assistant-copy"
      title={zh ? "复制整条回答内容" : "Copy response"}
      aria-label={zh ? "复制回答" : "Copy response"}
      onClick={(event) => {
        event.stopPropagation();
        copyText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={12} /> : <CopyIcon size={12} />}
    </button>
  );
}

/** 助手消息 foot 行里“引用到输入框”：把这条回答接进当前任务的草稿（不新开行，和复制按钮同一个样式）。 */
function AssistantQuoteIconBtn({ taskId, text }: { taskId: TaskId; text: string }) {
  const zh = currentLocale() === "zh-CN";
  if (text === "") return null;
  return (
    <button
      type="button"
      className="tsp-assistant-copy-btn"
      data-testid="tsp-assistant-quote"
      title={zh ? "引用到输入框" : "Quote to composer"}
      aria-label={zh ? "引用回答到输入框" : "Quote response to composer"}
      onClick={(event) => {
        event.stopPropagation();
        quoteToComposer(taskId, text);
      }}
    >
      <Comment size={12} />
    </button>
  );
}

function inspectTurnContext(
  taskId: NodeProps["ctx"]["taskId"],
  sf: string,
  nodeId: string,
): { toolCount: number; hasMoreProcessAfter: boolean } {
  const doc = peekTspDocument(taskId);
  const surface = doc?.surfaces.get(sf);
  const main = surface?.nodes.get("main");
  if (!surface || !main) return { toolCount: 0, hasMoreProcessAfter: false };
  const idx = main.c.indexOf(nodeId);
  if (idx === -1) return { toolCount: 0, hasMoreProcessAfter: false };

  let toolCount = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const cur = surface.nodes.get(main.c[i]!);
    if (!cur) continue;
    if (cur.k === "card" && cur.p["role"] === "omp.user") break;
    if (cur.k === "tool" && cur.p["role"] !== "omp.tool.ask") toolCount += 1;
  }

  let hasMoreProcessAfter = false;
  for (let i = idx + 1; i < main.c.length; i++) {
    const cur = surface.nodes.get(main.c[i]!);
    if (!cur) continue;
    if (cur.k === "card" && cur.p["role"] === "omp.user") break;
    if (cur.k === "tool" && cur.p["role"] !== "omp.tool.ask") {
      hasMoreProcessAfter = true;
      break;
    }
    if (cur.k === "col" && cur.p["role"] === "omp.assistant") {
      const hasThinking = cur.c.some((cid) => {
        const r = surface.nodes.get(cid)?.p["role"];
        return typeof r === "string" && r.startsWith("omp.thinking");
      });
      if (hasThinking) {
        hasMoreProcessAfter = true;
        break;
      }
    }
  }
  return { toolCount, hasMoreProcessAfter };
}

function synthesizeTurnRecap(markdown: string, toolCount: number): string | null {
  // 仅在工具调用 >= 5 次且经历复杂多步操作的回合渲染单行精炼 ※ 总结，普通简短对话直接不渲染
  if (toolCount < 5) return null;
  const cleaned = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\|[^\n]+\|/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
  if (cleaned.length < 120) return null;

  const rawLines = cleaned
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^(?:[#>*\-\s`]+|\d+\.\s+)+|[`*_]+$/g, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length >= 10 && !/^[-=:|\s]+$/.test(line));
  if (rawLines.length === 0) return null;

  const first = rawLines[0]!;
  return first.length > 96 ? `${first.slice(0, 95)}…` : first;
}

function AssistantCol(props: NodeProps) {
  const { taskId, sf } = props.ctx;
  const zh = currentLocale() === "zh-CN";
  // 只取轮数和自己那一轮的脚注：别的轮的用量刷新了不重画这一列。
  const turnCount = useSessionExtras(taskId, (extras) => extras.turns.length);
  const running = useTaskValue(taskId, (task) => task?.status === "running" || task?.status === "needs_you");
  const index = useBareTurnIndex(taskId, sf, props.node.id, turnCount, running);
  const footer = useSessionExtras(taskId, (extras) => (index >= 0 ? (extras.turns[index] ?? null) : null));
  const text = useMemo(() => (footer === null ? null : formatTurnFooter(footer)), [footer]);
  // omp.thinking 与工具读取的 media/image 节点已由 MainFlow 统一提取进 ProcessGroup 渲染，这里只画正式回答与单行安静底栏。
  const nonThoughtIds = props.node.c.filter((id) => {
    const child = peekTspNode(taskId, sf, id);
    if (!child) return false;
    if (child.k === "media" || child.k === "image") return false;
    const role = child.p["role"];
    return !(typeof role === "string" && role.startsWith("omp.thinking"));
  });
  const hasUsageChild = nonThoughtIds.some((id) => peekTspNode(taskId, sf, id)?.p["role"] === "omp.turn.usage");
  const { toolCount, hasMoreProcessAfter } = inspectTurnContext(taskId, sf, props.node.id);
  const visibleChildIds = hasMoreProcessAfter
    ? nonThoughtIds.filter((id) => peekTspNode(taskId, sf, id)?.p["role"] !== "omp.turn.usage")
    : nonThoughtIds;
  const answerText = useMemo(() => {
    const parts: string[] = [];
    for (const id of visibleChildIds) {
      const child = peekTspNode(taskId, sf, id);
      if (child?.k === "md" && child.p["role"] === undefined && typeof child.p["text"] === "string") {
        parts.push(child.p["text"]);
      }
    }
    return parts.join("\n\n").trim();
  }, [visibleChildIds, taskId, sf]);
  const recapText = useMemo(
    () => (running || hasMoreProcessAfter ? null : synthesizeTurnRecap(answerText, toolCount)),
    [running, hasMoreProcessAfter, answerText, toolCount],
  );
  const showRestoredUsage = !hasMoreProcessAfter && text !== null;
  const showBareCopyFoot = !running && !hasMoreProcessAfter && !hasUsageChild && text === null && answerText !== "";
  const blank = visibleChildIds.length === 0 && !showRestoredUsage;
  return (
    <AssistantCopyCtx.Provider value={answerText}>
      <div {...nodeDomProps(props, "tsp-col", { className: stackClasses(props.node.p), blank })}>
        {visibleChildIds.map((id) => (
          <TspNode key={id} id={id} ctx={props.ctx} />
        ))}
        {!running && recapText !== null && (
          <div
            className="tsp-row tsp-turn-summary"
            data-role="omp.turn.recap"
            data-testid="tsp-turn-summary"
            title={recapText}
          >
            <span className="tsp-turn-summary-text">{recapText}</span>
          </div>
        )}
        {showRestoredUsage && text !== null && (
          <div className="tsp-row" data-role="omp.turn.usage" data-restored="" title={text.title}>
            {answerText !== "" && (
              <>
                <AssistantCopyIconBtn text={answerText} />
                <AssistantQuoteIconBtn taskId={taskId} text={answerText} />
                <span className="tsp-foot-sep" aria-hidden="true">
                  ·
                </span>
              </>
            )}
            <div className="tsp-text">{text.text}</div>
          </div>
        )}
        {showBareCopyFoot && (
          <div className="tsp-row tsp-assistant-bare-foot" title={zh ? "复制回答" : "Copy response"}>
            <AssistantCopyIconBtn text={answerText} />
            <AssistantQuoteIconBtn taskId={taskId} text={answerText} />
          </div>
        )}
      </div>
    </AssistantCopyCtx.Provider>
  );
}

/**
 * 空闲回顾（omp.recap）：omp 终端里是 "※ recap: …"，节点里的图标 `history` 只是 TSP 的占位，tsp.css 里隐藏它、改画 ※。
 * 对话里只显示最新的一条：之后又来了新的回顾，这一条就收起（omp 每条都留着）。和 omp 一样只画 omp 发来的：恢复会话时 omp 不重放回顾，
 * studio 也不补；压缩、恢复这类整段重建对话时 omp 删掉它，这里跟着消失。
 */
function RecapRow(props: NodeProps) {
  const { taskId, sf } = props.ctx;
  const latest = useIsLatestRecap(taskId, sf, props.node.id);
  const blank = useBlank(props);
  if (!latest) return null;
  const dom = nodeDomProps(props, "tsp-row", { className: stackClasses(props.node.p), blank });
  return (
    <div {...dom} title={labels.recapTitle}>
      <TspChildren {...props} />
    </div>
  );
}

function UsageRow(props: NodeProps) {
  const { taskId, sf } = props.ctx;
  const answerText = useContext(AssistantCopyCtx);
  const blank = useBlank(props);
  const hasNativeCopy = props.node.c.some((cid) => peekTspNode(taskId, sf, cid)?.p["role"] === "omp.turn.copy");
  const showCopy = !hasNativeCopy && answerText !== "";
  return (
    <div {...nodeDomProps(props, "tsp-row", { className: stackClasses(props.node.p), blank })}>
      {showCopy && (
        <>
          <AssistantCopyIconBtn text={answerText} />
          <AssistantQuoteIconBtn taskId={taskId} text={answerText} />
          <span className="tsp-foot-sep" aria-hidden="true">
            ·
          </span>
        </>
      )}
      <TspChildren {...props} />
    </div>
  );
}

export function Row(props: NodeProps) {
  if (props.node.p.role === "omp.recap") return <RecapRow {...props} />;
  if (props.node.p.role === "omp.turn.usage") return <UsageRow {...props} />;
  if (props.node.p.role === ASK_BUTTON_ROLE) {
    return <AskButtonRow {...props} dom={nodeDomProps(props, "tsp-row", { className: stackClasses(props.node.p) })} />;
  }
  return <PlainRow {...props} />;
}

function PlainRow(props: NodeProps) {
  const blank = useBlank(props);
  return (
    <div {...nodeDomProps(props, "tsp-row", { className: stackClasses(props.node.p), blank })}>
      <TspChildren {...props} />
    </div>
  );
}

// ───────── card / section 共用：head 可以是文字，也可以是某个子节点的 id ─────────
/** head 是子节点 id 时返回这个 id（该子节点画在头里，不在 body 里）。 */
function headChildId(node: NodeProps["node"]): string | null {
  const { head } = node.p;
  return typeof head === "string" && node.c.includes(head) ? head : null;
}

function HeadContent({ props, headId }: { props: NodeProps; headId: string | null }) {
  const head = props.node.p.head as TspText | undefined;
  if (headId !== null) return <TspNode id={headId} ctx={props.ctx} />;
  return <TspSpans text={head} />;
}

function onHeadKey(toggle: () => void): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };
}

/** role → 卡片头图标（规范 Layout/card "Role icon"）：omp.tool.<tool> 按工具，其它按 role 的第二段。 */
function roleIcon(role: unknown): string | null {
  if (typeof role !== "string") return null;
  const parts = role.split(".");
  if (parts[0] === "omp" && parts[1] === "tool" && parts[2]) return toolIconName(parts[2]);
  return parts[1] && resolveIconName(parts[1]) !== null ? parts[1] : null;
}

function StatusChip({ status }: { status: string }) {
  const label = labels.status(status);
  if (label === undefined) return null;
  return (
    <span className="tsp-chip" data-status={status}>
      {status === "running" ? <i className="tsp-chip-dot" /> : <TspIcon name={chipIcon(status)} size={12} />}
      {label}
    </span>
  );
}

function chipIcon(status: string): string {
  return status === "done" ? "check" : status === "error" ? "x" : status === "cancelled" ? "stop" : "clock";
}

/**
 * 用户气泡（omp.user）里有元素被键盘聚焦（ui/input-modality 的 keyboardFocused；鼠标点出来的焦点不算）时给卡片加 data-kbd-focus，
 * tsp.css 据此显示平时只在悬停时出现的工具行。focus / blur 事件里判断，不靠 CSS 的 :has(:focus-visible)。
 */
function useKeyboardFocus(enabled: boolean): {
  "data-kbd-focus"?: "" | undefined;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
} {
  const [focused, setFocused] = useState(false);
  if (!enabled) return {};
  return {
    "data-kbd-focus": focused ? "" : undefined,
    onFocus: (event) => setFocused(keyboardFocused(event.target)),
    onBlur: (event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
        setFocused(false);
    },
  };
}

const USER_TEXT_COLLAPSE_HEIGHT = 220;

function CollapsibleUserBody({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const zh = currentLocale() === "zh-CN";

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollHeight > USER_TEXT_COLLAPSE_HEIGHT + 60);
    check();
    const obs = new ResizeObserver(check);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const collapsed = overflowing && !expanded;
  return (
    <div className="tsp-user-collapsible">
      <div ref={bodyRef} className="tsp-user-collapsible-inner" data-collapsed={collapsed || undefined}>
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          className="tsp-user-expand-btn"
          data-expanded={expanded || undefined}
          data-testid="user-msg-expand"
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronDown size={11} />
          <span>{expanded ? (zh ? "收起" : "Collapse") : zh ? "展开全文" : "Show more"}</span>
        </button>
      )}
    </div>
  );
}

function collectPlainNodeText(taskId: NodeProps["ctx"]["taskId"], sf: string, id: string): string {
  const node = peekTspNode(taskId, sf, id);
  if (!node) return "";
  if (node.p["role"] === "omp.error.actions" || node.p["role"] === "omp.error.action") return "";
  if (typeof node.p["text"] === "string") return node.p["text"];
  if (Array.isArray(node.p["spans"])) {
    return (node.p["spans"] as { t?: unknown }[]).map((s) => (typeof s?.t === "string" ? s.t : "")).join("");
  }
  return node.c
    .map((cid) => collectPlainNodeText(taskId, sf, cid))
    .filter((s) => s !== "")
    .join(" ");
}

function summarizeErrorText(raw: string, zh: boolean): { summary: string; hasDetail: boolean } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { summary: zh ? "请求异常中断" : "Request interrupted", hasDetail: false };
  }
  const codeMatch = /\b(401|403|404|408|413|429|500|502|503|504)\b/.exec(trimmed);
  let extractedMsg: string | null = null;
  const jsonMsgMatch = /"message"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(trimmed);
  if (jsonMsgMatch?.[1]) {
    extractedMsg = jsonMsgMatch[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
  }
  const firstCleanLine =
    extractedMsg ??
    trimmed
      .replace(/^Error\b[:\s-]*/i, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("{") && !l.startsWith("at ")) ??
    trimmed.replace(/\s+/g, " ");

  let summary = firstCleanLine;
  if (codeMatch && !summary.includes(codeMatch[1]!)) {
    summary = `${codeMatch[1]}: ${summary}`;
  }
  const hasDetail =
    trimmed.includes("\n") ||
    trimmed.includes("{") ||
    trimmed.length > 96 ||
    summary !== trimmed.replace(/^Error\s*/i, "");
  if (summary.length > 92) {
    summary = `${summary.slice(0, 91)}…`;
  }
  return { summary, hasDetail };
}

function ErrorBarCard(props: NodeProps) {
  const { node, ctx } = props;
  const zh = currentLocale() === "zh-CN";
  const [detailOpen, setDetailOpen] = useState(false);

  const actionIds: string[] = [];
  const detailIds: string[] = [];
  const rawParts: string[] = [];

  for (const cid of node.c) {
    const child = peekTspNode(ctx.taskId, ctx.sf, cid);
    if (!child) continue;
    if (child.p["role"] === "omp.error.actions" || child.p["role"] === "omp.error.action") {
      actionIds.push(cid);
      continue;
    }
    const text = collectPlainNodeText(ctx.taskId, ctx.sf, cid).trim();
    if (text.toLowerCase() === "error") continue;
    if (text !== "") rawParts.push(text);
    detailIds.push(cid);
  }

  const rawFull = rawParts.join("\n").trim();
  const { summary, hasDetail } = summarizeErrorText(rawFull, zh);

  return (
    <div {...nodeDomProps(props, "tsp-card", { className: "tsp-error-bar-card" })}>
      <div className="tsp-error-bar">
        {/* 可点是整行摘要（不是原生 <button>）：button 的 UA 外观（ButtonFace 底 + 边框 + padding）和悬停重绘会在这张
            半透明错误卡上变成一个深色小块，所以用 div + role="button"，外观全交给 tsp.css 的 .tsp-error-bar-main。 */}
        <div
          className="tsp-error-bar-main"
          role={hasDetail ? "button" : undefined}
          tabIndex={hasDetail ? 0 : undefined}
          data-expandable={hasDetail || undefined}
          data-expanded={(hasDetail && detailOpen) || undefined}
          aria-expanded={hasDetail ? detailOpen : undefined}
          onClick={() => {
            if (hasDetail) setDetailOpen((v) => !v);
          }}
          onKeyDown={(event) => {
            if (!hasDetail) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setDetailOpen((v) => !v);
          }}
        >
          <span className="tsp-error-dot" aria-hidden="true" />
          <span className="tsp-error-label">{zh ? "本轮运行失败" : "Turn failed"}</span>
          <span className="tsp-error-summary" title={summary}>
            {summary}
          </span>
          {hasDetail && (
            <span className="tsp-error-chev" data-expanded={detailOpen || undefined} aria-hidden="true">
              <ChevronDown size={12} />
            </span>
          )}
        </div>
        <div className="tsp-error-bar-actions">
          {actionIds.map((id) => (
            <TspNode key={id} id={id} ctx={ctx} />
          ))}
          <RetryButton taskId={ctx.taskId} sf={ctx.sf} id={node.id} />
        </div>
      </div>
      {hasDetail && detailOpen && detailIds.length > 0 && (
        <div className="tsp-error-detail">
          {detailIds.map((id) => (
            <TspNode key={id} id={id} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Card(props: NodeProps) {
  if (props.node.p.role === ERROR_CARD_ROLE) return <ErrorBarCard {...props} />;
  return <StandardCard {...props} />;
}

function StandardCard(props: NodeProps) {
  const { node } = props;
  const p = node.p;
  const isUser = p.role === "omp.user";
  const collapsible = p.collapsible === true;
  const [collapsed, toggle] = useFold(props, collapsible && p.collapsed === true);
  const keyFocus = useKeyboardFocus(isUser);
  const fold = useMemo(() => (collapsible ? { collapsed, expand: toggle } : NO_FOLD), [collapsible, collapsed, toggle]);
  const headId = headChildId(node);
  const hasHead =
    headId !== null || (p.head !== undefined && p.head !== "") || typeof p.status === "string" || collapsible;
  const lines = collapsed ? previewToLines(p.preview) : null;
  const classes = [
    collapsible && "collapsible",
    collapsed && "collapsed",
    collapsed && lines === null && "nopreview",
    p.selected === true && "selected",
    p.inset === true && "inset",
    p.variant === "bare" && "bare",
    !hasHead && "nohead",
  ].filter((c): c is string => typeof c === "string");
  const icon = roleIcon(p.role);
  const rawChildren = node.c.filter((id) => id !== headId);
  const orderedChildren = isUser
    ? [...rawChildren].sort((a, b) => {
        const ra = peekTspNode(props.ctx.taskId, props.ctx.sf, a)?.p.role === "omp.user.images" ? 0 : 1;
        const rb = peekTspNode(props.ctx.taskId, props.ctx.sf, b)?.p.role === "omp.user.images" ? 0 : 1;
        return ra - rb;
      })
    : rawChildren;
  const innerNodes = (
    <>
      {orderedChildren.map((id) => (
        <TspNode key={id} id={id} ctx={props.ctx} />
      ))}
    </>
  );
  const body: ReactNode = (
    <div className="tsp-card-body">{isUser ? <CollapsibleUserBody>{innerNodes}</CollapsibleUserBody> : innerNodes}</div>
  );
  return (
    <div
      {...nodeDomProps(props, "tsp-card", {
        className: classes.join(" "),
        own: { toggle: collapsible ? toggle : undefined },
      })}
      {...keyFocus}
    >
      {hasHead && (
        <div
          className="tsp-card-head"
          role={collapsible ? "button" : undefined}
          tabIndex={collapsible ? 0 : undefined}
          aria-expanded={collapsible ? !collapsed : undefined}
          onClick={collapsible ? (event) => !event.metaKey && toggle() : undefined}
          onKeyDown={collapsible ? onHeadKey(toggle) : undefined}
        >
          {icon !== null && (
            <span className="tsp-card-ic">
              <TspIcon name={icon} />
            </span>
          )}
          <div className="tsp-head">
            <HeadContent props={props} headId={headId} />
          </div>
          {typeof p.status === "string" && <StatusChip status={p.status} />}
          {collapsible && (
            <span className="tsp-chev" data-collapsed={collapsed || undefined}>
              <ChevronDown size={12} />
            </span>
          )}
        </div>
      )}
      <FoldCtx.Provider value={fold}>
        {collapsed && lines === null && collapsible ? null : lines !== null ? (
          <Clamp lines={lines} onExpand={toggle}>
            {body}
          </Clamp>
        ) : (
          body
        )}
      </FoldCtx.Provider>
      {isUser && <UserMessageActions taskId={props.ctx.taskId} sf={props.ctx.sf} cardId={node.id} />}
    </div>
  );
}

function firstThoughtLine(props: NodeProps, headId: string | null, live = false): string | null {
  const role = props.node.p.role;
  if (typeof role !== "string" || !role.startsWith("omp.thinking")) return null;
  const childIds = live ? props.node.c.toReversed() : props.node.c;
  for (const cid of childIds) {
    if (cid === headId) continue;
    const child = peekTspNode(props.ctx.taskId, props.ctx.sf, cid);
    if (child && typeof child.p.text === "string") {
      const candidates = child.p.text
        .replace(/```[\s\S]*?(?:```|$)/g, " ")
        .split(/\r?\n/)
        .map((s) =>
          s
            .replace(/^(?:[#>*\-\s`]+|\d+\.\s+)+|[`*_]+$/g, "")
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/__([^_]+)__/g, "$1")
            .replace(/`([^`]+)`/g, "$1")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .trim(),
        )
        .filter((s) => s.length > 0);
      const line = (live ? candidates.at(-1) : candidates[0]) ?? "";
      if (line !== "") return line.length > 90 ? `${line.slice(0, 89)}…` : line;
    }
  }
  return null;
}

export function Section(props: NodeProps) {
  const { node } = props;
  const p = node.p;
  const isThinking = typeof p.role === "string" && p.role.startsWith("omp.thinking");
  const headId = headChildId(node);
  const subscribedHeadNode = useTspNode(props.ctx.taskId, props.ctx.sf, isThinking && headId !== null ? headId : "");
  const headNode = subscribedHeadNode ?? (headId !== null ? peekTspNode(props.ctx.taskId, props.ctx.sf, headId) : null);
  const thoughtLive = isThinking && (p.role === "omp.thinking.live" || headNode?.k === "shimmer");
  // 照 reasoning-fold.ts：思考结束（head 从 shimmer 变成 text "Thought for Ns"）后默认自动收起，点行可随时展开。
  const thoughtDone = isThinking && headNode?.k === "text";
  const collapsible = p.collapsible === true;
  const [rawCollapsed, toggle] = useFold(props, collapsible && (p.collapsed === true || thoughtDone));
  const bodyRef = useRef<HTMLDivElement>(null);
  const [readingHold, setReadingHold] = useState(false);
  const prevThoughtDone = useRef(thoughtDone);
  useEffect(() => {
    const justFinished = isThinking && !prevThoughtDone.current && thoughtDone;
    prevThoughtDone.current = thoughtDone;
    if (justFinished && ownsReadingPosition(bodyRef.current)) {
      setReadingHold(true);
    }
  }, [isThinking, thoughtDone]);
  useEffect(() => {
    if (!readingHold) return;
    return subscribeReadingChanges(() => {
      if (!ownsReadingPosition(bodyRef.current)) setReadingHold(false);
    });
  }, [readingHold]);
  const collapsed = rawCollapsed && !readingHold;
  const bodyChildId = isThinking ? (node.c.find((cid) => cid !== headId) ?? null) : null;
  const liveBodyNode = useTspNode(
    props.ctx.taskId,
    props.ctx.sf,
    isThinking && bodyChildId !== null ? bodyChildId : "",
  );
  const liveChildText = typeof liveBodyNode?.p.text === "string" ? liveBodyNode.p.text : "";
  const previewLine = isThinking && collapsed ? firstThoughtLine(props, headId, thoughtLive) : null;
  const zh = currentLocale() === "zh-CN";
  const userScrolledRef = useRef(false);

  useEffect(() => {
    userScrolledRef.current = false;
  }, [thoughtLive, collapsed]);

  useEffect(() => {
    if (!thoughtLive || collapsed || userScrolledRef.current) return;
    const el = bodyRef.current;
    if (el && el.scrollHeight > el.clientHeight) {
      el.scrollTop = el.scrollHeight;
    }
  }, [thoughtLive, collapsed, liveChildText]);

  useEffect(() => {
    if (!thoughtLive || collapsed || typeof ResizeObserver === "undefined") return;
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!userScrolledRef.current && el.scrollHeight > el.clientHeight) {
        el.scrollTop = el.scrollHeight;
      }
    });
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, [thoughtLive, collapsed, node.c]);

  const classes = [collapsible && "collapsible", collapsed && "collapsed"].filter(
    (c): c is string => typeof c === "string",
  );
  return (
    <div
      {...nodeDomProps(props, "tsp-section", {
        className: classes.join(" "),
        own: { toggle: collapsible ? toggle : undefined },
      })}
      data-live={thoughtLive ? "" : undefined}
    >
      <div
        className="tsp-section-head"
        role={collapsible ? "button" : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? !collapsed : undefined}
        onClick={collapsible ? (event) => !event.metaKey && toggle() : undefined}
        onKeyDown={collapsible ? onHeadKey(toggle) : undefined}
      >
        {isThinking ? (
          collapsed ? (
            <>
              <span className="tsp-thought-preview">
                {previewLine ?? (thoughtLive ? (zh ? "正在思考…" : "Thinking…") : zh ? "思考过程" : "Thought")}
              </span>
              <span className="tsp-thought-arrow" aria-hidden="true">
                ›
              </span>
            </>
          ) : (
            <>
              <span className="tsp-thought-clean-label">
                {thoughtLive ? (zh ? "正在思考…" : "Thinking…") : zh ? "思考" : "Thought"}
              </span>
              <span className="tsp-chev">
                <ChevronDown size={12} />
              </span>
            </>
          )
        ) : (
          <>
            <span className="tsp-chev" data-collapsed={collapsed || undefined}>
              <ChevronDown size={12} />
            </span>
            <div className="tsp-head">
              <HeadContent props={props} headId={headId} />
            </div>
          </>
        )}
      </div>
      {!collapsed && (
        // 展开着的 section：思考 / Commentary 的正文就是要看全文，子节点的 preview 一律让位（不再因 NO_FOLD 被夹到几行）。
        <FoldCtx.Provider value={OPEN_FOLD}>
          <div
            ref={bodyRef}
            className="tsp-section-body"
            onScroll={
              thoughtLive
                ? (event) => {
                    const el = event.currentTarget;
                    userScrolledRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 28;
                  }
                : undefined
            }
          >
            {node.c
              .filter((id) => id !== headId)
              .map((id) => (
                <TspNode key={id} id={id} ctx={props.ctx} />
              ))}
          </div>
        </FoldCtx.Provider>
      )}
    </div>
  );
}

export function Rule(props: NodeProps) {
  const label = props.node.p.label as TspText | undefined;
  const bare = label === undefined || label === "";
  return (
    <div {...nodeDomProps(props, "tsp-rule", { className: bare ? "bare" : undefined })} role="separator">
      {!bare && (
        <span className="tsp-rule-label">
          <TspSpans text={label} />
        </span>
      )}
    </div>
  );
}

export function Spacer(props: NodeProps) {
  const size = typeof props.node.p.size === "string" ? props.node.p.size : "md";
  return <div {...nodeDomProps(props, "tsp-spacer", { className: `tsp-sz-${size}` })} aria-hidden="true" />;
}
