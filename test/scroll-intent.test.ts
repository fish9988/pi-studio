// 滚动意图记账的纯逻辑：吸底引擎、"回到最新"、reveal 和对话线跳转都靠它区分程序滚动与用户滚动。
// 用假对象（只有 scrollTop）就够，不需要 jsdom。
import { describe, expect, it } from "vitest";
import {
  classifyScroll,
  isSmoothScrolling,
  noteProgrammaticTop,
  noteSmoothScroll,
  readProgrammaticTop,
  resetScrollIntent,
  wheelEscapesStick,
  type ScrollChainNode,
} from "../src/renderer/src/features/conversation/scroll-intent.ts";

const EPSILON = 1;

describe("classifyScroll", () => {
  it("差值与记账值在 epsilon 以内算程序滚动", () => {
    const el = { scrollTop: 0 };
    noteProgrammaticTop(el, 400);
    el.scrollTop = 400;
    expect(classifyScroll(el, 400, EPSILON)).toBe("programmatic");
    el.scrollTop = 400.6;
    expect(classifyScroll(el, 400.6, EPSILON)).toBe("programmatic");
  });

  it("差值大（向上或向下）算用户滚动", () => {
    const el = { scrollTop: 0 };
    noteProgrammaticTop(el, 400);
    expect(classifyScroll(el, 120, EPSILON)).toBe("user");
    expect(classifyScroll(el, 900, EPSILON)).toBe("user");
  });

  it("从没记过账时算用户滚动", () => {
    const el = { scrollTop: 0 };
    expect(classifyScroll(el, 0, EPSILON)).toBe("user");
  });

  it("平滑滚动抑制窗口内差值大也算程序滚动，窗口外恢复用户滚动", () => {
    const during = { scrollTop: 0 };
    noteProgrammaticTop(during, 400);
    noteSmoothScroll(during, 1000);
    expect(isSmoothScrolling(during, Date.now())).toBe(true);
    expect(classifyScroll(during, 120, EPSILON)).toBe("programmatic");

    // 时长 0：截止时间就是当下，之后已经过期。
    const after = { scrollTop: 0 };
    noteProgrammaticTop(after, 400);
    noteSmoothScroll(after, 0);
    expect(isSmoothScrolling(after, Date.now())).toBe(false);
    expect(classifyScroll(after, 120, EPSILON)).toBe("user");
  });
});

describe("resetScrollIntent", () => {
  it("记下的 scrollTop 能原样读回，重置后没有记录", () => {
    const el = { scrollTop: 0 };
    noteProgrammaticTop(el, 123);
    expect(readProgrammaticTop(el)).toBe(123);
    noteSmoothScroll(el, 1000);
    resetScrollIntent(el);
    expect(readProgrammaticTop(el)).toBeUndefined();
    expect(isSmoothScrolling(el, Date.now())).toBe(false);
    expect(classifyScroll(el, 123, EPSILON)).toBe("user");
  });

  it("两个容器的记账互不影响", () => {
    const a = { scrollTop: 0 };
    const b = { scrollTop: 0 };
    noteProgrammaticTop(a, 50);
    expect(readProgrammaticTop(b)).toBeUndefined();
    expect(classifyScroll(b, 50, EPSILON)).toBe("user");
  });
});

/** 滚轮链上的一环（Element 天然满足：parentElement / scrollTop / scrollHeight / clientHeight）。 */
function chain(...room: readonly [top: number, height: number, client: number][]): ScrollChainNode {
  let parent: ScrollChainNode | null = null;
  for (let index = room.length - 1; index >= 0; index -= 1) {
    const [top, height, client] = room[index]!;
    parent = { parentElement: parent, scrollTop: top, scrollHeight: height, clientHeight: client };
  }
  return parent!;
}

describe("wheelEscapesStick", () => {
  it("内层还能朝滚轮方向继续滚时由内层吃掉，不解除吸底", () => {
    // 目标在内层（scroller 是祖先），内层向上还有 200px 可滚。
    const inner = chain([200, 600, 300], [0, 2000, 800]);
    const scroller = inner.parentElement!;
    expect(wheelEscapesStick(inner, scroller, -100)).toBe(true);
    // 向下还有内容同理。
    const down = chain([0, 600, 300], [0, 2000, 800]);
    expect(wheelEscapesStick(down, down.parentElement!, 100)).toBe(true);
  });

  it("内层已经滚到头时冒泡到根容器，算用户上滑", () => {
    const atTop = chain([0, 600, 300], [0, 2000, 800]);
    expect(wheelEscapesStick(atTop, atTop.parentElement!, -100)).toBe(false);
    const atBottom = chain([300, 600, 300], [0, 2000, 800]);
    expect(wheelEscapesStick(atBottom, atBottom.parentElement!, 100)).toBe(false);
  });

  it("目标就是根容器时永远不算内层吃掉的", () => {
    const root = chain([400, 2000, 800]);
    expect(wheelEscapesStick(root, root, -100)).toBe(false);
    expect(wheelEscapesStick(null, root, -100)).toBe(false);
  });

  it("几何上有余量但滚轮滚不动的内层（overflow: hidden）不算吃掉滚动", () => {
    const inner = chain([200, 600, 300], [0, 2000, 800]);
    const root = inner.parentElement!;
    expect(wheelEscapesStick(inner, root, -100, () => false)).toBe(false);
    expect(wheelEscapesStick(inner, root, -100, () => true)).toBe(true);
  });
});
