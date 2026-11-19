// 现代工作台（uiStyle === "zcode"）右侧的「新标签页」启动器：
// - 顶部左对齐标题 + 一行极简浅底全能搜索框（项目文件直达预览、网址回车开内置浏览器）；
// - 第一区「工作台工具」与第二区「应用插件」都是双列横向应用行：38×38 圆角图标底座 + 名称/说明 + 圆润「打开」胶囊，
//   不画外边框、不放任何置灰死按钮；
// - 草稿态（taskId === null）点需要 TaskId 的入口时先自动建会话（rekey → selectTask）再打开，任何状态下每个入口都可用；
// - 第三区只在真的有数据时才出现（本轮文件 / 活跃子代理 / 运行中终端），没有数据就完全不渲染空盒子。
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { GitStatus } from "../../../../shared/git.ts";
import { parseDraftKey, type DraftKey, type TaskId, type TerminalKey } from "../../../../shared/ipc.ts";
import type { McpAppServerSnapshot } from "../../../../shared/mcp-apps.ts";
import { AGENT_NODES, isAgentActive, listAgents, type HubAgent } from "../../../../shared/tsp/agent-hub.ts";
import { useLocale } from "../../i18n/use-t.ts";
import {
  ChevronRight,
  Close,
  Comment,
  Diff,
  FileIcon,
  Folder,
  Globe,
  Search,
  Sparkle,
  Terminal,
  Users,
} from "../../icons.tsx";
import { selectTask, useTask } from "../../store/index.ts";
import { showView } from "../../store/ui-store.ts";
import { reportErrorNow } from "../../ui/errors.ts";
import { dotStatus, sameAgents } from "../agents/agent-model.ts";
import { openAgentsPanel } from "../agents/agents-store.ts";
import { openBtw } from "../btw/btw-ui-store.ts";
import { openBrowserPanel } from "../browser/browser-store.ts";
import { filesTarget } from "../file-preview/files-target.ts";
import { openFilePreview, openFilesPanel } from "../file-preview/preview-store.ts";
import { useGitVersion } from "../git/git-store.ts";
import { setTerminalOpen } from "../terminal/terminal-store.ts";
import { useTspDerived } from "../tsp/tsp-store.ts";
import { EMPTY_SESSION_FILES, extractSessionChanges, sameSessionChanges } from "./GitChangesPanel.tsx";
import {
  activateDshTab,
  openDshMcpAppTab,
  openDshToolTab,
  rekeyDshWorkbench,
  type DshTabItem,
} from "./dsh-workbench-store.ts";
import { openChangesPanel } from "./workbench-store.ts";
import "./workbench.css";

const NO_AGENTS: readonly HubAgent[] = [];
const MAX_FILE_MATCHES = 8;
const MAX_SESSION_FILES = 6;
const MAX_AGENTS = 4;

const KNOWN_FILE_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|less|html|htm|svg|png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|pptx?|py|rs|go|java|kt|c|cpp|h|hpp|cs|rb|php|sh|ps1|yaml|yml|toml|xml|sql|csv|tsv|txt|lock)$/i;

