// 模型选择对话框（ui/Dialog，适配 Pi /model 与 /scoped-models）：
// 顶上是搜索框；左栏是范围：全部模型 / 常用模型 (Scoped) / 各 Provider；
// 右边一张表（模型 | Int | t/s | Ctx | $/M + 星标收藏进 enabledModels）+ 参数行 + 7 档思考强度分段选择。
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useOpenKey, usePresence } from "../../ui/presence.ts";
import type { ModelInsights, ModelKey, ModelOption, ProjectId, TaskId } from "../../../../shared/ipc.ts";
import { clampThinkingLevel, thinkingLevelOptions } from "../../../../shared/ui/new-task-default.ts";
import type { ThinkingLevel } from "../../../../shared/omp-wire/rpc-wire.generated.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import { Check, ChevronRight, Plus, Search, Star } from "../../icons.tsx";
import { Button, IconButton, TextField } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { Popover } from "../../ui/Popover.tsx";
import { Skeleton } from "../../ui/Skeleton.tsx";
import { Reveal } from "../../ui/Reveal.tsx";
import { reportError } from "../../ui/errors.ts";
import { showView } from "../../store/index.ts";
import { ModelDetails } from "./ModelDetails.tsx";
import {
  groupModels,
  modelContextCell,
  modelItemId,
  modelPriceCell,
  pinnedKeys,
  providerCounts,
  sameModel,
} from "./model-groups.ts";
import type { SpeedControls } from "./SpeedToggle.tsx";
import { ThinkingSegments } from "./ThinkingSegments.tsx";
import type { ModelPickerRequest } from "./slash-args.ts";

const recentKey = "pi-studio.recentModels";
const missing = "–";
const loading = "…";

function readRecent(): ModelKey[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey) ?? "[]");
    return Array.isArray(parsed) ? (parsed as ModelKey[]).slice(0, 3) : [];
  } catch {
    return [];
  }
}

export interface ModelPickerProps {
  /** 正在生效的模型；表里它带勾，打开时选中的是它。 */
  model: ModelOption | null;
  thinkingLevel: ThinkingLevel | null;
  /** 正在生效的模型的档位（任务里含 off）。 */
  thinkingLevels: readonly ThinkingLevel[];
  running: boolean;
  /** 读压缩设置用哪个项目的配置；草稿里没有项目时为 null（只看全局）。 */
  projectId: ProjectId | null;
  loadModels(): Promise<ModelOption[]>;
  setModel(key: ModelKey): Promise<void>;
  setThinking(level: ThinkingLevel): Promise<void>;
  speed?: SpeedControls;
  taskId?: TaskId;
  onClose(): void;
  request?: ModelPickerRequest | null;
}

interface ModelItem {
  kind: "model";
  id: string;
  option: ModelOption;
}

type Scope = { kind: "all" } | { kind: "scoped" } | { kind: "provider"; provider: string };

const sameScope = (a: Scope, b: Scope) =>
  a.kind === b.kind && (a.kind !== "provider" || (b.kind === "provider" && a.provider === b.provider));

function matchesScopedPattern(pattern: string, fullId: string, modelId: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p === "") return false;
  const full = fullId.toLowerCase();
  const id = modelId.toLowerCase();
  if (p === full || p === id) return true;
  if (p.includes("*")) {
    const regex = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "i");
    return regex.test(full) || regex.test(id);
  }
  return false;
}

