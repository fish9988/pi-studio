// 合一的 DSH 风格上下文环形指示器（替代底栏散落的轮数、缓存百分比、绿饼图、美元金额）：
// - 外观：精致小圆环进度条 + 百分比（如 `14%`），超过 75% 变琥珀色预警，超过 90% 变柔和红色预警；
// - 悬停：弹出精美 Tooltip 卡片，集中展示 对话轮数、缓存命中率、具体 Token 用量、累计开销（$）；
// - 点击：打开上下文构成（ContextBreakdown + ModelBreakdown），并承接全局 UsageDialog。
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ModelOption, ProjectId, TaskState } from "../../../../shared/ipc.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import { DraftContextBreakdown, prefetchCompaction, TaskContextBreakdown } from "./ContextBreakdown.tsx";
import { hasModelUsage, ModelBreakdown, useModelUsage, useSpeed, type Speed } from "./ModelBreakdown.tsx";
import { Popover } from "../../ui/Popover.tsx";
import { onStudioCommand } from "../palette/studio-command.ts";
import { formatCount, formatMoney, formatPercent } from "./usage-format.ts";
import { UsageDialog } from "./UsageDialog.tsx";
import { setUsageDialogOpen, useUsageDialogOpen } from "./usage-store.ts";
import { useSubscription } from "./use-subscription.ts";

const ringSize = 16;
const ringRadius = 6;
const ringLength = 2 * Math.PI * ringRadius;
const noPins: TaskState["credentialPins"] = {};

/** 精致圆环进度条：底圈轨道 + 圆角进度弧；`autoAt`（0–100）在圆环内侧画一道自动压缩触发刻度。 */
function Ring({ percent, autoAt = null }: { percent: number; autoAt?: number | null }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = (clamped / 100) * ringLength;
  const center = ringSize / 2;
  return (
    <svg
      className="usage-ring"
      width={ringSize}
      height={ringSize}
      viewBox={`0 0 ${ringSize} ${ringSize}`}
      aria-hidden="true"
    >
      <circle className="usage-ring-track" cx={center} cy={center} r={ringRadius} />
      {filled > 0.25 && (
        <circle
          className="usage-ring-fill"
          cx={center}
          cy={center}
          r={ringRadius}
          strokeDasharray={`${filled} ${ringLength}`}
          transform={`rotate(-90 ${center} ${center})`}
        />
      )}
      {autoAt !== null && (
        <line
          className="usage-ring-tick"
          data-testid="context-ring-tick"
          data-at={autoAt}
          x1={center}
          y1={center - ringRadius - 0.5}
          x2={center}
          y2={center - ringRadius + 2}
          transform={`rotate(${(Math.min(100, Math.max(0, autoAt)) / 100) * 360} ${center} ${center})`}
        />
      )}
    </svg>
  );
}

const contextWidth = 320;
const usageWidth = 300;

