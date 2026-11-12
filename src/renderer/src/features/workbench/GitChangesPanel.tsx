// 右栏工作区变更检视器：在不离开、不遮挡主对话流的前提下查看当前任务的改动文件清单与行内统一 diff，
// 也支持一键跳往文件预览或全屏评审（逐行评论、按块暂存）。当任务目录不是 git 仓库或工作区已提交干净时，
// 自动回退展示当前会话内工具实际修改的文件与内联 Diff，彻底告别空白死胡同。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { GitChangeKind, GitDiffArea } from "../../../../shared/git.ts";
import type { TaskId } from "../../../../shared/ipc.ts";
import type { DocNode, DocSurface, TspDocument } from "../../../../shared/tsp/document.ts";
import type { TspDiffHunk } from "../../../../shared/tsp/tsp.generated.ts";
import {
  flattenGroups,
  groupChanges,
  resolveSelection,
  stepEntry,
  type ReviewEntry,
} from "../../../../shared/ui/review-model.ts";
import { useT } from "../../i18n/use-t.ts";
import { Close, Eye, Restart } from "../../icons.tsx";
import { currentLocale } from "../../store/settings-store.ts";
import { useTask } from "../../store/index.ts";
import { IconButton } from "../../ui/controls.tsx";
import { explainError } from "../../ui/errors.ts";
import { openFilePreview, setPreviewWidth, usePreviewWidth } from "../file-preview/preview-store.ts";
import { refreshGit } from "../git/git-store.ts";
import { ReviewView } from "../review/ReviewView.tsx";
import { diffKeyOf, useChangeStats, useFileDiff, useReviewStatus } from "../review/use-review-data.ts";
import { useTspDerived } from "../tsp/tsp-store.ts";
import { closeChangesPanel } from "./workbench-store.ts";
import "../file-preview/file-preview.css";
import "./workbench.css";

const minWidth = 280;
const maxShare = 0.7;
const keyboardStep = 16;

const KIND_BADGE: Record<GitChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "U",
  conflicted: "!",
};

const GROUP_KEY: Record<GitDiffArea, "review.groupStaged" | "review.groupUnstaged" | "review.groupUntracked"> = {
  staged: "review.groupStaged",
  unstaged: "review.groupUnstaged",
  untracked: "review.groupUntracked",
};

interface ParsedSessionHunkLine {
  kind: "add" | "del" | "ctx";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

interface ParsedSessionHunk {
  header: string;
  lines: readonly ParsedSessionHunkLine[];
}

export interface SessionChangedFile {
  key: string;
  path: string;
  displayDir: string;
  name: string;
  kind: "added" | "modified";
  added: number;
  removed: number;
  hunks: readonly ParsedSessionHunk[];
}

export const EMPTY_SESSION_FILES: readonly SessionChangedFile[] = [];

function splitFilePath(filePath: string): { dir: string; name: string } {
  const norm = filePath.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  if (slash === -1) return { dir: "", name: norm };
  return { dir: norm.slice(0, slash), name: norm.slice(slash + 1) };
}

function computeCommonDirPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const splitDirs = paths
    .map((p) => {
      const norm = p.replace(/\\/g, "/");
      const idx = norm.lastIndexOf("/");
      return idx > 0 ? norm.slice(0, idx).split("/") : [];
    })
    .filter((parts) => parts.length > 0);
  if (splitDirs.length === 0) return "";
  const first = splitDirs[0]!;
  let commonLen = first.length;
  for (let i = 1; i < splitDirs.length; i += 1) {
    const other = splitDirs[i]!;
    let j = 0;
    while (j < commonLen && j < other.length && first[j]?.toLowerCase() === other[j]?.toLowerCase()) {
      j += 1;
    }
    commonLen = j;
  }
  if (commonLen === 0) {
    // 单文件或无公共前缀时：若路径包含常见源码顶层目录，则截取自该目录起
    if (paths.length === 1) {
      const m = /^(.*)\/(?:src|docs|test|tests|packages|scripts|public|app)\//i.exec(paths[0]!.replace(/\\/g, "/"));
      if (m?.[1]) return `${m[1]}/`;
    }
    return "";
  }
  return `${first.slice(0, commonLen).join("/")}/`;
}