/** 输入框里像不像一个能直接在内置浏览器打开的地址（带空格的按搜索词处理）。 */
function navigableUrl(raw: string): string | null {
  const q = raw.trim();
  if (q === "" || /\s/.test(q)) return null;
  if (/^https?:\/\//i.test(q)) return q;
  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/.*)?$/i.test(q)) return `http://${q}`;
  if (!q.includes("/") && KNOWN_FILE_EXT.test(q)) return null;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/.*)?$/i.test(q) && !KNOWN_FILE_EXT.test(q)) return `https://${q}`;
  return null;
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** 应用区的彩色图标块里用的 SVG（和 icons.tsx 的线性图标同一套描边语言）。 */
const APP_GLYPHS = {
  pdf: (
    <Glyph>
      <path d="M4 1.9h5.2l3 3v9.2H4z" />
      <path d="M9.2 1.9v3h3" />
      <path d="M6.1 9.4h4M6.1 11.4h2.6" />
    </Glyph>
  ),
  sheet: (
    <Glyph>
      <rect x="2.3" y="3.2" width="11.4" height="9.6" rx="1.6" />
      <path d="M2.3 6.5h11.4M6.6 6.5v6.3M2.3 9.6h11.4" />
    </Glyph>
  ),
  doc: (
    <Glyph>
      <path d="M3.4 1.9h5.6l3.6 3.6v8.8H3.4z" />
      <path d="M9 1.9v3.6h3.6" />
      <path d="M5.6 8.4h4.8M5.6 10.9h3.2" />
    </Glyph>
  ),
  canvas: (
    <Glyph>
      <path d="M2.4 12.6V3.4M2.4 12.6h11.2" />
      <path d="M4.6 9.9l2.5-3 2.4 1.9 2.3-3.8" />
    </Glyph>
  ),
  skills: (
    <Glyph>
      <path d="M7.2 1.9c.6 2.3 1.5 3.2 3.8 3.8-2.3.6-3.2 1.5-3.8 3.8-.6-2.3-1.5-3.2-3.8-3.8 2.3-.6 3.2-1.5 3.8-3.8Z" />
      <path d="M11.9 9.6c.3 1.2.8 1.7 2 2-1.2.3-1.7.8-2 2-.3-1.2-.8-1.7-2-2 1.2-.3 1.7-.8 2-2Z" />
    </Glyph>
  ),
  mcp: (
    <Glyph>
      <rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1.2" />
      <rect x="9" y="2.4" width="4.6" height="4.6" rx="1.2" />
      <rect x="2.4" y="9" width="4.6" height="4.6" rx="1.2" />
      <path d="M11.3 9v4.6M9 11.3h4.6" />
    </Glyph>
  ),
};

interface LauncherEntry {
  readonly id: string;
  /** 图标块的配色档（见 workbench.css 的 .spl-tile[data-tone]）。 */
  readonly tone: string;
  readonly glyph: ReactNode;
  readonly title: string;
  readonly hint: string;
  readonly badge?: number | undefined;
  readonly testId?: string | undefined;
  readonly onOpen: () => void;
}

interface LauncherRowProps {
  testId: string;
  tone: string;
  glyph: ReactNode;
  title: string;
  hint: string;
  badge?: number | undefined;
  busy: boolean;
  openLabel: string;
  onOpen: () => void;
}

/** 一行「横向应用」：图标底座 + 名称/说明 + 圆润「打开」胶囊，整行是一个按钮。 */
function LauncherRow({ testId, tone, glyph, title, hint, badge, busy, openLabel, onOpen }: LauncherRowProps) {
  return (
    <button
      type="button"
      className="spl-app"
      data-testid={testId}
      data-busy={busy ? "" : undefined}
      title={hint}
      onClick={onOpen}
    >
      <span className="spl-tile" data-tone={tone === "tool" ? undefined : tone} aria-hidden="true">
        {glyph}
      </span>
      <span className="spl-app-main">
        <span className="spl-app-title">
          <span className="spl-app-name">{title}</span>
          {badge !== undefined && badge > 0 && <span className="spl-badge">{badge}</span>}
        </span>
        <span className="spl-app-hint">{hint}</span>
      </span>
      <span className="spl-open-pill">{openLabel}</span>
    </button>
  );
}

export interface SidePaneLauncherProps {
  /** 工作台面板键：任务 id，或新任务草稿的键（`new:<项目 id>`）。 */
  panelKey: TerminalKey;
  /** 当前任务；草稿或没有任务时 null。 */
  taskId: TaskId | null;
  /** 当前「新标签页」自己的页签 id：从卡片打开工具时原位替换它，不留一个空启动页。 */
  tabId: string;
  /** 已开着的终端页签，用于第三区「运行中终端」。 */
  terminalTabs: readonly Extract<DshTabItem, { kind: "terminal" }>[];
}

