// Antigravity × DSH 右侧并排多标签工作台（Right Split Pane）：
// - 单一常驻容器，无切换抽动/滑入动画（零重排抖动）；
// - 顶部动态多标签栏 + `+` 新建 Overview 标签 + 最大化/还原面板按钮 + 关闭（`×`）按钮；
// - 默认页采用 Antigravity Overview 极简无框列表：全能搜索/URL 输入框 + 快捷导航区 + 实时状态区（Artifacts / Subagents / Background Tasks）；
// - 代码变更评审（Review）、文件树与预览（Files）、内置终端（Terminal）、内置浏览器（Browser）、扩展插件（Extensions）全部在分栏标签中并排打开，绝不遮挡左侧聊天区。
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { GitStatus } from "../../../../shared/git.ts";
import { draftKey, parseDraftKey, type DraftKey, type TaskId, type TerminalKey } from "../../../../shared/ipc.ts";
import type { McpAppServerSnapshot } from "../../../../shared/mcp-apps.ts";
import { AGENT_NODES, isAgentActive, listAgents, type HubAgent } from "../../../../shared/tsp/agent-hub.ts";
import {
  AgentsPanel,
  BrowserPanel,
  FilePreviewPane,
  GitChangesPanel,
  RightTerminalPane,
} from "../../app/lazy-views.tsx";
import { lazyView } from "../../ui/lazy-view.ts";
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
  Restart,
  Search,
  Sparkle,
  Terminal,
  Users,
} from "../../icons.tsx";
import { useTask } from "../../store/index.ts";
import { reportErrorNow } from "../../ui/errors.ts";
import { dotStatus, sameAgents } from "../agents/agent-model.ts";
import { openAgentsPanel, useAgentsPanel } from "../agents/agents-store.ts";
import { openBrowserPanel } from "../browser/browser-store.ts";
import { filesTarget } from "../file-preview/files-target.ts";
import {
  closePreviewTabAndRestoreFocus,
  openFilePreview,
  openFilesPanel,
  setPreviewWidth,
  usePreviewPanel,
  usePreviewWidth,
} from "../file-preview/preview-store.ts";
import { baseName } from "../file-preview/PreviewContent.tsx";
import { PreviewPage } from "../file-preview/PreviewPage.tsx";
import { withRoot } from "../file-preview/files-target.ts";
import { useGitVersion } from "../git/git-store.ts";
import { IntegrationsSection } from "../settings/IntegrationsSection.tsx";
import { setTerminalOpen } from "../terminal/terminal-store.ts";
import { useTspDerived } from "../tsp/tsp-store.ts";
import {
  activateDshTab,
  addDshStartTab,
  closeDshTab,
  collapseDshSidebar,
  openDshMcpAppTab,
  openDshToolTab,
  reorderDshTab,
  toggleDshExpanded,
  useDshWorkspace,
  type DshTabItem,
} from "./dsh-workbench-store.ts";

