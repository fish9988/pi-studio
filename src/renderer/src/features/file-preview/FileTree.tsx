// 文件面板的"文件"页：根目录下的树，每层目录展开时才向主进程要（listDirectory），一层上千项也只画眼前的行（定高虚拟化）。
// 键盘：↑↓ 移动、→ 展开 / 进入第一个子项、← 收起 / 回到父目录、Enter 或空格打开文件（目录是展开收起）、Home/End。
// 路径校验全在主进程；这里只拼相对路径传回去。被 .gitignore 忽略的条目调暗显示。
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
} from "react";
import type { DirListing, ProjectFilesTarget, TerminalKey } from "../../../../shared/ipc.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import {
  ChevronDown,
  ChevronRight,
  CopyIcon,
  External,
  FileIcon,
  Folder,
  Pencil,
  Plus,
  Restart,
  Trash,
} from "../../icons.tsx";
import { reportError } from "../../ui/errors.ts";
import { Menu, type MenuAnchor, type MenuEntry } from "../../ui/Menu.tsx";
import { pushToast } from "../dialogs/index.ts";
import { flattenTree, treeKeyAction, type NodeRow, type TreeKey, type TreeRow } from "./tree-model.ts";
import { treeMemory } from "./tree-state.ts";
import { insertFileRefIntoComposer } from "./PreviewPage.tsx";

const overscan = 8;
const treeKeys = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "]);

interface FileTreeProps {
  /** 数据来源（任务目录或某个额外根，主进程按目标查根）。 */
  target: ProjectFilesTarget;
  /** 展开状态、光标和滚动位置按它记（同一个任务的不同根各记各的）。 */
  memoryKey: TerminalKey;
  /** 文件页正在显示：变成 true 时重新读一遍已加载的目录，并把焦点放进树。 */
  active: boolean;
  /** 刷新按钮每按一次加一。 */
  reload: number;
  /** 预览页正在看的文件（相对路径），树里对应的行高亮。 */
  selected: string | null;
  onOpenFile(path: string): void;
}

