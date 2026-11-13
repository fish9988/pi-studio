// 输入框草稿（按任务）：内存里一份，经主进程防抖存盘（下面的持久化段）。
// v2 落盘：文字原样保留占位符，大段粘贴原文带着，图片按内容 sha256 存在 userData/draft-attachments（drafts.json 里只有 id），
// 文件附件只存主进程知道的路径；重启后按需读回图片内容，附件丢了就安全丢掉它和它的占位符，不阻塞输入。
import { reportErrorNow } from "../../ui/errors.ts";
import type { DraftSave, PersistedDraft, PersistedDraftImage, RestoredDraft, TaskId } from "../../../../shared/ipc.ts";
import { createStore, useStoreValue } from "../../store/create-store.ts";
import {
  adoptPersistedDraft,
  appendDraft,
  draftFromRestored,
  EMPTY_DRAFT,
  persistedText,
  type Draft,
  type DraftImage,
} from "./composer-tokens.ts";
import { commitFieldHeight } from "./field-height-store.ts";
export type { Draft } from "./composer-tokens.ts";

/** 和主进程 files/draft-attachments.ts 的 maxDraftChars 一致。 */
const maxPersistedChars = 200_000;

const drafts = createStore<Readonly<Record<string, Draft>>>({});

export function useDraft(taskId: TaskId): Draft {
  return useStoreValue(drafts, (state) => state[taskId] ?? EMPTY_DRAFT);
}

export function getDraft(taskId: TaskId): Draft {
  return drafts.get()[taskId] ?? EMPTY_DRAFT;
}

export function setDraft(taskId: TaskId, draft: Draft): void {
  drafts.set({ ...drafts.get(), [taskId]: draft });
  scheduleSave(taskId, draft);
}

/** 换掉文字；顶部已挂载的附件（图片、文件、大段粘贴）与文字解耦保留，仅在点击附件卡片右上角 × 时移除。 */
export function setDraftText(taskId: TaskId, text: string): void {
  setDraft(taskId, { ...getDraft(taskId), text });
}
/** 清空草稿（发送后）：同时复原手动拉高的输入框高度，回到紧凑单行。 */
export function clearDraft(taskId: TaskId): void {
  // 清空后这些图片会在主进程被当成孤儿回收：忘掉已经落盘的 id，万一发送失败被放回来，会重新传 base64。
  for (const image of getDraft(taskId).images) savedImages.delete(image);
  setDraft(taskId, EMPTY_DRAFT);
  commitFieldHeight(null);
}

// ───── 持久化：经主进程存盘（防抖）；图片内容按内容 sha256 存在主进程的 draft-attachments ─────
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, Draft>();
const touched = new Set<string>();
const lastSaved = new Map<string, string>();
/** 已落盘的图片：同一个 DraftImage 对象只把 base64 交给主进程一次（内容寻址，重复存也不会多写）。 */
const savedImages = new WeakMap<object, PersistedDraftImage>();
/** 图片对象的身份编号：没落过盘的两张图靠它区分（内容一样时主进程自己会去重）。 */
const imageTokens = new WeakMap<object, number>();
let imageTokenSeq = 0;

function imageToken(image: DraftImage): number {
  const known = imageTokens.get(image);
  if (known !== undefined) return known;
  const token = (imageTokenSeq += 1);
  imageTokens.set(image, token);
  return token;
}

/** 落盘用的图片名（只在 drafts.json 里给人看，不参与读写内容）。 */
function imageName(image: DraftImage): string {
  const ext = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice("image/".length);
  return `image-${imageToken(image)}.${ext}`;
}

/** 草稿的内容签名：和上次存的一样就不重复发给主进程。 */
function signature(draft: Draft): string {
  return JSON.stringify([
    draft.text,
    draft.pasteCounter,
    Object.keys(draft.pastes).sort((a, b) => Number(a) - Number(b)),
    draft.images.map((image) => savedImages.get(image)?.id ?? `new:${imageToken(image)}`),
    draft.files.map((file) => file.id),
  ]);
}

/** 落盘载荷：纯文字的草稿照旧存字符串（drafts.json 里最省），带附件 / 粘贴的存 v2。 */
function savePayload(draft: Draft): DraftSave | string {
  if (draft.images.length === 0 && draft.files.length === 0 && Object.keys(draft.pastes).length === 0) {
    return persistedText(draft, maxPersistedChars);
  }
  return {
    text: draft.text,
    pastes: draft.pastes,
    pasteCounter: draft.pasteCounter,
    images: draft.images.map((image) => {
      const saved = savedImages.get(image);
      if (saved !== undefined) return saved;
      return {
        name: imageName(image),
        mimeType: image.mimeType,
        data: image.data,
        ...(image.width !== undefined && image.height !== undefined && { width: image.width, height: image.height }),
      };
    }),
    files: draft.files.map((file) => ({ id: file.id, name: file.name, size: file.size })),
  };
}