const mcpAppHostView = lazyView(() => import("../mcp-apps/McpAppHost.tsx").then((m) => m.McpAppHost));
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
  const draft = parseDraftKey(panelKey);
  const effectiveProjectId = task?.projectId ?? draft?.projectId ?? null;
  const gitVersion = useGitVersion(taskId ?? ("" as TaskId));
  const [gitChangedCount, setGitChangedCount] = useState(0);
  const [query, setQuery] = useState("");
  const [fileMatches, setFileMatches] = useState<string[]>([]);
  // 全能框的下拉里当前高亮的一项（↓ / ↑ 移动，Enter 打开高亮的那个）
  const [activeIndex, setActiveIndex] = useState(0);
  const omniListId = useId();
  const [mcpApps, setMcpApps] = useState<McpAppServerSnapshot[]>([]);
  const [mcpAppsTick, setMcpAppsTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    window.studio
      .listMcpApps(effectiveProjectId)
      .then((list) => {
        if (!cancelled) setMcpApps(list);
      })
      .catch(() => {
        if (!cancelled) setMcpApps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveProjectId, mcpAppsTick]);

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

  // 下拉项：URL 直达在内嵌浏览器打开，文件命中直接在预览页打开
  const omniOptions = useMemo(() => {
    const list: { key: string; kind: "url" | "file"; value: string; label: string }[] = [];
    if (urlCandidate !== null && taskId !== null) {
      list.push({
        key: "url",
        kind: "url",
        value: urlCandidate,
        label: isZh ? `在内置浏览器中打开 ${urlCandidate}` : `Open ${urlCandidate} in Browser`,
      });
    }
    for (const relPath of fileMatches) {
      list.push({ key: `file:${relPath}`, kind: "file", value: relPath, label: relPath });
    }
    return list;
  }, [fileMatches, isZh, taskId, urlCandidate]);

  const runOmniOption = (option: (typeof omniOptions)[number]) => {
    if (option.kind === "url") openBrowserAtUrl(option.value);
    else openMatchedFile(option.value);
  };

  const handleOmniSubmit = () => {
    const option = omniOptions[activeIndex] ?? omniOptions[0];
    if (option !== undefined) runOmniOption(option);
  };

  const onOmniKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (omniOptions.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => Math.min(omniOptions.length - 1, Math.max(0, index + delta)));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      handleOmniSubmit();
      return;
    }
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  };

  const isRunningTask = task !== null && (task.status === "running" || task.status === "starting");

  const t = useT();
  const availableMcpApps = useMemo(
    () =>
      mcpApps.flatMap((srv) =>
        srv.resources.map((res) => ({
          server: srv.server,
          uri: res.uri,
          title: res.title || res.name || res.uri,
        })),
      ),
    [mcpApps],
  );

  return (
    <div className="dsh-wb-start" data-testid="dsh-start-launcher">
      <div className="dsh-ov-container">
        <div className="dsh-ov-omni-wrap">
          <div className="dsh-ov-omni">
            <Search size={13} className="dsh-ov-omni-ic" />
            <input
              type="text"
              className="dsh-ov-omni-input"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onOmniKeyDown}
              role="combobox"
              aria-expanded={omniOptions.length > 0}
              aria-controls={omniListId}
              aria-autocomplete="list"
              aria-activedescendant={
                omniOptions.length > 0 ? `${omniListId}-${Math.min(activeIndex, omniOptions.length - 1)}` : undefined
              }
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
                onClick={() => {
                  setQuery("");
                  setActiveIndex(0);
                }}
              >
                <Close size={11} />
              </button>
            )}
          </div>

          {omniOptions.length > 0 && (
            <div
              className="dsh-ov-omni-dropdown"
              role="listbox"
              id={omniListId}
              aria-label={isZh ? "搜索结果" : "Results"}
            >
              {omniOptions.map((option, index) => (
                <div
                  key={option.key}
                  id={`${omniListId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className="dsh-ov-omni-option"
                  data-active={index === activeIndex ? "" : undefined}
                  data-testid="dsh-start-omni-option"
                  // 按下鼠标时不抢输入框焦点，键盘和鼠标落到同一套高亮上
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runOmniOption(option)}
                >
                  {option.kind === "url" ? <Globe size={13} /> : <FileIcon size={13} />}
                  <span className="dsh-ov-omni-option-main">{option.label}</span>
                  {option.kind === "url" && <span className="dsh-ov-omni-kbd">Enter</span>}
                </div>
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
                <span className="dsh-ov-tile-top">
                  <span className="dsh-ov-tile-ic is-blue">
                    <Diff size={14} />
                  </span>
                  <span className="dsh-ov-tile-kbd">{shortcutLabel("Ctrl Shift D")}</span>
                </span>
                <span className="dsh-ov-tile-foot">
                  <span className="dsh-ov-tile-title">{isZh ? "Review · 变更" : "Review"}</span>
                  {reviewBadgeCount > 0 && <span className="dsh-ov-badge">{reviewBadgeCount}</span>}
                </span>
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
              <span className="dsh-ov-tile-top">
                <span className="dsh-ov-tile-ic is-blue">
                  <Folder size={14} />
                </span>
                <span className="dsh-ov-tile-kbd">{shortcutLabel("Ctrl Shift E")}</span>
              </span>
              <span className="dsh-ov-tile-foot">
                <span className="dsh-ov-tile-title">{isZh ? "Files · 文件" : "Files"}</span>
              </span>
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
              <span className="dsh-ov-tile-top">
                <span className="dsh-ov-tile-ic is-green">
                  <Terminal size={14} />
                </span>
                <span className="dsh-ov-tile-kbd">{shortcutLabel("Ctrl `")}</span>
              </span>
              <span className="dsh-ov-tile-foot">
                <span className="dsh-ov-tile-title">{isZh ? "Terminal · 终端" : "Terminal"}</span>
              </span>
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
                <span className="dsh-ov-tile-top">
                  <span className="dsh-ov-tile-ic is-blue">
                    <Globe size={14} />
                  </span>
                  <span className="dsh-ov-tile-kbd">{shortcutLabel("Ctrl Shift B")}</span>
                </span>
                <span className="dsh-ov-tile-foot">
                  <span className="dsh-ov-tile-title">{isZh ? "Browser · 浏览" : "Browser"}</span>
                </span>
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
            <span className="dsh-ov-tile-ic is-neutral">
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
                      <span className="dsh-ov-live-ic">
                        <FileIcon size={13} />
                      </span>
                      <span className="dsh-ov-live-main">
                        <span className="dsh-ov-live-title">{item.name}</span>
                        {item.displayDir && <span className="dsh-ov-live-sub">{item.displayDir}</span>}
                      </span>
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
                    // 橙 = 排队 / 挂起，绿 = 在跑或已完成，红 = 失败（和子代理面板的状态点同语义，但一览里不区分完成/运行）
                    const dot =
                      agent.status === "pending" || agent.status === "parked" ? "waiting" : dotStatus(agent.status);
                    return (
                      <button
                        key={agent.name}
                        type="button"
                        className="dsh-ov-live-row"
                        data-testid="dsh-start-agents"
                        title={agent.task === "" ? agent.name : agent.task}
                        onClick={() => {
                          openAgentsPanel(taskId, agent.name);
                          openDshToolTab(panelKey, "agents", { replaceTabId: tabId });
                        }}
                      >
                        <span className="dsh-ov-dot" data-state={dot} aria-hidden="true" />
                        <span className="dsh-ov-live-main">
                          <span className="dsh-ov-live-title">{agent.name}</span>
                          {agent.task !== "" && <span className="dsh-ov-live-sub">{agent.task}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        {availableMcpApps.length > 0 && (
          <section
            className="dsh-ov-section dsh-ov-card"
            aria-label={t("preview.mcpAppsTitle")}
            data-testid="dsh-start-mcp-apps"
          >
            <div className="dsh-ov-section-head">
              <span>{t("preview.mcpAppsTitle")}</span>
              <button
                type="button"
                className="dsh-ov-head-btn"
                title={t("preview.mcpAppsRefresh")}
                aria-label={t("preview.mcpAppsRefresh")}
                onClick={() => setMcpAppsTick((n) => n + 1)}
              >
                <Restart size={12} />
              </button>
            </div>
            <div className="dsh-ov-live-list">
              {availableMcpApps.map((appItem) => (
                <button
                  key={`${appItem.server}:${appItem.uri}`}
                  type="button"
                  className="dsh-ov-live-row"
                  data-testid="dsh-start-mcp-app-item"
                  onClick={() =>
                    openDshMcpAppTab(panelKey, {
                      server: appItem.server,
                      uri: appItem.uri,
                      title: appItem.title,
                      projectId: effectiveProjectId,
                      replaceTabId: tabId,
                    })
                  }
                >
                  <span className="dsh-ov-live-ic">
                    <Sparkle size={13} />
                  </span>
                  <span className="dsh-ov-live-main">
                    <span className="dsh-ov-live-title">{appItem.title}</span>
                    <span className="dsh-ov-live-sub">{appItem.server}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
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
                  <span className="dsh-ov-dot" data-state="running" aria-hidden="true" />
                  <span className="dsh-ov-live-main">
                    <span className="dsh-ov-live-title">
                      {isZh ? "主会话代理正在执行..." : "Primary agent running..."}
                    </span>
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
                  <span className="dsh-ov-live-ic">
                    <Terminal size={13} />
                  </span>
                  <span className="dsh-ov-live-main">
                    <span className="dsh-ov-live-title">
                      {term.shellLabel ?? (isZh ? `终端 ${term.index}` : `Terminal ${term.index}`)}
                    </span>
                    <span className="dsh-ov-live-sub">{isZh ? "活跃会话" : "Active"}</span>
                  </span>
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
    case "preview":
      return { label: baseName(tab.path), icon: <FileIcon size={13} /> };
    case "mcp-app":
      return { label: tab.title, icon: <Sparkle size={13} /> };
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

function StandalonePreviewTab({
  tab,
  target,
  isCurrent,
  onClose,
}: {
  tab: Extract<DshTabItem, { kind: "preview" }>;
  target: ReturnType<typeof filesTarget>;
  isCurrent: boolean;
  onClose: () => void;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (isCurrent) sectionRef.current?.focus({ preventScroll: true });
  }, [isCurrent, tab.id]);

  return (
    <section
      ref={sectionRef}
      className="file-preview"
      data-testid={isCurrent ? "file-preview" : undefined}
      hidden={!isCurrent}
      tabIndex={-1}
      aria-label={tab.path}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <PreviewPage
        target={withRoot(target, tab.root ?? 0)}
        path={tab.path}
        focusLine={tab.line}
        focusPage={tab.page}
        hidden={!isCurrent}
      />
    </section>
  );
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
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const draftObj = parseDraftKey(panelKey);
  const effectiveTaskId = taskId ?? (draftObj === undefined ? (panelKey as TaskId) : null);
  const taskObj = useTask(effectiveTaskId);

  if (!ws.open || ws.tabs.length === 0) return null;

  const activeTab = ws.tabs.find((item) => item.id === ws.activeTabId) ?? ws.tabs[0]!;
  const isLoneStart = ws.tabs.length === 1 && activeTab.kind === "start";
  const quoteTarget: TaskId | DraftKey | null =
    effectiveTaskId ?? (taskObj?.projectId ? draftKey(taskObj.projectId) : draftObj ? panelKey : null);

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
    if (tab.kind === "preview") {
      closePreviewTabAndRestoreFocus(panelKey, tab.id);
      return;
    }
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
  const previewTabs = ws.tabs.filter(
    (item): item is Extract<DshTabItem, { kind: "preview" }> => item.kind === "preview",
  );
  const mcpAppTabs = ws.tabs.filter(
    (item): item is Extract<DshTabItem, { kind: "mcp-app" }> => item.kind === "mcp-app",
  );
  const previewTargetBase = filesTarget(panelKey);
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
                      draggable
                      aria-selected={isCurrent}
                      className="dsh-wb-tab"
                      data-active={isCurrent ? "" : undefined}
                      data-testid={`wb-tab-${tab.kind}`}
                      title={tab.kind === "preview" ? tab.path : meta.label}
                      onDragStart={(e) => {
                        setDragTabId(tab.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", tab.id);
                      }}
                      onDragOver={(e) => {
                        if (dragTabId !== null && dragTabId !== tab.id) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragTabId !== null && dragTabId !== tab.id) {
                          reorderDshTab(panelKey, dragTabId, tab.id);
                        }
                        setDragTabId(null);
                      }}
                      onDragEnd={() => setDragTabId(null)}
                      onAuxClick={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          handleCloseTab(tab);
                        }
                      }}
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
        {previewTabs.map((pTab) => (
          <StandalonePreviewTab
            key={pTab.id}
            tab={pTab}
            target={previewTargetBase}
            isCurrent={activeTab.id === pTab.id}
            onClose={() => handleCloseTab(pTab)}
          />
        ))}
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
        {mcpAppTabs.map((appTab) => {
          const isCurrent = activeTab.id === appTab.id;
          return (
            <div
              key={appTab.id}
              hidden={!isCurrent}
              className="mcp-app-tab-slot"
              style={{ display: isCurrent ? "flex" : "none", flex: "1 1 auto", minHeight: 0 }}
            >
              <mcpAppHostView.View
                projectId={appTab.projectId}
                server={appTab.server}
                uri={appTab.uri}
                title={appTab.title}
                taskId={effectiveTaskId}
                quoteTarget={quoteTarget}
                displayMode="fullscreen"
              />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
