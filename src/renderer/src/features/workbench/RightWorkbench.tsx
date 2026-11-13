// Antigravity × DSH 右侧并排多标签工作台（Right Split Pane）：
// - 单一常驻容器，无切换抽动/滑入动画（零重排抖动）；
// - 顶部动态多标签栏 + `+` 新建 Overview 标签 + 最大化/还原面板按钮 + 关闭（`×`）按钮；
// - 默认页采用 Antigravity Overview 极简无框列表：全能搜索/URL 输入框 + 快捷导航区 + 实时状态区（Artifacts / Subagents / Background Tasks）；
// - 代码变更评审（Review）、文件树与预览（Files）、内置终端（Terminal）、内置浏览器（Browser）、扩展插件（Extensions）全部在分栏标签中并排打开，绝不遮挡左侧聊天区。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { GitStatus } from "../../../../shared/git.ts";
import { parseDraftKey, type TaskId, type TerminalKey } from "../../../../shared/ipc.ts";
import { AGENT_NODES, isAgentActive, listAgents, type HubAgent } from "../../../../shared/tsp/agent-hub.ts";
import {
  AgentsPanel,
  BrowserPanel,
  FilePreviewPane,
  GitChangesPanel,
  RightTerminalPane,
} from "../../app/lazy-views.tsx";
import { shortcutLabel } from "../../app/platform-keys.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import {
  ChevronRight,
  Close,
  Compass,
  Diff,
  FileIcon,
  Folder,
  Globe,
  Plus,
  Puzzle,
  Search,
  Terminal,
  Users,
} from "../../icons.tsx";
import { useTask } from "../../store/index.ts";
import { reportErrorNow } from "../../ui/errors.ts";
import { sameAgents } from "../agents/agent-model.ts";
import { openAgentsPanel, useAgentsPanel } from "../agents/agents-store.ts";
import { openBrowserPanel } from "../browser/browser-store.ts";
import { filesTarget } from "../file-preview/files-target.ts";
import {
  openFilePreview,
  openFilesPanel,
  setPreviewWidth,
  usePreviewPanel,
  usePreviewWidth,
} from "../file-preview/preview-store.ts";
import { useGitVersion } from "../git/git-store.ts";
import { IntegrationsSection } from "../settings/IntegrationsSection.tsx";
import { setTerminalOpen } from "../terminal/terminal-store.ts";
import { useTspDerived } from "../tsp/tsp-store.ts";
import {
  activateDshTab,
  addDshStartTab,
  closeDshTab,
  collapseDshSidebar,
  openDshToolTab,
  toggleDshExpanded,
  useDshWorkspace,
  type DshTabItem,
} from "./dsh-workbench-store.ts";
import { EMPTY_SESSION_FILES, extractSessionChanges, sameSessionChanges } from "./GitChangesPanel.tsx";
import { openChangesPanel } from "./workbench-store.ts";
import "../file-preview/file-preview.css";
import "./workbench.css";

const minWidth = 300;
const maxShare = 0.78;
const keyboardStep = 16;
const NO_AGENTS: readonly HubAgent[] = [];

const KNOWN_FILE_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|less|html|htm|svg|png|jpe?g|gif|webp|ico|py|rs|go|java|kt|c|cpp|h|hpp|cs|rb|php|sh|ps1|yaml|yml|toml|xml|sql|csv|tsv|txt|lock)$/i;

function normalizeNavigableUrl(raw: string): string | null {
  const q = raw.trim();
  if (!q || /\s/.test(q)) return null;
  if (/^https?:\/\//i.test(q)) return q;
  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/.*)?$/i.test(q)) {
    return `http://${q}`;
  }
  if (!q.includes("/") && KNOWN_FILE_EXT.test(q)) return null;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/.*)?$/i.test(q) && !KNOWN_FILE_EXT.test(q)) {
    return `https://${q}`;
  }
  return null;
}

