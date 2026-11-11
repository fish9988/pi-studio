// DSH 灵感工作台插件：「⚡ 快捷指令短语」存储与输入框工具栏按钮。
// 支持在输入框工具栏一键插入常用提示词模板，并在设置 → 插件与市场中自定义增删与启停。
import { useState, useSyncExternalStore } from "react";
import type { TaskId } from "../../../../shared/ipc.ts";
import { Bolt } from "../../icons.tsx";
import { useLocale } from "../../i18n/use-t.ts";
import { Menu, type MenuAnchor, type MenuEntry } from "../../ui/Menu.tsx";
import { reconcileDraft } from "./composer-tokens.ts";
import { getDraft, setDraft } from "./draft-store.ts";

export interface QuickPhraseItem {
  id: string;
  title: string;
  prompt: string;
}

interface QuickPhrasesState {
  enabled: boolean;
  items: QuickPhraseItem[];
}

const STORAGE_KEY = "pi-studio:quick-phrases:v1";

const DEFAULT_PHRASES: QuickPhraseItem[] = [
  {
    id: "explain-simple",
    title: "用小算例通俗讲清原理",
    prompt: "请先直接给出结论，再结合一个极小规模的可手算数字算例，用通俗直白的话把核心流程讲清楚，不要堆砌术语。",
  },
  {
    id: "deep-research",
    title: "检索最新资料并附出处",
    prompt: "请检索网页和社区一手信息进行调研，所有关键结论、数字和论文请标注明确出处。",
  },
  {
    id: "minimal-fix",
    title: "最小化精准修复并跑通检查",
    prompt: "请直接定位根因并做最小化修改，优先复用现有实现，改完后运行检查与测试确认通过。",
  },
  {
    id: "review-diff",
    title: "审阅当前 Git 改动与潜在风险",
    prompt: "请检查当前工作区的 git diff，指出潜在的边界情况、回归风险或冗余代码。",
  },
];

function loadInitialState(): QuickPhrasesState {
  if (typeof window === "undefined") {
    return { enabled: true, items: DEFAULT_PHRASES };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: true, items: DEFAULT_PHRASES };
    const parsed = JSON.parse(raw) as Partial<QuickPhrasesState>;
    const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : true;
    const items =
      Array.isArray(parsed.items) && parsed.items.length > 0
        ? parsed.items.filter(
            (x): x is QuickPhraseItem =>
              typeof x?.id === "string" && typeof x?.title === "string" && typeof x?.prompt === "string",
          )
        : DEFAULT_PHRASES;
    return { enabled, items };
  } catch {
    return { enabled: true, items: DEFAULT_PHRASES };
  }
}

let state: QuickPhrasesState = loadInitialState();
const listeners = new Set<() => void>();

function saveState(next: QuickPhrasesState): void {
  state = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
  for (const listener of listeners) listener();
}

export function useQuickPhrases(): QuickPhrasesState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

export function setQuickPhrasesEnabled(enabled: boolean): void {
  saveState({ ...state, enabled });
}

export function addQuickPhrase(title: string, prompt: string): void {
  const cleanTitle = title.trim();
  const cleanPrompt = prompt.trim();
  if (!cleanTitle || !cleanPrompt) return;
  saveState({
    ...state,
    items: [...state.items, { id: `custom-${Date.now()}`, title: cleanTitle, prompt: cleanPrompt }],
  });
}

export function removeQuickPhrase(id: string): void {
  saveState({
    ...state,
    items: state.items.filter((item) => item.id !== id),
  });
}

export function resetQuickPhrases(): void {
  saveState({ enabled: true, items: DEFAULT_PHRASES });
}

export function QuickPhrasesButton({
  draftKey,
  disabled = false,
  onFocusField,
}: {
  draftKey: TaskId;
  disabled?: boolean;
  onFocusField?: () => void;
}) {
  const locale = useLocale();
  const isZh = locale === "zh-CN";
  const { enabled, items } = useQuickPhrases();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);

  if (!enabled || items.length === 0) return null;

  const insertPhrase = (prompt: string) => {
    const current = getDraft(draftKey);
    const sep = current.text.trim() === "" ? "" : "\n";
    const nextText = `${current.text}${sep}${prompt}`;
    setDraft(draftKey, reconcileDraft({ ...current, text: nextText }));
    onFocusField?.();
  };

  const menuItems: MenuEntry[] = items.map((item) => ({
    id: item.id,
    label: item.title,
    onSelect: () => insertPhrase(item.prompt),
  }));

  const label = isZh ? "快捷指令短语" : "Quick phrases";

  return (
    <>
      <button
        type="button"
        className="ui-chip enhance-prompt-btn"
        disabled={disabled}
        title={isZh ? "插入快捷指令短语 (DSH 增强)" : "Insert quick phrase"}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: box.left, y: box.top - 6, returnFocus: e.currentTarget });
        }}
        data-testid="quick-phrases-btn"
      >
        <Bolt size={14} />
      </button>
      {anchor !== null && <Menu anchor={anchor} items={menuItems} label={label} onClose={() => setAnchor(null)} />}
    </>
  );
}