function parseTspDiffHunks(rawHunks: readonly TspDiffHunk[]): {
  hunks: ParsedSessionHunk[];
  added: number;
  removed: number;
} {
  const hunks: ParsedSessionHunk[] = [];
  let added = 0;
  let removed = 0;
  for (const hunk of rawHunks) {
    if (!Array.isArray(hunk?.lines)) continue;
    let oldNo = typeof hunk.oldStart === "number" ? hunk.oldStart : 1;
    let newNo = typeof hunk.newStart === "number" ? hunk.newStart : 1;
    const lines: ParsedSessionHunkLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (const rawLine of hunk.lines) {
      if (typeof rawLine !== "string") continue;
      if (rawLine.startsWith("+")) {
        added += 1;
        newCount += 1;
        lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: rawLine.slice(1) });
      } else if (rawLine.startsWith("-")) {
        removed += 1;
        oldCount += 1;
        lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: rawLine.slice(1) });
      } else {
        oldCount += 1;
        newCount += 1;
        lines.push({
          kind: "ctx",
          oldNo: oldNo++,
          newNo: newNo++,
          text: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine,
        });
      }
    }
    if (lines.length > 0) {
      hunks.push({
        header: `@@ -${hunk.oldStart ?? 1},${oldCount} +${hunk.newStart ?? 1},${newCount} @@`,
        lines,
      });
    }
  }
  return { hunks, added, removed };
}

