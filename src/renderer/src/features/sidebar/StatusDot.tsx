// 极简侧栏状态点（DSH 低噪点规范）：
// - 历史已完成会话与空闲正常完成会话左侧不画任何圆点（彻底清除空心圆圈、刺眼绿勾与红叉）；
// - 运行中会话的左侧槽位同样折叠为 0 宽，活动指示改由行尾四点动画承担，标题左右零跳动；
// - 仅在待确认（waiting）的会话旁渲染极柔和呼吸小圆点；
// - 失败/中断仅保留极低对比度的微缩小点，不抢占标题视觉重心。
import type { TFunction } from "../../../../shared/i18n/index.ts";
import type { SessionSummary, TaskState } from "../../../../shared/ipc.ts";
import { dotKind, sessionDotKind, type DotKind } from "../../../../shared/ui/sidebar-model.ts";

type Kind = Exclude<DotKind, "none" | "done" | "running">;

function Glyph({ kind }: { kind: Kind }) {
  switch (kind) {
    case "waiting":
      return (
        <>
          <circle className="sb-dot-soft-halo" cx="8" cy="8" r="5.2" />
          <circle className="sb-dot-fill" cx="8" cy="8" r="2.8" />
        </>
      );
    case "error":
      return <circle className="sb-dot-fill" cx="8" cy="8" r="2.2" />;
    case "interrupted":
      return <circle className="sb-dot-ring" cx="8" cy="8" r="2.4" />;
    default:
      return null;
  }
}

/** 把所有挂载的四点动画 startTime 钉在 0，保证多个运行中会话的四点严格同相。 */
function syncFourDots(element: HTMLSpanElement | null): void {
  if (element === null) return;
  const pin = () => {
    const animatable = element as { getAnimations?: Element["getAnimations"] };
    for (const anim of animatable.getAnimations?.({ subtree: true }) ?? []) {
      if ("animationName" in anim && anim.animationName === "sb-four-dot-pulse") {
        anim.startTime = 0;
      }
    }
  };
  pin();
  element.addEventListener("animationstart", pin);
}

/** 2×2 四点交互动效：运行中会话的活动指示（md 用于任务行尾，sm 用于紧凑位置）。 */
export function RunningFourDots({
  label,
  size = "md",
  active = true,
}: {
  label?: string | undefined;
  size?: "md" | "sm" | undefined;
  active?: boolean | undefined;
}) {
  const className =
    size === "sm"
      ? `sb-four-dots sb-four-dots-sm${active ? "" : " sb-four-dots-idle"}`
      : "sb-dot sb-dot-running sb-four-dots";
  return (
    <span
      ref={active ? syncFourDots : undefined}
      className={className}
      data-active={active || undefined}
      data-testid={size === "md" ? "status-loading-spinner" : undefined}
      role={label !== undefined ? "img" : undefined}
      aria-label={label}
      aria-hidden={label === undefined ? "true" : undefined}
    >
      <span className="sb-four-dot" data-agent-state-dot={active ? "" : undefined} />
      <span className="sb-four-dot" data-agent-state-dot={active ? "" : undefined} />
      <span className="sb-four-dot" data-agent-state-dot={active ? "" : undefined} />
      <span className="sb-four-dot" data-agent-state-dot={active ? "" : undefined} />
    </span>
  );
}

/** 按状态画极简圆点；已完成、空闲与运行中完全折叠为 0 宽，使会话标题干净左对齐。 */
function StatusMark({ kind, label, title }: { kind: DotKind; label: string; title?: string }) {
  if (kind === "none" || kind === "done" || kind === "running") {
    return <span key="none" className="sb-dot sb-dot-none" aria-hidden="true" />;
  }
  return (
    <span key={kind} className={`sb-dot sb-dot-${kind}`} role="img" aria-label={label} title={title}>
      <svg className="sb-dot-mark" viewBox="0 0 16 16" aria-hidden="true">
        <Glyph kind={kind} />
      </svg>
    </span>
  );
}

export function StatusDot({ task, t }: { task: TaskState; t: TFunction }) {
  const kind = dotKind(task);
  const label =
    kind === "running"
      ? t("status.running")
      : kind === "waiting"
        ? t("status.waiting")
        : kind === "done"
          ? t("status.done")
          : t("status.error");
  return <StatusMark kind={kind} label={label} />;
}

/** 历史会话：已完成不画任何图标，仅中断或异常留微弱标识。 */
export function SessionStatusDot({ session, t }: { session: SessionSummary; t: TFunction }) {
  const kind = sessionDotKind(session);
  if (kind === "interrupted")
    return <StatusMark kind={kind} label={t("status.interrupted")} title={t("status.interrupted")} />;
  return <StatusMark kind={kind} label={kind === "error" ? t("status.error") : t("status.done")} />;
}
