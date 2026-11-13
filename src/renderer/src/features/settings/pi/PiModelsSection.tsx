// Pi 模型页（models）：默认模型 + 7 档思考强度、常用模型池（/scoped-models · enabledModels）、思考预算与缓存预热、Studio 辅助模型。
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { helperThinkingLevels, type HelperThinking, type ModelOption } from "../../../../../shared/ipc.ts";
import { PI_THINKING_LEVELS, type PiThinkingLevel } from "../../../../../shared/pi-config-types.ts";
import { setAutoSmartRename, setHelperModel, setHelperThinking, useShellValue } from "../../../app/shell-store.ts";
import { Close, Restart, Search, Star } from "../../../icons.tsx";
import {
  Button,
  IconButton,
  Row,
  SectionHead,
  Segmented,
  Switch,
  TextField,
  type Option,
} from "../../../ui/controls.tsx";
import { reportError } from "../../../ui/errors.ts";
import { Select, type SelectOption } from "../../../ui/Select.tsx";
import { piBridge } from "./pi-bridge.ts";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  PiNumberCommitField,
  usePiSetting,
  usePiText,
} from "./pi-shared.tsx";

type CacheWarmingMode = "off" | "streaming" | "idle";

const asThinkingLevel = (raw: unknown, fallback: PiThinkingLevel): PiThinkingLevel =>
  typeof raw === "string" && (PI_THINKING_LEVELS as readonly string[]).includes(raw)
    ? (raw as PiThinkingLevel)
    : fallback;

const asCacheWarming = (raw: unknown, fallback: CacheWarmingMode): CacheWarmingMode =>
  raw === "off" || raw === "streaming" || raw === "idle" ? raw : fallback;

function modelKeyString(model: ModelOption): string {
  return `${model.key.provider}/${model.key.modelId}`;
}

