// 划词浮条的纯函数单测（Node 环境，不装 DOM）：排除目标判定、引用/旁路提问的文案整理、浮条坐标。
import { describe, expect, it } from "vitest";
import {
  computeTooltipPosition,
  formatSelectionBtwPrefill,
  formatSelectionQuote,
  isExcludedSelectionTarget,
} from "../src/renderer/src/features/conversation/selection-tooltip-model.ts";

/** tsconfig.node 里没有 DOM 类型（组件签名里的 Node 不存在），测试里直接把假对象当节点传。 */
type Node = FakeNode;

/** 假的元素节点：只造祖先链判定要看的 tagName / 属性 / parentElement。 */
interface FakeNode {
  nodeType: number;
  tagName: string;
  parentElement: FakeNode | null;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

function element(tagName: string, attrs: Record<string, string> = {}, parent: FakeNode | null = null): FakeNode {
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    parentElement: parent,
    attrs,
    getAttribute: (name) => attrs[name] ?? null,
    hasAttribute: (name) => name in attrs,
  };
}

/** 文本节点（nodeType 3）：它自己不是元素，判定从 parentElement 算起。 */
function textNode(parent: FakeNode): FakeNode {
  return { ...element("#text", {}, parent), nodeType: 3 };
}

const asNode = (value: FakeNode | null): Node | null => value;

describe("isExcludedSelectionTarget", () => {
  it("没有节点、或普通段落里的文字都不排除", () => {
    expect(isExcludedSelectionTarget(null)).toBe(false);
    const paragraph = element("p");
    expect(isExcludedSelectionTarget(asNode(paragraph))).toBe(false);
    expect(isExcludedSelectionTarget(asNode(textNode(element("span", {}, paragraph))))).toBe(false);
  });

  it("输入控件与按钮（含其中的文字）一律排除", () => {
    for (const tag of ["input", "textarea", "select", "button"]) {
      const control = element(tag);
      expect(isExcludedSelectionTarget(asNode(control))).toBe(true);
      expect(isExcludedSelectionTarget(asNode(textNode(element("span", {}, control))))).toBe(true);
    }
  });

  it("contenteditable 与 data-selection-ignore 的子树排除", () => {
    const editor = element("div", { contenteditable: "true" });
    expect(isExcludedSelectionTarget(asNode(textNode(element("span", {}, editor))))).toBe(true);
    const ignored = element("div", { "data-selection-ignore": "" });
    expect(isExcludedSelectionTarget(asNode(textNode(element("em", {}, ignored))))).toBe(true);
    // 只认 contenteditable="true"：别的值（false、plaintext-only）照常弹浮条。
    expect(isExcludedSelectionTarget(asNode(element("div", { contenteditable: "false" })))).toBe(false);
  });

  it("深层嵌套只看祖先链，遇到第一个排除目标就停", () => {
    const quote = element("blockquote");
    const para = element("p", {}, quote);
    const button = element("button", {}, para);
    expect(isExcludedSelectionTarget(asNode(textNode(element("span", {}, button))))).toBe(true);
  });
});

describe("formatSelectionQuote", () => {
  it("每行加 > ，去掉首尾空行与行尾空白", () => {
    expect(formatSelectionQuote("  第一行\n第二行  \n")).toBe("> 第一行\n> 第二行");
  });

  it("段内空行保持为空的引用行", () => {
    expect(formatSelectionQuote("a\n\nb")).toBe("> a\n>\n> b");
  });

  it("CRLF 归一成 LF", () => {
    expect(formatSelectionQuote("a\r\nb\r")).toBe("> a\n> b");
  });

  it("有来源时末尾补一行来源，空白来源忽略", () => {
    expect(formatSelectionQuote("x", "README.md")).toBe("> x\n> — README.md");
    expect(formatSelectionQuote("x", "  notes.md  ")).toBe("> x\n> — notes.md");
    expect(formatSelectionQuote("x", "   ")).toBe("> x");
  });

  it("空文字返回空串（调用方据此不发引用）", () => {
    expect(formatSelectionQuote("")).toBe("");
    expect(formatSelectionQuote("  \n\t\n ")).toBe("");
  });
});

describe("formatSelectionBtwPrefill", () => {
  it("引用块后面留一个空行给问题", () => {
    expect(formatSelectionBtwPrefill("一句话")).toBe("> 一句话\n\n");
    expect(formatSelectionBtwPrefill("一句话", "notes.md")).toBe("> 一句话\n> — notes.md\n\n");
    expect(formatSelectionBtwPrefill("   ")).toBe("");
  });

  it("正好 1500 字不截断，多一个字就截到 1500 加 …", () => {
    const exact = "a".repeat(1500);
    expect(formatSelectionBtwPrefill(exact)).toBe(`> ${exact}\n\n`);
    const over = "a".repeat(1501);
    expect(formatSelectionBtwPrefill(over)).toBe(`> ${"a".repeat(1500)}…\n\n`);
    expect(formatSelectionBtwPrefill(over)).not.toContain("a".repeat(1501));
  });

  it("截断按字符算，不切坏 emoji", () => {
    const emoji = "😀".repeat(2000);
    expect(formatSelectionBtwPrefill(emoji)).toBe(`> ${"😀".repeat(1500)}…\n\n`);
  });
});

describe("computeTooltipPosition", () => {
  const viewport = { width: 1000, height: 800 };

  it("顶部空间够时放在选区上方居中（y 是浮条底边）", () => {
    expect(computeTooltipPosition({ top: 200, bottom: 220, left: 300, width: 100 }, viewport)).toEqual({
      x: 224,
      y: 192,
      placement: "above",
    });
  });

  it("顶部不足 48px 时翻到下方（y 是浮条顶边）", () => {
    expect(computeTooltipPosition({ top: 47, bottom: 67, left: 300, width: 100 }, viewport)).toEqual({
      x: 224,
      y: 75,
      placement: "below",
    });
    // 正好 48 仍放上面。
    expect(computeTooltipPosition({ top: 48, bottom: 68, left: 300, width: 100 }, viewport).placement).toBe("above");
  });

  it("左右夹进窗口：贴左边、贴右边、窗口比浮条还窄", () => {
    expect(computeTooltipPosition({ top: 300, bottom: 320, left: 0, width: 10 }, viewport).x).toBe(8);
    expect(computeTooltipPosition({ top: 300, bottom: 320, left: 990, width: 10 }, viewport).x).toBe(740);
    expect(computeTooltipPosition({ top: 300, bottom: 320, left: 50, width: 10 }, { width: 200, height: 800 }).x).toBe(
      8,
    );
  });

  it("上方用选区的 top 减间距，下方用选区的 bottom 加间距", () => {
    const above = computeTooltipPosition({ top: 400, bottom: 460, left: 300, width: 100 }, viewport);
    expect(above.y).toBe(392);
    const below = computeTooltipPosition({ top: 10, bottom: 70, left: 300, width: 100 }, viewport);
    expect(below.y).toBe(78);
  });
});
