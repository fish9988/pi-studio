// 草稿附件（v2）的落盘，drafts.json 的搭档：图片按内容 sha256 存到 <userData>/draft-attachments/<sha256>.<ext>，
// drafts.json 里只留 { id, name, mimeType, width, height }（base64 绝不进 drafts.json）；文件附件只记主进程知道的磁盘路径，
// 恢复时重新向 composer-files 登记（路径不返回渲染进程），文件被外部删掉就只占位置、由渲染进程安全丢掉它和它的占位符。
// 这里不 import electron（目录由调用方传），纯函数 + 显式目录，单测见 test/draft-attachments.test.ts。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  limits,
  type ComposerFile,
  type DraftImageSave,
  type PersistedDraft,
  type PersistedDraftImage,
  type PromptImage,
} from "../../shared/ipc.ts";
import { renameWithRetry } from "../tasks/atomic-write.ts";

/** userData 下的目录名。 */
export const draftAttachmentDirName = "draft-attachments";

/** 和渲染进程 draft-store.ts 的 maxPersistedChars 一致。 */
export const maxDraftChars = 200_000;
/** 一段粘贴原文的上限（折叠成 `#N` 芯片的长文本，超出的不是我们写的）。 */
const maxPasteChars = 4_000_000;
const maxPastes = 200;
const maxNameChars = 200;
const maxPathChars = 4096;
/** 一张图片的 base64 上限（渲染进程最多给到 8 张缩放后的 WebP，远小于这个数）。 */
const maxImageDataChars = 32 * 1024 * 1024;

type ImageMime = PromptImage["mimeType"];

const extByMime: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const mimeByExt: Record<string, ImageMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** 附件 id = 内容的 sha256 + 按 mime 定的扩展名；文件名就是 id（和 backdropFilePattern 同一种写法）。 */
const attachmentIdPattern = /^[0-9a-f]{64}\.(?:png|jpe?g|webp|gif)$/;

export function isDraftAttachmentId(value: unknown): value is string {
  return typeof value === "string" && attachmentIdPattern.test(value);
}

/** 落盘的图片记录 → 读内容时的 mime（扩展名推出来，和写的时候一致）。 */
export function draftAttachmentMime(id: string): ImageMime | null {
  return isDraftAttachmentId(id) ? (mimeByExt[id.slice(id.lastIndexOf(".") + 1)] ?? null) : null;
}

/** base64 内容 → 附件 id（不是合法 base64 / 不认识的 mime 时 null）。同内容同 mime 永远同一个 id。 */
export function draftAttachmentId(data: string, mimeType: string): string | null {
  const ext = extByMime[mimeType as ImageMime];
  if (ext === undefined || data.length === 0 || data.length > maxImageDataChars) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) return null;
  return `${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
}

/** 检查某张附件是否完整存在于磁盘上（非 0 字节普通文件）。 */
export async function hasDraftAttachment(dir: string, id: string): Promise<boolean> {
  if (!isDraftAttachmentId(id)) return false;
  const info = await stat(path.join(dir, id)).catch(() => null);
  return info !== null && info.isFile() && info.size > 0;
}

/** 存一张图片（同内容已完整存在时跳过，否则先写临时文件再 rename 防写半截损坏）：返回附件 id，内容不合法时 null。 */
export async function writeDraftAttachment(
  dir: string,
  image: { mimeType: string; data: string },
): Promise<string | null> {
  const id = draftAttachmentId(image.data, image.mimeType);
  if (id === null) return null;
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, id);
  const existing = await stat(target).catch(() => null);
  if (existing !== null && existing.isFile() && existing.size > 0) return id;
  const temp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}-${id}`);
  try {
    await writeFile(temp, Buffer.from(image.data, "base64"));
    await renameWithRetry(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return id;
}

/** 读回一张图片的内容（base64）；id 不合法或文件已被清理掉时 null。 */
export async function readDraftAttachment(dir: string, id: string): Promise<PromptImage | null> {
  const mimeType = draftAttachmentMime(id);
  if (mimeType === null) return null;
  const bytes = await readFile(path.join(dir, id)).catch(() => null);
  return bytes === null ? null : { mimeType, data: bytes.toString("base64") };
}

/** 删掉不再被任何草稿引用的附件文件（孤儿）；返回删掉的 id。目录不存在时什么也不做。 */
export async function pruneDraftAttachments(dir: string, referenced: ReadonlySet<string>): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const entry of entries) {
    if (!isDraftAttachmentId(entry) || referenced.has(entry)) continue;
    const gone = await unlink(path.join(dir, entry)).then(
      () => true,
      () => false,
    );
    if (gone) removed.push(entry);
  }
  return removed;
}

// ───── drafts.json 里的形状（文件附件多一个只留在主进程的路径）─────

/** drafts.json 里的文件附件：比 ComposerFile 多一个磁盘路径。 */
export interface StoredDraftFile extends ComposerFile {
  /** null = 存的时候登记表里就没有这个 id；恢复时按不可用丢掉（占着位置，渲染进程据此重排文字里的占位符）。 */
  path: string | null;
}

