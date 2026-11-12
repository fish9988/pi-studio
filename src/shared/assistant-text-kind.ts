// 判断一条 assistant `text` 块该当"正文"还是当"过程/思考"渲染。
//
// 起因：部分通道（WorkBuddy/DeepSeek、若干中转站）会把思维或过程旁白塞进正文通道：
//  1) Responses API 的 message.phase = "commentary" —— 过程旁白/半截推理，不是最终答案；
//  2) 思维标签（` thinking…<｜end▁of▁thinking｜>`）直接漏在正文里；
//  3) 原始 DSML 工具调用标记被当作正文吐回来。
// Pi 只把 1) 存进 `textSignature`（`{"v":1,"id":…,"phase":"commentary"}`），2)/3) 完全不标记，
// 于是这些内容在界面上就是一段普通正文。这里把它们识别成"过程"，交给思考/过程区折叠渲染。

/** 过程旁白的标题（英文短语，和 "Thought" 保持同一风格）。 */
export const PROCESS_HEAD_TEXT = "Commentary";

export type AssistantTextKind =
  | { kind: "answer" }
  /** `reasoning` 进过程区；`answer` 是同一块里剩下的正文（可能为空）。 */
  | { kind: "process"; reasoning: string; answer: string };

/** 从 `textSignature` 里读 Responses API 的 message.phase；读不到返回 null。 */
export function textBlockPhase(signature: string | undefined): string | null {
  if (typeof signature !== "string" || signature.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(signature);
    if (typeof parsed !== "object" || parsed === null) return null;
    const phase = (parsed as { phase?: unknown }).phase;
    return typeof phase === "string" && phase !== "" ? phase : null;
  } catch {
    return null;
  }
}

// 思维标签：DeepSeek 官方的 ` 与 `<｜end▁of▁thinking｜>`，以及常见的 `<thinking>` 写法。
const OPEN_TAG = /^(?:<think(?:ing)?>|<[｜|](?:begin|start)[^<>]{0,16}think(?:ing)?[｜|]>|<[｜|]think(?:ing)?[｜|]>)/i;
const CLOSE_TAG = /(?:<\/think(?:ing)?>|<[｜|](?:end|close)[^<>]{0,16}think(?:ing)?[｜|]>)/i;
/** 只认整块末尾的闭标签：中间位置出现裸闭标签的正文不切。 */
const CLOSE_TAG_AT_END = new RegExp(`(?:${CLOSE_TAG.source})$`, "i");
/**
 * 整块以原始工具调用标记开头（通道把调用块原样吐进正文）。
 * DeepSeek 原生标记是 `<｜DSML｜ calls>` / `<｜DSML｜ invoke …>`（全角竖线）。
 */
const RAW_MARKUP_LEAD = /^(?:<[｜|]DSML[｜|]|[｜|]DSML[｜|])/i;

/** 去掉代码（围栏块与行内反引号）：正文里举例说明标记长什么样时不能当真泄漏。 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * 拆出漏在正文里的思维标签内容。只认"整块被标签包住"的形态（起始开标签 / 结尾闭标签），
 * 正文里正常讨论 `think` 标签的段落不会被误伤。
 */
export function splitLeakedReasoning(raw: string): { reasoning: string; answer: string } | null {
  const leading = raw.trimStart();
  const open = OPEN_TAG.exec(leading);
  if (open !== null) {
    const rest = leading.slice(open[0].length);
    const close = CLOSE_TAG.exec(rest);
    if (close === null) return { reasoning: rest.trim(), answer: "" };
    const reasoning = rest.slice(0, close.index).trim();
    const answer = rest.slice(close.index + close[0].length).trim();
    return { reasoning, answer };
  }
  // 没有开标签、只有闭标签：只认"整块以闭标签收尾"（`推理</think>` 这种被截断的思维倒灌）。
  // 闭标签出现在中间时后半截还有正文，说明这是正常讨论标签的句子，一律不切。
  if (leading.startsWith("```")) return null;
  const tail = closeTagAtEnd(raw);
  if (tail === null) return null;
  const reasoning = raw.slice(0, tail.index).trim();
  if (reasoning === "") return null;
  return { reasoning, answer: "" };
}

/** 整块末尾的裸闭标签位置；末尾标签还写在行内代码里时不算。 */
function closeTagAtEnd(text: string): { index: number; length: number } | null {
  const trimmed = text.trimEnd();
  const match = CLOSE_TAG_AT_END.exec(trimmed);
  if (match === null) return null;
  const index = match.index;
  if (isBackticked(trimmed, index, match[0].length)) return null;
  return { index, length: match[0].length };
}

/** 标签两边有没有反引号（说明它是写在行内代码里当例子）。 */
function isBackticked(text: string, index: number, length: number): boolean {
  return text[index - 1] === "`" || text[index + length] === "`";
}

/**
 * 整块是**原始工具调用标记块**：去掉代码后，开头就是 `<｜DSML｜` / `｜DSML｜` 这类标记，
 * 并且正文里出现过 `invoke` / `parameter`。
 * 只在正文中间提到标记（哪怕写了多处）都不算——通道没解析成功时整块一定是从标记开始的。
 */
export function hasRawToolMarkup(text: string): boolean {
  const plain = stripCode(text).trimStart();
  if (!RAW_MARKUP_LEAD.test(plain)) return false;
  return /\b(?:invoke|parameter)\b/i.test(plain);
}

/** 整块是否带着"过程"的结构信号：以思维开标签/原始标记开头，或以裸闭标签收尾。 */
function looksTagged(raw: string): boolean {
  const leading = raw.trimStart();
  if (OPEN_TAG.test(leading)) return true;
  if (RAW_MARKUP_LEAD.test(stripCode(raw).trimStart())) return true;
  return closeTagAtEnd(raw) !== null;
}

/**
 * 给一个 assistant text 块定性。
 * `signature` 是块上的 `textSignature`（只有 Responses API 才有 phase）。
 * 注意：`commentary` 只是"不是最终答案"，是否降级还取决于整条消息有没有别的答案，
 * 由调用方用 `isCommentaryOnlyBlock` 之类的条件决定，这里只报事实。
 */
export function classifyAssistantText(raw: string, signature?: string | undefined): AssistantTextKind {
  // 通道明确标了 final_answer：它就是回答，前缀/正文里的任何标记都不该让它变成思考。
  if (textBlockPhase(signature) === "final_answer") return { kind: "answer" };

  // 硬性防线：只有带着"过程"结构信号（开头是思维标签/原始标记，或整块以裸闭标签收尾）的块
  // 才可能被折叠。正文里出现 `<tag>`、`Array<string>`、`</thinking>`、`text_start` 这类字样
  // 都只是文本本身，一律按回答处理，不再看其它信号。
  if (looksTagged(raw)) {
    const split = splitLeakedReasoning(raw);
    if (split !== null && split.reasoning !== "") {
      return { kind: "process", reasoning: split.reasoning, answer: split.answer };
    }
    if (hasRawToolMarkup(raw)) {
      return { kind: "process", reasoning: raw.trim(), answer: "" };
    }
  }

  // phase=commentary 是通道自己给的信号（内容里可以完全没有标签），仍然降级成过程段。
  if (textBlockPhase(signature) === "commentary") {
    return { kind: "process", reasoning: raw.trim(), answer: "" };
  }
  return { kind: "answer" };
}