export function SidePaneLauncher({ panelKey, taskId, tabId, terminalTabs }: SidePaneLauncherProps) {
  const isZh = useLocale() === "zh-CN";
  const draft = useMemo(() => parseDraftKey(panelKey), [panelKey]);
  const draftProjectId = draft?.projectId ?? null;
  const task = useTask(taskId);
  const effectiveProjectId = task?.projectId ?? draftProjectId;
  const target = useMemo(() => filesTarget(panelKey), [panelKey]);
  const gitVersion = useGitVersion(taskId ?? ("" as TaskId));

  const [query, setQuery] = useState("");
  const [fileMatches, setFileMatches] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [gitChangedCount, setGitChangedCount] = useState(0);
  const [mcpApps, setMcpApps] = useState<McpAppServerSnapshot[]>([]);
  /** 正在自动建会话 / 正在取第一个 PDF 的入口 id：连点只会触发一次。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  const omniListId = useId();

  useEffect(() => {
    let cancelled = false;
    window.studio.listMcpApps(effectiveProjectId).then(
      (list) => {
        if (!cancelled) setMcpApps(list);
      },
      () => {
        if (!cancelled) setMcpApps([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [effectiveProjectId]);

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
    if (q === "" || navigableUrl(q) !== null) {
      setFileMatches([]);
      return;
    }
    let cancelled = false;
    window.studio.listProjectFiles(target, q).then(
      (res) => {
        if (!cancelled) setFileMatches(res.slice(0, MAX_FILE_MATCHES));
      },
      () => {
        if (!cancelled) setFileMatches([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [query, target]);

  const sessionFiles = useTspDerived(taskId, extractSessionChanges, sameSessionChanges) ?? EMPTY_SESSION_FILES;
  const agents = useTspDerived(taskId, listAgents, sameAgents, AGENT_NODES) ?? NO_AGENTS;
  const activeAgentCount = useMemo(() => agents.filter((a) => isAgentActive(a.status)).length, [agents]);
  const reviewBadgeCount = gitChangedCount > 0 ? gitChangedCount : sessionFiles.length;
  const urlCandidate = useMemo(() => navigableUrl(query), [query]);

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

  /**
   * 草稿态点需要 TaskId 的入口：先把草稿变成真会话（工作台状态跟着 rekey 过去），再在这个会话上打开工具。
   * 返回打开工具要用的面板键与任务 id。
   */
  const ensureTaskForTool = async (): Promise<{ key: TerminalKey; task: TaskId }> => {
    const projectId = draftProjectId ?? (await window.studio.ensureChatsProject()).id;
    const created = await window.studio.createTask({ projectId });
    rekeyDshWorkbench(panelKey as DraftKey, created.id, false);
    await selectTask(created.id);
    return { key: created.id, task: created.id };
  };

  /** 需要任务才成立的入口：有任务就直接开，草稿态先自动建会话。 */
  const withTask = (busyKey: string, action: (key: TerminalKey, taskId: TaskId) => void) => {
    if (busyId !== null) return;
    if (taskId !== null) {
      action(panelKey, taskId);
      return;
    }
    setBusyId(busyKey);
    void ensureTaskForTool()
      .then((ctx) => action(ctx.key, ctx.task))
      .catch(reportErrorNow)
      .finally(() => setBusyId(null));
  };

  const openFirstPdf = (key: TerminalKey) => {
    if (busyId !== null) return;
    setBusyId("pdf");
    window.studio
      .listProjectFiles(filesTarget(key), "pdf")
      .then((paths) => {
        const pdf = paths.find((path) => path.toLowerCase().endsWith(".pdf"));
        if (pdf !== undefined) {
          openFilePreview(key, pdf, { replaceTabId: tabId });
          return;
        }
        // 工作区里没有 PDF：退回文件树，让用户自己挑一个 PDF。
        openFilesPanel(key);
        openDshToolTab(key, "files", { replaceTabId: tabId });
      }, reportErrorNow)
      .finally(() => setBusyId(null));
  };

  const openTool = (kind: "files" | "browser" | "changes" | "agents" | "extensions", key: TerminalKey) => {
    openDshToolTab(key, kind, { replaceTabId: tabId });
  };

  const openFiles = (key: TerminalKey) => {
    openFilesPanel(key);
    openDshToolTab(key, "files", { replaceTabId: tabId });
  };

  const openTerminal = (key: TerminalKey) => {
    const created = openDshToolTab(key, "terminal", { replaceTabId: tabId, forceNewTerminal: true });
    if (created.kind === "terminal" && created.terminalKey === key) setTerminalOpen(key, true, { focus: true });
  };

  const openBrowserAt = (url: string) => {
    if (busyId !== null) return;
    const show = (key: TerminalKey, taskId2: TaskId) => {
      openBrowserPanel(taskId2, true);
      openDshToolTab(key, "browser", { replaceTabId: tabId });
      void window.studio.navigateBrowser(taskId2, url).catch(reportErrorNow);
      setQuery("");
      setActiveIndex(0);
    };
    if (taskId !== null) {
      show(panelKey, taskId);
      return;
    }
    setBusyId("url");
    void ensureTaskForTool()
      .then((ctx) => show(ctx.key, ctx.task))
      .catch(reportErrorNow)
      .finally(() => setBusyId(null));
  };

  const openMatchedFile = (relPath: string) => {
    openFilePreview(panelKey, relPath, { replaceTabId: tabId });
    setQuery("");
    setActiveIndex(0);
  };

  // 下拉项：URL 直达在内嵌浏览器打开，文件命中直接在预览页打开
  const omniOptions = useMemo(() => {
    const list: { key: string; kind: "url" | "file"; value: string; label: string }[] = [];
    if (urlCandidate !== null) {
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
  }, [fileMatches, isZh, urlCandidate]);

  const runOmniOption = (option: (typeof omniOptions)[number]) => {
    if (option.kind === "url") openBrowserAt(option.value);
    else openMatchedFile(option.value);
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
      const option = omniOptions[Math.min(activeIndex, omniOptions.length - 1)];
      if (option === undefined) return;
      event.preventDefault();
      runOmniOption(option);
      return;
    }
    if (event.key === "Escape" && query !== "") {
      // 只吞掉「清空搜索」这一下，别把工作台的 Esc 语义一起吃掉
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setActiveIndex(0);
    }
  };

  const openLabel = busyId !== null ? (isZh ? "打开中" : "Opening") : isZh ? "打开" : "Open";
  const hasContext = sessionFiles.length > 0 || agents.length > 0 || terminalTabs.length > 0;

  const workspaceRows: readonly LauncherEntry[] = [
    {
      id: "files",
      testId: "dsh-start-files",
      tone: "tool",
      glyph: <Folder size={17} />,
      title: isZh ? "文件" : "Files",
      hint: isZh ? "从目录中选择文件" : "Pick workspace files",
      onOpen: () => openFiles(panelKey),
    },
    {
      id: "browser",
      testId: "dsh-start-browser",
      tone: "tool",
      glyph: <Globe size={17} />,
      title: isZh ? "浏览器" : "Browser",
      hint: isZh ? "浏览网页与预览应用" : "Browse & preview apps",
      onOpen: () =>
        withTask("browser", (key, id) => {
          openBrowserPanel(id, true);
          openTool("browser", key);
        }),
    },
    {
      id: "terminal",
      testId: "dsh-start-terminal",
      tone: "tool",
      glyph: <Terminal size={17} />,
      title: isZh ? "终端" : "Terminal",
      hint: isZh ? "运行命令与查看输出" : "Run commands & output",
      onOpen: () => openTerminal(panelKey),
    },
    {
      id: "changes",
      testId: "dsh-start-changes",
      tone: "tool",
      glyph: <Diff size={17} />,
      title: isZh ? "审查" : "Review",
      hint: isZh ? "查看代码变更与差异" : "Review changes & diffs",
      badge: reviewBadgeCount,
      onOpen: () =>
        withTask("changes", (key, id) => {
          openChangesPanel(id);
          openTool("changes", key);
        }),
    },
    {
      id: "btw",
      testId: "dsh-start-btw",
      tone: "tool",
      glyph: <Comment size={17} />,
      title: isZh ? "辅助对话" : "Side chat",
      hint: isZh ? "在侧边面板继续追问" : "Ask aside in side pane",
      onOpen: () => withTask("btw", (_key, id) => openBtw(id)),
    },
    {
      id: "agents",
      testId: "dsh-start-agents-entry",
      tone: "tool",
      glyph: <Users size={17} />,
      title: isZh ? "子代理" : "Subagents",
      hint: isZh ? "查看子代理运行轨迹" : "Inspect subagent runs",
      onOpen: () =>
        withTask("agents", (key, id) => {
          openAgentsPanel(id);
          openTool("agents", key);
        }),
    },
  ];

  const appRows: readonly LauncherEntry[] = [
    {
      id: "pdf",
      tone: "pdf",
      glyph: APP_GLYPHS["pdf"],
      title: isZh ? "PDF 阅读器" : "PDF reader",
      hint: isZh ? "双栏阅读与页码缩放" : "Outline & page zoom",
      onOpen: () => openFirstPdf(panelKey),
    },
    {
      id: "sheet",
      tone: "sheet",
      glyph: APP_GLYPHS["sheet"],
      title: isZh ? "电子表格" : "Spreadsheet",
      hint: isZh ? "原生预览 Excel 表格" : "Preview Excel sheets",
      onOpen: () => openFiles(panelKey),
    },
    {
      id: "doc",
      tone: "doc",
      glyph: APP_GLYPHS["doc"],
      title: isZh ? "Word 文档" : "Word document",
      hint: isZh ? "原生排版预览 DOCX" : "Layout preview DOCX",
      onOpen: () => openFiles(panelKey),
    },
    {
      id: "canvas",
      tone: "canvas",
      glyph: APP_GLYPHS["canvas"],
      title: isZh ? "交互画布" : "Visual canvas",
      hint: isZh ? "Gen UI 图表与可视化" : "Live Gen UI visuals",
      onOpen: () => openTool("extensions", panelKey),
    },
    {
      id: "skills",
      tone: "skills",
      glyph: APP_GLYPHS["skills"],
      title: isZh ? "技能库" : "Skills",
      hint: isZh ? "管理已安装 Agent 技能" : "Manage agent skills",
      onOpen: () => showView("settings", { section: "extensions" }),
    },
    {
      id: "mcp-center",
      tone: "mcp",
      glyph: APP_GLYPHS["mcp"],
      title: isZh ? "MCP 应用" : "MCP Apps",
      hint: isZh ? "交互式 MCP 工具面板" : "Interactive MCP apps",
      onOpen: () => openTool("extensions", panelKey),
    },
  ];

  return (
    <div className="spl-root" data-testid="dsh-start-launcher">
      <div className="spl-inner">
        <header className="spl-head">
          <h1 className="spl-title">{isZh ? "新标签页" : "New tab"}</h1>
        </header>

        <div className="spl-omni-wrap">
          <div className="spl-omni">
            <Search size={13} className="spl-omni-ic" />
            <input
              type="text"
              className="spl-omni-input"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
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
                isZh ? "搜索项目文件，或输入 URL 回车浏览…" : "Search workspace files, or enter a URL to browse…"
              }
              spellCheck={false}
              data-testid="dsh-start-omnibox"
            />
            {urlCandidate !== null && (
              <span className="spl-omni-kbd" aria-hidden="true">
                Enter
              </span>
            )}
            {query !== "" && (
              <button
                type="button"
                className="spl-omni-clear"
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
              className="spl-omni-dropdown"
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
                  className="spl-omni-option"
                  data-active={index === activeIndex ? "" : undefined}
                  data-testid="dsh-start-omni-option"
                  // 按下鼠标时不抢输入框焦点：高亮和键盘落在同一项上
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runOmniOption(option)}
                >
                  {option.kind === "url" ? <Globe size={13} /> : <FileIcon size={13} />}
                  <span className="spl-omni-option-main">{option.label}</span>
                  {option.kind === "url" && <span className="spl-omni-kbd">Enter</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <section className="spl-section" aria-label={isZh ? "工作台工具" : "Workspace tools"}>
          <div className="spl-apps">
            {workspaceRows.map((row) => (
              <LauncherRow
                key={row.id}
                testId={row.testId ?? `dsh-start-${row.id}`}
                tone={row.tone}
                glyph={row.glyph}
                title={row.title}
                hint={row.hint}
                badge={row.badge}
                busy={busyId === row.id}
                openLabel={openLabel}
                onOpen={row.onOpen}
              />
            ))}
          </div>
        </section>

        <div className="spl-divider" aria-hidden="true" />

        <section className="spl-section" aria-label={isZh ? "应用与能力" : "Apps & capabilities"}>
          <div className="spl-section-head">
            <span className="spl-section-title">{isZh ? "应用插件" : "Apps"}</span>
            <button
              type="button"
              className="spl-link"
              data-testid="dsh-start-extensions"
              onClick={() => openTool("extensions", panelKey)}
            >
              <span>{isZh ? "查看所有插件" : "All plugins"}</span>
              <ChevronRight size={12} />
            </button>
          </div>
          <div className="spl-apps">
            {appRows.map((row) => (
              <LauncherRow
                key={row.id}
                testId={row.testId ?? `dsh-start-app-${row.id}`}
                tone={row.tone}
                glyph={row.glyph}
                title={row.title}
                hint={row.hint}
                busy={busyId === row.id}
                openLabel={openLabel}
                onOpen={row.onOpen}
              />
            ))}
            {availableMcpApps.length > 0 && (
              // display: contents 的语义容器：MCP App 直接落在同一张双列网格里，不另起一块外框
              <div className="spl-mcp-host" data-testid="dsh-start-mcp-apps">
                {availableMcpApps.map((appItem) => (
                  <LauncherRow
                    key={`${appItem.server}:${appItem.uri}`}
                    testId="dsh-start-mcp-app-item"
                    tone="mcp"
                    glyph={<Sparkle size={17} />}
                    title={appItem.title}
                    hint={`MCP · ${appItem.server}`}
                    busy={false}
                    openLabel={openLabel}
                    onOpen={() =>
                      openDshMcpAppTab(panelKey, {
                        server: appItem.server,
                        uri: appItem.uri,
                        title: appItem.title,
                        projectId: effectiveProjectId,
                        replaceTabId: tabId,
                      })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {hasContext && (
          <section className="spl-context" aria-label={isZh ? "本轮上下文" : "Session context"}>
            {sessionFiles.length > 0 && (
              <div className="spl-context-group">
                <div className="spl-context-head">
                  <span>{isZh ? "本轮文件" : "Session files"}</span>
                  <span className="spl-count">{sessionFiles.length}</span>
                </div>
                {sessionFiles.slice(0, MAX_SESSION_FILES).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="spl-live"
                    title={item.path}
                    onClick={() => {
                      openFilePreview(panelKey, item.path, { replaceTabId: tabId });
                    }}
                  >
                    <span className="spl-live-ic">
                      <FileIcon size={13} />
                    </span>
                    <span className="spl-live-main">
                      <span className="spl-live-title">{item.name}</span>
                      {item.displayDir !== "" && <span className="spl-live-sub">{item.displayDir}</span>}
                    </span>
                    {(item.added > 0 || item.removed > 0) && (
                      <span className="spl-live-stats">
                        {item.added > 0 && <span className="wb-stat-add">+{item.added}</span>}
                        {item.removed > 0 && <span className="wb-stat-del">−{item.removed}</span>}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {agents.length > 0 && (
              <div className="spl-context-group">
                <div className="spl-context-head">
                  <span>{isZh ? "活跃子代理" : "Subagents"}</span>
                  <span className="spl-count">
                    {activeAgentCount > 0
                      ? isZh
                        ? `${activeAgentCount} 运行中`
                        : `${activeAgentCount} active`
                      : agents.length}
                  </span>
                </div>
                {agents.slice(0, MAX_AGENTS).map((agent) => {
                  // 橙 = 排队 / 挂起，绿 = 在跑或已完成，红 = 失败（和子代理面板的状态点同语义）
                  const dot =
                    agent.status === "pending" || agent.status === "parked" ? "waiting" : dotStatus(agent.status);
                  return (
                    <button
                      key={agent.name}
                      type="button"
                      className="spl-live"
                      data-testid="dsh-start-agents"
                      title={agent.task === "" ? agent.name : agent.task}
                      onClick={() =>
                        withTask("agents", (key, id) => {
                          openAgentsPanel(id, agent.name);
                          openTool("agents", key);
                        })
                      }
                    >
                      <span className="spl-dot" data-state={dot} aria-hidden="true" />
                      <span className="spl-live-main">
                        <span className="spl-live-title">{agent.name}</span>
                        {agent.task !== "" && <span className="spl-live-sub">{agent.task}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {terminalTabs.length > 0 && (
              <div className="spl-context-group">
                <div className="spl-context-head">
                  <span>{isZh ? "运行中终端" : "Terminals"}</span>
                  <span className="spl-count">{terminalTabs.length}</span>
                </div>
                {terminalTabs.map((term) => (
                  <button
                    key={term.id}
                    type="button"
                    className="spl-live"
                    onClick={() => activateDshTab(panelKey, term.id)}
                  >
                    <span className="spl-live-ic">
                      <Terminal size={13} />
                    </span>
                    <span className="spl-live-main">
                      <span className="spl-live-title">
                        {term.shellLabel ?? (isZh ? `终端 ${term.index}` : `Terminal ${term.index}`)}
                      </span>
                      <span className="spl-live-sub">{isZh ? "活跃会话" : "Active"}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
