// 草稿附件（v2）的落盘：src/main/files/draft-attachments.ts。
// 防的是：base64 被写进 drafts.json；同内容重复落盘；旧版（纯字符串）草稿读不回来；脏数据把整份草稿带崩；孤儿附件越攒越多。
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  draftAttachmentDirName,
  draftAttachmentId,
  draftAttachmentMime,
  isDraftAttachmentId,
  maxDraftChars,
  parseDraftSave,
  parseStoredDraft,
  pruneDraftAttachments,
  readDraftAttachment,
  writeDraftAttachment,
} from "../src/main/files/draft-attachments.ts";

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "pi-draft-")), draftAttachmentDirName);
  dirs.push(path.dirname(dir));
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe("附件 id（内容寻址）", () => {
  it("同内容同 mime 是同一个 id，扩展名跟着 mime 走；id 就是文件名", () => {
    const data = base64("webp-bytes");
    const id = draftAttachmentId(data, "image/webp");
    expect(id).toBe(draftAttachmentId(data, "image/webp"));
    expect(id).toMatch(/^[0-9a-f]{64}\.webp$/);
    expect(draftAttachmentId(data, "image/png")).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(draftAttachmentId(data, "image/jpeg")).toMatch(/^[0-9a-f]{64}\.jpg$/);
    expect(isDraftAttachmentId(id)).toBe(true);
    expect(draftAttachmentMime(id!)).toBe("image/webp");
  });
  it("内容不同 id 不同；不是 base64 / mime 不认 / 空内容时 null", () => {
    expect(draftAttachmentId(base64("a"), "image/webp")).not.toBe(draftAttachmentId(base64("b"), "image/webp"));
    expect(draftAttachmentId("not base64!!", "image/webp")).toBeNull();
    expect(draftAttachmentId(base64("a"), "image/avif")).toBeNull();
    expect(draftAttachmentId("", "image/webp")).toBeNull();
    expect(isDraftAttachmentId("../../etc/passwd")).toBe(false);
    expect(draftAttachmentMime("../../etc/passwd")).toBeNull();
  });
});

describe("落盘 / 读回 / 回收孤儿", () => {
  it("落盘后能按 id 读回同样的内容；重复落盘只有一份文件", async () => {
    const dir = await tempDir();
    const data = base64("image-content");
    const id = await writeDraftAttachment(dir, { mimeType: "image/webp", data });
    expect(id).not.toBeNull();
    expect(await writeDraftAttachment(dir, { mimeType: "image/webp", data })).toBe(id);
    expect(await readdir(dir)).toEqual([id!]);
    expect(await readDraftAttachment(dir, id!)).toEqual({ mimeType: "image/webp", data });
    // 不是我们写的文件名、不认识的 id 都读不到。
    expect(await readDraftAttachment(dir, "../drafts.json")).toBeNull();
    expect(await readDraftAttachment(dir, `${"0".repeat(64)}.webp`)).toBeNull();
    expect(await writeDraftAttachment(dir, { mimeType: "image/webp", data: "%%%" })).toBeNull();
  });

  it("回收：只删没人引用的附件，不认识的文件不碰；目录不存在时什么也不做", async () => {
    const dir = await tempDir();
    const kept = await writeDraftAttachment(dir, { mimeType: "image/webp", data: base64("keep") });
    const orphan = await writeDraftAttachment(dir, { mimeType: "image/png", data: base64("orphan") });
    await writeFile(path.join(dir, "notes.txt"), "x");
    expect(await pruneDraftAttachments(dir, new Set([kept!]))).toEqual([orphan!]);
    expect((await readdir(dir)).sort()).toEqual([kept!, "notes.txt"].sort());
    expect(await pruneDraftAttachments(path.join(tmpdir(), "pi-draft-does-not-exist"), new Set())).toEqual([]);
  });
});