function ProviderBrandGlyph({ provider, modelId }: { provider: string; modelId: string }) {
  const lower = `${provider}/${modelId}`.toLowerCase();
  if (lower.includes("deepseek")) {
    return (
      <span className="dsh-model-brand" data-brand="deepseek" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M2.5 8.8c0-3.2 2.5-5.6 5.8-5.6 2.4 0 4.4 1.3 5.2 3.3-.8-.3-1.7-.2-2.4.3-.7-.8-1.7-1.3-2.8-1.3-2.1 0-3.8 1.6-3.8 3.6 0 1.4.8 2.6 2 3.2-2.3-.2-4-1.7-4-3.5Z"
            fill="currentColor"
          />
          <circle cx="10.8" cy="7.5" r="1.1" fill="currentColor" />
        </svg>
      </span>
    );
  }
  if (lower.includes("claude") || lower.includes("anthropic")) {
    return (
      <span className="dsh-model-brand" data-brand="claude" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <path d="M8 2.2v11.6M2.2 8h11.6M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2" />
        </svg>
      </span>
    );
  }
  if (lower.includes("gemini") || lower.includes("google")) {
    return (
      <span className="dsh-model-brand" data-brand="gemini" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 1.6C8.5 5.1 10.9 7.5 14.4 8 10.9 8.5 8.5 10.9 8 14.4 7.5 10.9 5.1 8.5 1.6 8 5.1 7.5 7.5 5.1 8 1.6Z"
            fill="currentColor"
          />
        </svg>
      </span>
    );
  }
  if (
    lower.includes("gpt") ||
    lower.includes("openai") ||
    lower.includes("o1") ||
    lower.includes("o3") ||
    lower.includes("o4")
  ) {
    return (
      <span className="dsh-model-brand" data-brand="openai" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="8" cy="8" r="5.2" />
          <circle cx="8" cy="8" r="2" />
        </svg>
      </span>
    );
  }
  return (
    <span className="dsh-model-brand" data-brand="default" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="2.5" y="2.5" width="11" height="11" rx="3" />
        <circle cx="8" cy="8" r="2" fill="currentColor" />
      </svg>
    </span>
  );
}

function describeModelSubtitle(option: ModelOption, zh: boolean): string {
  const lower = `${option.key.provider}/${option.key.modelId} ${option.name}`.toLowerCase();
  const ctx = modelContextCell(option);
  const ctxSuffix = ctx ? ` · ${ctx}` : "";
  if (lower.includes("opus") || lower.includes("pro") || lower.includes("r1") || lower.includes("reasoner")) {
    return (zh ? "深度推理旗舰模型，适合复杂架构与分析" : "Flagship reasoning model for complex tasks") + ctxSuffix;
  }
  if (lower.includes("haiku") || lower.includes("flash") || lower.includes("mini") || lower.includes("lite")) {
    return (zh ? "轻量高速模型，适合快速问答与辅助任务" : "Fast lightweight model for quick tasks") + ctxSuffix;
  }
  if (option.reasoning) {
    return (
      (zh ? "旗舰模型，支持深度思考，适合日常编码与使用" : "Flagship reasoning model for daily coding") + ctxSuffix
    );
  }
  return (zh ? "通用高效模型，适合日常对话与代码生成" : "Versatile model for daily chat & coding") + ctxSuffix;
}