export function FileTree({ target, memoryKey, active, reload, selected, onOpenFile }: FileTreeProps) {
  const t = useT();
  const locale = useLocale();
  const isZh = locale === "zh-CN";
  const idBase = useId();
  const memory = treeMemory(memoryKey);
  const scroller = useRef<HTMLDivElement>(null);
  const [listings, setListings] = useState<ReadonlyMap<string, DirListing>>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(memory.expanded));
  const [cursor, setCursor] = useState<string | null>(memory.active);
  const [rowHeight, setRowHeight] = useState(28);
  const [viewHeight, setViewHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ anchor: MenuAnchor; items: MenuEntry[] } | null>(null);
  const [inlinePrompt, setInlinePrompt] = useState<
    | { mode: "create"; parentDir: string; kind: "file" | "dir"; value: string }
    | { mode: "rename"; path: string; kind: "file" | "dir"; value: string }
    | { mode: "delete"; path: string; kind: "file" | "dir"; name: string }
    | null
  >(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const revealNext = useRef(false);
  const restored = useRef(false);

  const rows = useMemo(() => flattenTree(listings, expanded), [listings, expanded]);
  const cursorIndex = cursor === null ? -1 : rows.findIndex((row) => row.type === "node" && row.path === cursor);
  const latest = useRef({ rows, expanded, rowHeight, cursorIndex });
  latest.current = { rows, expanded, rowHeight, cursorIndex };

  const changeExpanded = useCallback(
    (next: ReadonlySet<string>) => {
      memory.expanded = next;
      setExpanded(next);
    },
    [memory],
  );

  const loadDir = useCallback(
    (dir: string) => {
      window.studio.listDirectory(target, dir).then(
        (listing) => setListings((previous) => new Map(previous).set(dir, listing)),
        (error: unknown) => {
          reportError(t, error);
          const next = new Set(latest.current.expanded);
          if (next.delete(dir)) changeExpanded(next);
        },
      );
    },
    [target, t, changeExpanded],
  );

  // 页面显示（或按了刷新）时：根目录和所有展开的目录重新读一遍。
  useEffect(() => {
    if (!active) return;
    loadDir("");
    for (const dir of latest.current.expanded) loadDir(dir);
  }, [active, reload, loadDir]);

  useEffect(() => {
    if (active) scroller.current?.focus({ preventScroll: true });
  }, [active]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const height = parseFloat(getComputedStyle(el).getPropertyValue("--row-tool"));
    if (height > 0) setRowHeight(height);
    setViewHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 切回任务时恢复滚动位置：列表加载出来、内容有高度之后才能滚。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!active || restored.current || rows.length === 0 || el === null) return;
    restored.current = true;
    el.scrollTop = memory.scrollTop;
  }, [active, rows.length, memory]);

  // 键盘移动光标后，保证光标行在可见范围内。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!revealNext.current || el === null || cursorIndex < 0) return;
    revealNext.current = false;
    const top = cursorIndex * latest.current.rowHeight;
    const bottom = top + latest.current.rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [cursorIndex]);

  const moveCursor = (path: string, reveal: boolean) => {
    revealNext.current = reveal;
    memory.active = path;
    setCursor(path);
  };

  const expand = (path: string) => {
    changeExpanded(new Set(expanded).add(path));
    loadDir(path);
  };
  const collapse = (path: string) => {
    const next = new Set(expanded);
    next.delete(path);
    changeExpanded(next);
  };

  const refreshAllLoadedDirs = useCallback(() => {
    loadDir("");
    for (const dir of latest.current.expanded) loadDir(dir);
  }, [loadDir]);

  useEffect(() => {
    if (inlinePrompt !== null && inlinePrompt.mode !== "delete") {
      requestAnimationFrame(() => {
        const input = promptInputRef.current;
        if (!input) return;
        input.focus();
        if (inlinePrompt.mode === "rename" && inlinePrompt.kind === "file") {
          const dot = inlinePrompt.value.lastIndexOf(".");
          input.setSelectionRange(0, dot > 0 ? dot : inlinePrompt.value.length);
        } else {
          input.select();
        }
      });
    }
  }, [inlinePrompt]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onCustomCreate = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: "file" | "dir" }>).detail;
      if (!detail) return;
      const activeRow = latest.current.rows.find((r): r is NodeRow => r.type === "node" && r.path === cursor);
      const parentDir =
        activeRow?.kind === "dir"
          ? activeRow.path
          : activeRow
            ? activeRow.path.includes("/")
              ? activeRow.path.slice(0, activeRow.path.lastIndexOf("/"))
              : ""
            : "";
      setInlinePrompt({ mode: "create", parentDir, kind: detail.kind, value: "" });
    };
    el.addEventListener("studio:file-tree-create", onCustomCreate);
    return () => el.removeEventListener("studio:file-tree-create", onCustomCreate);
  }, [cursor]);

  const submitInlinePrompt = async () => {
    if (inlinePrompt === null) return;
    const current = inlinePrompt;
    try {
      if (current.mode === "create") {
        const name = current.value.trim();
        if (name === "") return;
        const relPath = current.parentDir === "" ? name : `${current.parentDir}/${name}`;
        await window.studio.createFileEntry(target, relPath, current.kind);
        setInlinePrompt(null);
        if (current.parentDir !== "") {
          changeExpanded(new Set(latest.current.expanded).add(current.parentDir));
          loadDir(current.parentDir);
        }
        refreshAllLoadedDirs();
        moveCursor(relPath, true);
        if (current.kind === "file") {
          onOpenFile(relPath);
        }
        pushToast({
          level: "info",
          message: isZh
            ? `已新建${current.kind === "dir" ? "文件夹" : "文件"} ${name}`
            : `Created ${current.kind === "dir" ? "folder" : "file"} ${name}`,
        });
      } else if (current.mode === "rename") {
        const newName = current.value.trim();
        const oldBase = current.path.includes("/")
          ? current.path.slice(current.path.lastIndexOf("/") + 1)
          : current.path;
        if (newName === "" || newName === oldBase) {
          setInlinePrompt(null);
          return;
        }
        const nextRel = await window.studio.renameFileEntry(target, current.path, newName);
        setInlinePrompt(null);
        refreshAllLoadedDirs();
        moveCursor(nextRel, true);
        if (selected === current.path && current.kind === "file") {
          onOpenFile(nextRel);
        }
        pushToast({
          level: "info",
          message: isZh ? `已重命名为 ${newName}` : `Renamed to ${newName}`,
        });
      } else if (current.mode === "delete") {
        await window.studio.deleteFileEntry(target, current.path);
        setInlinePrompt(null);
        if (current.kind === "dir") {
          const next = new Set(latest.current.expanded);
          next.delete(current.path);
          changeExpanded(next);
        }
        refreshAllLoadedDirs();
        pushToast({
          level: "info",
          message: isZh ? `已删除 ${current.name}` : `Deleted ${current.name}`,
        });
      }
    } catch (error) {
      reportError(t, error);
    }
  };

  const openRowContextMenu = (row: NodeRow, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    moveCursor(row.path, false);
    const parentDir =
      row.kind === "dir" ? row.path : row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "";
    const items: MenuEntry[] = [
      {
        id: "open",
        label:
          row.kind === "file"
            ? isZh
              ? "在侧栏预览"
              : "Preview in Sidebar"
            : row.expanded
              ? isZh
                ? "收起文件夹"
                : "Collapse Folder"
              : isZh
                ? "展开文件夹"
                : "Expand Folder",
        icon: row.kind === "file" ? <FileIcon size={14} /> : <Folder size={14} />,
        onSelect: () => onRowClick(row),
      },
      {
        id: "insertRef",
        label: isZh ? "引用到输入框 (@)" : "Insert @reference",
        icon: <span className="file-preview-at-glyph">@</span>,
        onSelect: () => insertFileRefIntoComposer(row.path),
      },
      { kind: "separator", id: "sep-create" },
      {
        id: "newFile",
        label: isZh ? "新建文件…" : "New File…",
        icon: <Plus size={14} />,
        onSelect: () => setInlinePrompt({ mode: "create", parentDir, kind: "file", value: "" }),
      },
      {
        id: "newFolder",
        label: isZh ? "新建文件夹…" : "New Folder…",
        icon: <Folder size={14} />,
        onSelect: () => setInlinePrompt({ mode: "create", parentDir, kind: "dir", value: "" }),
      },
      {
        id: "rename",
        label: isZh ? "重命名…" : "Rename…",
        icon: <Pencil size={14} />,
        shortcut: "F2",
        onSelect: () => setInlinePrompt({ mode: "rename", path: row.path, kind: row.kind, value: row.name }),
      },
      { kind: "separator", id: "sep-path" },
      {
        id: "copyPath",
        label: isZh ? "复制相对路径" : "Copy Relative Path",
        icon: <CopyIcon size={14} />,
        onSelect: () => {
          void navigator.clipboard.writeText(row.path).then(() =>
            pushToast({
              level: "info",
              message: isZh ? `已复制路径 ${row.path}` : `Copied ${row.path}`,
            }),
          );
        },
      },
      {
        id: "reveal",
        label: t("preview.reveal"),
        icon: <External size={14} />,
        onSelect: () => {
          window.studio.revealProjectFile(target, row.path).catch((err: unknown) => reportError(t, err));
        },
      },
      { kind: "separator", id: "sep-delete" },
      {
        id: "delete",
        label: isZh ? "删除…" : "Delete…",
        icon: <Trash size={14} />,
        tone: "danger",
        shortcut: "Del",
        onSelect: () => setInlinePrompt({ mode: "delete", path: row.path, kind: row.kind, name: row.name }),
      },
    ];
    setContextMenu({
      anchor: { x: event.clientX, y: event.clientY, returnFocus: scroller.current },
      items,
    });
  };

  const openTreeBackgroundMenu = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-testid=file-tree-row]")) return;
    event.preventDefault();
    const items: MenuEntry[] = [
      {
        id: "newFileRoot",
        label: isZh ? "新建文件…" : "New File…",
        icon: <Plus size={14} />,
        onSelect: () => setInlinePrompt({ mode: "create", parentDir: "", kind: "file", value: "" }),
      },
      {
        id: "newFolderRoot",
        label: isZh ? "新建文件夹…" : "New Folder…",
        icon: <Folder size={14} />,
        onSelect: () => setInlinePrompt({ mode: "create", parentDir: "", kind: "dir", value: "" }),
      },
      { kind: "separator", id: "sep-bg" },
      {
        id: "refreshTree",
        label: t("preview.refresh"),
        icon: <Restart size={14} />,
        onSelect: () => refreshAllLoadedDirs(),
      },
      {
        id: "revealRoot",
        label: t("preview.reveal"),
        icon: <External size={14} />,
        onSelect: () => {
          window.studio.revealProjectFile(target, "").catch((err: unknown) => reportError(t, err));
        },
      },
    ];
    setContextMenu({
      anchor: { x: event.clientX, y: event.clientY, returnFocus: scroller.current },
      items,
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (inlinePrompt !== null) return;
    if (event.key === "F2" && cursor !== null) {
      const activeRow = rows.find((r): r is NodeRow => r.type === "node" && r.path === cursor);
      if (activeRow) {
        event.preventDefault();
        setInlinePrompt({ mode: "rename", path: activeRow.path, kind: activeRow.kind, value: activeRow.name });
        return;
      }
    }
    if (event.key === "Delete" && cursor !== null) {
      const activeRow = rows.find((r): r is NodeRow => r.type === "node" && r.path === cursor);
      if (activeRow) {
        event.preventDefault();
        setInlinePrompt({ mode: "delete", path: activeRow.path, kind: activeRow.kind, name: activeRow.name });
        return;
      }
    }
    if (event.ctrlKey || event.altKey || event.metaKey || !treeKeys.has(event.key)) return;
    const action = treeKeyAction(
      rows,
      cursor ?? (selected === null ? null : selected.replaceAll("\\", "/")),
      event.key as TreeKey,
    );
    if (action === null) return;
    event.preventDefault();
    moveCursor(action.path, action.type === "move");
    if (action.type === "expand") expand(action.path);
    else if (action.type === "collapse") collapse(action.path);
    else if (action.type === "open") onOpenFile(action.path);
  };

  const onRowClick = (row: NodeRow) => {
    moveCursor(row.path, false);
    if (row.kind === "file") onOpenFile(row.path);
    else if (row.expanded) collapse(row.path);
    else expand(row.path);
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
    if (active) memory.scrollTop = event.currentTarget.scrollTop;
  };

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / rowHeight) + overscan);
  const selectedPath = selected?.replaceAll("\\", "/") ?? null;

  return (
    <div
      ref={scroller}
      className="file-tree"
      hidden={!active}
      data-testid="file-tree"
      role="tree"
      tabIndex={0}
      aria-label={t("preview.treeLabel")}
      aria-activedescendant={cursorIndex >= 0 ? `${idBase}-${cursorIndex}` : undefined}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
      onContextMenu={openTreeBackgroundMenu}
    >
      {inlinePrompt !== null && (
        <div
          className="file-tree-prompt-bar"
          data-testid="file-tree-prompt"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setInlinePrompt(null);
              scroller.current?.focus({ preventScroll: true });
            } else if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              void submitInlinePrompt();
            }
          }}
        >
          {inlinePrompt.mode === "delete" ? (
            <>
              <span className="file-tree-prompt-label">
                {isZh ? `确认删除「${inlinePrompt.name}」？` : `Delete "${inlinePrompt.name}"?`}
              </span>
              <div className="file-tree-prompt-actions">
                <button
                  type="button"
                  className="file-tree-prompt-btn file-tree-prompt-btn-danger"
                  data-testid="file-tree-prompt-confirm"
                  onClick={() => void submitInlinePrompt()}
                >
                  {isZh ? "删除" : "Delete"}
                </button>
                <button
                  type="button"
                  className="file-tree-prompt-btn"
                  data-testid="file-tree-prompt-cancel"
                  onClick={() => setInlinePrompt(null)}
                >
                  {isZh ? "取消" : "Cancel"}
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="file-tree-prompt-label">
                {inlinePrompt.mode === "create"
                  ? inlinePrompt.kind === "dir"
                    ? isZh
                      ? `新建文件夹${inlinePrompt.parentDir ? ` (${inlinePrompt.parentDir}/)` : ""}`
                      : `New Folder${inlinePrompt.parentDir ? ` (${inlinePrompt.parentDir}/)` : ""}`
                    : isZh
                      ? `新建文件${inlinePrompt.parentDir ? ` (${inlinePrompt.parentDir}/)` : ""}`
                      : `New File${inlinePrompt.parentDir ? ` (${inlinePrompt.parentDir}/)` : ""}`
                  : isZh
                    ? `重命名 ${inlinePrompt.path}`
                    : `Rename ${inlinePrompt.path}`}
              </span>
              <div className="file-tree-prompt-row">
                <input
                  ref={promptInputRef}
                  type="text"
                  className="file-tree-prompt-input"
                  data-testid="file-tree-prompt-input"
                  value={inlinePrompt.value}
                  placeholder={
                    inlinePrompt.mode === "create" ? (inlinePrompt.kind === "dir" ? "folder-name" : "filename.ext") : ""
                  }
                  onChange={(e) => setInlinePrompt({ ...inlinePrompt, value: e.target.value })}
                />
                <button
                  type="button"
                  className="file-tree-prompt-btn file-tree-prompt-btn-primary"
                  data-testid="file-tree-prompt-confirm"
                  onClick={() => void submitInlinePrompt()}
                >
                  {isZh ? "确定" : "OK"}
                </button>
                <button
                  type="button"
                  className="file-tree-prompt-btn"
                  data-testid="file-tree-prompt-cancel"
                  onClick={() => setInlinePrompt(null)}
                >
                  {isZh ? "取消" : "Cancel"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {listings.get("")?.entries.length === 0 && <p className="file-preview-note">{t("preview.emptyDir")}</p>}
      <div className="file-tree-canvas" style={{ height: rows.length * rowHeight }}>
        {rows.slice(first, last).map((row, offset) => (
          <TreeRowView
            key={row.path}
            id={`${idBase}-${first + offset}`}
            row={row}
            top={(first + offset) * rowHeight}
            cursor={row.type === "node" && row.path === cursor}
            selected={row.type === "node" && row.path === selectedPath}
            onClick={onRowClick}
            onContextMenu={openRowContextMenu}
          />
        ))}
      </div>
      {contextMenu !== null && (
        <Menu
          anchor={contextMenu.anchor}
          items={contextMenu.items}
          label={isZh ? "文件操作" : "File Actions"}
          onClose={() => setContextMenu(null)}
          testId="file-tree-context-menu"
        />
      )}
    </div>
  );
}

interface TreeRowViewProps {
  id: string;
  row: TreeRow;
  top: number;
  cursor: boolean;
  selected: boolean;
  onClick(row: NodeRow): void;
  onContextMenu(row: NodeRow, event: MouseEvent<HTMLElement>): void;
}

function TreeRowView({ id, row, top, cursor, selected, onClick, onContextMenu }: TreeRowViewProps) {
  const t = useT();
  const style = { top, "--depth": row.depth } as CSSProperties;
  if (row.type === "truncated") {
    return (
      <div className="file-tree-row file-tree-more" role="none" style={style}>
        {t("preview.truncated", { count: row.shown })}
      </div>
    );
  }
  return (
    <div
      id={id}
      className="file-tree-row"
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.kind === "dir" ? row.expanded : undefined}
      aria-selected={selected}
      data-testid="file-tree-row"
      data-path={row.path}
      data-kind={row.kind}
      data-cursor={cursor || undefined}
      data-ignored={row.ignored || undefined}
      title={row.path}
      style={style}
      onClick={() => onClick(row)}
      onContextMenu={(e) => onContextMenu(row, e)}
    >
      <span className="file-tree-chevron" aria-hidden="true">
        {row.kind === "dir" && (row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </span>
      {row.kind === "dir" ? <Folder size={14} /> : <FileIcon size={14} />}
      <span className="file-tree-name">{row.name}</span>
      {row.kind === "file" && (
        <button
          type="button"
          className="file-tree-at-btn"
          tabIndex={-1}
          title={`@${row.path}`}
          onClick={(e) => {
            e.stopPropagation();
            insertFileRefIntoComposer(row.path);
          }}
        >
          @
        </button>
      )}
    </div>
  );
}
