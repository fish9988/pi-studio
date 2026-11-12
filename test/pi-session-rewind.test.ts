import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rewindSessionFileBefore } from "../src/main/pi/pi-session-rewind.ts";
import { fileLeafId, readSessionEntries } from "../src/main/tsp/session-tree-file.ts";

const header = JSON.stringify({
  type: "session",
  version: 3,
  id: "sess-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "C:\\work",
});

function user(id: string, parentId: string | null, text: string) {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function assistant(id: string, parentId: string, text: string) {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: [{ type: "text", text }], extra: { keep: true } },
  });
}

async function withSessionJsonl(lines: readonly string[], run: (file: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-studio-rewind-"));
  const file = path.join(dir, "2026-01-01_session.jsonl");
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  try {
    await run(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("rewindSessionFileBefore（就地回退，不分叉）", () => {
  it("把这条用户消息和它之后的内容截掉，叶子回到它的父条目，文件路径不变", async () => {
    const lines = [
      header,
      user("u1", null, "第一轮"),
      assistant("a1", "u1", "回答一"),
      user("u2", "a1", "第二轮"),
      assistant("a2", "u2", "回答二"),
      user("u3", "a2", "第三轮"),
    ];
    await withSessionJsonl(lines, async (file, dir) => {
      const result = await rewindSessionFileBefore(file, "u2");

      expect(result.droppedLines).toBe(3);
      expect(result.leafId).toBe("a1");
      expect(result.backupFile).not.toBeNull();
      expect(path.dirname(result.backupFile as string)).toBe(dir);

      const text = await readFile(file, "utf8");
      expect(text).toBe(`${[header, lines[1], lines[2]].join("\n")}\n`);
      // 叶子 = 文件最后一个条目（pi 打开会话时就是这么认的）。
      expect(fileLeafId(await readSessionEntries(file))).toBe("a1");
      // 被截掉的那一段另存备好了（.bak 不会被 /resume 当成会话列出来）。
      expect(await readFile(result.backupFile as string, "utf8")).toBe(
        `${[lines[3], lines[4], lines[5]].join("\n")}\n`,
      );
      expect((await readdir(dir)).filter((name) => name.endsWith(".jsonl"))).toEqual(["2026-01-01_session.jsonl"]);
    });
  });

  it("回溯到第一条用户消息之前：只剩文件头，叶子为 null", async () => {
    const lines = [header, user("u1", null, "只有一轮"), assistant("a1", "u1", "回答")];
    await withSessionJsonl(lines, async (file) => {
      const result = await rewindSessionFileBefore(file, "u1");

      expect(result.leafId).toBeNull();
      expect(result.droppedLines).toBe(2);
      expect(await readFile(file, "utf8")).toBe(`${header}\n`);
      expect(fileLeafId(await readSessionEntries(file))).toBeNull();
    });
  });

  it("目标前一条是标签 / 用量这类条目时，把父条目挪到最后一行，叶子仍然对", async () => {
    const label = JSON.stringify({
      type: "label",
      id: "l1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      targetId: "a1",
      label: "检查点",
    });
    const lines = [
      header,
      user("u1", null, "第一轮"),
      assistant("a1", "u1", "回答一"),
      label,
      user("u2", "a1", "第二轮"),
    ];
    await withSessionJsonl(lines, async (file) => {
      const result = await rewindSessionFileBefore(file, "u2");

      expect(result.leafId).toBe("a1");
      const kept = (await readFile(file, "utf8")).trimEnd().split("\n");
      expect(kept.at(0)).toBe(header);
      expect(kept.at(-1)).toBe(lines[2]);
      // 标签行还在（父条目挪了位置，靠 parentId 认，不靠行序）。
      expect(kept).toContain(label);
      expect(fileLeafId(await readSessionEntries(file))).toBe("a1");
    });
  });

  it("没写进文件里的条目、以及不是用户消息的条目都拒绝回退", async () => {
    const lines = [header, user("u1", null, "第一轮"), assistant("a1", "u1", "回答一")];
    await withSessionJsonl(lines, async (file) => {
      await expect(rewindSessionFileBefore(file, "nope")).rejects.toThrow(/is not in the session file/);
      // 文件原样不动。
      expect(await readFile(file, "utf8")).toBe(`${lines.join("\n")}\n`);
    });
  });
});
