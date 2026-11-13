// 输入框草稿的持久化（userData/drafts.json）：切任务、重启应用都不丢字，也不丢大段粘贴和图片附件。
// v2：文字原样保留占位符（`[Image #N]` / `[Paste #N]` / `[File #N]`），粘贴原文整段带着，图片只存元数据——
// 内容按 sha256 放在 userData/draft-attachments（base64 不进 drafts.json，见 files/draft-attachments.ts），文件附件只存主进程知道的路径。
// 旧版是纯字符串（v1，只存文字），照样能读。key 是任务 id 或 `new:<projectId>`（空状态里的草稿）；渲染进程传来的都当不可信，限长限量。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { HandlerGroup, PersistedDraft, PersistedDraftImage } from "../../shared/ipc.ts";
import { stripBom } from "../../shared/strip-bom.ts";
import { composerFilePath, registerComposerFileAt } from "../files/composer-files.ts";
import {
  draftAttachmentDirName,
  draftAttachmentId,
  hasDraftAttachment,
  isEmptyDraft,
  isDraftAttachmentId,
  parseDraftSave,
  parseStoredDraft,
  pruneDraftAttachments,
  readDraftAttachment,
  writeDraftAttachment,
  type StoredDraft,
  type StoredDraftFile,
} from "../files/draft-attachments.ts";
import { writeFileAtomic } from "../tasks/atomic-write.ts";
import { IpcValidationError, parseString } from "./validate.ts";

const maxDrafts = 300;

let cache: Map<string, StoredDraft> | null = null;
let writing: Promise<void> = Promise.resolve();
/** 正在落盘但尚未写进 drafts Map 的附件引用计数，避免并发保存时被前一次的孤儿清理误删。 */
const pendingAttachmentCounts = new Map<string, number>();

function holdPendingAttachment(id: string): void {
  pendingAttachmentCounts.set(id, (pendingAttachmentCounts.get(id) ?? 0) + 1);
}

function releasePendingAttachment(id: string): void {
  const n = (pendingAttachmentCounts.get(id) ?? 0) - 1;
  if (n <= 0) pendingAttachmentCounts.delete(id);
  else pendingAttachmentCounts.set(id, n);
}

const file = () => path.join(app.getPath("userData"), "drafts.json");
const attachmentDir = () => path.join(app.getPath("userData"), draftAttachmentDirName);

async function load(): Promise<Map<string, StoredDraft>> {
  if (cache) return cache;
  try {
    const raw: unknown = JSON.parse(stripBom(await readFile(file(), "utf8")));
    const entries =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? Object.entries(raw as Record<string, unknown>)
        : [];
    cache = new Map(
      entries.flatMap(([key, value]) => {
        const draft = parseStoredDraft(value);
        return draft === null ? [] : [[key, draft] as [string, StoredDraft]];
      }),
    );
  } catch (error) {
    // 只有文件不存在才是"还没有草稿"；其它错误（EBUSY…）抛给调用方，免得下一次保存把原文件覆盖成空的。
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    cache = new Map();
  }
  return cache;
}

/** 没人引用的附件文件（孤儿）删掉：合并当前保存快照与进行中的写盘 id，绝不误删并发刚写下的图片。 */
async function pruneOrphans(snapshotIds: ReadonlySet<string>): Promise<void> {
  const protectedIds = new Set<string>(snapshotIds);
  for (const id of pendingAttachmentCounts.keys()) protectedIds.add(id);
  await pruneDraftAttachments(attachmentDir(), protectedIds).catch(() => []);
}

function collectReferencedIds(drafts: Map<string, StoredDraft>): Set<string> {
  const ids = new Set<string>();
  for (const draft of drafts.values()) for (const image of draft.images) ids.add(image.id);
  return ids;
}

function persist(drafts: Map<string, StoredDraft>): Promise<void> {
  const snapshot = JSON.stringify(Object.fromEntries(drafts));
  const snapshotIds = collectReferencedIds(drafts);
  // 串行写，先写临时文件再改名。一次失败不连累后面的写入；这次的错误返回给 saveDraft，由调用方看到。
  const run = writing.then(() => writeFileAtomic(file(), snapshot, "draft")).then(() => pruneOrphans(snapshotIds));
  writing = run.catch(() => {});
  return run;
}