function MaximizePaneIcon({ maximized }: { maximized: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {maximized ? (
        <path
          d="M6 2.75v3.25H2.75M10 2.75v3.25h3.25M6 13.25V10H2.75M10 13.25V10h3.25"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M2.75 6V2.75H6M13.25 6V2.75H10M2.75 10v3.25H6M13.25 10v3.25H10"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function DshStartView({
  panelKey,
  taskId,
  tabId,
  isZh,
  terminalTabs,
}: {
  panelKey: TerminalKey;
  taskId: TaskId | null;
  tabId: string;
  isZh: boolean;
  terminalTabs: readonly Extract<DshTabItem, { kind: "terminal" }>[];
}) {
  const task = useTask(taskId);
  const gitVersion = useGitVersion(taskId ?? ("" as TaskId));
  const [gitChangedCount, setGitChangedCount] = useState(0);
  const [query, setQuery] = useState("");
  const [fileMatches, setFileMatches] = useState<string[]>([]);

  const target = useMemo(() => filesTarget(panelKey), [panelKey]);
  const urlCandidate = useMemo(() => normalizeNavigableUrl(query), [query]);

  useEffect(() => {
    if (taskId === null) {
      setGitChangedCount(0);
      return;
    }
    let alive = true;
    window.studio.getGitStatus(taskId).then(
      (res: GitStatus) => {
        if (alive) setGitChangedCount(res.kind === "ok" ? res.files.length : 0);
      },
      () => {
        if (alive) setGitChangedCount(0);
      },
    );
    return () => {
      alive = false;
    };
  }, [taskId, task?.updatedAt, gitVersion]);

  useEffect(() => {
    const q = query.trim();
    if (!q || /^https?:\/\//i.test(q)) {
      setFileMatches([]);
      return;
    }
    let cancelled = false;
    window.studio
      .listProjectFiles(target, q)
      .then((res) => {
        if (!cancelled) setFileMatches(res.slice(0, 10));
      })
      .catch(() => {
        if (!cancelled) setFileMatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [query, target]);

  const sessionFiles = useTspDerived(taskId, extractSessionChanges, sameSessionChanges) ?? EMPTY_SESSION_FILES;
  const agents = useTspDerived(taskId, listAgents, sameAgents, AGENT_NODES) ?? NO_AGENTS;
  const activeAgentCount = useMemo(() => agents.filter((a) => isAgentActive(a.status)).length, [agents]);
  const reviewBadgeCount = gitChangedCount > 0 ? gitChangedCount : sessionFiles.length;

  const openBrowserAtUrl = (url: string) => {
    if (taskId === null) return;
    openBrowserPanel(taskId, true);
    openDshToolTab(panelKey, "browser", { replaceTabId: tabId });
    void window.studio.navigateBrowser(taskId, url).catch(reportErrorNow);
    setQuery("");
  };

  const openMatchedFile = (relPath: string) => {
    openFilePreview(panelKey, relPath);
    openDshToolTab(panelKey, "files", { replaceTabId: tabId });
    setQuery("");
  };

  const handleOmniSubmit = () => {
    if (urlCandidate !== null && taskId !== null) {
      openBrowserAtUrl(urlCandidate);
      return;
    }
    if (fileMatches.length > 0 && fileMatches[0]) {
      openMatchedFile(fileMatches[0]);
    }
  };

  const isRunningTask = task !== null && (task.status === "running" || task.status === "starting");

  return (
    <div className="dsh-wb-start" data-testid="dsh-start-launcher">
      <div className="dsh-ov-container">
        <div className="dsh-ov-omni-wrap">
          <div className="dsh-ov-omni">
            <Search size={13} />
            <input
              type="text"
              className="dsh-ov-omni-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleOmniSubmit();
                } else if (e.key === "Escape" && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder={
                isZh ? "搜索项目文件，或输入 URL 回车浏览..." : "Search workspace files, or enter a URL to browse..."
              }
              spellCheck={false}
              data-testid="dsh-start-omnibox"
            />
            {query && (
              <button
                type="button"
                className="dsh-ov-omni-clear"
                aria-label={isZh ? "清空输入" : "Clear"}
                onClick={() => setQuery("")}
              >
                <Close size={11} />
              </button>
            )}
          </div>

          {(urlCandidate !== null || fileMatches.length > 0) && (
            <div className="dsh-ov-omni-dropdown" role="listbox">
              {urlCandidate !== null && taskId !== null && (
                <button type="button" className="dsh-ov-omni-option" onClick={() => openBrowserAtUrl(urlCandidate)}>
                  <Globe size={13} />
                  <span className="dsh-ov-omni-option-main">
                    {isZh ? `在内置浏览器中打开 ${urlCandidate}` : `Open ${urlCandidate} in Browser`}
                  </span>
                  <span className="dsh-ov-omni-kbd">Enter</span>
                </button>
              )}
              {fileMatches.map((relPath) => (
                <button
                  key={relPath}
                  type="button"
                  className="dsh-ov-omni-option"
                  onClick={() => openMatchedFile(relPath)}
                >
                  <FileIcon size={13} />
                  <span className="dsh-ov-omni-option-main">{relPath}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <section className="dsh-ov-section" aria-label={isZh ? "快捷导航" : "Quick navigation"}>
          <div className="dsh-ov-section-head">{isZh ? "工作台" : "Workspace"}</div>
          <div className="dsh-ov-tile-grid">
            {taskId !== null && (
              <button
                type="button"
                className="dsh-ov-tile"
                data-testid="dsh-start-changes"
                onClick={() => {
                  openChangesPanel(taskId);
                  openDshToolTab(panelKey, "changes", { replaceTabId: tabId });
                }}
              >
                <div className="dsh-ov-tile-top">
                  <span className="dsh-ov-tile-ic is-accent">
                    <Diff size={14} />
                  </span>
                  <span className="dsh-ov-tile-kbd">{shortcutLabel("Ctrl Shift D")}</span>
                </div>
                <div className="dsh-ov-tile-foot">
                  <span className="dsh-ov-tile-title">{isZh ? "Review · 变更" : "Review"}</span>
                  {reviewBadgeCount > 0 && <span className="dsh-ov-badge">{reviewBadgeCount}</span>}
                </div>
              </button>
            )}

            <button
              type="button"
              className="dsh-ov-tile"
              data-testid="dsh-start-files"
              onClick={() => {
                openFilesPanel(panelKey);
                openDshToolTab(panelKey, "files", { replaceTabId: tabId });
              }}
            >
              <div className="dsh-ov-tile-top">
                <span className="dsh-ov-tile-ic is-sky">
                  <Folder size={14} />
                </span>
                <span className="dsh-ov-tile-kbd">{shortcutLabel("Ctrl Shift E")}</span>
              </div>
              <div className="dsh-ov-tile-foot">
                <span className="dsh-ov-tile-title">{isZh ? "Files · 文件" : "Files"}</span>
              </div>
            </button>

            <button
              type="button"
              className="dsh-ov-tile"
              data-testid="dsh-start-terminal"
              onClick={() => {
                const created = openDshToolTab(panelKey, "terminal", {
                  replaceTabId: tabId,
                  forceNewTerminal: true,
                });
                if (created.kind === "terminal" && created.terminalKey === panelKey) {
                  setTerminalOpen(panelKey, true, { focus: true });
                }
              }}
            >
              <div className="dsh-ov-tile-top">
                <span className="dsh-ov-tile-ic is-mint">
                  <Terminal size={14} />
                </span>
                <span className="dsh-ov-tile-kbd">{shortcutLabel("Ctrl `")}</span>
              </div>
              <div className="dsh-ov-tile-foot">
                <span className="dsh-ov-tile-title">{isZh ? "Terminal · 终端" : "Terminal"}</span>
              </div>
            </button>

            {taskId !== null && (
              <button
                type="button"
                className="dsh-ov-tile"
                data-testid="dsh-start-browser"
                onClick={() => {
                  openBrowserPanel(taskId, true);
                  openDshToolTab(panelKey, "browser", { replaceTabId: tabId });
                }}
              >
                <div className="dsh-ov-tile-top">
                  <span className="dsh-ov-tile-ic is-violet">
                    <Globe size={14} />
                  </span>
                  <span className="dsh-ov-tile-kbd">{shortcutLabel("Ctrl Shift B")}</span>
                </div>
                <div className="dsh-ov-tile-foot">
                  <span className="dsh-ov-tile-title">{isZh ? "Browser · 浏览" : "Browser"}</span>
                </div>
              </button>
            )}
          </div>

          <button
            type="button"
            className="dsh-ov-tile-wide"
            data-testid="dsh-start-extensions"
            onClick={() => {
              openDshToolTab(panelKey, "extensions", { replaceTabId: tabId });
            }}
          >
            <span className="dsh-ov-tile-ic is-violet">
              <Puzzle size={14} />
            </span>
            <span className="dsh-ov-nav-label">{isZh ? "扩展与技能 · Extensions" : "Extensions & Skills"}</span>
            <ChevronRight size={13} className="dsh-ov-nav-arrow" />
          </button>
        </section>

        {taskId !== null && (
          <>
            <section
              className="dsh-ov-section dsh-ov-card"
              aria-label={isZh ? "本轮涉及文件" : "Artifacts & Touched Files"}
            >
              <div className="dsh-ov-section-head">
                <span>{isZh ? "本轮文件 · Artifacts" : "Artifacts / Touched Files"}</span>
                {sessionFiles.length > 0 && <span className="dsh-ov-head-count">{sessionFiles.length}</span>}
              </div>
              {sessionFiles.length === 0 ? (
                <div className="dsh-ov-empty">
                  {isZh ? "当前会话暂无生成或修改的文件" : "No files modified in this session yet"}
                </div>
              ) : (
                <div className="dsh-ov-live-list">
                  {sessionFiles.slice(0, 8).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className="dsh-ov-live-row"
                      title={item.path}
                      onClick={() => {
                        openFilePreview(panelKey, item.path);
                        openDshToolTab(panelKey, "files", { replaceTabId: tabId });
                      }}
                    >
                      <FileIcon size={13} />
                      <span className="dsh-ov-live-title">{item.name}</span>
                      {item.displayDir && <span className="dsh-ov-live-sub">{item.displayDir}</span>}
                      {(item.added > 0 || item.removed > 0) && (
                        <span className="dsh-ov-live-stats">
                          {item.added > 0 && <span className="wb-stat-add">+{item.added}</span>}
                          {item.removed > 0 && <span className="wb-stat-del">−{item.removed}</span>}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="dsh-ov-section dsh-ov-card" aria-label="Subagents">
              <div className="dsh-ov-section-head">
                <span>{isZh ? "子代理 · Subagents" : "Subagents"}</span>
                {agents.length > 0 && (
                  <span className="dsh-ov-head-count">
                    {activeAgentCount > 0
                      ? isZh
                        ? `${activeAgentCount} 运行中`
                        : `${activeAgentCount} active`
                      : agents.length}
                  </span>
                )}
              </div>
              {agents.length === 0 ? (
                <div className="dsh-ov-empty">{isZh ? "暂无活跃或历史子代理" : "No subagents spawned"}</div>
              ) : (
                <div className="dsh-ov-live-list">
                  {agents.slice(0, 6).map((agent) => {
                    const active = isAgentActive(agent.status);
                    return (
                      <button
                        key={agent.name}
                        type="button"
                        className="dsh-ov-live-row"
                        data-testid="dsh-start-agents"
                        onClick={() => {
                          openAgentsPanel(taskId, agent.name);
                          openDshToolTab(panelKey, "agents", { replaceTabId: tabId });
                        }}
                      >
                        <span className="dsh-ov-dot" data-state={active ? "running" : agent.status} />
                        <span className="dsh-ov-live-title">{agent.name}</span>
                        {agent.task && <span className="dsh-ov-live-sub">{agent.task}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        <section className="dsh-ov-section dsh-ov-card" aria-label="Background Tasks">
          <div className="dsh-ov-section-head">
            <span>{isZh ? "后台任务 · Background" : "Background Tasks"}</span>
            {(terminalTabs.length > 0 || isRunningTask) && (
              <span className="dsh-ov-head-count">{terminalTabs.length + (isRunningTask ? 1 : 0)}</span>
            )}
          </div>
          {terminalTabs.length === 0 && !isRunningTask ? (
            <div className="dsh-ov-empty">{isZh ? "暂无运行中的后台终端或任务" : "No active background terminals"}</div>
          ) : (
            <div className="dsh-ov-live-list">
              {isRunningTask && (
                <div className="dsh-ov-live-row dsh-ov-live-static">
                  <span className="dsh-ov-dot" data-state="running" />
                  <span className="dsh-ov-live-title">
                    {isZh ? "主会话代理正在执行..." : "Primary agent running..."}
                  </span>
                </div>
              )}
              {terminalTabs.map((term) => (
                <button
                  key={term.id}
                  type="button"
                  className="dsh-ov-live-row"
                  onClick={() => activateDshTab(panelKey, term.id)}
                >
                  <Terminal size={13} />
                  <span className="dsh-ov-live-title">
                    {term.shellLabel ?? (isZh ? `终端 ${term.index}` : `Terminal ${term.index}`)}
                  </span>
                  <span className="dsh-ov-live-sub">{isZh ? "活跃会话" : "Active"}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function tabMeta(tab: DshTabItem, isZh: boolean) {
  switch (tab.kind) {
    case "start":
      return { label: isZh ? "概览" : "Overview", icon: <Compass size={13} /> };
    case "files":
      return { label: isZh ? "Files" : "Files", icon: <Folder size={13} /> };
    case "terminal": {
      const base = tab.shellLabel ?? (isZh ? "终端" : "Terminal");
      return {
        label: tab.index > 1 ? `${base} ${tab.index}` : base,
        icon: <Terminal size={13} />,
      };
    }
    case "browser":
      return { label: isZh ? "浏览器" : "Browser", icon: <Globe size={13} /> };
    case "changes":
      return { label: "Review", icon: <Diff size={13} /> };
    case "agents":
      return { label: "Subagents", icon: <Users size={13} /> };
    case "extensions":
      return { label: isZh ? "扩展" : "Extensions", icon: <Puzzle size={13} /> };
  }
}

export function RightWorkbench({ panelKey, taskId }: { panelKey: TerminalKey; taskId: TaskId | null }) {
  const t = useT();
  const isZh = useLocale() === "zh-CN";
  const ws = useDshWorkspace(panelKey);
  const preview = usePreviewPanel();
  const agentsState = useAgentsPanel();
  const width = usePreviewWidth();
  const root = useRef<HTMLElement>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  if (!ws.open || ws.tabs.length === 0) return null;

  const activeTab = ws.tabs.find((item) => item.id === ws.activeTabId) ?? ws.tabs[0]!;
  const isLoneStart = ws.tabs.length === 1 && activeTab.kind === "start";
  const effectiveTaskId = taskId ?? (parseDraftKey(panelKey) === undefined ? (panelKey as TaskId) : null);

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
    const current = root.current?.offsetWidth ?? minWidth;
    setPreviewWidth(clampWidth(current + (event.key === "ArrowLeft" ? keyboardStep : -keyboardStep)));
  };

  const handleCloseTab = (tab: DshTabItem) => {
    const removed = closeDshTab(panelKey, tab.id);
    if (removed?.kind === "terminal") {
      if (removed.terminalKey === panelKey) {
        setTerminalOpen(panelKey, false);
      } else {
        void window.studio.closeTerminal(removed.terminalKey).catch(() => undefined);
      }
    }
  };

  const previewPage = preview?.key === panelKey ? preview.page : "files";
  const previewPath = preview?.key === panelKey ? preview.path : null;
  const terminalTabs = ws.tabs.filter(
    (item): item is Extract<DshTabItem, { kind: "terminal" }> => item.kind === "terminal",
  );

  return (
    <aside
      ref={root}
      className="dsh-wb"
      data-expanded={ws.expanded ? "" : undefined}
      data-testid="right-workbench"
      aria-label={t("review.wbLabel")}
      style={!ws.expanded && width !== null ? { flexBasis: width } : undefined}
    >
      <div
        className="file-preview-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("preview.resize")}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          drag.current = null;
        }}
        onKeyDown={onResizerKey}
      />

      <header className="dsh-wb-header" data-testid="workbench-strip">
        <div className="dsh-wb-tabs" role="tablist">
          {isLoneStart ? (
            <span className="dsh-wb-lone-start">
              <Compass size={13} />
              <span>{isZh ? "概览" : "Overview"}</span>
            </span>
          ) : (
            <>
              {ws.tabs.map((tab, index) => {
                const isCurrent = tab.id === activeTab.id;
                const prevCurrent = index > 0 && ws.tabs[index - 1]?.id === activeTab.id;
                const meta = tabMeta(tab, isZh);
                return (
                  <div key={tab.id} className="dsh-wb-tab-slot">
                    {index > 0 && !isCurrent && !prevCurrent && <span className="dsh-wb-tab-sep" aria-hidden="true" />}
                    <div
                      role="tab"
                      tabIndex={0}
                      aria-selected={isCurrent}
                      className="dsh-wb-tab"
                      data-active={isCurrent ? "" : undefined}
                      data-testid={`wb-tab-${tab.kind}`}
                      onClick={() => activateDshTab(panelKey, tab.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          activateDshTab(panelKey, tab.id);
                        }
                      }}
                    >
                      <span className="dsh-wb-tab-ic">{meta.icon}</span>
                      <span className="dsh-wb-tab-label">{meta.label}</span>
                      <button
                        type="button"
                        className="dsh-wb-tab-close"
                        aria-label={isZh ? `关闭 ${meta.label}` : `Close ${meta.label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCloseTab(tab);
                        }}
                      >
                        <Close size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                className="dsh-wb-add-btn"
                title={isZh ? "打开 Overview 新标签页" : "New Overview tab"}
                aria-label={isZh ? "打开 Overview 新标签页" : "New Overview tab"}
                data-testid="dsh-wb-add-tab"
                onClick={() => addDshStartTab(panelKey)}
              >
                <Plus size={13} />
              </button>
            </>
          )}
        </div>

        <div className="dsh-wb-actions">
          <button
            type="button"
            className="dsh-wb-icon-btn"
            title={
              ws.expanded ? (isZh ? "还原分栏宽度" : "Restore split width") : isZh ? "最大化当前面板" : "Maximize pane"
            }
            aria-label={
              ws.expanded ? (isZh ? "还原分栏宽度" : "Restore split width") : isZh ? "最大化当前面板" : "Maximize pane"
            }
            data-testid="dsh-wb-expand"
            onClick={() => toggleDshExpanded(panelKey)}
          >
            <MaximizePaneIcon maximized={ws.expanded} />
          </button>
          <button
            type="button"
            className="dsh-wb-icon-btn"
            title={isZh ? "关闭面板" : "Close pane"}
            aria-label={isZh ? "关闭面板" : "Close pane"}
            data-testid="dsh-wb-collapse"
            onClick={() => collapseDshSidebar(panelKey)}
          >
            <Close size={14} />
          </button>
        </div>
      </header>

      <div className="dsh-wb-body">
        {activeTab.kind === "start" && (
          <DshStartView
            panelKey={panelKey}
            taskId={effectiveTaskId}
            tabId={activeTab.id}
            isZh={isZh}
            terminalTabs={terminalTabs}
          />
        )}
        {activeTab.kind === "files" && <FilePreviewPane panelKey={panelKey} page={previewPage} path={previewPath} />}
        {activeTab.kind === "changes" && effectiveTaskId !== null && <GitChangesPanel taskId={effectiveTaskId} />}
        {activeTab.kind === "agents" && effectiveTaskId !== null && (
          <AgentsPanel
            taskId={effectiveTaskId}
            selected={agentsState?.taskId === effectiveTaskId ? agentsState.selected : null}
          />
        )}
        {activeTab.kind === "browser" && effectiveTaskId !== null && <BrowserPanel taskId={effectiveTaskId} />}
        {activeTab.kind === "extensions" && (
          <div className="dsh-wb-extensions-pane" data-testid="wb-extensions-pane">
            <IntegrationsSection />
          </div>
        )}
        {terminalTabs.map((termTab) => (
          <RightTerminalPane
            key={termTab.id}
            workspaceKey={panelKey}
            terminalKey={termTab.terminalKey}
            active={activeTab.id === termTab.id}
            onCloseTab={() => handleCloseTab(termTab)}
          />
        ))}
      </div>
    </aside>
  );
}