function ModelPickerBody(props: ModelPickerProps & { open: boolean }) {
  const { model, thinkingLevel, running, onClose, open } = props;
  const t = useT();
  const locale = useLocale();
  const zh = locale === "zh-CN";
  const listId = useId();
  const tableRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const dialog = sideRef.current?.closest<HTMLElement>(".mp-dialog");
    if (!dialog) return;
    let tallest = 0;
    const observer = new ResizeObserver(() => {
      const height = dialog.offsetHeight;
      if (height <= tallest) return;
      tallest = height;
      dialog.style.minHeight = `min(${height}px, 84vh, var(--content-w-min))`;
    });
    observer.observe(dialog);
    return () => observer.disconnect();
  }, []);

  const searchRef = useRef<HTMLInputElement>(null);
  const [viewMode, setViewMode] = useState<"popover" | "dialog">(
    props.request?.scope === "roles" ? "dialog" : "popover",
  );
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [insights, setInsights] = useState<ModelInsights | null>(null);
  const [enabledPatterns, setEnabledPatterns] = useState<string[]>([]);
  const [query, setQuery] = useState(props.request?.query ?? "");
  const [scope, setScope] = useState<Scope>(props.request?.scope === "roles" ? { kind: "scoped" } : { kind: "all" });
  const [selection, setSelection] = useState<string | null>(null);
  const firstClick = useRef<string | null>(null);
  const [pickedLevel, setPickedLevel] = useState<ThinkingLevel | null>(null);
  const [pinned, setPinned] = useState<ModelKey[] | null>(null);
  const report = useCallback((error: unknown) => reportError(t, error), [t]);

  useEffect(() => {
    let current = true;
    window.studio
      .getOmpConfig()
      .then((snap) => {
        if (!current) return;
        const item = snap.items.find((entry) => entry.key === "enabledModels");
        const val = item?.hasValue ? item.value : [];
        if (Array.isArray(val)) {
          setEnabledPatterns(val.filter((entry): entry is string => typeof entry === "string"));
        }
      })
      .catch(() => {});

    props.loadModels().then(
      (list) => {
        if (!current) return;
        setModels(list);
        window.studio
          .getModelInsights(
            props.projectId,
            list.map((option) => option.key),
          )
          .then(
            (value) => current && setInsights(value),
            (error: unknown) => {
              if (current) setInsights({ perf: {}, compaction: null });
              report(error);
            },
          );
      },
      (error: unknown) => {
        if (current) setModels([]);
        report(error);
      },
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isScopedModel = useCallback(
    (option: ModelOption): boolean => {
      const fullId = `${option.key.provider}/${option.key.modelId}`;
      return enabledPatterns.some((pat) => matchesScopedPattern(pat, fullId, option.key.modelId));
    },
    [enabledPatterns],
  );

  const toggleScopedModel = useCallback(
    (option: ModelOption) => {
      const fullId = `${option.key.provider}/${option.key.modelId}`;
      const currentlyScoped = enabledPatterns.some((pat) => matchesScopedPattern(pat, fullId, option.key.modelId));
      const next = currentlyScoped
        ? enabledPatterns.filter(
            (pat) =>
              pat.trim().toLowerCase() !== fullId.toLowerCase() &&
              pat.trim().toLowerCase() !== option.key.modelId.toLowerCase(),
          )
        : [...enabledPatterns, fullId];
      setEnabledPatterns(next);
      window.studio.setOmpConfig("enabledModels", JSON.stringify(next)).catch(report);
    },
    [enabledPatterns, report],
  );

  const scopedModels = useMemo(() => (models ?? []).filter(isScopedModel), [models, isScopedModel]);

  useEffect(() => {
    if (pinned === null && models !== null) {
      setPinned(pinnedKeys(model?.key ?? null, scopedModels.slice(0, 5), readRecent()));
    }
  }, [pinned, models, model, scopedModels]);

  const searching = query.trim() !== "";
  const providers = useMemo(() => providerCounts(models ?? []), [models]);
  const activeModel = model;
  const scopeProvider = scope.kind === "provider" ? scope.provider : null;

  const rows = useMemo(() => {
    const baseList = scope.kind === "scoped" ? scopedModels : (models ?? []);
    return groupModels(baseList, query, scope.kind === "scoped" ? [] : (pinned ?? []), scopeProvider);
  }, [scope.kind, scopedModels, models, query, pinned, scopeProvider]);

  const collapsible = scope.kind === "all" && !searching;
  const [openProviders, setOpenProviders] = useState<ReadonlySet<string>>(new Set());
  const activeProvider = activeModel?.key.provider ?? null;
  useEffect(() => {
    if (activeProvider !== null) {
      setOpenProviders((prev) => (prev.has(activeProvider) ? prev : new Set([...prev, activeProvider])));
    }
  }, [activeProvider]);

  const toggleProvider = (provider: string) => {
    const next = new Set(openProviders);
    if (!next.delete(provider)) next.add(provider);
    setOpenProviders(next);
  };

  const shownRows = useMemo(
    () =>
      collapsible
        ? [...rows.pinned, ...rows.rest.filter((option) => openProviders.has(option.key.provider))]
        : rows.flat,
    [collapsible, rows, openProviders],
  );

  const items = useMemo<ModelItem[]>(
    () => shownRows.map((option) => ({ kind: "model", id: modelItemId(option.key), option })),
    [shownRows],
  );

  const currentId = activeModel ? modelItemId(activeModel.key) : null;
  const selectedItem = items.find((item) => item.id === (selection ?? currentId)) ?? items[0] ?? null;
  const selectedId = selectedItem?.id ?? null;
  const shown = selectedItem?.option ?? null;

  useEffect(() => {
    tableRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const levelsOf = (option: ModelOption): readonly ThinkingLevel[] => {
    if (model !== null && sameModel(option.key, model.key)) return props.thinkingLevels;
    const efforts = thinkingLevelOptions(option, []);
    return efforts.length > 0 && props.thinkingLevels.includes("off") ? ["off", ...efforts] : efforts;
  };

  const levelIn = (levels: readonly ThinkingLevel[]): ThinkingLevel | null => {
    const wanted = pickedLevel ?? thinkingLevel;
    if (wanted === null || levels.length === 0) return null;
    return levels.includes(wanted) ? wanted : clampThinkingLevel(wanted, levels);
  };

  const shownLevels = shown === null ? [] : levelsOf(shown);
  const shownLevel = levelIn(shownLevels);

  const selectScope = (next: Scope) => {
    setScope(next);
    setSelection(null);
  };

  const apply = (item: ModelItem | null) => {
    if (item === null) return;
    const option = item.option;
    onClose();
    localStorage.setItem(
      recentKey,
      JSON.stringify([option.key, ...readRecent().filter((key) => !sameModel(key, option.key))].slice(0, 3)),
    );
    const switching = activeModel === null || !sameModel(option.key, activeModel.key);
    const level = pickedLevel === null ? null : levelIn(levelsOf(option));
    let done = switching ? props.setModel(option.key) : Promise.resolve();
    if (level !== null && (switching || level !== thinkingLevel)) done = done.then(() => props.setThinking(level));
    done.catch(report);
  };

  const move = (delta: number) => {
    if (items.length === 0) return;
    const index = selectedItem ? items.indexOf(selectedItem) : -1;
    const next = items[Math.min(Math.max(index + delta, 0), items.length - 1)];
    if (next) setSelection(next.id);
  };

  const onSearchKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && !(event.nativeEvent.isComposing || event.keyCode === 229)) {
      event.preventDefault();
      apply(selectedItem);
    }
  };

  const total =
    scope.kind === "scoped"
      ? scopedModels.length
      : scopeProvider === null
        ? (models?.length ?? 0)
        : (providers.find((entry) => entry.provider === scopeProvider)?.count ?? 0);
  const matched = rows.flat.length;

  const numbers = (option: ModelOption) => {
    const fullKey = `${option.key.provider}/${option.key.modelId}`;
    const measured = insights?.perf[fullKey]?.tokensPerSecond;
    const tps = measured ?? option.catalogTps ?? null;
    const cell = (value: string | null) => value ?? missing;
    return {
      intelligence: option.intelligence === null ? missing : String(Math.round(option.intelligence)),
      speed: tps !== null ? String(Math.round(tps)) : insights === null ? loading : missing,
      context: cell(modelContextCell(option)),
      price: cell(modelPriceCell(option)),
    };
  };

  const renderItem = (item: ModelItem): ReactNode => {
    const isSelected = item.id === selectedId;
    const isCurrent = activeModel !== null && sameModel(activeModel.key, item.option.key);
    const starred = isScopedModel(item.option);
    const cells = numbers(item.option);
    return (
      <div
        key={item.id}
        id={`${listId}${item.id}`}
        role="option"
        aria-selected={isSelected}
        className="mp-row"
        data-testid="model-option"
        data-current={isCurrent || undefined}
        title={`${item.option.name}\n${item.option.key.provider}/${item.option.key.modelId}`}
        onClick={(event) => {
          if (event.detail <= 1) firstClick.current = item.id;
          if (firstClick.current === item.id) setSelection(item.id);
        }}
        onDoubleClick={() => firstClick.current === item.id && apply(item)}
        onMouseDown={(event) => event.preventDefault()}
      >
        <span className="mp-cell-model">
          <IconButton
            label={
              starred
                ? zh
                  ? "移出常用模型 (enabledModels)"
                  : "Remove from scoped models"
                : zh
                  ? "加入常用模型 (enabledModels)"
                  : "Add to scoped models"
            }
            pressed={starred}
            testId="model-scoped-star"
            onClick={(event) => {
              event.stopPropagation();
              toggleScopedModel(item.option);
            }}
          >
            <Star size={12} fill={starred ? "currentColor" : "none"} />
          </IconButton>
          <span className="mp-id">
            <span className="mp-id-dim">{item.option.key.provider}/</span>
            <span className="mp-id-name">{item.option.key.modelId}</span>
          </span>
        </span>
        <span className="mp-num" data-testid="model-intelligence">
          {cells.intelligence}
        </span>
        <span className="mp-num" data-testid="model-speed">
          {cells.speed}
        </span>
        <span className="mp-num">{cells.context}</span>
        <span className="mp-num">{cells.price}</span>
        <span className="mp-tick">{isCurrent && <Check size={14} />}</span>
      </div>
    );
  };

  const renderGroup = (key: string, label: string, list: readonly ModelItem[]) => (
    <div role="group" aria-label={label} key={key}>
      <p className="mp-group" aria-hidden="true">
        {label} <span className="mp-group-count">{list.length}</span>
      </p>
      {list.map(renderItem)}
    </div>
  );

  const providerGroups = () => {
    const groups = new Map<string, ModelItem[]>();
    for (const option of rows.rest) {
      const item: ModelItem = { kind: "model", id: modelItemId(option.key), option };
      groups.set(option.key.provider, [...(groups.get(option.key.provider) ?? []), item]);
    }
    return [...groups].map(([provider, list]) => {
      if (!collapsible) return renderGroup(`p:${provider}`, provider, list);
      const expanded = openProviders.has(provider);
      return (
        <div role="group" aria-label={provider} key={`p:${provider}`}>
          <button
            type="button"
            className="mp-group mp-group-toggle"
            aria-expanded={expanded}
            data-testid="model-provider-group"
            data-provider={provider}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => toggleProvider(provider)}
          >
            <ChevronRight size={14} />
            {provider} <span className="mp-group-count">{list.length}</span>
          </button>
          <Reveal open={expanded}>{list.map(renderItem)}</Reveal>
        </div>
      );
    });
  };

  const pinnedCount = searching || scope.kind === "scoped" ? 0 : rows.pinned.length;
  const groups = searching
    ? items.length === 0
      ? []
      : [renderGroup("matches", t("model.matches"), items)]
    : [
        ...(pinnedCount > 0 ? [renderGroup("pinned", t("model.pinned"), items.slice(0, pinnedCount))] : []),
        ...providerGroups(),
      ];

  const scopeButton = (entry: Scope, label: string, count: number, testId: string, dot = false) => (
    <button
      key={entry.kind === "provider" ? `p:${entry.provider}` : entry.kind}
      type="button"
      className="mp-scope"
      aria-current={sameScope(entry, scope) ? "true" : undefined}
      title={label}
      onClick={() => selectScope(entry)}
      data-testid={testId}
    >
      <span className="mp-scope-label">{label}</span>
      {dot && <span className="mp-scope-dot" aria-hidden="true" />}
      <span className="mp-scope-count">{count}</span>
    </button>
  );

  const popoverItems = useMemo<ModelItem[]>(() => {
    if (models === null) return [];
    if (searching) {
      return rows.flat.map((option) => ({ kind: "model", id: modelItemId(option.key), option }));
    }
    const base = scopedModels.length > 0 ? scopedModels : models;
    const grouped = groupModels(base, "", pinned ?? [], null);
    const ordered = [...grouped.pinned];
    for (const opt of grouped.rest) {
      if (!ordered.some((p) => sameModel(p.key, opt.key))) ordered.push(opt);
    }
    return ordered.map((option) => ({ kind: "model", id: modelItemId(option.key), option }));
  }, [models, searching, rows.flat, scopedModels, pinned]);

  const popoverSelected = popoverItems.find((item) => item.id === (selection ?? currentId)) ?? popoverItems[0] ?? null;

  const onPopoverSearchKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (popoverItems.length === 0) return;
      const idx = popoverSelected ? popoverItems.indexOf(popoverSelected) : -1;
      const next =
        popoverItems[Math.min(Math.max(idx + (event.key === "ArrowDown" ? 1 : -1), 0), popoverItems.length - 1)];
      if (next) setSelection(next.id);
    } else if (event.key === "Enter" && !(event.nativeEvent.isComposing || event.keyCode === 229)) {
      event.preventDefault();
      apply(popoverSelected);
    }
  };

  if (viewMode === "popover") {
    const providerBuckets = new Map<string, ModelItem[]>();
    for (const item of popoverItems) {
      const prov = item.option.key.provider;
      providerBuckets.set(prov, [...(providerBuckets.get(prov) ?? []), item]);
    }
    const bucketEntries = [...providerBuckets.entries()];

    return (
      <Popover open={open} onClose={onClose} width={336} align="end" label={t("model.title")}>
        <div className="dsh-model-popover" data-testid="model-picker">
          <div className="dsh-mp-search-wrap">
            <Search size={13} />
            <input
              ref={searchRef}
              type="search"
              className="dsh-mp-search"
              data-testid="model-search"
              data-autofocus=""
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded="true"
              aria-controls={listId}
              aria-label={t("model.search")}
              placeholder={zh ? "搜索模型…" : "Search models…"}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelection(null);
              }}
              onKeyDown={onPopoverSearchKey}
            />
          </div>
          <div id={listId} className="dsh-mp-list" role="listbox" aria-label={t("model.list")}>
            {models === null && (
              <div className="dsh-mp-loading">
                <Skeleton variant="row" count={4} height="44px" label={t("model.list")} testId="model-skeleton" />
              </div>
            )}
            {models !== null && popoverItems.length === 0 && (
              <p className="dsh-mp-empty" data-testid="model-empty">
                {searching ? t("model.noMatch") : t("model.empty")}
              </p>
            )}
            {bucketEntries.map(([prov, groupList], groupIdx) => (
              <div key={prov} className="dsh-mp-group" role="group" aria-label={prov}>
                {groupIdx > 0 && <div className="dsh-mp-divider" aria-hidden="true" />}
                {bucketEntries.length >= 1 && <div className="dsh-mp-group-title">{prov}</div>}
                {groupList.map((item) => {
                  const isCurrent = activeModel !== null && sameModel(activeModel.key, item.option.key);
                  const isSelected = item.id === popoverSelected?.id;
                  const displayName = item.option.name || item.option.key.modelId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className="dsh-mp-item"
                      data-testid="model-option"
                      data-current={isCurrent || undefined}
                      title={`${displayName} (${item.option.key.provider}/${item.option.key.modelId})`}
                      onMouseEnter={() => setSelection(item.id)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => apply(item)}
                    >
                      <ProviderBrandGlyph provider={item.option.key.provider} modelId={item.option.key.modelId} />
                      <span className="dsh-mp-item-main">
                        <span className="dsh-mp-item-name">{displayName}</span>
                        <span className="dsh-mp-item-desc">{describeModelSubtitle(item.option, zh)}</span>
                      </span>
                      <span className="dsh-mp-item-check" aria-hidden="true">
                        {isCurrent && <Check size={15} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="dsh-mp-footer">
            <button
              type="button"
              className="dsh-mp-more-btn"
              data-testid="model-popover-more"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setViewMode("dialog")}
            >
              <span>{zh ? "更多模型" : "More models"}</span>
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </Popover>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      className="mp-dialog"
      testId="model-picker"
      title={t("model.title")}
      head={
        <div className="mp-head">
          <TextField
            ref={searchRef}
            width="100%"
            testId="model-search"
            data-autofocus=""
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={selectedId === null ? undefined : `${listId}${selectedId}`}
            aria-label={t("model.search")}
            placeholder={t("model.search")}
            leading={<Search size={14} />}
            value={query}
            onChange={(next) => {
              setQuery(next);
              setSelection(null);
            }}
            onKeyDown={onSearchKey}
          />
          {searching && (
            <span className="mp-count" data-testid="model-count">
              {`${matched} / ${total}`}
            </span>
          )}
        </div>
      }
      footStart={
        <Button
          variant="quiet"
          icon={<Plus size={14} />}
          testId="model-add-provider"
          onClick={() => {
            onClose();
            showView("settings", { section: "providers" });
          }}
        >
          {t("model.addProvider")}
        </Button>
      }
      footer={
        <>
          <Button testId="model-close" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            variant="primary"
            testId="model-use"
            disabled={selectedItem === null}
            onClick={() => apply(selectedItem)}
          >
            {t("model.use")}
          </Button>
        </>
      }
    >
      <nav ref={sideRef} className="mp-side" aria-label={t("model.scopes")}>
        {scopeButton({ kind: "all" }, t("model.all"), models?.length ?? 0, "model-scope-all")}
        {scopeButton(
          { kind: "scoped" },
          zh ? "常用模型 (Scoped)" : "Scoped models",
          scopedModels.length,
          "model-scope-scoped",
        )}
        {providers.length > 0 && (
          <p className="mp-scopes-head" aria-hidden="true">
            {t("model.providers")}
          </p>
        )}
        {providers.map((entry) =>
          scopeButton(
            { kind: "provider", provider: entry.provider },
            entry.provider,
            entry.count,
            "model-scope-provider",
            activeModel?.key.provider === entry.provider,
          ),
        )}
      </nav>
      <div className="mp-main">
        <div
          ref={tableRef}
          className="mp-table ui-scroll-fade"
          style={{ "--fade-inset": "var(--control-h-md)" } as CSSProperties}
        >
          {(models === null || items.length > 0) && (
            <div className="mp-cols" aria-hidden="true">
              <span />
              <span className="mp-num">{t("model.colIntelligence")}</span>
              <span className="mp-num">{t("model.colSpeed")}</span>
              <span className="mp-num">{t("model.colContext")}</span>
              <span className="mp-num">{t("model.colPrice")}</span>
              <span className="mp-tick" />
            </div>
          )}
          <div
            id={listId}
            className={models === null ? "mp-list" : "mp-list ui-data-in"}
            role="listbox"
            aria-label={t("model.list")}
          >
            {models === null && (
              <Skeleton
                variant="row"
                count={6}
                height="var(--control-h-md)"
                label={t("model.list")}
                testId="model-skeleton"
              />
            )}
            {models !== null && items.length === 0 && (
              <p className="mp-empty" data-testid="model-empty">
                {scope.kind === "scoped" && !searching
                  ? zh
                    ? "尚未收藏常用模型（点击模型左侧星标即可加入 enabledModels）"
                    : "No scoped models yet (star any model to add it to enabledModels)"
                  : searching
                    ? t("model.noMatch")
                    : t("model.empty")}
              </p>
            )}
            {groups}
          </div>
        </div>
        <div className="mp-foot">
          {shown !== null && <ModelDetails option={shown} insights={insights} />}
          {shown !== null && shownLevels.length > 0 && (
            <div className="mp-ctl">
              <span className="mp-ctl-label">{t("model.thinking")}</span>
              <div className="mp-ctl-body">
                <ThinkingSegments levels={shownLevels} level={shownLevel} onPick={setPickedLevel} />
                {running && <span className="mp-hint">{t("composer.nextRequest")}</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function ModelPicker(props: ModelPickerProps & { open: boolean }) {
  const presence = usePresence(props.open);
  const key = useOpenKey(props.open);
  if (!presence.mounted) return null;
  return <ModelPickerBody key={key} {...props} />;
}