function scheduleSave(key: string, draft: Draft): void {
  touched.add(key);
  const current = signature(draft);
  if (lastSaved.get(key) === current) return;
  clearTimeout(saveTimers.get(key));
  pending.set(key, draft);
  saveTimers.set(
    key,
    setTimeout(() => flushKey(key), 400),
  );
}

function flushKey(key: string): void {
  clearTimeout(saveTimers.get(key));
  saveTimers.delete(key);
  const draft = pending.get(key);
  pending.delete(key);
  if (draft === undefined) return;
  lastSaved.set(key, signature(draft));
  window.studio.saveDraft(key, savePayload(draft)).then(
    (images) => {
      draft.images.forEach((image, index) => {
        const saved = images[index];
        if (saved !== undefined) savedImages.set(image, saved);
      });
      // 记下的 id 让签名变了：把当前草稿的签名对齐，免得紧接着又存一次。
      lastSaved.set(key, signature(drafts.get()[key] ?? draft));
    },
    (error: unknown) => {
      lastSaved.delete(key);
      reportErrorNow(error);
    },
  );
}

/** 立刻把还在防抖里的草稿发给主进程：关窗、刷新、切后台时调用，否则最后几个字会丢。 */
function flushDrafts(): void {
  // 先拷一份 key：flushKey 会从 pending 里删。
  for (const key of Array.from(pending.keys())) flushKey(key);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDrafts);
  window.addEventListener("beforeunload", flushDrafts);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushDrafts());
}

// 任务删除：内存里的草稿、待存的定时器和记录一并丢（主进程那边的 drafts.json 条目由主进程删）。草稿页的键是按项目的，不会等于任务 id。
if (typeof window !== "undefined" && "studio" in window) {
  window.studio.onTaskRemoved((taskId) => {
    clearTimeout(saveTimers.get(taskId));
    saveTimers.delete(taskId);
    pending.delete(taskId);
    touched.delete(taskId);
    lastSaved.delete(taskId);
    const { [taskId]: _removed, ...rest } = drafts.get();
    drafts.set(rest);
  });
}

/** 落盘的一条草稿 → 内存里的草稿：v2 的图片内容按需从主进程读回，读不到（文件被回收）的那张丢掉。 */
async function adopt(value: string | PersistedDraft): Promise<Draft> {
  if (typeof value === "string") return { ...EMPTY_DRAFT, text: value };
  const images = await Promise.all(
    value.images.map(async (record): Promise<DraftImage | null> => {
      const data = await window.studio.getDraftAttachment(record.id).catch(() => null);
      if (data === null) return null;
      return {
        mimeType: data.mimeType,
        data: data.data,
        ...(record.width !== undefined &&
          record.height !== undefined && { width: record.width, height: record.height }),
      };
    }),
  );
  const draft = adoptPersistedDraft(value, images, value.files);
  // 已经落过盘的图片记下 id：下次保存只发 id，不再重复传 base64。
  const records = value.images.filter((_, index) => (images[index] ?? null) !== null);
  draft.images.forEach((image, index) => {
    const record = records[index];
    if (record !== undefined) savedImages.set(image, record);
  });
  return draft;
}

/** 启动时把已存的草稿读回来；用户在读回来之前已经打过字的 key 不覆盖。 */
if (typeof window !== "undefined" && "studio" in window) {
  window.studio.getDrafts().then(async (saved) => {
    const entries = await Promise.all(
      Object.entries(saved).map(async ([key, value]) => [key, await adopt(value)] as const),
    );
    const restored: Record<string, Draft> = {};
    for (const [key, draft] of entries) {
      if (touched.has(key)) continue;
      lastSaved.set(key, signature(draft));
      restored[key] = draft;
    }
    drafts.set({ ...restored, ...drafts.get() });
  }, reportErrorNow);
}

/** 把撤回 / 预填的消息放回草稿末尾（空行分隔，图片作为附件）。 */
export function appendToDraft(taskId: TaskId, restored: readonly RestoredDraft[]): void {
  setDraft(taskId, appendDraft(getDraft(taskId), draftFromRestored(restored)));
}

/** 发送失败：把整份草稿（文字、图片、大段粘贴）接回现在的草稿后面。 */
export function restoreDraft(taskId: TaskId, draft: Draft): void {
  setDraft(taskId, appendDraft(getDraft(taskId), draft));
}

/** omp 往它自己（studio 不画）的输入框里写了草稿（Ctrl+R 选中的历史、排队消息的 Edit、`/annotate`、`/plan` 预填，可带图片）：主进程已清空那边，接进这个任务的草稿。 */
if (typeof window !== "undefined" && "studio" in window) {
  window.studio.onComposerPrefill(({ taskId, draft }) => appendToDraft(taskId, [draft]));
}
