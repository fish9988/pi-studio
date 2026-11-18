// 右侧文件预览的读取：路径校验复用 task-file-path（只允许落在任务 cwd 内），按扩展名/内容分类，限制大小。
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { OfficePreviewKind, PreviewFile } from "../../shared/ipc.ts";
import { canOpenDirectly, resolveInside, resolveInsideReal } from "../ipc/task-file-path.ts";
import { isMissing } from "./list-directory.ts";

const previewTextMaxBytes = 2 * 1024 * 1024;
const previewImageMaxBytes = 20 * 1024 * 1024;
const previewOfficeMaxBytes = 30 * 1024 * 1024;
const previewPdfMaxBytes = 200 * 1024 * 1024;
export const previewRangeMaxBytes = 2 * 1024 * 1024;

const imageMime: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

const mediaMime: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const officeKinds: Record<string, OfficePreviewKind> = {
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".xls": "xlsx",
};

const isHtml = (ext: string): boolean => ext === ".html" || ext === ".htm";

/** 绝对路径（含 `file:///C:/...` 或前导 `/C:/...`）落在 cwd 内时换算成相对路径；其余原样交给 resolveInside 校验。 */
export function stripPreviewFragment(input: string): string {
  return input
    .trim()
    .replace(/#(?:L\d+(?:-L?\d+)?|page[:=]\d+(?:-\d+)?).*$/i, "")
    .replace(/(?<!^[A-Za-z]):\d+(?:[:-]\d+)?$/, "");
}

function toRelative(cwd: string, input: string): string {
  let cleaned = input.trim();
  if (/^file:\/\//i.test(cleaned)) {
    try {
      cleaned = decodeURIComponent(cleaned.replace(/^file:\/\//i, ""));
    } catch {
      cleaned = cleaned.replace(/^file:\/\//i, "");
    }
  }
  if (/^\/+[A-Za-z]:[\\/]/.test(cleaned)) {
    cleaned = cleaned.replace(/^\/+/, "");
  }
  cleaned = stripPreviewFragment(cleaned);
  if (!path.isAbsolute(cleaned) && !path.win32.isAbsolute(cleaned)) return cleaned;
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(cwd) && /^[a-zA-Z]:/.test(cleaned)) {
    if (cwd[0]!.toLowerCase() === cleaned[0]!.toLowerCase()) {
      cleaned = cwd[0]! + cleaned.slice(1);
    }
  }
  const relative = path.relative(cwd, cleaned);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? cleaned : relative;
}

export async function resolvePreviewRealFile(
  cwd: string,
  input: string,
): Promise<{ normalized: string; file: string; size: number } | { normalized: string; missing: true }> {
  const relPath = toRelative(cwd, input);
  const normalized = path.normalize(relPath);
  // 词法校验先于磁盘访问：越界直接抛错，不泄露文件是否存在。
  resolveInside(cwd, normalized);
  let file: string;
  try {
    file = await resolveInsideReal(cwd, normalized);
  } catch (error) {
    if (isMissing(error)) return { normalized, missing: true };
    throw error;
  }
  const info = await stat(file);
  if (!info.isFile()) return { normalized, missing: true };
  return { normalized, file, size: info.size };
}

export async function readPreviewFile(cwd: string, input: string): Promise<PreviewFile> {
  const resolved = await resolvePreviewRealFile(cwd, input);
  if ("missing" in resolved) return { kind: "missing", path: resolved.normalized, size: 0, canOpen: false };
  const { normalized, file, size } = resolved;
  const ext = path.extname(file).toLowerCase();
  const base = { path: normalized, size, canOpen: canOpenDirectly(file) };

  if (ext === ".pdf") {
    if (size > previewPdfMaxBytes) return { ...base, kind: "too_large" };
    return { ...base, kind: "pdf", totalBytes: size };
  }

  const officeKind = officeKinds[ext];
  if (officeKind !== undefined) {
    if (size > previewOfficeMaxBytes) return { ...base, kind: "too_large" };
    return { ...base, kind: "office", officeKind, totalBytes: size };
  }

  const mime = imageMime[ext];
  if (mime !== undefined) {
    if (size > previewImageMaxBytes) return { ...base, kind: "too_large" };
    const bytes = await readFile(file);
    const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    if (ext === ".svg" && size <= previewTextMaxBytes) {
      return { ...base, kind: "image", dataUrl, text: bytes.toString("utf8") };
    }
    return { ...base, kind: "image", dataUrl };
  }
  const embedMime = mediaMime[ext];
  if (embedMime !== undefined) {
    if (size > previewImageMaxBytes) return { ...base, kind: "too_large" };
    const bytes = await readFile(file);
    return { ...base, kind: "binary", dataUrl: `data:${embedMime};base64,${bytes.toString("base64")}` };
  }
  if (size > previewTextMaxBytes) return { ...base, kind: "too_large" };
  const bytes = await readFile(file);
  // 前 8000 字节含 NUL 视为二进制（和 git 的判断一致）。
  if (bytes.subarray(0, 8000).includes(0)) return { ...base, kind: "binary" };
  return { ...base, kind: isHtml(ext) ? "html" : "text", text: bytes.toString("utf8") };
}

export async function readPreviewRange(
  cwd: string,
  input: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const resolved = await resolvePreviewRealFile(cwd, input);
  if ("missing" in resolved) throw new Error("file not found");
  if (resolved.size > previewPdfMaxBytes) throw new Error("file is too large to preview");
  if (offset < 0 || offset >= resolved.size) return new Uint8Array(0);
  const clampedLength = Math.min(length, previewRangeMaxBytes, resolved.size - offset);
  if (clampedLength <= 0) return new Uint8Array(0);
  const buf = new Uint8Array(clampedLength);
  const handle = await open(resolved.file, "r");
  try {
    const { bytesRead } = await handle.read(buf, 0, clampedLength, offset);
    return bytesRead === clampedLength ? buf : buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readPreviewBytes(cwd: string, input: string): Promise<Uint8Array> {
  const resolved = await resolvePreviewRealFile(cwd, input);
  if ("missing" in resolved) throw new Error("file not found");
  const ext = path.extname(resolved.file).toLowerCase();
  const limit = ext === ".pdf" ? previewPdfMaxBytes : previewOfficeMaxBytes;
  if (resolved.size > limit) throw new Error("file is too large to preview");
  const bytes = await readFile(resolved.file);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
