// 过程组折叠状态的纯逻辑与 store 读写。这里不 import 任何 React 组件或 DOM：
// process-fold.ts 只依赖 create-store.ts（不引 tsp-store.ts，后者由 MainFlow 负责挂到 onTspDocumentDropped 上）。
import { describe, expect, it, beforeEach } from "vitest";
import {
  dropGroupFolds,
  groupFoldKey,
  nextGroupFold,
  pruneGroupFolds,
  readGroupFold,
  resolveGroupCollapsed,
  writeGroupFold,
  type GroupFold,
} from "../src/renderer/src/features/tsp/process-fold.ts";

const USER: GroupFold = { userToggled: true, collapsed: true };
const USER_OPEN: GroupFold = { userToggled: true, collapsed: false };

describe("resolveGroupCollapsed", () => {
  it("没记录时用程序默认值", () => {
    expect(resolveGroupCollapsed(undefined, true)).toBe(true);
    expect(resolveGroupCollapsed(undefined, false)).toBe(false);
  });

  it("有记录时记录说了算", () => {
    expect(resolveGroupCollapsed({ userToggled: false, collapsed: true }, false)).toBe(true);
    expect(resolveGroupCollapsed(USER_OPEN, true)).toBe(false);
  });
});

describe("nextGroupFold", () => {
  it("toggle 是唯一会把 userToggled 置真的动作", () => {
    expect(nextGroupFold(undefined, false, "toggle")).toEqual({ userToggled: true, collapsed: true });
    expect(nextGroupFold(undefined, true, "toggle")).toEqual({ userToggled: true, collapsed: false });
    expect(nextGroupFold(undefined, false, "auto-collapse")).toEqual({ userToggled: false, collapsed: true });
    expect(nextGroupFold(undefined, false, "auto-expand")).toEqual({ userToggled: false, collapsed: false });
    expect(nextGroupFold(undefined, false, "pref")).toEqual({ userToggled: false, collapsed: false });
  });

  // 最高优回归用例：手动展开过的过程组，被流式更新 / 自动收起强制收回（原来的 bug：
  // completed = settled || !running 在一轮之内反复 true，justCompleted 效应每次都 setFolded(true) + 收起子卡片）。
  it("用户手动翻过的组，程序自己的 auto-collapse / auto-expand 不改 collapsed", () => {
    expect(nextGroupFold(USER_OPEN, true, "auto-collapse")).toBe(USER_OPEN);
    expect(nextGroupFold(USER_OPEN, true, "auto-expand")).toBe(USER_OPEN);
    expect(nextGroupFold(USER, false, "auto-expand")).toBe(USER);
    expect(nextGroupFold(USER, false, "auto-collapse")).toBe(USER);
  });

  // 设置项是用户主动下的全局指令，连手动翻过的组也一并纠正（E2E：打开「自动收起工具」开关后过程组要跟着收起/展开）。
  it("设置项（pref）能覆盖手动翻过的组，并把 userToggled 清掉", () => {
    expect(nextGroupFold(USER_OPEN, true, "pref")).toEqual({ userToggled: false, collapsed: true });
    expect(nextGroupFold(USER, false, "pref")).toEqual({ userToggled: false, collapsed: false });
    // 纠正之后又回到「跟着程序走」的状态
    expect(nextGroupFold({ userToggled: false, collapsed: true }, false, "auto-expand")).toEqual({
      userToggled: false,
      collapsed: false,
    });
  });

  it("没手动过的组跟着程序走", () => {
    expect(resolveGroupCollapsed(nextGroupFold(undefined, false, "auto-collapse"), false)).toBe(true);
    expect(
      resolveGroupCollapsed(nextGroupFold({ userToggled: false, collapsed: true }, false, "auto-expand"), true),
    ).toBe(false);
    // 设置项翻转
    expect(nextGroupFold({ userToggled: false, collapsed: true }, false, "pref")).toEqual({
      userToggled: false,
      collapsed: false,
    });
  });

  it("用户翻回来之后 toggle 仍按当前值取反", () => {
    const reopened = nextGroupFold(USER, false, "toggle");
    expect(reopened).toEqual({ userToggled: true, collapsed: false });
    expect(nextGroupFold(reopened, true, "auto-collapse")).toEqual({ userToggled: true, collapsed: false });
  });
});

