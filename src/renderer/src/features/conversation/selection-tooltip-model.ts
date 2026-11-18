// 划词浮条的纯辅助函数（无 DOM 依赖，Node 单测直接跑）。

/** 选区两端落在这里面的节点不算划词：输入控件、按钮自己处理选中，标了 data-selection-ignore 的区域不弹浮条。 */
const EXCLUDED_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);
const ELEMENT_NODE = 1;
export const MAX_SELECTION_CHARS = 8000;
const MAX_BTW_CHARS = 1500;
const TOOLTIP_WIDTH = 252;
const TOOLTIP_GAP = 8;
const VIEWPORT_EDGE = 8;
const FLIP_MIN_SPACE = 48;

export interface SelectionNodeLike {
  readonly nodeType: number;
  readonly tagName?: string;
  readonly parentElement: SelectionNodeLike | null;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
}

function isExcludedElement(element: SelectionNodeLike): boolean {
  if (element.tagName !== undefined && EXCLUDED_TAGS.has(element.tagName)) return true;
  return (
    element.getAttribute?.("contenteditable") === "true" || element.hasAttribute?.("data-selection-ignore") === true
  );
}

/** 节点自己或它的任一祖先是不是"不弹浮条"的地方（文本节点从父元素算起）。 */
export function isExcludedSelectionTarget(node: SelectionNodeLike | null): boolean {
  let element: SelectionNodeLike | null =
    node === null ? null : node.nodeType === ELEMENT_NODE ? node : node.parentElement;
  while (element !== null) {
    if (isExcludedElement(element)) return true;
    element = element.parentElement;
  }
  return false;
}

/** 选区文字整理成一段干净的文字：统一换行、去掉行尾空白和首尾空行。 */
function normalizeSelection(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

/** Markdown 引用块（`> …`）；有来源时末尾带一行 `> — 来源`。空文字返回空串。 */
export function formatSelectionQuote(text: string, sourceLabel?: string): string {
  const body = normalizeSelection(text);
  if (body === "") return "";
  const lines = body.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
  const label = sourceLabel?.trim() ?? "";
  if (label !== "") lines.push(`> — ${label}`);
  return lines.join("\n");
}

/** 旁路提问的预填：同样的引用块，后面留一个空行让用户接着写问题；过长时按字符（不切坏 emoji）截到 1500 字加 `…`。 */
export function formatSelectionBtwPrefill(text: string, sourceLabel?: string): string {
  const body = normalizeSelection(text);
  if (body === "") return "";
  const chars = [...body];
  const clipped = chars.length > MAX_BTW_CHARS ? `${chars.slice(0, MAX_BTW_CHARS).join("")}…` : body;
  return `${formatSelectionQuote(clipped, sourceLabel)}\n\n`;
}

/**
 * 浮条坐标：默认居中在选区上方（`y` 是浮条的底边，样式里靠 translateY(-100%) 上去）；
 * 上方不足 48px 时翻到下方（`y` 是顶边）；左右夹在窗口内，`x` 是左边缘。
 */
export function computeTooltipPosition(
  rect: { top: number; bottom: number; left: number; width: number },
  viewport: { width: number; height: number },
): { x: number; y: number; placement: "above" | "below" } {
  const placement = rect.top >= FLIP_MIN_SPACE ? "above" : "below";
  const centered = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
  const rightmost = viewport.width - VIEWPORT_EDGE - TOOLTIP_WIDTH;
  const x = Math.max(VIEWPORT_EDGE, Math.min(centered, rightmost));
  const y = placement === "above" ? rect.top - TOOLTIP_GAP : rect.bottom + TOOLTIP_GAP;
  return { x, y, placement };
}
