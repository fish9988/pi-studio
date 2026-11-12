// 按会话文件逆向还原指定用户消息（fromEntryId）及之后所有轮次的 AI 文件改动（edit / write）。
// 用于用户点击撤回（Confirm Undo）并勾选「还原文件修改」时，即使不在 Git 仓库中也能精确逆向撤销编辑。
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "../../shared/type-guards.ts";

const execFileAsync = promisify(execFile);

interface EditPair {
  oldText: string;
  newText: string;
}

type RecordedFileOp =
  { kind: "edit"; filePath: string; pairs: EditPair[] } | { kind: "write"; filePath: string; content: string };

function resolveTargetPath(rawPath: string, cwd: string): string | null {
  const trimmed = rawPath.trim();
  if (trimmed === "") return null;
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
}

async function tryGitRestoreFile(cwd: string, absPath: string): Promise<"restored" | "untracked" | "failed"> {
  try {
    const rel = path.relative(cwd, absPath);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return "failed";
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd });
    await execFileAsync("git", ["checkout", "HEAD", "--", rel], { cwd });
    return "restored";
  } catch {
    try {
      await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
      return "untracked";
    } catch {
      return "failed";
    }
  }
}

export async function revertSessionFileChangesFromFile(
  sessionFile: string,
  fromEntryId: string,
  cwd: string,
  leafIdOverride?: string | null,
): Promise<number> {
  let rawContent: string;
  try {
    rawContent = await readFile(sessionFile, "utf8");
  } catch {
    return 0;
  }
  return revertSessionFileChangesFromJsonl(rawContent, fromEntryId, cwd, leafIdOverride);
}