function ContextButton({
  context,
  task,
  provider = null,
  speed = null,
  children,
}: {
  context: NonNullable<TaskState["contextUsage"]>;
  task?: TaskState;
  provider?: string | null;
  speed?: Speed | null;
  children: ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hoverCloseTimer = useRef<number | undefined>(undefined);
  const usageDialogOpen = useUsageDialogOpen();
  const effectiveProvider = task?.model?.key.provider ?? provider;
  const subscription = useSubscription(effectiveProvider);
  const usage = useModelUsage(task, open);

  // 斜杠命令 /context：打开上下文构成。
  useEffect(() => onStudioCommand((command) => command === "context" && setOpen(true)), []);
  useEffect(() => () => window.clearTimeout(hoverCloseTimer.current), []);

  const openHover = () => {
    window.clearTimeout(hoverCloseTimer.current);
    setHovered(true);
  };
  const closeHoverSoon = () => {
    window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = window.setTimeout(() => setHovered(false), 120);
  };

  const close = () => setOpen(false);
  const label = t("composer.context", { p: formatPercent(context.percent) });
  const expanded = task !== undefined && (hasModelUsage(usage) || speed !== null);
  const autoAt = task?.contextCompaction?.autoAtPercent ?? null;
  const pctRounded = Math.max(0, Math.round(context.percent));
  const pctBadge = `${pctRounded}%`;
  const isWarn = context.percent >= 75 && context.percent < 90;
  const isHigh = context.percent >= 90;

  const sessionUsage = task?.sessionUsage ?? null;
  const turns = sessionUsage?.requests ?? 0;
  const inTok = sessionUsage?.tokens.input ?? 0;
  const outTok = sessionUsage?.tokens.output ?? 0;
  const cacheRead = sessionUsage?.tokens.cacheRead ?? 0;
  const cacheWrite = sessionUsage?.tokens.cacheWrite ?? 0;
  const totalTok = sessionUsage?.tokens.total ?? inTok + outTok + cacheRead + cacheWrite;
  const promptTotal = inTok + cacheRead + cacheWrite;
  const hitPct = promptTotal > 0 && cacheRead > 0 ? Math.round((cacheRead / promptTotal) * 100) : null;
  const cost = sessionUsage?.cost ?? 0;
  const subagentCost = sessionUsage?.subagentCost ?? 0;

  return (
    <div className="ui-popover-anchor usage-context-anchor" onMouseEnter={openHover} onMouseLeave={closeHoverSoon}>
      <button
        type="button"
        className="usage-context"
        data-pct-label={pctBadge}
        data-warn={isWarn || undefined}
        data-high={isHigh || undefined}
        data-testid="context-meter"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onFocus={openHover}
        onBlur={closeHoverSoon}
        onClick={() => {
          setHovered(false);
          if (open) close();
          else setOpen(true);
        }}
      >
        <Ring percent={context.percent} autoAt={autoAt} />
      </button>

      {hovered && !open && !usageDialogOpen && (
        <div
          className="ctx-hover-card"
          role="tooltip"
          data-warn={isWarn || undefined}
          data-high={isHigh || undefined}
          data-testid="context-hover-card"
        >
          <div className="ctx-hover-head">
            <span className="ctx-hover-title">{zh ? "上下文窗口" : "Context Window"}</span>
            <span className="ctx-hover-pct">
              {pctBadge} · {formatCount(context.tokens)} / {formatCount(context.contextWindow)}
            </span>
          </div>
          <div className="ctx-hover-bar">
            <span className="ctx-hover-bar-fill" style={{ width: `${Math.min(100, Math.max(0, context.percent))}%` }} />
          </div>
          <div className="ctx-hover-grid">
            <div className="ctx-hover-item">
              <span className="ctx-hover-label">{zh ? "对话轮数" : "Turns"}</span>
              <span className="ctx-hover-val">{zh ? `${turns} 轮` : `${turns}`}</span>
            </div>
            <div className="ctx-hover-item">
              <span className="ctx-hover-label">{zh ? "缓存命中率" : "Cache Hit"}</span>
              <span className="ctx-hover-val">{hitPct !== null ? `${hitPct}%` : "—"}</span>
            </div>
            <div className="ctx-hover-item">
              <span className="ctx-hover-label">{zh ? "Token 用量" : "Tokens"}</span>
              <span className="ctx-hover-val" title={`In ${formatCount(inTok)} · Out ${formatCount(outTok)}`}>
                {formatCount(totalTok)}
              </span>
            </div>
            <div className="ctx-hover-item">
              <span className="ctx-hover-label">{zh ? "累计开销" : "Cost"}</span>
              <span className="ctx-hover-val">
                {formatMoney(cost)}
                {subagentCost > 0 ? ` (+${formatMoney(subagentCost)})` : ""}
                {subscription ? " (sub)" : ""}
              </span>
            </div>
          </div>
          <div className="ctx-hover-foot">
            <span className="ctx-hover-hint">
              {autoAt !== null
                ? t("board.ctxAutoAt", { p: Math.round(autoAt) })
                : zh
                  ? "点击查看上下文构成"
                  : "Click for context breakdown"}
            </span>
            <button
              type="button"
              className="ctx-hover-usage-btn"
              onClick={(e) => {
                e.stopPropagation();
                setHovered(false);
                setUsageDialogOpen(true);
              }}
            >
              {zh ? "用量账单 ›" : "Usage ›"}
            </button>
          </div>
        </div>
      )}

      <Popover
        open={open}
        onClose={close}
        width={expanded ? contextWidth + usageWidth : contextWidth}
        align="end"
        label={label}
      >
        <div className="ctx-pop" data-expanded={expanded || undefined}>
          {expanded && task !== undefined && (
            <div className="ctx-pop-aside" data-testid="session-usage">
              <ModelBreakdown task={task} load={usage} speed={speed} />
            </div>
          )}
          <div className="ctx-pop-main">{children}</div>
        </div>
      </Popover>

      <UsageDialog
        provider={effectiveProvider}
        credentialPins={task?.credentialPins ?? noPins}
        open={usageDialogOpen}
        onClose={() => setUsageDialogOpen(false)}
      />
    </div>
  );
}

/** 还没有上下文数据时的占位圆环。 */
function ContextPlaceholder({ provider = null }: { provider?: string | null }) {
  const usageDialogOpen = useUsageDialogOpen();
  return (
    <span className="usage-context-anchor">
      <span className="usage-context" data-pending data-testid="context-meter-pending" aria-hidden="true">
        <Ring percent={0} />
      </span>
      <UsageDialog
        provider={provider}
        credentialPins={noPins}
        open={usageDialogOpen}
        onClose={() => setUsageDialogOpen(false)}
      />
    </span>
  );
}

/** 任务的合一上下文圆环指示器。 */
export function ContextMeter({ task }: { task: TaskState }) {
  const speed = useSpeed(task);
  const fallbackWindow = task.model?.contextWindow ?? null;
  const context =
    task.contextUsage ??
    (fallbackWindow !== null && fallbackWindow > 0 ? { tokens: 0, contextWindow: fallbackWindow, percent: 0 } : null);
  if (context === null) return <ContextPlaceholder provider={task.model?.key.provider ?? null} />;
  return (
    <ContextButton context={context} task={task} provider={task.model?.key.provider ?? null} speed={speed}>
      <TaskContextBreakdown key={`${task.id}:${context.tokens}`} taskId={task.id} context={context} task={task} />
    </ContextButton>
  );
}

/** 新任务草稿的合一上下文圆环指示器。 */
export function DraftContextMeter({ model, projectId }: { model: ModelOption | null; projectId: ProjectId | null }) {
  const windowSize = model?.contextWindow ?? null;
  useEffect(() => prefetchCompaction(projectId), [projectId]);
  if (windowSize === null || windowSize <= 0) return <ContextPlaceholder provider={model?.key.provider ?? null} />;
  return (
    <ContextButton
      context={{ tokens: 0, contextWindow: windowSize, percent: 0 }}
      provider={model?.key.provider ?? null}
    >
      <DraftContextBreakdown window={windowSize} modelKey={model?.key ?? null} projectId={projectId} />
    </ContextButton>
  );
}
