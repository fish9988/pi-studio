// Pi 通用页交互卡片（general）：消息队列投递策略、双击 Esc 行为、会话树默认筛选、项目信任策略与 Shell 前缀。
import { Row, SectionHead, Segmented, type Option } from "../../../ui/controls.tsx";
import { Select, type SelectOption } from "../../../ui/Select.tsx";
import { asString, PiTextCommitField, usePiSetting, usePiText } from "./pi-shared.tsx";

type QueueDeliveryMode = "one-at-a-time" | "all";
type DoubleEscapeAction = "tree" | "fork" | "none";
type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
type ProjectTrustPolicy = "ask" | "always" | "never";

const asQueueMode = (raw: unknown, fallback: QueueDeliveryMode): QueueDeliveryMode =>
  raw === "one-at-a-time" || raw === "all" ? raw : fallback;

const asDoubleEsc = (raw: unknown, fallback: DoubleEscapeAction): DoubleEscapeAction =>
  raw === "tree" || raw === "fork" || raw === "none" ? raw : fallback;

const asTreeFilter = (raw: unknown, fallback: TreeFilterMode): TreeFilterMode =>
  raw === "default" || raw === "no-tools" || raw === "user-only" || raw === "labeled-only" || raw === "all"
    ? raw
    : fallback;

const asTrustPolicy = (raw: unknown, fallback: ProjectTrustPolicy): ProjectTrustPolicy =>
  raw === "ask" || raw === "always" || raw === "never" ? raw : fallback;

export function PiInteractionCard() {
  const { tr } = usePiText();

  const steeringMode = usePiSetting<QueueDeliveryMode>("steeringMode", "one-at-a-time", asQueueMode);
  const followUpMode = usePiSetting<QueueDeliveryMode>("followUpMode", "one-at-a-time", asQueueMode);
  const doubleEscapeAction = usePiSetting<DoubleEscapeAction>("doubleEscapeAction", "tree", asDoubleEsc);
  const treeFilterMode = usePiSetting<TreeFilterMode>("treeFilterMode", "default", asTreeFilter);
  const defaultProjectTrust = usePiSetting<ProjectTrustPolicy>("defaultProjectTrust", "ask", asTrustPolicy);
  const shellCommandPrefix = usePiSetting("shellCommandPrefix", "", asString);

  const queueOptions: readonly Option<QueueDeliveryMode>[] = [
    { value: "one-at-a-time", label: tr("逐条投递", "One at a time") },
    { value: "all", label: tr("合并投递", "All at once") },
  ];

  const doubleEscOptions: readonly Option<DoubleEscapeAction>[] = [
    { value: "tree", label: tr("会话树 (/tree)", "Tree") },
    { value: "fork", label: tr("分叉 (/fork)", "Fork") },
    { value: "none", label: tr("无动作", "None") },
  ];

  const treeFilterOptions: readonly SelectOption<TreeFilterMode>[] = [
    { value: "default", label: tr("默认视图 (default)", "Default") },
    { value: "no-tools", label: tr("隐藏工具调用 (no-tools)", "Hide tools") },
    { value: "user-only", label: tr("仅用户消息 (user-only)", "User messages only") },
    { value: "labeled-only", label: tr("仅带标签节点 (labeled-only)", "Labeled nodes only") },
    { value: "all", label: tr("全部事件节点 (all)", "All entries") },
  ];

  const trustOptions: readonly Option<ProjectTrustPolicy>[] = [
    { value: "ask", label: tr("询问", "Ask") },
    { value: "always", label: tr("始终信任", "Always") },
    { value: "never", label: tr("从不信任", "Never") },
  ];

  return (
    <section className="pis-group" data-testid="pi-interaction-card">
      <SectionHead title={tr("Pi 会话交互与信任策略", "Pi interaction & project trust")} />
      <div className="pis-card pis-card-rows">
        <Row
          label={tr("运行中插话模式 (steeringMode)", "Steering delivery")}
          modified={steeringMode.modified}
          reset={{ tip: "one-at-a-time", onReset: () => void steeringMode.reset() }}
          testId="pi-steering-mode-row"
        >
          {(labelId) => (
            <Segmented
              size="sm"
              value={steeringMode.value}
              options={queueOptions}
              labelledBy={labelId}
              onChange={(next) => void steeringMode.save(next)}
              testId="pi-steering-mode"
            />
          )}
        </Row>

        <Row
          label={tr("跟进队列投递 (followUpMode)", "Follow-up queue")}
          modified={followUpMode.modified}
          reset={{ tip: "one-at-a-time", onReset: () => void followUpMode.reset() }}
          testId="pi-followup-mode-row"
        >
          {(labelId) => (
            <Segmented
              size="sm"
              value={followUpMode.value}
              options={queueOptions}
              labelledBy={labelId}
              onChange={(next) => void followUpMode.save(next)}
              testId="pi-followup-mode"
            />
          )}
        </Row>

        <Row
          label={tr("双击 Esc 动作 (doubleEscapeAction)", "Double-Escape action")}
          modified={doubleEscapeAction.modified}
          reset={{ tip: "tree", onReset: () => void doubleEscapeAction.reset() }}
          testId="pi-double-esc-row"
        >
          {(labelId) => (
            <Segmented
              size="sm"
              value={doubleEscapeAction.value}
              options={doubleEscOptions}
              labelledBy={labelId}
              onChange={(next) => void doubleEscapeAction.save(next)}
              testId="pi-double-esc"
            />
          )}
        </Row>

        <Row
          label={tr("会话树默认过滤 (treeFilterMode)", "Session tree filter")}
          modified={treeFilterMode.modified}
          reset={{ tip: "default", onReset: () => void treeFilterMode.reset() }}
          testId="pi-tree-filter-row"
        >
          {(labelId) => (
            <Select
              size="sm"
              width={220}
              value={treeFilterMode.value}
              options={treeFilterOptions}
              labelledBy={labelId}
              onChange={(next) => void treeFilterMode.save(next)}
              testId="pi-tree-filter"
            />
          )}
        </Row>

        <Row
          label={tr("项目配置信任策略 (defaultProjectTrust)", "Project config trust")}
          modified={defaultProjectTrust.modified}
          reset={{ tip: "ask", onReset: () => void defaultProjectTrust.reset() }}
          testId="pi-project-trust-row"
        >
          {(labelId) => (
            <Segmented
              size="sm"
              value={defaultProjectTrust.value}
              options={trustOptions}
              labelledBy={labelId}
              onChange={(next) => void defaultProjectTrust.save(next)}
              testId="pi-project-trust"
            />
          )}
        </Row>

        <Row
          label={tr("Shell 命令前缀 (shellCommandPrefix)", "Shell command prefix")}
          modified={shellCommandPrefix.modified}
          reset={{ tip: tr("空", "Empty"), onReset: () => void shellCommandPrefix.reset() }}
          testId="pi-shell-prefix-row"
        >
          {(labelId) => (
            <PiTextCommitField
              mono
              width={240}
              value={shellCommandPrefix.value}
              placeholder="shopt -s expand_aliases;"
              labelledBy={labelId}
              onCommit={(next) => void shellCommandPrefix.save(next)}
              testId="pi-shell-prefix"
            />
          )}
        </Row>
      </div>
    </section>
  );
}
