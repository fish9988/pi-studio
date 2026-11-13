// 长历史挂载分帧的两个前提（features/tsp/MainFlow.tsx 的 useDeferredHead / deferred-mount.ts）：
// 什么时候才允许先画最后一截，以及"要跳老消息时立刻挂完"这个兜底确实叫得动登记方。
import { describe, expect, it } from "vitest";
import {
  deferredHeadStart,
  flushDeferredHistory,
  registerDeferredFlush,
} from "../src/renderer/src/features/tsp/deferred-mount.ts";

describe("长历史首次挂载分帧", () => {
  it("短历史、screen 页面不躲：一次画完全部", () => {
    expect(deferredHeadStart(0, true)).toBe(0);
    expect(deferredHeadStart(119, true)).toBe(0);
    expect(deferredHeadStart(5000, false)).toBe(0);
  });

  it("长历史只藏掉前面的块，最后 20 块照画", () => {
    expect(deferredHeadStart(120, true)).toBe(100);
    expect(deferredHeadStart(902, true)).toBe(882);
  });

  it("flushDeferredHistory 叫得动每个还在分帧的 surface，注销后不再叫", () => {
    let flushed = 0;
    const unregister = registerDeferredFlush(() => {
      flushed += 1;
    });
    flushDeferredHistory();
    expect(flushed).toBe(1);
    unregister();
    flushDeferredHistory();
    expect(flushed).toBe(1);
  });
});
