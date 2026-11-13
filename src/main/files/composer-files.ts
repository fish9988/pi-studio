// 输入框的文件附件登记（路径不可信，也不给渲染进程）：拖入 / 粘贴 / 选择器拿到的路径在这里校验并换成不透明的 id，
// 渲染进程只拿 id + 名字 + 大小；发送时凭 id 换回路径（tsp-runner 的 sendPrompt）。
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { limits, type ComposerFile } from "../../shared/ipc.ts";

const maxRegistered = 500;
const registry = new Map<string, string>();
/** 启动从草稿恢复的文件附件单独存放，避免被新拖入的 500 条普通文件 FIFO 挤出而丢路径。 */
const draftRegistry = new Map<string, string>();

/** 登记一个已经 stat 过的普通文件，返回给渲染进程的 { id, name, size }。 */
function remember(absolute: string, size: number, target = registry, capped = true): ComposerFile {
  const id = randomUUID();
  target.set(id, absolute);
  if (capped && target.size > maxRegistered) target.delete(target.keys().next().value!);
  return { id, name: path.basename(absolute), size };
}

/** 绝对路径、不含 `"`（会破坏 @"…" 提及）、确实是普通文件才登记；其余原样返回（目录、不存在、相对路径…）。 */
export async function registerComposerFiles(
  paths: readonly string[],
): Promise<{ files: ComposerFile[]; rest: string[] }> {
  const files: ComposerFile[] = [];
  const rest: string[] = [];
  for (const candidate of paths.slice(0, limits.promptMaxFiles)) {
    const info =
      path.isAbsolute(candidate) && !candidate.includes('"') ? await stat(candidate).catch(() => null) : null;
    if (!info?.isFile()) {
      rest.push(candidate);
      continue;
    }
    files.push(remember(candidate, info.size));
  }
  return { files, rest };
}

/** 草稿落盘用：id → 磁盘路径（只给主进程用；路径绝不返回渲染进程）。没登记过时 undefined。 */
export function composerFilePath(id: string): string | undefined {
  return registry.get(id) ?? draftRegistry.get(id);
}

/**
 * 重启后把草稿里记着的路径重新登记成文件附件：stat 确认还是普通文件才登记，已被外部删掉时返回 null
 * （草稿里那一格按不可用处理，渲染进程丢掉它和它的占位符，不阻塞输入）。
 */
export async function registerComposerFileAt(filePath: string): Promise<ComposerFile | null> {
  if (!path.isAbsolute(filePath) || filePath.includes('"')) return null;
  const info = await stat(filePath).catch(() => null);
  return info?.isFile() ? remember(filePath, info.size, draftRegistry, false) : null;
}

/** id → 路径（顺序同 ids）；没登记过的 id、已经不存在的文件 reject（发送失败，草稿会放回去）。 */
export async function resolveComposerFiles(ids: readonly string[]): Promise<string[]> {
  return Promise.all(
    ids.map(async (id) => {
      const file = registry.get(id) ?? draftRegistry.get(id);
      if (file === undefined) throw new Error("the attached file is no longer available");
      if (!(await stat(file).catch(() => null))?.isFile())
        throw new Error(`the attached file is gone: ${path.basename(file)}`);
      return file;
    }),
  );
}