/** drafts.json 里的一条草稿。 */
export interface StoredDraft extends Omit<PersistedDraft, "files"> {
  files: StoredDraftFile[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function asInt(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** 逐个解析数组；遇到第一个不认识的元素就停（前面的位置编号仍然对得上文字的占位符）。 */
function collect<T>(value: unknown, max: number, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value.slice(0, max)) {
    const parsed = parse(item);
    if (parsed === null) break;
    out.push(parsed);
  }
  return out;
}

function parsePastes(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (record === null) return null;
  const entries = Object.entries(record).slice(0, maxPastes);
  const pastes: Record<string, string> = {};
  for (const [key, content] of entries) {
    const n = asInt(Number(key), 1, Number.MAX_SAFE_INTEGER);
    const text = asText(content, maxPasteChars);
    if (n === null || text === null) return null;
    pastes[String(n)] = text;
  }
  return pastes;
}

function imagesOf(value: unknown, parse: (item: unknown) => PersistedDraftImage | null): PersistedDraftImage[] {
  return collect(value, limits.promptMaxImages, parse);
}

function parseStoredImage(value: unknown): PersistedDraftImage | null {
  const record = asRecord(value);
  if (record === null || !isDraftAttachmentId(record["id"])) return null;
  const name = asText(record["name"], maxNameChars);
  const mimeType = draftAttachmentMime(record["id"]);
  if (name === null || mimeType === null) return null;
  const width = asInt(record["width"], 1, 100_000);
  const height = asInt(record["height"], 1, 100_000);
  return {
    id: record["id"],
    name,
    mimeType,
    ...(width !== null && height !== null ? { width, height } : {}),
  };
}

function parseStoredFile(value: unknown): StoredDraftFile | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asText(record["id"], 200);
  const name = asText(record["name"], maxNameChars);
  const size = asInt(record["size"], 0, Number.MAX_SAFE_INTEGER);
  if (id === null || name === null || size === null) return null;
  const raw = record["path"];
  const stored = typeof raw === "string" && raw.length > 0 && raw.length <= maxPathChars && path.isAbsolute(raw);
  return { id, name, size, path: stored ? raw : null };
}

/**
 * 读 drafts.json 里的一条：旧版是纯字符串（v1，只有文字），新版是对象。
 * 认不出来（或者文字超长）时返回 null，调用方丢掉这一条，不影响别的草稿。
 */
export function parseStoredDraft(value: unknown): StoredDraft | null {
  if (typeof value === "string") {
    return value.length <= maxDraftChars ? { text: value, pastes: {}, pasteCounter: 0, images: [], files: [] } : null;
  }
  const record = asRecord(value);
  if (record === null) return null;
  const text = asText(record["text"], maxDraftChars);
  const pastes = parsePastes(record["pastes"]);
  const pasteCounter = asInt(record["pasteCounter"] ?? 0, 0, Number.MAX_SAFE_INTEGER);
  if (text === null || pastes === null || pasteCounter === null) return null;
  return {
    text,
    pastes,
    pasteCounter,
    images: imagesOf(record["images"], parseStoredImage),
    files: collect(record["files"], limits.promptMaxFiles, parseStoredFile),
  };
}

// ───── 渲染进程传来的保存载荷 ─────

export interface ParsedDraftSave {
  text: string;
  pastes: Record<string, string>;
  pasteCounter: number;
  images: DraftImageSave[];
  files: ComposerFile[];
}

function parseSaveImage(value: unknown): DraftImageSave | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = asText(record["name"], maxNameChars);
  const mimeType = record["mimeType"];
  const ext = typeof mimeType === "string" ? extByMime[mimeType as ImageMime] : undefined;
  if (name === null || ext === undefined) return null;
  const data = typeof record["data"] === "string" ? asText(record["data"], maxImageDataChars) : null;
  const id = isDraftAttachmentId(record["id"]) ? record["id"] : null;
  // 有 base64（第一次存）或者有已经落过盘的 id，否则这条图片没法落地。
  if (data === null && id === null) return null;
  if (data !== null && draftAttachmentId(data, mimeType as string) === null) return null;
  const width = asInt(record["width"], 1, 100_000);
  const height = asInt(record["height"], 1, 100_000);
  return {
    name,
    mimeType: mimeType as ImageMime,
    ...(id !== null ? { id } : {}),
    ...(data !== null ? { data } : {}),
    ...(width !== null && height !== null ? { width, height } : {}),
  };
}

function parseSaveFile(value: unknown): ComposerFile | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asText(record["id"], 200);
  const name = asText(record["name"], maxNameChars);
  const size = asInt(record["size"], 0, Number.MAX_SAFE_INTEGER);
  return id === null || name === null || size === null ? null : { id, name, size };
}

/** 校验 saveDraft 的载荷（旧渲染进程只发文字，按 v1 收）。认不出来时 null，由 handler 报 IPC 参数错误。 */
export function parseDraftSave(value: unknown): ParsedDraftSave | null {
  if (typeof value === "string") {
    return value.length <= maxDraftChars ? { text: value, pastes: {}, pasteCounter: 0, images: [], files: [] } : null;
  }
  const record = asRecord(value);
  if (record === null) return null;
  const text = asText(record["text"], maxDraftChars);
  const pastes = parsePastes(record["pastes"]);
  const pasteCounter = asInt(record["pasteCounter"] ?? 0, 0, Number.MAX_SAFE_INTEGER);
  if (text === null || pastes === null || pasteCounter === null) return null;
  return {
    text,
    pastes,
    pasteCounter,
    images: collect(record["images"], limits.promptMaxImages, parseSaveImage),
    files: collect(record["files"], limits.promptMaxFiles, parseSaveFile),
  };
}

/** 空草稿（不占 drafts.json 的条目）。 */
export function isEmptyDraft(draft: { text: string; images: unknown[]; files: unknown[]; pastes: object }): boolean {
  return (
    draft.text === "" && draft.images.length === 0 && draft.files.length === 0 && Object.keys(draft.pastes).length === 0
  );
}
