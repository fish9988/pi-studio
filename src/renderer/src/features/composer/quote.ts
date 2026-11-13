// 把一段文字引用进输入框：代码块、文件面板的 `@path `、终端选区、助手回答、页面上任意选中的文字都走这里，
// 统一写草稿 store（不直接改 textarea 的值，否则芯片、撤销和选区都会对不上）。
// 长文字折叠成粘贴附件（`#N` 芯片），短的直接接在末尾并留一个换行。
import { draftKey, type DraftKey, type TaskId, type TerminalKey } from "../../../../shared/ipc.ts";
import { insertPaste } from "./composer-tokens.ts";
import { getDraft, setDraft, setDraftText } from "./draft-store.ts";

export interface QuoteOptions {
  /** 代码块的语言：有值时包成 ```lang … ``` 围栏。 */
  lang?: string | null | undefined;
  /** 太长时要不要折叠成粘贴附件（默认折；`@path ` 这类短引用传 false）。 */
  fold?: boolean | undefined;
}

/** 终端键 → 草稿键：多标签终端的键带 `#t2` 后缀，草稿挂在打开它的任务 / 草稿上。 */
export function composerKeyForTerminal(terminalKey: TerminalKey): TaskId | DraftKey {
  return terminalKey.replace(/#t\d+$/, "") as TaskId | DraftKey;
}

/** 页面上选中的文字（拖选、双击选中的内容）；焦点在输入框里（那里有自己的选中）或没有选区时返回 null。 */
export function pageSelectionText(): string | null {
  if (document.activeElement instanceof HTMLTextAreaElement) return null;
  if (document.activeElement instanceof HTMLInputElement) return null;
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed) return null;
  const text = selection.toString();
  return text.trim() === "" ? null : text;
}

/** 引用到输入框：`key` 是任务 id 或草稿键（`new:<projectId>`），null = 无项目的那份聊天草稿。空文字什么也不做，返回 false。 */
export function quoteToComposer(key: TaskId | DraftKey | null, text: string, options: QuoteOptions = {}): boolean {
  const snippet = options.lang ? `\`\`\`${options.lang}\n${text.trimEnd()}\n\`\`\`` : text.trim();
  if (snippet.trim() === "") return false;
  const target = (key ?? draftKey(null)) as TaskId;
  const current = getDraft(target);
  const sep = current.text.length > 0 && !/\s$/.test(current.text) ? "\n" : "";
  const prepared = sep ? { ...current, text: `${current.text}${sep}` } : current;
  const pasted = options.fold === false ? null : insertPaste(prepared, snippet, prepared.text.length);
  if (pasted !== null) {
    setDraft(target, pasted.draft);
  } else {
    setDraftText(target, `${prepared.text}${snippet}\n`);
  }
  document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')?.focus();
  return true;
}

/** `@路径 `（正斜杠；有空白时加引号，和 omp 的提及写法一致）。 */
export function fileRefToken(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes(" ") ? `@"${normalized}" ` : `@${normalized} `;
}

/**
 * `@路径 ` 进输入框。`key` 为 undefined 表示调用方拿不到草稿键（文件树的右键菜单只给路径）：
 * 退回到正在打开的输入框，用输入框自己的 input 事件插进去（React 侧照常走 onChange → 草稿 store，撤销也保留）。
 */
export function quotePathToComposer(filePath: string, key?: TaskId | DraftKey | null): void {
  const token = fileRefToken(filePath);
  if (key !== undefined) {
    quoteToComposer(key, token, { fold: false });
    return;
  }
  const field = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
  if (field === null) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  const before = field.value.slice(0, start);
  const prefix = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const next = `${before}${prefix}${token}${field.value.slice(end)}`;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setValue?.call(field, next);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  const caret = (before + prefix + token).length;
  field.setSelectionRange(caret, caret);
}