describe("groupFoldKey", () => {
  it("同一轮同一个过程组的键相同，与节点 id 无关", () => {
    const a = groupFoldKey("task-1", "sf-main", 3, 1);
    const b = groupFoldKey("task-1", "sf-main", 3, 1);
    expect(a).toBe(b);
    // 键里只有 (任务, surface, 轮次, 序号) 四段，没有节点 id
    expect(a.split("\u0000")).toEqual(["task-1", "sf-main", "3", "1"]);
  });

  it("序号 / 轮次 / 任务 / surface 任一不同就是不同的键", () => {
    const base = groupFoldKey("task-1", "sf-main", 3, 1);
    expect(
      new Set([
        base,
        groupFoldKey("task-1", "sf-main", 3, 2),
        groupFoldKey("task-1", "sf-main", 4, 1),
        groupFoldKey("task-2", "sf-main", 3, 1),
        groupFoldKey("task-1", "sf-other", 3, 1),
      ]).size,
    ).toBe(5);
  });
});

describe("store 读写", () => {
  const key = groupFoldKey("task-store", "sf-main", 0, 0);

  beforeEach(() => {
    writeGroupFold(key, { userToggled: false, collapsed: false });
  });

  it("write 之后 read 拿得到", () => {
    expect(readGroupFold(key)).toEqual({ userToggled: false, collapsed: false });
    writeGroupFold(key, USER);
    expect(readGroupFold(key)).toEqual(USER);
  });

  it("写入用户翻过的组之后，程序动作写不进去", () => {
    writeGroupFold(key, USER_OPEN);
    // 组件里的 apply 走的就是 nextGroupFold + writeGroupFold；用户手动翻过时 next 是同一个引用，write 直接跳过。
    writeGroupFold(key, nextGroupFold(readGroupFold(key), false, "auto-collapse"));
    writeGroupFold(key, nextGroupFold(readGroupFold(key), true, "auto-expand"));
    expect(readGroupFold(key)).toBe(USER_OPEN);
  });
});

describe("pruneGroupFolds", () => {
  it("只删对应 taskId 前缀的条目", () => {
    const state = {
      [groupFoldKey("task-a", "sf", 0, 0)]: USER,
      [groupFoldKey("task-a", "sf", 1, 0)]: { userToggled: false, collapsed: true },
      [groupFoldKey("task-ab", "sf", 0, 0)]: USER,
      [groupFoldKey("task-b", "sf", 0, 0)]: { userToggled: false, collapsed: false },
    };
    const next = pruneGroupFolds(state, "task-a");
    expect(Object.keys(next).sort()).toEqual(
      [groupFoldKey("task-ab", "sf", 0, 0), groupFoldKey("task-b", "sf", 0, 0)].sort(),
    );
    // 前缀按 `taskId\u0000` 精确比较：task-a 不能把 task-ab 的记录一起删掉
    expect(next[groupFoldKey("task-ab", "sf", 0, 0)]).toBe(USER);
  });

  it("没有该任务的记录时原样返回（不触发 store 通知）", () => {
    const state = { [groupFoldKey("task-b", "sf", 0, 0)]: USER };
    expect(pruneGroupFolds(state, "task-a")).toBe(state);
  });
});

describe("dropGroupFolds", () => {
  it("只清掉这个任务在 store 里的记录", () => {
    const mine = groupFoldKey("task-drop", "sf", 0, 0);
    const other = groupFoldKey("task-keep", "sf", 0, 0);
    writeGroupFold(mine, USER);
    writeGroupFold(other, { userToggled: false, collapsed: true });
    dropGroupFolds("task-drop");
    expect(readGroupFold(mine)).toBeUndefined();
    expect(readGroupFold(other)).toEqual({ userToggled: false, collapsed: true });
  });
});
