// Pi 设置页共享工具：中英双语文案辅助、点路径/嵌套对象双兼容的设置读写、范围（全局 / 当前项目）选择与防抖数字/文本输入。
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { OmpConfigItem, Project, ProjectId } from "../../../../../shared/ipc.ts";
import type { PiConfigScope } from "../../../../../shared/pi-config-types.ts";
import { useLocale, useT } from "../../../i18n/use-t.ts";
import { useSelectedTaskId, useTask } from "../../../store/index.ts";
import { NumberField, Segmented, TextField, type Option } from "../../../ui/controls.tsx";
import { Select, type SelectOption } from "../../../ui/Select.tsx";
import { reportError } from "../../../ui/errors.ts";
import { refreshProjects, useProjects, useProjectsState } from "../../sidebar/projects-store.ts";
import {
  ensureOmpConfigLoaded,
  loadOmpConfig,
  resetOmpConfig,
  saveOmpConfigOrThrow,
  useConfigLoad,
} from "../config-store.ts";
import { piBridge } from "./pi-bridge.ts";

export function usePiText() {
  const locale = useLocale();
  const t = useT();
  const zh = locale === "zh-CN";
  const tr = useCallback((zhText: string, enText: string) => (zh ? zhText : enText), [zh]);
  return { zh, tr, t };
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function findNestedItem(
  items: readonly OmpConfigItem[],
  dottedKey: string,
): { found: boolean; value: unknown; modified: boolean } {
  const exact = items.find((entry) => entry.key === dottedKey);
  if (exact !== undefined) {
    return {
      found: true,
      value: exact.hasValue ? exact.value : exact.defaultValue,
      modified: exact.hasValue && !Object.is(exact.value, exact.defaultValue),
    };
  }
  const dot = dottedKey.indexOf(".");
  if (dot <= 0) return { found: false, value: undefined, modified: false };
  const rootKey = dottedKey.slice(0, dot);
  const rest = dottedKey.slice(dot + 1).split(".");
  const parent = items.find((entry) => entry.key === rootKey);
  if (parent === undefined) return { found: false, value: undefined, modified: false };
  let cursor: unknown = parent.hasValue ? parent.value : parent.defaultValue;
  for (const part of rest) {
    if (!isPlainObject(cursor) || !(part in cursor)) return { found: false, value: undefined, modified: false };
    cursor = cursor[part];
  }
  return { found: true, value: cursor, modified: parent.hasValue };
}

export function usePiConfigReady(): boolean {
  const load = useConfigLoad();
  useEffect(() => {
    ensureOmpConfigLoaded();
  }, []);
  return load.kind === "ready";
}

export function usePiSetting<T>(
  key: string,
  fallback: T,
  coerce?: (raw: unknown, fallback: T) => T,
): {
  value: T;
  modified: boolean;
  ready: boolean;
  save: (next: T) => Promise<void>;
  reset: () => Promise<void>;
} {
  const { t } = usePiText();
  const load = useConfigLoad();
  useEffect(() => {
    ensureOmpConfigLoaded();
  }, []);

  const items = load.kind === "ready" ? load.data.items : null;
  const resolved = useMemo(() => {
    if (items === null) return { value: fallback, modified: false };
    const hit = findNestedItem(items, key);
    if (!hit.found || hit.value === undefined) return { value: fallback, modified: false };
    const value = coerce ? coerce(hit.value, fallback) : (hit.value as T);
    return { value, modified: hit.modified };
  }, [items, key, fallback, coerce]);

  const save = useCallback(
    async (next: T) => {
      try {
        if (items !== null && !items.some((entry) => entry.key === key)) {
          const dot = key.indexOf(".");
          const rootKey = dot > 0 ? key.slice(0, dot) : null;
          const parent = rootKey ? items.find((entry) => entry.key === rootKey) : undefined;
          if (parent !== undefined && rootKey !== null) {
            const parts = key.slice(dot + 1).split(".");
            const base = isPlainObject(parent.hasValue ? parent.value : parent.defaultValue)
              ? structuredClone((parent.hasValue ? parent.value : parent.defaultValue) as Record<string, unknown>)
              : {};
            let cursor: Record<string, unknown> = base;
            for (let i = 0; i < parts.length - 1; i++) {
              const seg = parts[i]!;
              const child = cursor[seg];
              const nextObj = isPlainObject(child) ? { ...child } : {};
              cursor[seg] = nextObj;
              cursor = nextObj;
            }
            const leaf = parts.at(-1);
            if (leaf !== undefined) cursor[leaf] = next;
            await saveOmpConfigOrThrow(rootKey, base);
            return;
          }
          // 若快照里还没有登记该键，直接走桥接写入并重读快照
          await piBridge().setOmpConfig(key, JSON.stringify(next));
          await loadOmpConfig(true);
          return;
        }
        await saveOmpConfigOrThrow(key, next);
      } catch (error) {
        reportError(t, error);
      }
    },
    [items, key, t],
  );

  const reset = useCallback(async () => {
    try {
      await resetOmpConfig(key);
    } catch (error) {
      reportError(t, error);
    }
  }, [key, t]);

  return { value: resolved.value, modified: resolved.modified, ready: load.kind === "ready", save, reset };
}

export const asBoolean = (raw: unknown, fallback: boolean): boolean => (typeof raw === "boolean" ? raw : fallback);
export const asNumber = (raw: unknown, fallback: number): number =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
export const asString = (raw: unknown, fallback: string): string => (typeof raw === "string" ? raw : fallback);
export const asStringArray = (raw: unknown, fallback: string[]): string[] =>
  Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : fallback;

export function usePiScopeState(): {
  scope: PiConfigScope;
  setScope: (next: PiConfigScope) => void;
  projects: readonly Project[];
  projectId: ProjectId | null;
  setProjectId: (next: ProjectId) => void;
  activeProject: Project | null;
} {
  const projectsState = useProjectsState();
  const projects = useProjects();
  const selectedTaskId = useSelectedTaskId();
  const selectedTask = useTask(selectedTaskId);

  useEffect(() => {
    if (!projectsState.loaded) void refreshProjects();
  }, [projectsState.loaded]);

  const defaultProjectId = selectedTask?.projectId ?? projects[0]?.id ?? null;
  const [scope, setScope] = useState<PiConfigScope>("global");
  const [pickedProjectId, setPickedProjectId] = useState<ProjectId | null>(null);

  const effectiveProjectId = useMemo(() => {
    if (pickedProjectId !== null && projects.some((p) => p.id === pickedProjectId)) return pickedProjectId;
    return defaultProjectId;
  }, [pickedProjectId, projects, defaultProjectId]);

  const activeProject = useMemo(
    () => (effectiveProjectId === null ? null : (projects.find((p) => p.id === effectiveProjectId) ?? null)),
    [effectiveProjectId, projects],
  );

  return {
    scope: scope === "project" && effectiveProjectId === null ? "global" : scope,
    setScope,
    projects,
    projectId: effectiveProjectId,
    setProjectId: setPickedProjectId,
    activeProject,
  };
}

export function PiScopeBar({
  scope,
  onScopeChange,
  projects,
  projectId,
  onProjectChange,
  testId,
}: {
  scope: PiConfigScope;
  onScopeChange: (next: PiConfigScope) => void;
  projects: readonly Project[];
  projectId: ProjectId | null;
  onProjectChange: (next: ProjectId) => void;
  testId?: string | undefined;
}) {
  const { tr } = usePiText();
  const scopeOptions: readonly Option<PiConfigScope>[] = [
    { value: "global", label: tr("全局 (~/.pi)", "Global (~/.pi)") },
    { value: "project", label: tr("当前项目 (.pi)", "Project (.pi)") },
  ];
  const projectOptions: SelectOption<string>[] = projects.map((project) => ({
    value: project.id,
    label: project.name,
    note: project.path,
  }));
  return (
    <div className="pis-scope-bar">
      <Segmented<PiConfigScope>
        size="sm"
        value={scope}
        options={scopeOptions}
        disabled={projects.length === 0 && scope === "global"}
        label={tr("配置范围", "Scope")}
        onChange={(next) => {
          if (next === "project" && projectId === null) return;
          onScopeChange(next);
        }}
        testId={testId}
      />
      {scope === "project" && projectOptions.length > 1 && projectId !== null && (
        <Select
          size="sm"
          value={projectId}
          options={projectOptions}
          label={tr("选择项目", "Select project")}
          onChange={(next) => onProjectChange(next as ProjectId)}
          testId={testId ? `${testId}-project` : undefined}
        />
      )}
      {scope === "project" && projectOptions.length === 1 && projects[0] !== undefined && (
        <span className="pis-scope-project" title={projects[0].path}>
          {projects[0].name}
        </span>
      )}
    </div>
  );
}

/** 失焦或回车时提交的数字输入框。 */
export function PiNumberCommitField({
  value,
  min = 0,
  max,
  unit,
  width = 124,
  disabled = false,
  labelledBy,
  label,
  onCommit,
  testId,
}: {
  value: number;
  min?: number | undefined;
  max?: number | undefined;
  unit?: string | undefined;
  width?: number | undefined;
  disabled?: boolean | undefined;
  labelledBy?: string | undefined;
  label?: string | undefined;
  onCommit: (next: number) => void;
  testId?: string | undefined;
}) {
  const [draft, setDraft] = useState(() => String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  const parsed = Number(draft.trim());
  const invalid =
    draft.trim() === "" ||
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < min ||
    (max !== undefined && parsed > max);

  const commit = () => {
    if (invalid) {
      setDraft(String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setDraft(String(value));
      event.currentTarget.blur();
    }
  };

  return (
    <NumberField
      size="sm"
      width={width}
      unit={unit}
      value={draft}
      invalid={focused && invalid}
      disabled={disabled}
      aria-labelledby={labelledBy}
      aria-label={label}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={setDraft}
      onKeyDown={onKeyDown}
      testId={testId}
    />
  );
}

/** 失焦或回车时提交的单行文本输入框。 */
export function PiTextCommitField({
  value,
  placeholder,
  width = 260,
  mono = false,
  disabled = false,
  labelledBy,
  label,
  onCommit,
  testId,
}: {
  value: string;
  placeholder?: string | undefined;
  width?: number | string | undefined;
  mono?: boolean | undefined;
  disabled?: boolean | undefined;
  labelledBy?: string | undefined;
  label?: string | undefined;
  onCommit: (next: string) => void;
  testId?: string | undefined;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed !== value) onCommit(trimmed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setDraft(value);
      event.currentTarget.blur();
    }
  };

  return (
    <TextField
      size="sm"
      width={width}
      mono={mono}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      aria-labelledby={labelledBy}
      aria-label={label}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={setDraft}
      onKeyDown={onKeyDown}
      testId={testId}
    />
  );
}
