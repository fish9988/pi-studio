// 「回退」= 就地回溯，不是分叉。pi 打开会话文件时叶子 / 当前分支 = 文件里最后一个条目
// （dist/core/session-manager.js 的 _buildIndex：遍历所有条目，最后一个留下 leafId；
//  docs/session-format.md「The "leaf" is the current position in the tree」），
// 而追加写入的每个条目都挂在当时的叶子下面（appendFileSync，一行一个条目，写时没有长期打开的 fd）。
// 所以把文件截到这条用户消息之前、并让这条消息的父条目成为最后一行，pi 重新读同一个文件就回到了那条消息之前：
// 会话文件、任务 id 都不变，不会像 --fork 那样多出一份一模一样的分支会话。
// 被截掉的那一段先另存成 .bak（不叫 .jsonl，/resume 不会把它当成会话列出来），出错了还能找回。
import { readFile } from "node:fs/promises";
import { isRecord } from "../../shared/type-guards.ts";
import { writeFileAtomic } from "../tasks/atomic-write.ts";

interface SessionLine {
  /** 原始一行（原样写回，避免重新序列化改变字段顺序或丢掉我们不认识的字段）。 */
  text: string;
  /** 树里的条目 id；坏行 / 没有 id 的行为 null。 */
  id: string | null;
  parentId: string | null;
  type: string;
}

export interface SessionRewindResult {
  /** 被截掉的行数（这条用户消息本身 + 它之后的所有条目）。 */
  droppedLines: number;
  /** 截断后的叶子 = 目标用户消息的父条目；回溯到会话开头时为 null。 */
  leafId: string | null;
  /** 另存被截掉那一段的备份文件；没有可截内容时为 null。 */
  backupFile: string | null;
}

function parseLines(text: string): { header: string | null; lines: SessionLine[] } {
  let header: string | null = null;
  const lines: SessionLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 写到一半的坏行：留着（在目标之前的话不影响回溯），但没有 id，不算树节点。
      lines.push({ text: line, id: null, parentId: null, type: "invalid" });
      continue;
    }
    if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
      lines.push({ text: line, id: null, parentId: null, type: "invalid" });
      continue;
    }
    if (parsed["type"] === "session" && header === null) {
      header = line;
      continue;
    }
    lines.push({
      text: line,
      id: typeof parsed["id"] === "string" ? parsed["id"] : null,
      parentId: typeof parsed["parentId"] === "string" ? parsed["parentId"] : null,
      type: parsed["type"],
    });
  }
  return { header, lines };
}

/** 目标条目 + 它是其后代的所有条目（会话是 append-only 的树：之后新增的条目都挂在它的后代下面）。 */
function collectRewound(lines: readonly SessionLine[], target: SessionLine): Set<SessionLine> {
  const rewound = new Set<SessionLine>([target]);
  const byId = new Map<string, SessionLine>();
  for (const line of lines) if (line.id !== null) byId.set(line.id, line);
  // 一轮轮往下扫：父条目已经在被截集合里，自己也进集合。深度不会超过会话轮数，够用。
  let grew = true;
  while (grew) {
    grew = false;
    for (const line of lines) {
      if (rewound.has(line)) continue;
      if (line.parentId === null) continue;
      const parent = byId.get(line.parentId);
      if (parent !== undefined && rewound.has(parent)) {
        rewound.add(line);
        grew = true;
      }
    }
  }
  return rewound;
}

/**
 * 把会话文件截到 `entryId` 这条用户消息之前：这条消息、它的后代、以及它之后写的坏行都拿掉，
 * 并把它的父条目挪到最后一行（叶子）。会话文件原地改，路径不变。
 * 备份写在同目录 `<文件>.rewound-<时间戳>.bak`。
 */
export async function rewindSessionFileBefore(file: string, entryId: string): Promise<SessionRewindResult> {
  const { header, lines } = parseLines(await readFile(file, "utf8"));
  const target = lines.find((line) => line.id === entryId);
  if (target === undefined) {
    throw new Error(`entry "${entryId}" is not in the session file`);
  }

  const rewound = collectRewound(lines, target);
  // 目标之后没有 id 的坏行（写到一半）也一起拿掉，否则最后一行就是它、叶子会算错。
  const targetIndex = lines.indexOf(target);
  const kept: SessionLine[] = [];
  const removed: SessionLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (rewound.has(line) || (line.id === null && index > targetIndex)) removed.push(line);
    else kept.push(line);
  }

  const leafId = target.parentId;
  let cutLine: SessionLine | null = null;
  if (leafId !== null) {
    cutLine = kept.find((line) => line.id === leafId) ?? null;
    if (cutLine === null) {
      throw new Error(`entry "${entryId}" has parent "${leafId}" that is not in the session file`);
    }
  }
  // 叶子必须是最后一行：把这条消息的父条目挪到末尾（中间那些标签 / 用量条目照原顺序排在前面）。
  const ordered = cutLine === null ? [] : [...kept.filter((line) => line !== cutLine), cutLine];

  const bodyLines = ordered.map((line) => line.text);
  const nextText = `${(header === null ? bodyLines : [header, ...bodyLines]).join("\n")}\n`;

  let backupFile: string | null = null;
  if (removed.length > 0) {
    backupFile = `${file}.rewound-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.bak`;
    await writeFileAtomic(backupFile, `${removed.map((line) => line.text).join("\n")}\n`, "rewind-backup");
  }

  await writeFileAtomic(file, nextText, "rewind");
  return { droppedLines: removed.length, leafId, backupFile };
}