export function PiModelsSection() {
  const { tr, t } = usePiText();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [poolQuery, setPoolQuery] = useState("");

  const loadModels = useCallback(
    async (refresh: boolean) => {
      setLoadingModels(true);
      try {
        const list = await piBridge().listModels(refresh);
        setModels(list);
      } catch (error) {
        reportError(t, error);
      } finally {
        setLoadingModels(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void loadModels(false);
  }, [loadModels]);

  // 1. 默认模型与思考强度
  const defaultProvider = usePiSetting("defaultProvider", "", asString);
  const defaultModel = usePiSetting("defaultModel", "", asString);
  const defaultThinking = usePiSetting<PiThinkingLevel>("defaultThinkingLevel", "medium", asThinkingLevel);

  const selectedDefaultKey =
    defaultProvider.value !== "" && defaultModel.value !== "" ? `${defaultProvider.value}/${defaultModel.value}` : "";

  const sortedModels = useMemo(
    () =>
      [...models].sort(
        (a, b) =>
          a.key.provider.localeCompare(b.key.provider) ||
          a.name.localeCompare(b.name) ||
          a.key.modelId.localeCompare(b.key.modelId),
      ),
    [models],
  );

  const defaultModelOptions = useMemo<SelectOption<string>[]>(() => {
    const opts: SelectOption<string>[] = [
      {
        value: "",
        label: tr("自动（按首个已认证 Provider）", "Auto (first authenticated provider)"),
      },
    ];
    let hasCurrent = selectedDefaultKey === "";
    for (const model of sortedModels) {
      const value = modelKeyString(model);
      if (value === selectedDefaultKey) hasCurrent = true;
      opts.push({
        value,
        label: model.name,
        note: model.key.modelId,
        display: `${model.key.provider} · ${model.name}`,
        group: model.key.provider,
      });
    }
    if (!hasCurrent && selectedDefaultKey !== "") {
      opts.splice(1, 0, {
        value: selectedDefaultKey,
        label: selectedDefaultKey,
        display: selectedDefaultKey,
      });
    }
    return opts;
  }, [sortedModels, selectedDefaultKey, tr]);

  const handleDefaultModelChange = async (next: string) => {
    if (next === "") {
      await defaultProvider.reset();
      await defaultModel.reset();
      return;
    }
    const slash = next.indexOf("/");
    if (slash <= 0) return;
    await defaultProvider.save(next.slice(0, slash));
    await defaultModel.save(next.slice(slash + 1));
  };

  const onThinkingKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const target = (index + step + PI_THINKING_LEVELS.length) % PI_THINKING_LEVELS.length;
    const next = PI_THINKING_LEVELS[target];
    if (next === undefined) return;
    void defaultThinking.save(next);
    event.currentTarget.parentElement?.querySelectorAll("button")[target]?.focus();
  };

  // 2. 常用模型池 (/scoped-models · enabledModels)
  const enabledModels = usePiSetting("enabledModels", [] as string[], asStringArray);
  const enabledSet = useMemo(() => new Set(enabledModels.value), [enabledModels.value]);

  const filteredPool = useMemo(() => {
    const needle = poolQuery.trim().toLowerCase();
    if (needle === "") return sortedModels;
    return sortedModels.filter((model) => {
      const full = modelKeyString(model).toLowerCase();
      return (
        full.includes(needle) ||
        model.name.toLowerCase().includes(needle) ||
        model.key.provider.toLowerCase().includes(needle)
      );
    });
  }, [sortedModels, poolQuery]);

  const toggleScopedModel = (fullKey: string) => {
    const next = enabledSet.has(fullKey)
      ? enabledModels.value.filter((item) => item !== fullKey)
      : [...enabledModels.value, fullKey];
    void enabledModels.save(next);
  };

  // 3. 思考预算与缓存预热
  const budgetMinimal = usePiSetting("thinkingBudgets.minimal", 1024, asNumber);
  const budgetLow = usePiSetting("thinkingBudgets.low", 2048, asNumber);
  const budgetMedium = usePiSetting("thinkingBudgets.medium", 8192, asNumber);
  const budgetHigh = usePiSetting("thinkingBudgets.high", 16384, asNumber);
  const hideThinkingBlock = usePiSetting("hideThinkingBlock", false, asBoolean);
  const cacheWarming = usePiSetting<CacheWarmingMode>("cacheWarming", "idle", asCacheWarming);
  const showCacheMissNotices = usePiSetting("showCacheMissNotices", false, asBoolean);

  const cacheWarmingOptions: readonly Option<CacheWarmingMode>[] = [
    { value: "off", label: tr("关闭", "Off") },
    { value: "streaming", label: tr("流式中", "Streaming") },
    { value: "idle", label: tr("空闲保活", "Idle") },
  ];

  // 4. Studio AI 辅助模型
  const autoSmartRename = useShellValue("autoSmartRename") ?? true;
  const helperModel = useShellValue("helperModel") ?? "current";
  const helperThinking = useShellValue("helperThinking") ?? "low";

  const helperModelOptions = useMemo<SelectOption<string>[]>(() => {
    const opts: SelectOption<string>[] = [
      { value: "current", label: tr("跟随当前会话模型", "Current session model") },
      { value: "default", label: tr("跟随默认模型", "Default model") },
    ];
    if (helperModel === "smol") {
      opts.push({ value: "smol", label: tr("轻量预设 (smol)", "Fast preset (smol)") });
    }
    let found = opts.some((item) => item.value === helperModel);
    for (const model of sortedModels) {
      const value = modelKeyString(model);
      if (value === helperModel) found = true;
      opts.push({
        value,
        label: model.name,
        note: model.key.modelId,
        display: `${model.key.provider} · ${model.name}`,
        group: model.key.provider,
      });
    }
    if (!found && helperModel !== "") {
      opts.push({ value: helperModel, label: helperModel });
    }
    return opts;
  }, [sortedModels, helperModel, tr]);

  const helperThinkingOptions: readonly Option<HelperThinking>[] = helperThinkingLevels.map((level) => ({
    value: level,
    label: level,
  }));

  return (
    <div className="pis-stack" data-testid="pi-models-section">
      {/* 1. 默认模型与思考强度 */}
      <section className="pis-group">
        <SectionHead
          title={tr("默认模型与思考强度", "Default model & thinking")}
          actions={
            <IconButton
              label={tr("刷新模型列表", "Refresh models")}
              disabled={loadingModels}
              onClick={() => void loadModels(true)}
              testId="pi-models-refresh"
            >
              <Restart />
            </IconButton>
          }
        />
        <div className="pis-card pis-card-rows">
          <Row
            label={tr("默认模型", "Default model")}
            modified={defaultProvider.modified || defaultModel.modified}
            reset={{
              tip: tr("恢复自动选择", "Reset to auto"),
              onReset: () => void handleDefaultModelChange(""),
            }}
            testId="pi-default-model-row"
          >
            {(labelId) => (
              <Select
                size="sm"
                width={300}
                value={selectedDefaultKey}
                options={defaultModelOptions}
                search={tr("搜索模型…", "Search models…")}
                labelledBy={labelId}
                onChange={(next) => void handleDefaultModelChange(next)}
                testId="pi-default-model"
              />
            )}
          </Row>
          <Row
            label={tr("默认思考强度", "Thinking level")}
            modified={defaultThinking.modified}
            reset={{
              tip: "medium",
              onReset: () => void defaultThinking.reset(),
            }}
            testId="pi-default-thinking-row"
          >
            {(labelId) => (
              <div
                role="radiogroup"
                className="pis-thinking-bar"
                aria-labelledby={labelId}
                data-testid="pi-thinking-bar"
              >
                {PI_THINKING_LEVELS.map((level, index) => (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    className="pis-thinking-step"
                    aria-checked={defaultThinking.value === level}
                    tabIndex={defaultThinking.value === level ? 0 : -1}
                    onClick={() => void defaultThinking.save(level)}
                    onKeyDown={(event) => onThinkingKeyDown(event, index)}
                    data-testid={`pi-thinking-${level}`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            )}
          </Row>
        </div>
      </section>

      {/* 2. 常用模型池 (/scoped-models · enabledModels) */}
      <section className="pis-group">
        <SectionHead
          title={tr("常用模型池", "Scoped models")}
          count={enabledModels.value.length > 0 ? enabledModels.value.length : tr("全部", "All")}
          note={tr("留空即包含全部已认证模型。", "Leave empty to include every authenticated model.")}
          actions={
            enabledModels.value.length > 0 ? (
              <Button size="sm" onClick={() => void enabledModels.save([])} testId="pi-scoped-clear">
                {tr("清空过滤", "Clear filter")}
              </Button>
            ) : undefined
          }
        />
        <div className="pis-card-padded">
          <div className="pis-scoped-toolbar">
            <TextField
              size="sm"
              width="100%"
              className="pis-scoped-search"
              leading={<Search size={14} />}
              value={poolQuery}
              onChange={setPoolQuery}
              placeholder={tr("筛选模型或 Provider（如 anthropic/claude）…", "Filter by model or provider…")}
              aria-label={tr("筛选常用模型", "Filter scoped models")}
              testId="pi-scoped-search"
            />
          </div>

          {enabledModels.value.length > 0 && (
            <div className="pis-selected-chips" data-testid="pi-scoped-chips">
              {enabledModels.value.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="pis-chip"
                  onClick={() => toggleScopedModel(item)}
                  title={tr("点击移出常用池", "Click to remove")}
                >
                  <span>{item}</span>
                  <Close size={11} />
                </button>
              ))}
            </div>
          )}

          {filteredPool.length === 0 ? (
            <p className="pis-muted">
              {models.length === 0
                ? tr(
                    "暂无已发现的模型，请先在「模型来源」配置 API Key 或登录。",
                    "No models discovered yet. Configure a provider first.",
                  )
                : tr("无匹配模型", "No matching models")}
            </p>
          ) : (
            <div className="pis-model-pool" data-testid="pi-scoped-pool">
              {filteredPool.map((model) => {
                const fullKey = modelKeyString(model);
                const selected = enabledSet.has(fullKey);
                return (
                  <button
                    key={fullKey}
                    type="button"
                    className="pis-model-item"
                    data-selected={selected || undefined}
                    aria-pressed={selected}
                    onClick={() => toggleScopedModel(fullKey)}
                  >
                    <span className="pis-model-star" aria-hidden="true">
                      <Star size={14} />
                    </span>
                    <span className="pis-model-text">
                      <span className="pis-model-name">{model.name}</span>
                      <span className="pis-model-id">{fullKey}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* 3. 思考预算与缓存预热 */}
      <section className="pis-group">
        <SectionHead title={tr("思考预算与缓存预热", "Thinking budgets & prompt cache")} />
        <div className="pis-card pis-card-rows">
          <div className="pis-budget-grid" data-testid="pi-thinking-budgets">
            <div className="pis-budget-cell">
              <span className="pis-budget-label">minimal</span>
              <PiNumberCommitField
                value={budgetMinimal.value}
                min={128}
                max={128000}
                unit="tok"
                width={116}
                label="minimal thinking budget"
                onCommit={(next) => void budgetMinimal.save(next)}
                testId="pi-budget-minimal"
              />
            </div>
            <div className="pis-budget-cell">
              <span className="pis-budget-label">low</span>
              <PiNumberCommitField
                value={budgetLow.value}
                min={128}
                max={128000}
                unit="tok"
                width={116}
                label="low thinking budget"
                onCommit={(next) => void budgetLow.save(next)}
                testId="pi-budget-low"
              />
            </div>
            <div className="pis-budget-cell">
              <span className="pis-budget-label">medium</span>
              <PiNumberCommitField
                value={budgetMedium.value}
                min={256}
                max={200000}
                unit="tok"
                width={116}
                label="medium thinking budget"
                onCommit={(next) => void budgetMedium.save(next)}
                testId="pi-budget-medium"
              />
            </div>
            <div className="pis-budget-cell">
              <span className="pis-budget-label">high</span>
              <PiNumberCommitField
                value={budgetHigh.value}
                min={256}
                max={200000}
                unit="tok"
                width={116}
                label="high thinking budget"
                onCommit={(next) => void budgetHigh.save(next)}
                testId="pi-budget-high"
              />
            </div>
          </div>

          <Row
            label={tr("隐藏思考过程折叠块", "Hide thinking blocks")}
            info={tr("仅 Pi CLI 生效，桌面端暂不读取。", "Pi CLI only; not yet applied in desktop UI.")}
            modified={hideThinkingBlock.modified}
            reset={{ tip: "false", onReset: () => void hideThinkingBlock.reset() }}
            testId="pi-hide-thinking-row"
          >
            {(labelId) => (
              <Switch
                checked={hideThinkingBlock.value}
                labelledBy={labelId}
                onChange={(next) => void hideThinkingBlock.save(next)}
                testId="pi-hide-thinking"
              />
            )}
          </Row>
          <Row
            label={tr("提示词缓存预热 (cacheWarming)", "Cache warming")}
            modified={cacheWarming.modified}
            reset={{ tip: "idle", onReset: () => void cacheWarming.reset() }}
            testId="pi-cache-warming-row"
          >
            {(labelId) => (
              <Segmented
                size="sm"
                mono
                value={cacheWarming.value}
                options={cacheWarmingOptions}
                labelledBy={labelId}
                onChange={(next) => void cacheWarming.save(next)}
                testId="pi-cache-warming"
              />
            )}
          </Row>
          <Row
            label={tr("显示缓存未命中提示", "Show cache-miss notices")}
            info={tr("仅 Pi CLI 生效，桌面端暂不读取。", "Pi CLI only; not yet applied in desktop UI.")}
            modified={showCacheMissNotices.modified}
            reset={{ tip: "false", onReset: () => void showCacheMissNotices.reset() }}
            testId="pi-cache-miss-row"
          >
            {(labelId) => (
              <Switch
                checked={showCacheMissNotices.value}
                labelledBy={labelId}
                onChange={(next) => void showCacheMissNotices.save(next)}
                testId="pi-cache-miss"
              />
            )}
          </Row>
        </div>
      </section>

      {/* 4. AI 辅助模型 (Studio) */}
      <section className="pis-group">
        <SectionHead
          title={tr("AI 辅助模型", "AI helper model")}
          note={tr("用于会话标题与提交说明生成。", "Used for session titles and commit message drafts.")}
        />
        <div className="pis-card pis-card-rows">
          <Row label={tr("新对话自动智能命名", "Auto smart title")} testId="pi-helper-rename-row">
            {(labelId) => (
              <Switch
                checked={autoSmartRename}
                labelledBy={labelId}
                onChange={setAutoSmartRename}
                testId="pi-helper-rename"
              />
            )}
          </Row>
          <Row label={tr("辅助任务模型", "Helper model")} testId="pi-helper-model-row">
            {(labelId) => (
              <Select
                size="sm"
                width={260}
                value={helperModel}
                options={helperModelOptions}
                search={tr("搜索模型…", "Search models…")}
                labelledBy={labelId}
                onChange={setHelperModel}
                testId="pi-helper-model"
              />
            )}
          </Row>
          <Row label={tr("辅助思考强度", "Helper thinking")} testId="pi-helper-thinking-row">
            {(labelId) => (
              <Segmented
                size="sm"
                mono
                value={helperThinking}
                options={helperThinkingOptions}
                labelledBy={labelId}
                onChange={setHelperThinking}
                testId="pi-helper-thinking"
              />
            )}
          </Row>
        </div>
      </section>
    </div>
  );
}