/** 任务删除/归档后去掉它的草稿；不然条目一直占着 maxDrafts，攒满后新任务存不了草稿。 */
export async function forgetDraft(taskId: string): Promise<void> {
  const drafts = await load();
  if (drafts.delete(taskId)) await persist(drafts);
}

/**
 * drafts.json 里的一条 → 渲染进程用的草稿：纯文字的照旧返回字符串（v1 形状，最省）；带附件的返回 v2，
 * 文件重新登记（路径不给渲染进程），已不在磁盘上的占位成 null。
 */
async function toPersistedDraft(draft: StoredDraft): Promise<string | PersistedDraft> {
  if (draft.images.length === 0 && draft.files.length === 0 && Object.keys(draft.pastes).length === 0) {
    return draft.text;
  }
  const files = await Promise.all(
    draft.files.map((entry) => (entry.path === null ? Promise.resolve(null) : registerComposerFileAt(entry.path))),
  );
  return { text: draft.text, pastes: draft.pastes, pasteCounter: draft.pasteCounter, images: draft.images, files };
}

export const draftHandlers: HandlerGroup<"getDrafts" | "saveDraft" | "getDraftAttachment"> = {
  async getDrafts() {
    const drafts = await load();
    const list = [...drafts.entries()];
    const result: (readonly [string, string | PersistedDraft])[] = [];
    // 分批恢复文件附件登记，避免上百条草稿同时打开海量 stat 句柄。
    const batchSize = 8;
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = await Promise.all(
        list.slice(i, i + batchSize).map(async ([key, draft]) => [key, await toPersistedDraft(draft)] as const),
      );
      result.push(...batch);
    }
    return Object.fromEntries(result);
  },

  async saveDraft(key, value) {
    const k = parseString(key, "key", 220);
    const draft = parseDraftSave(value);
    if (draft === null) throw new IpcValidationError("草稿格式不对");
    const drafts = await load();
    const empty = isEmptyDraft(draft);
    if (!empty && !drafts.has(k) && drafts.size >= maxDrafts) throw new Error("too many drafts");
    // 先把图片落到磁盘（同内容同一个文件名，重复保存不会多写），期间登记 pending 防止并发孤儿清理误删。
    const heldIds: string[] = [];
    const images: PersistedDraftImage[] = [];
    try {
      for (const image of draft.images) {
        let id: string | null = null;
        if (image.data === undefined) {
          if (isDraftAttachmentId(image.id) && (await hasDraftAttachment(attachmentDir(), image.id))) {
            id = image.id;
            holdPendingAttachment(id);
            heldIds.push(id);
          }
        } else {
          const candidateId = draftAttachmentId(image.data, image.mimeType);
          if (candidateId !== null) {
            holdPendingAttachment(candidateId);
            heldIds.push(candidateId);
            id = await writeDraftAttachment(attachmentDir(), { mimeType: image.mimeType, data: image.data });
          }
        }
        // 单张失效或缺失时跳过该项，不截断后面的合法图片。
        if (id === null) continue;
        images.push({
          id,
          name: image.name,
          mimeType: image.mimeType,
          ...(image.width !== undefined && image.height !== undefined && { width: image.width, height: image.height }),
        });
      }
      const files: StoredDraftFile[] = draft.files.map((entry) => ({
        ...entry,
        path: composerFilePath(entry.id) ?? null,
      }));
      if (empty) drafts.delete(k);
      else drafts.set(k, { text: draft.text, pastes: draft.pastes, pasteCounter: draft.pasteCounter, images, files });
      await persist(drafts);
      return images;
    } finally {
      for (const id of heldIds) releasePendingAttachment(id);
    }
  },

  async getDraftAttachment(id) {
    return readDraftAttachment(attachmentDir(), parseString(id, "id", 200));
  },
};
