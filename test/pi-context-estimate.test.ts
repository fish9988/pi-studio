import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSessionBranchTokens } from "../src/main/pi/pi-context-estimate.ts";

describe("analyzeSessionBranchTokens（DSH compact 压缩后与历史会话上下文估算）", () => {
  it("当最新条目为 dsh-compact 的 compaction 时，忽略压缩前旧 usage，按压缩摘要 + 保留消息计算真实投影上下文", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-ctx-est-"));
    try {
      const file = path.join(dir, "session.jsonl");
      const dshSummary = [
        "## 1. Primary Request and Intent",
        "重构右侧多标签工作台并支持 Claude Code 双模式主题。",
        "## 2. Key Technical Concepts",
        "Electron + React + TypeScript + Pi RPC.",
      ].join("\n");
      const lines = [
        JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir }),
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: null,
          message: { role: "user", content: [{ type: "text", text: "第一轮很长的历史请求" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          parentId: "u1",
          message: {
            role: "assistant",
            stopReason: "stop",
            usage: { input: 120_000, output: 2_000, cacheRead: 0, cacheWrite: 0, totalTokens: 122_000 },
            content: [{ type: "text", text: "压缩前的回复" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "u2",
          parentId: "a1",
          message: { role: "user", content: [{ type: "text", text: "保留在压缩点之后的最新用户指令" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "c1",
          parentId: "u2",
          tokensBefore: 125_000,
          firstKeptEntryId: "u2",
          summary: dshSummary,
        }),
      ];
      await writeFile(file, `${lines.join("\n")}\n`, "utf8");

      const res = await analyzeSessionBranchTokens(file, 2700);
      expect(res).not.toBeNull();
      expect(res!.hasCompaction).toBe(true);
      expect(res!.exactUsage).toBe(false);
      expect(res!.compactionTokensBefore).toBe(125_000);
      expect(res!.compactionTokens).toBeGreaterThan(20);
      expect(res!.userTokens).toBeGreaterThan(0);
      // 绝不沿用压缩前 122,000，也绝不退化为 0
      expect(res!.estimatedTotalTokens).toBeGreaterThan(2720);
      expect(res!.estimatedTotalTokens).toBeLessThan(10_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("压缩之后若有新一轮助手回复，优先采用新回复的精确 usage", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-ctx-est-post-"));
    try {
      const file = path.join(dir, "session.jsonl");
      const lines = [
        JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir }),
        JSON.stringify({
          type: "compaction",
          id: "c1",
          parentId: null,
          tokensBefore: 140_000,
          firstKeptEntryId: "u2",
          summary: "DSH 8章节摘要内容",
        }),
        JSON.stringify({
          type: "message",
          id: "u2",
          parentId: "c1",
          message: { role: "user", content: [{ type: "text", text: "继续下一步" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "a2",
          parentId: "u2",
          message: {
            role: "assistant",
            stopReason: "stop",
            usage: { input: 8_400, output: 600, cacheRead: 1_000, cacheWrite: 0, totalTokens: 10_000 },
            content: [{ type: "text", text: "好的，继续执行。" }],
          },
        }),
      ];
      await writeFile(file, `${lines.join("\n")}\n`, "utf8");

      const res = await analyzeSessionBranchTokens(file, 2700);
      expect(res).not.toBeNull();
      expect(res!.exactUsage).toBe(true);
      expect(res!.estimatedTotalTokens).toBe(10_000);
      expect(res!.compactionTokens).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