describe("读 drafts.json（v1 兼容 + 脏数据）", () => {
  it("旧版纯字符串按只有文字的草稿读回来", () => {
    expect(parseStoredDraft("旧草稿")).toEqual({
      text: "旧草稿",
      pastes: {},
      pasteCounter: 0,
      images: [],
      files: [],
    });
    expect(parseStoredDraft("")).toEqual({ text: "", pastes: {}, pasteCounter: 0, images: [], files: [] });
  });

  it("v2：文字、粘贴、图片元数据、文件路径都在；渲染进程拿不到的那份路径是 null", () => {
    const id = `${"a".repeat(64)}.webp`;
    expect(
      parseStoredDraft({
        text: "[Image #1, 8x6] [Paste #1, +12 lines] [File #1, a.txt]",
        pastes: { 1: "line\nline" },
        pasteCounter: 1,
        images: [{ id, name: "image-1.webp", mimeType: "image/webp", width: 8, height: 6 }],
        files: [
          { id: "f1", name: "a.txt", size: 12, path: "/tmp/a.txt" },
          { id: "f2", name: "b.txt", size: 3, path: "../../etc" },
        ],
      }),
    ).toEqual({
      text: "[Image #1, 8x6] [Paste #1, +12 lines] [File #1, a.txt]",
      pastes: { 1: "line\nline" },
      pasteCounter: 1,
      images: [{ id, name: "image-1.webp", mimeType: "image/webp", width: 8, height: 6 }],
      files: [
        { id: "f1", name: "a.txt", size: 12, path: "/tmp/a.txt" },
        // 不是绝对路径：不认，只占位置（恢复时按不可用丢掉）。
        { id: "f2", name: "b.txt", size: 3, path: null },
      ],
    });
  });

  it("认不出来的条目返回 null（文字超长、不是对象、必填字段坏了）", () => {
    expect(parseStoredDraft("x".repeat(maxDraftChars + 1))).toBeNull();
    expect(parseStoredDraft(42)).toBeNull();
    expect(parseStoredDraft(null)).toBeNull();
    expect(parseStoredDraft({})).toBeNull();
    expect(parseStoredDraft({ text: 1 })).toBeNull();
    expect(parseStoredDraft({ text: "x", pastes: { nope: "y" } })).toBeNull();
    expect(parseStoredDraft({ text: "x", pasteCounter: -1 })).toBeNull();
  });

  it("图片 / 文件数组遇到坏元素就停在它前面（前面的位置编号仍然对得上文字）", () => {
    const good = { id: `${"b".repeat(64)}.png`, name: "a.png", mimeType: "image/png" };
    const parsed = parseStoredDraft({
      text: "x",
      images: [good, { id: "../../drafts.json", name: "evil", mimeType: "image/webp" }, good],
    });
    expect(parsed?.images).toEqual([{ id: good.id, name: "a.png", mimeType: "image/png" }]);
    expect(parsed?.files).toEqual([]);
  });
});

describe("saveDraft 的载荷校验", () => {
  it("旧渲染进程只发字符串：按只有文字的草稿收", () => {
    expect(parseDraftSave("hi")).toEqual({ text: "hi", pastes: {}, pasteCounter: 0, images: [], files: [] });
    expect(parseDraftSave("x".repeat(maxDraftChars + 1))).toBeNull();
  });

  it("图片带 data（第一次存）或只带 id（已经落过盘）都行；两样都没有就停在那里", () => {
    const id = `${"c".repeat(64)}.webp`;
    const data = base64("fresh");
    const parsed = parseDraftSave({
      text: "hi",
      pastes: { 1: "a\nb" },
      pasteCounter: 1,
      images: [
        { name: "old.webp", mimeType: "image/webp", id },
        { name: "new.webp", mimeType: "image/webp", data, width: 4, height: 3 },
        { name: "broken.webp", mimeType: "image/webp" },
        { name: "after.webp", mimeType: "image/webp", data },
      ],
      files: [{ id: "f1", name: "a.txt", size: 1 }],
    });
    expect(parsed?.images).toEqual([
      { id, name: "old.webp", mimeType: "image/webp" },
      { name: "new.webp", mimeType: "image/webp", data, width: 4, height: 3 },
    ]);
    expect(parsed?.files).toEqual([{ id: "f1", name: "a.txt", size: 1 }]);
  });

  it("不是合法 base64 的图片不进草稿；整体形状不对时 null", () => {
    expect(
      parseDraftSave({ text: "", images: [{ name: "x.webp", mimeType: "image/webp", data: "%%%" }] })?.images,
    ).toEqual([]);
    expect(parseDraftSave(42)).toBeNull();
    expect(parseDraftSave({ text: "x", files: [{ id: 1 }] })?.files).toEqual([]);
  });
});