export async function revertSessionFileChangesFromJsonl(
  jsonlContent: string,
  fromEntryId: string,
  cwd: string,
  leafIdOverride?: string | null,
): Promise<number> {
  const entries: Record<string, unknown>[] = [];
  for (const line of jsonlContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed["type"] === "string" && parsed["type"] !== "session") {
        entries.push(parsed);
      }
    } catch {
      // ignore malformed lines
    }
  }
  if (entries.length === 0) return 0;

  // Build active branch chain from root -> leaf.
  const byId = new Map<string, Record<string, unknown>>();
  let hasTreeIds = false;
  for (const entry of entries) {
    if (typeof entry["id"] === "string" && entry["id"] !== "") {
      byId.set(entry["id"], entry);
      hasTreeIds = true;
    }
  }

  let branch: Record<string, unknown>[] = entries;
  if (hasTreeIds) {
    const leafId =
      leafIdOverride !== undefined ? leafIdOverride : ((entries[entries.length - 1]?.["id"] as string | null) ?? null);
    if (leafId === null) return 0;
    if (byId.has(leafId)) {
      const chain: Record<string, unknown>[] = [];
      const visited = new Set<string>();
      let cur: string | null = leafId;
      while (cur !== null && !visited.has(cur)) {
        visited.add(cur);
        const node = byId.get(cur);
        if (!node) break;
        chain.push(node);
        cur = typeof node["parentId"] === "string" ? node["parentId"] : null;
      }
      chain.reverse();
      branch = chain;
    }
  }

  const startIdx = branch.findIndex((e) => e["id"] === fromEntryId);
  if (startIdx < 0) return 0;

  const beforeEntries = branch.slice(0, startIdx);
  const targetEntries = branch.slice(startIdx);

  // Collect toolResults in targetEntries to skip failed tool calls.
  const failedToolCallIds = new Set<string>();
  const completedToolCallIds = new Set<string>();
  for (const entry of targetEntries) {
    if (entry["type"] === "message" && isRecord(entry["message"])) {
      const msg = entry["message"];
      if (msg["role"] === "toolResult" && typeof msg["toolCallId"] === "string") {
        if (msg["isError"] === true) failedToolCallIds.add(msg["toolCallId"]);
        else completedToolCallIds.add(msg["toolCallId"]);
      }
    }
  }

  // Track any prior writes before startIdx so if a file was written earlier in the session, we can restore that content.
  const priorLastWriteContent = new Map<string, string>();
  for (const entry of beforeEntries) {
    if (entry["type"] !== "message" || !isRecord(entry["message"])) continue;
    const msg = entry["message"];
    if (msg["role"] !== "assistant" || !Array.isArray(msg["content"])) continue;
    for (const block of msg["content"]) {
      if (!isRecord(block) || block["type"] !== "toolCall") continue;
      if (block["name"] === "write" && isRecord(block["arguments"])) {
        const args = block["arguments"];
        const rawP =
          typeof args["path"] === "string"
            ? args["path"]
            : typeof args["file_path"] === "string"
              ? args["file_path"]
              : "";
        const resolved = resolveTargetPath(rawP, cwd);
        if (resolved !== null && typeof args["content"] === "string") {
          priorLastWriteContent.set(resolved.toLowerCase(), args["content"]);
        }
      }
    }
  }

  const ops: RecordedFileOp[] = [];
  for (const entry of targetEntries) {
    if (entry["type"] !== "message" || !isRecord(entry["message"])) continue;
    const msg = entry["message"];
    if (msg["role"] !== "assistant" || !Array.isArray(msg["content"])) continue;
    for (const block of msg["content"]) {
      if (!isRecord(block) || block["type"] !== "toolCall") continue;
      const callId = typeof block["id"] === "string" ? block["id"] : "";
      if (callId !== "" && (failedToolCallIds.has(callId) || !completedToolCallIds.has(callId))) continue;
      const toolName = block["name"];
      const args = isRecord(block["arguments"]) ? block["arguments"] : null;
      if (!args) continue;
      const rawPath =
        typeof args["path"] === "string"
          ? args["path"]
          : typeof args["file_path"] === "string"
            ? args["file_path"]
            : "";
      const filePath = resolveTargetPath(rawPath, cwd);
      if (filePath === null) continue;

      if (toolName === "edit") {
        const pairs: EditPair[] = [];
        if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") {
          pairs.push({ oldText: args["oldText"], newText: args["newText"] });
        } else if (typeof args["old_str"] === "string" && typeof args["new_str"] === "string") {
          pairs.push({ oldText: args["old_str"], newText: args["new_str"] });
        } else if (Array.isArray(args["edits"])) {
          for (const item of args["edits"]) {
            if (isRecord(item) && typeof item["oldText"] === "string" && typeof item["newText"] === "string") {
              pairs.push({ oldText: item["oldText"], newText: item["newText"] });
            }
          }
        }
        if (pairs.length > 0) {
          ops.push({ kind: "edit", filePath, pairs });
        }
      } else if (toolName === "write" && typeof args["content"] === "string") {
        ops.push({ kind: "write", filePath, content: args["content"] });
      }
    }
  }

  let revertedCount = 0;
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i]!;
    if (op.kind === "edit") {
      try {
        let current = await readFile(op.filePath, "utf8");
        let changed = false;
        const normalizedCurrent = current.replace(/\r\n/g, "\n");
        const usesCrlf = current.includes("\r\n");
        let working = normalizedCurrent;
        for (let j = op.pairs.length - 1; j >= 0; j -= 1) {
          const pair = op.pairs[j]!;
          const targetNew = pair.newText.replace(/\r\n/g, "\n");
          const targetOld = pair.oldText.replace(/\r\n/g, "\n");
          if (targetNew !== "" && working.includes(targetNew)) {
            working = working.replace(targetNew, () => targetOld);
            changed = true;
          }
        }
        if (changed) {
          current = usesCrlf ? working.replace(/\n/g, "\r\n") : working;
          await writeFile(op.filePath, current, "utf8");
          revertedCount += 1;
        }
      } catch {
        // file missing or unreadable
      }
    } else {
      const priorContent = priorLastWriteContent.get(op.filePath.toLowerCase());
      if (priorContent !== undefined) {
        try {
          await writeFile(op.filePath, priorContent, "utf8");
          revertedCount += 1;
        } catch {
          // ignore
        }
        continue;
      }
      const gitRes = await tryGitRestoreFile(cwd, op.filePath);
      if (gitRes === "restored") {
        revertedCount += 1;
      } else {
        try {
          await rm(op.filePath, { force: true });
          revertedCount += 1;
        } catch {
          // ignore
        }
      }
    }
  }
  return revertedCount;
}
