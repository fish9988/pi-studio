// 文件面板 / `@` 补全的数据来源（纯函数，单测在 test/file-handlers.test.ts）。
import { parseDraftKey, type ProjectFilesTarget, type TaskId, type TerminalKey } from "../../../../shared/ipc.ts";

/** 任务的工作目录、草稿的项目目录，或默认文件夹（没有项目的草稿）；都由主进程查出，渲染进程不传路径。 */
export function filesTarget(key: TerminalKey): ProjectFilesTarget {
  const draft = parseDraftKey(key);
  if (draft === undefined) return { kind: "task", taskId: key as TaskId };
  if (draft.projectId === null) return { kind: "defaultFolder" };
  return { kind: "project", projectId: draft.projectId };
}

/** 任务目标选额外根（下标）；别的目标（草稿的项目、默认文件夹）没有额外根。 */
export function withRoot(target: ProjectFilesTarget, root: number): ProjectFilesTarget {
  return target.kind === "task" && root > 0 ? { ...target, root } : target;
}

export interface ParsedPreviewRef {
  path: string;
  line?: number | undefined;
  page?: number | undefined;
}

/** 从路径末尾拆出 `#L123` / `:123` 或 `#page:5` / `#page=5`。 */
export function parsePreviewPathFragment(rawPath: string): ParsedPreviewRef {
  const trimmed = rawPath.trim();
  const pageMatch = /#page[:=](\d+)(?:-\d+)?$/i.exec(trimmed);
  if (pageMatch) {
    const pageNum = Number.parseInt(pageMatch[1]!, 10);
    return {
      path: trimmed.slice(0, pageMatch.index),
      page: Number.isFinite(pageNum) && pageNum >= 1 ? pageNum : undefined,
    };
  }
  const lineHashMatch = /#L(\d+)(?:-L?\d+)?$/i.exec(trimmed);
  if (lineHashMatch) {
    const lineNum = Number.parseInt(lineHashMatch[1]!, 10);
    return {
      path: trimmed.slice(0, lineHashMatch.index),
      line: Number.isFinite(lineNum) && lineNum >= 1 ? lineNum : undefined,
    };
  }
  const lineColonMatch = /(?<!^[A-Za-z]):(\d+)(?:[:-]\d+)?$/.exec(trimmed);
  if (lineColonMatch) {
    const lineNum = Number.parseInt(lineColonMatch[1]!, 10);
    return {
      path: trimmed.slice(0, lineColonMatch.index),
      line: Number.isFinite(lineNum) && lineNum >= 1 ? lineNum : undefined,
    };
  }
  return { path: trimmed };
}