function collectSurfaceSessionFiles(surface: DocSurface, map: Map<string, SessionChangedFile>): void {
  const visit = (node: DocNode) => {
    if (node.k === "tool" && node.p["status"] === "done") {
      const toolName = node.p["name"];
      if (toolName === "write" || toolName === "edit") {
        const rawTarget =
          typeof node.p["target"] === "string" && node.p["targetKind"] === "path"
            ? node.p["target"]
            : typeof node.p["href"] === "string"
              ? node.p["href"]
              : "";
        const cleaned = rawTarget
          .trim()
          .replace(/^file:\/\//i, "")
          .replace(/^\/+(?=[A-Za-z]:)/, "")
          .replace(/\\/g, "/");
        if (cleaned !== "" && !cleaned.startsWith("~") && !/AppData\/Local\/Temp|\/tmp\//i.test(cleaned)) {
          let hunks: ParsedSessionHunk[] = [];
          let added = 0;
          let removed = 0;
          for (const cid of node.c) {
            const child = surface.nodes.get(cid);
            if (child?.k === "diff" && Array.isArray(child.p["hunks"])) {
              const parsed = parseTspDiffHunks(child.p["hunks"] as TspDiffHunk[]);
              hunks = parsed.hunks;
              added = parsed.added;
              removed = parsed.removed;
              break;
            }
          }
          if (added === 0 && removed === 0 && Array.isArray(node.p["meta"])) {
            for (const m of node.p["meta"]) {
              if (typeof m !== "string") continue;
              const addM = /\+(\d+)/.exec(m);
              const delM = /[-−](\d+)/.exec(m);
              if (addM) added += Number(addM[1]);
              if (delM) removed += Number(delM[1]);
            }
          }
          const key = cleaned.toLowerCase();
          const prev = map.get(key);
          const { dir, name } = splitFilePath(cleaned);
          const kind: "added" | "modified" = toolName === "write" || prev?.kind === "added" ? "added" : "modified";
          map.set(key, {
            key,
            path: cleaned,
            displayDir: dir,
            name,
            kind,
            added: (prev?.added ?? 0) + added,
            removed: (prev?.removed ?? 0) + removed,
            hunks: hunks.length > 0 ? [...(prev?.hunks ?? []), ...hunks] : (prev?.hunks ?? []),
          });
        }
      }
    }
    for (const cid of node.c) {
      const child = surface.nodes.get(cid);
      if (child) visit(child);
    }
  };
  const main = surface.nodes.get("main");
  if (main) visit(main);
}

export function extractSessionChanges(doc: TspDocument): readonly SessionChangedFile[] {
  const map = new Map<string, SessionChangedFile>();
  for (const surface of doc.surfaces.values()) {
    collectSurfaceSessionFiles(surface, map);
  }
  if (map.size === 0) return EMPTY_SESSION_FILES;
  const list = [...map.values()];
  const prefix = computeCommonDirPrefix(list.map((f) => f.path));
  if (prefix === "") return list;
  const prefixLower = prefix.toLowerCase();
  return list.map((item) => {
    const norm = item.path.replace(/\\/g, "/");
    const rel = norm.toLowerCase().startsWith(prefixLower) ? norm.slice(prefix.length) : norm;
    const { dir } = splitFilePath(rel);
    return { ...item, displayDir: dir };
  });
}

export function sameSessionChanges(a: readonly SessionChangedFile[], b: readonly SessionChangedFile[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (item, idx) =>
      item.key === b[idx]?.key &&
      item.added === b[idx]?.added &&
      item.removed === b[idx]?.removed &&
      item.hunks.length === b[idx]?.hunks.length,
  );
}

export function GitChangesPanel({ taskId }: { taskId: TaskId }) {
  const t = useT();
  const zh = currentLocale() === "zh-CN";
  const task = useTask(taskId);
  const root = useRef<HTMLElement>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const width = usePreviewWidth();
  const { status, error, stamp, refresh } = useReviewStatus(taskId, task?.status);
  const sessionFiles = useTspDerived(taskId, extractSessionChanges, sameSessionChanges) ?? EMPTY_SESSION_FILES;
  const [sourceMode, setSourceMode] = useState<"auto" | "git" | "session">("auto");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const lastIndex = useRef(0);

  const groups = useMemo(() => (status?.kind === "ok" ? groupChanges(status.files) : []), [status]);
  const entries = useMemo(() => flattenGroups(groups), [groups]);
  const entry: ReviewEntry | null = resolveSelection(entries, selectedKey, lastIndex.current);

  const hasSessionChanges = sessionFiles.length > 0;
  const usingSessionFallback =
    hasSessionChanges &&
    (sourceMode === "session" || (sourceMode === "auto" && (status?.kind !== "ok" || entries.length === 0)));

  const activeSessionFile = useMemo(() => {
    if (sessionFiles.length === 0) return null;
    if (selectedSessionKey !== null) {
      const found = sessionFiles.find((f) => f.key === selectedSessionKey);
      if (found) return found;
    }
    return sessionFiles[0] ?? null;
  }, [sessionFiles, selectedSessionKey]);

  useEffect(() => {
    lastIndex.current = entry === null ? 0 : entries.indexOf(entry);
  }, [entries, entry]);

  useEffect(() => {
    if (stamp !== 0) refreshGit(taskId);
  }, [taskId, stamp]);

  const stats = useChangeStats(taskId, status?.kind === "ok" ? stamp : 0);
  const diffState = useFileDiff(taskId, usingSessionFallback ? null : entry, "hunks", false, stamp);

  const totals = useMemo(() => {
    if (usingSessionFallback) {
      let added = 0;
      let removed = 0;
      for (const f of sessionFiles) {
        added += f.added;
        removed += f.removed;
      }
      return { added, removed };
    }
    let added = 0;
    let removed = 0;
    for (const counts of stats.values()) {
      added += counts.added;
      removed += counts.removed;
    }
    return { added, removed };
  }, [usingSessionFallback, sessionFiles, stats]);

  useLayoutEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeChangesPanel();
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const target = event.target as HTMLElement | null;
      if (target && target.closest(".wb-diff-scroll")) return;
      if (usingSessionFallback) {
        if (sessionFiles.length === 0) return;
        const currIdx = activeSessionFile ? sessionFiles.indexOf(activeSessionFile) : 0;
        const nextIdx = Math.max(0, Math.min(sessionFiles.length - 1, currIdx + (event.key === "ArrowDown" ? 1 : -1)));
        const nextItem = sessionFiles[nextIdx];
        if (nextItem) {
          event.preventDefault();
          setSelectedSessionKey(nextItem.key);
        }
        return;
      }
      const next = stepEntry(entries, entry?.key ?? null, event.key === "ArrowDown" ? 1 : -1);
      if (next) {
        event.preventDefault();
        setSelectedKey(next.key);
      }
    }
  };

  const clampWidth = (value: number) => {
    const parent = root.current?.parentElement;
    const max = parent ? parent.clientWidth * maxShare : value;
    return Math.max(minWidth, Math.min(max, value));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: root.current?.offsetWidth ?? minWidth };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setPreviewWidth(clampWidth(drag.current.startWidth + drag.current.startX - event.clientX));
  };
  const onResizerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const now = root.current?.offsetWidth ?? minWidth;
    setPreviewWidth(clampWidth(now + (event.key === "ArrowLeft" ? keyboardStep : -keyboardStep)));
  };

  const expectedDiffKey = entry ? diffKeyOf(entry.area, "hunks", false, entry.path) : null;
  const diffLoading = !usingSessionFallback && entry !== null && diffState.key !== expectedDiffKey;
  const activeCount = usingSessionFallback ? sessionFiles.length : entries.length;

  if (status?.kind === "ok" && !usingSessionFallback) {
    return (
      <section
        ref={root}
        className="file-preview wb-changes-panel"
        data-testid="git-changes-panel"
        aria-label={t("review.panelToggle")}
        tabIndex={-1}
        style={width === null ? undefined : { flexBasis: width }}
      >
        <ReviewView
          taskId={taskId}
          open={true}
          embedded={true}
          sessionCount={sessionFiles.length}
          onSwitchSession={hasSessionChanges ? () => setSourceMode("session") : undefined}
        />
      </section>
    );
  }

  return (
    <section
      ref={root}
      className="file-preview wb-changes-panel"
      data-testid="git-changes-panel"
      aria-label={t("review.panelToggle")}
      tabIndex={-1}
      style={width === null ? undefined : { flexBasis: width }}
      onKeyDown={onKeyDown}
    >
      <div
        className="file-preview-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("review.panelResize")}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          drag.current = null;
        }}
        onKeyDown={onResizerKey}
      />
      <header className="file-preview-head wb-changes-head">
        <span className="wb-changes-title" data-testid="wb-changes-count">
          {t("review.changedFilesCount", { count: activeCount })}
        </span>
        {(totals.added > 0 || totals.removed > 0) && (
          <span className="wb-changes-totals">
            {totals.added > 0 && <span className="wb-stat-add">+{totals.added}</span>}
            {totals.removed > 0 && <span className="wb-stat-del">−{totals.removed}</span>}
          </span>
        )}
        {status?.kind === "ok" && hasSessionChanges && (
          <div className="wb-source-switch" role="group" aria-label={zh ? "变更来源" : "Changes source"}>
            <button
              type="button"
              className="wb-source-btn"
              data-active={!usingSessionFallback ? "" : undefined}
              onClick={() => setSourceMode("git")}
            >
              Git ({entries.length})
            </button>
            <button
              type="button"
              className="wb-source-btn"
              data-active={usingSessionFallback ? "" : undefined}
              onClick={() => setSourceMode("session")}
            >
              {zh ? `本轮 (${sessionFiles.length})` : `Session (${sessionFiles.length})`}
            </button>
          </div>
        )}
        <span className="file-preview-spacer" />
        <IconButton label={t("review.refresh")} testId="wb-changes-refresh" onClick={refresh}>
          <Restart size={14} />
        </IconButton>
        <IconButton
          label={t("review.panelClose")}
          tip={`${t("review.panelClose")} (Esc)`}
          testId="wb-changes-close"
          onClick={() => closeChangesPanel()}
        >
          <Close size={14} />
        </IconButton>
      </header>

      <div className="wb-changes-body">
        {usingSessionFallback ? (
          <>
            <div className="wb-file-list" data-testid="wb-file-list">
              <div className="wb-group">
                <div className="wb-group-head">
                  <span>{zh ? "会话变更文件" : "Session modified files"}</span>
                  <span className="wb-group-count">{sessionFiles.length}</span>
                </div>
                {sessionFiles.map((item) => {
                  const active = activeSessionFile?.key === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className="wb-file-row"
                      aria-current={active ? "true" : undefined}
                      data-testid="wb-file-row"
                      data-path={item.path}
                      onClick={() => setSelectedSessionKey(item.key)}
                    >
                      <span className="wb-kind" data-kind={item.kind}>
                        {KIND_BADGE[item.kind]}
                      </span>
                      <span className="wb-file-text">
                        <span className="wb-file-name">{item.name}</span>
                        {item.displayDir !== "" && <span className="wb-file-dir">{item.displayDir}</span>}
                      </span>
                      <span className="wb-file-counts">
                        <span className="wb-stat-add">+{item.added}</span>
                        <span className="wb-stat-del">−{item.removed}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {activeSessionFile !== null && (
              <div className="wb-diff-pane">
                <div className="wb-diff-head">
                  <span className="wb-diff-path" data-testid="wb-selected-path" title={activeSessionFile.path}>
                    {activeSessionFile.displayDir !== ""
                      ? `${activeSessionFile.displayDir}/${activeSessionFile.name}`
                      : activeSessionFile.name}
                  </span>
                  <IconButton
                    label={t("review.previewFile")}
                    tip={t("review.previewFile")}
                    testId="wb-preview-file"
                    onClick={() => openFilePreview(taskId, activeSessionFile.path)}
                  >
                    <Eye size={14} />
                  </IconButton>
                </div>
                <div className="wb-diff-scroll" data-testid="wb-diff-scroll">
                  {activeSessionFile.hunks.length === 0 ? (
                    <div className="wb-diff-note">{t("review.noTextChanges")}</div>
                  ) : (
                    activeSessionFile.hunks.map((hunk, hunkIdx) => (
                      <div key={`${hunkIdx}:${hunk.header}`} className="wb-hunk">
                        <div className="wb-hunk-head">{hunk.header}</div>
                        <div className="wb-hunk-lines">
                          {hunk.lines.map((line, lineIdx) => (
                            <div key={lineIdx} className="wb-diff-row" data-kind={line.kind}>
                              <span className="wb-line-no">{line.oldNo ?? ""}</span>
                              <span className="wb-line-no">{line.newNo ?? ""}</span>
                              <span className="wb-line-sign">
                                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                              </span>
                              <span className="wb-line-code">{line.text}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </>
        ) : stamp === 0 ? (
          <div className="wb-changes-empty">{t("review.loading")}</div>
        ) : error !== null ? (
          <div className="wb-changes-empty">{explainError(t, error)}</div>
        ) : status?.kind === "git_missing" ? (
          <div className="wb-changes-empty">{t("review.gitMissing")}</div>
        ) : status?.kind === "not_git" ? (
          <div className="wb-changes-empty">{t("review.notGit")}</div>
        ) : entries.length === 0 ? (
          <div className="wb-changes-empty" data-testid="wb-changes-clean">
            {t("review.noFiles")}
          </div>
        ) : (
          <>
            <div className="wb-file-list" data-testid="wb-file-list">
              {groups.map((group) => (
                <div key={group.area} className="wb-group">
                  <div className="wb-group-head">
                    <span>{t(GROUP_KEY[group.area])}</span>
                    <span className="wb-group-count">{group.entries.length}</span>
                  </div>
                  {group.entries.map((item) => {
                    const { dir, name } = splitFilePath(item.path);
                    const lineCounts = stats.get(item.key);
                    const active = entry?.key === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        className="wb-file-row"
                        aria-current={active ? "true" : undefined}
                        data-testid="wb-file-row"
                        data-path={item.path}
                        onClick={() => setSelectedKey(item.key)}
                      >
                        <span className="wb-kind" data-kind={item.kind}>
                          {KIND_BADGE[item.kind]}
                        </span>
                        <span className="wb-file-text">
                          <span className="wb-file-name">{name}</span>
                          {dir !== "" && <span className="wb-file-dir">{dir}</span>}
                        </span>
                        {lineCounts && (lineCounts.added > 0 || lineCounts.removed > 0) && (
                          <span className="wb-file-counts">
                            {lineCounts.added > 0 && <span className="wb-stat-add">+{lineCounts.added}</span>}
                            {lineCounts.removed > 0 && <span className="wb-stat-del">−{lineCounts.removed}</span>}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {entry !== null && (
              <div className="wb-diff-pane">
                <div className="wb-diff-head">
                  <span className="wb-diff-path" data-testid="wb-selected-path">
                    {entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
                  </span>
                  {entry.kind !== "deleted" && (
                    <IconButton
                      label={t("review.previewFile")}
                      tip={t("review.previewFile")}
                      testId="wb-preview-file"
                      onClick={() => openFilePreview(taskId, entry.path)}
                    >
                      <Eye size={14} />
                    </IconButton>
                  )}
                </div>
                <div className="wb-diff-scroll" data-testid="wb-diff-scroll">
                  {diffLoading ? (
                    <div className="wb-diff-note">{t("review.loading")}</div>
                  ) : diffState.error !== null ? (
                    <div className="wb-diff-note">{explainError(t, diffState.error)}</div>
                  ) : diffState.diff === null ? null : diffState.diff.kind === "binary" ? (
                    <div className="wb-diff-note">{t("review.binary")}</div>
                  ) : diffState.diff.kind === "too_large" ? (
                    <div className="wb-diff-note">{t("review.tooLarge")}</div>
                  ) : diffState.diff.hunks.length === 0 ? (
                    <div className="wb-diff-note">{t("review.noTextChanges")}</div>
                  ) : (
                    diffState.diff.hunks.map((hunk, hunkIdx) => (
                      <div key={`${hunkIdx}:${hunk.header}`} className="wb-hunk">
                        <div className="wb-hunk-head">{hunk.header}</div>
                        <div className="wb-hunk-lines">
                          {hunk.lines.map((line, lineIdx) => (
                            <div key={lineIdx} className="wb-diff-row" data-kind={line.kind}>
                              <span className="wb-line-no">{line.oldNo ?? ""}</span>
                              <span className="wb-line-no">{line.newNo ?? ""}</span>
                              <span className="wb-line-sign">
                                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                              </span>
                              <span className="wb-line-code">{line.text}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
