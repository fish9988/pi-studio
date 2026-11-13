import { describe, expect, it } from "vitest";
import { shouldLogTaskkillFailure } from "../src/main/platform/win32/process-tree.ts";

const errorWith = (message: string, extra: { code?: unknown; killed?: unknown }): Error =>
  Object.assign(new Error(message), extra);

describe("shouldLogTaskkillFailure（taskkill 失败要不要记日志）", () => {
  it("进程已经自己退出（退出码 128）不算失败，不记", () => {
    expect(shouldLogTaskkillFailure(errorWith("taskkill failed", { code: 128, killed: false }))).toBe(false);
  });

  it("被超时或信号强制结束的 taskkill 不记", () => {
    expect(shouldLogTaskkillFailure(errorWith("killed", { killed: true, code: null }))).toBe(false);
    expect(shouldLogTaskkillFailure(errorWith("killed", { killed: true, code: 128 }))).toBe(false);
  });

  it("找不到 taskkill.exe、权限拒绝、参数错误这些真实失败要记", () => {
    expect(shouldLogTaskkillFailure(errorWith("spawn taskkill.exe ENOENT", { code: "ENOENT" }))).toBe(true);
    expect(shouldLogTaskkillFailure(errorWith("Access is denied.", { code: 1 }))).toBe(true);
    expect(shouldLogTaskkillFailure(errorWith("ERROR: Invalid argument/option", { code: 5 }))).toBe(true);
    expect(shouldLogTaskkillFailure(errorWith("generic", {}))).toBe(true);
  });

  it("没有错误时什么都不记", () => {
    expect(shouldLogTaskkillFailure(null)).toBe(false);
    expect(shouldLogTaskkillFailure(undefined)).toBe(false);
  });

  it("非对象的失败按真实失败处理（宁可多记一行也不静默吞掉）", () => {
    expect(shouldLogTaskkillFailure("boom")).toBe(true);
  });
});
