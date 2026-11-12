// 右侧文件预览的读取：路径校验复用 task-file-path（只允许落在任务 cwd 内），按扩展名/内容分类，限制大小。
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PreviewFile } from "../../shared/ipc.ts";
import { canOpenDirectly, resolveInside, resolveInsideReal } from "../ipc/task-file-path.ts";
import { isMissing } from "./list-directory.ts";

const previewTextMaxBytes = 2 * 1024 * 1024;
const previewImageMaxBytes = 20 * 1024 * 1024;

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
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const isHtml = (ext: string): boolean => ext === ".html" || ext === ".htm";

/** 绝对路径（含 `file:///C:/...` 或前导 `/C:/...`）落在 cwd 内时换算成相对路径；其余原样交给 resolveInside 校验。 */
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
  cleaned = cleaned.replace(/#L\d+(?:-L?\d+)?.*$/i, "").replace(/(?<!^[A-Za-z]):\d+(?:[:-]\d+)?$/, "");
  if (!path.isAbsolute(cleaned) && !path.win32.isAbsolute(cleaned)) return cleaned;
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(cwd) && /^[a-zA-Z]:/.test(cleaned)) {
    if (cwd[0]!.toLowerCase() === cleaned[0]!.toLowerCase()) {
      cleaned = cwd[0]! + cleaned.slice(1);
    }
  }
  const relative = path.relative(cwd, cleaned);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? cleaned : relative;
}
export async function readPreviewFile(cwd: string, input: string): Promise<PreviewFile> {
  const relPath = toRelative(cwd, input);
  const normalized = path.normalize(relPath);
  // 词法校验先于磁盘访问：越界直接抛错，不泄露文件是否存在。
  resolveInside(cwd, normalized);
  let file: string;
  try {
    file = await resolveInsideReal(cwd, normalized);
  } catch (error) {
    if (isMissing(error)) return { kind: "missing", path: normalized, size: 0, canOpen: false };
    throw error;
  }
  const info = await stat(file);
  if (!info.isFile()) return { kind: "missing", path: normalized, size: 0, canOpen: false };
  const ext = path.extname(file).toLowerCase();
  const base = { path: normalized, size: info.size, canOpen: canOpenDirectly(file) };

  const mime = imageMime[ext];
  if (mime !== undefined) {
    if (info.size > previewImageMaxBytes) return { ...base, kind: "too_large" };
    const bytes = await readFile(file);
    const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    if (ext === ".svg" && info.size <= previewTextMaxBytes) {
      return { ...base, kind: "image", dataUrl, text: bytes.toString("utf8") };
    }
    return { ...base, kind: "image", dataUrl };
  }
  const embedMime = mediaMime[ext];
  if (embedMime !== undefined) {
    if (info.size > previewImageMaxBytes) return { ...base, kind: "too_large" };
    const bytes = await readFile(file);
    return { ...base, kind: "binary", dataUrl: `data:${embedMime};base64,${bytes.toString("base64")}` };
  }
  if (info.size > previewTextMaxBytes) return { ...base, kind: "too_large" };
  const bytes = await readFile(file);
  // 前 8000 字节含 NUL 视为二进制（和 git 的判断一致）。
  if (bytes.subarray(0, 8000).includes(0)) return { ...base, kind: "binary" };
  return { ...base, kind: isHtml(ext) ? "html" : "text", text: bytes.toString("utf8") };
}
