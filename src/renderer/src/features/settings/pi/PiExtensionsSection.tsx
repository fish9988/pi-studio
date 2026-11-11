// Pi 扩展与集成页（extensions）：内置扩展（builtin:*）、MCP 服务器（mcp.json + exposure）、Pi 扩展包（pi install/update/remove）、Skills 与提示词模板（prompts/*.md）。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PI_BUILTIN_EXTENSIONS,
  PI_MCP_EXPOSURES,
  type PiBuiltinExtensionId,
  type PiConfigScope,
  type PiMcpExposure,
  type PiMcpServerItem,
  type PiMcpServerSaveInput,
  type PiPackageItem,
  type PiResourcesSnapshot,
} from "../../../../../shared/pi-config-types.ts";
import {
  cleanPiPackageName,
  CURATED_PI_PLUGINS,
  findCuratedPiPlugin,
  formatPluginNumber,
  PI_PLUGIN_CATEGORIES,
  piPluginHue,
  piPluginInitial,
  type PiMarketplacePlugin,
  type PiPluginCategory,
} from "../../../../../shared/pi-plugin-catalog.ts";
import { setAutoSmartRename, useShellValue } from "../../../app/shell-store.ts";
import {
  addQuickPhrase,
  removeQuickPhrase,
  resetQuickPhrases,
  setQuickPhrasesEnabled,
  useQuickPhrases,
} from "../../composer/QuickPhrasesButton.tsx";
import {
  Bolt,
  Code,
  External,
  FileIcon,
  Pencil,
  Plug,
  Plus,
  Restart,
  Search,
  Sparkle,
  Star,
  Terminal,
  Trash,
} from "../../../icons.tsx";
import {
  Badge,
  Button,
  Checkbox,
  FormField,
  IconButton,
  ListRow,
  NumberField,
  Row,
  SectionHead,
  Segmented,
  Switch,
  Textarea,
  TextField,
  type Option,
} from "../../../ui/controls.tsx";
import { ConfirmDialog, Dialog } from "../../../ui/Dialog.tsx";
import { reportError } from "../../../ui/errors.ts";
import { pushToast } from "../../dialogs/toast-store.ts";
import { SkillsCard } from "../SkillsCard.tsx";
import { piBridge } from "./pi-bridge.ts";
import { asBoolean, PiScopeBar, usePiScopeState, usePiSetting, usePiText } from "./pi-shared.tsx";

interface BuiltinExtMeta {
  id: PiBuiltinExtensionId;
  icon: ReactNode;
  zh: string;
  en: string;
}

const BUILTIN_EXT_META: readonly BuiltinExtMeta[] = [
  { id: "builtin:mcp", icon: <Plug size={14} />, zh: "MCP 客户端与工具桥接", en: "MCP client & tool bridge" },
  { id: "builtin:codemode", icon: <Code size={14} />, zh: "JS 沙箱工具编排", en: "JS sandbox tool orchestration" },
  {
    id: "builtin:tool-search",
    icon: <Sparkle size={14} />,
    zh: "延迟工具按需检索",
    en: "On-demand deferred tool lookup",
  },
  { id: "builtin:llama.cpp", icon: <Terminal size={14} />, zh: "本地 llama.cpp 推理", en: "Local llama.cpp inference" },
];

function parseKeyValueLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    const colon = trimmed.indexOf(":");
    const sep = eq > 0 && (colon <= 0 || eq < colon) ? eq : colon;
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const val = trimmed.slice(sep + 1).trim();
    if (key !== "") out[key] = val;
  }
  return out;
}

function parseArgLines(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  if (trimmed.includes("\n")) {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }
  return trimmed.split(/\s+/).filter((item) => item !== "");
}

interface McpFormState {
  mode: "add" | "edit";
  previousName?: string | undefined;
  existingEnvKeys: string[];
  existingHeaderKeys: string[];
  scope: PiConfigScope;
  name: string;
  transport: "stdio" | "http";
  exposure: PiMcpExposure;
  enabled: boolean;
  command: string;
  argsText: string;
  cwd: string;
  envText: string;
  clearEnv: boolean;
  url: string;
  headersText: string;
  clearHeaders: boolean;
  timeoutText: string;
  description: string;
}

function createEmptyMcpForm(scope: PiConfigScope): McpFormState {
  return {
    mode: "add",
    existingEnvKeys: [],
    existingHeaderKeys: [],
    scope,
    name: "",
    transport: "stdio",
    exposure: "codemode",
    enabled: true,
    command: "",
    argsText: "",
    cwd: "",
    envText: "",
    clearEnv: false,
    url: "",
    headersText: "",
    clearHeaders: false,
    timeoutText: "",
    description: "",
  };
}

function createEditMcpForm(server: PiMcpServerItem): McpFormState {
  return {
    mode: "edit",
    previousName: server.name,
    existingEnvKeys: server.envKeys,
    existingHeaderKeys: server.headerKeys,
    scope: server.scope,
    name: server.name,
    transport: server.transport,
    exposure: server.exposure,
    enabled: server.enabled,
    command: server.command ?? "",
    argsText: (server.args ?? []).join("\n"),
    cwd: server.cwd ?? "",
    envText: "",
    clearEnv: false,
    url: server.url ?? "",
    headersText: "",
    clearHeaders: false,
    timeoutText: server.timeout !== undefined ? String(server.timeout) : "",
    description: server.description ?? "",
  };
}

export function PiExtensionsSection() {
  const { tr, t } = usePiText();
  const { scope, setScope, projects, projectId, setProjectId } = usePiScopeState();
  const scopedProjectId = scope === "project" ? projectId : null;

  const [resources, setResources] = useState<PiResourcesSnapshot>(() => ({
    packages: [],
    builtinExtensions: PI_BUILTIN_EXTENSIONS.map((id) => ({ id, enabled: true })),
    customExtensions: [],
    mcpServers: [],
    prompts: [],
    enableSkillCommands: true,
  }));
  const [loading, setLoading] = useState(false);

  // MCP 新增/编辑/删除弹窗
  const [mcpForm, setMcpForm] = useState<McpFormState | null>(null);
  const [savingMcp, setSavingMcp] = useState(false);
  const [deletingMcp, setDeletingMcp] = useState<PiMcpServerItem | null>(null);

  // Pi 扩展包安装 / 更新状态
  const [pkgSource, setPkgSource] = useState("");
  const [pkgBusy, setPkgBusy] = useState<"install" | "update" | string | null>(null);
  const [pkgOutput, setPkgOutput] = useState("");

  // 插件市场状态
  const [marketQuery, setMarketQuery] = useState("");
  const [marketCategory, setMarketCategory] = useState<"all" | PiPluginCategory>("all");
  const [marketItems, setMarketItems] = useState<PiMarketplacePlugin[]>(() => [...CURATED_PI_PLUGINS]);
  const [marketLoading, setMarketLoading] = useState(false);

  // DSH 灵感工作台插件（快捷短语库 + 智能重命名）
  const quickPhrases = useQuickPhrases();
  const [phraseTitle, setPhraseTitle] = useState("");
  const [phrasePrompt, setPhrasePrompt] = useState("");
  const autoSmartRename = useShellValue("autoSmartRename") ?? false;

  // 自定义扩展路径
  const [extPathDraft, setExtPathDraft] = useState("");

  // Skill 命令开关 (/skill:name)
  const enableSkillCommands = usePiSetting("enableSkillCommands", true, asBoolean);

  const loadResources = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await piBridge().getPiResources(projectId);
      setResources(snap);
    } catch (error) {
      reportError(t, error);
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void loadResources();
  }, [loadResources]);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      setMarketLoading(true);
      void piBridge()
        .searchPiPlugins(marketQuery)
        .then((items) => {
          if (alive) setMarketItems(items);
        })
        .catch(() => {})
        .finally(() => {
          if (alive) setMarketLoading(false);
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [marketQuery]);

  const builtinStateMap = useMemo(() => {
    const map = new Map<PiBuiltinExtensionId, boolean>();
    for (const item of resources.builtinExtensions) map.set(item.id, item.enabled);
    return map;
  }, [resources.builtinExtensions]);

  const visibleMcpServers = useMemo(
    () => resources.mcpServers.filter((srv) => (scope === "global" ? srv.scope === "global" : true)),
    [resources.mcpServers, scope],
  );

  const visiblePackages = useMemo(
    () => resources.packages.filter((pkg) => (scope === "global" ? pkg.scope === "global" : true)),
    [resources.packages, scope],
  );

  const visiblePrompts = useMemo(
    () => resources.prompts.filter((p) => (scope === "global" ? p.scope === "global" : true)),
    [resources.prompts, scope],
  );

  const installedPkgNames = useMemo(() => {
    const map = new Map<string, PiPackageItem>();
    for (const pkg of visiblePackages) {
      map.set(cleanPiPackageName(pkg.source), pkg);
      map.set(pkg.source, pkg);
    }
    return map;
  }, [visiblePackages]);

  const filteredMarketItems = useMemo(() => {
    if (marketCategory === "all") return marketItems;
    return marketItems.filter((item) => item.category === marketCategory);
  }, [marketItems, marketCategory]);

  const toggleBuiltinExtension = async (id: PiBuiltinExtensionId, enabled: boolean) => {
    try {
      await piBridge().setPiBuiltinExtensionEnabled(id, enabled);
      await loadResources();
    } catch (error) {
      reportError(t, error);
    }
  };

  const addCustomExtensionPath = async () => {
    const trimmed = extPathDraft.trim();
    if (trimmed === "" || resources.customExtensions.includes(trimmed)) return;
    try {
      await piBridge().setPiCustomExtensions([...resources.customExtensions, trimmed]);
      setExtPathDraft("");
      await loadResources();
    } catch (error) {
      reportError(t, error);
    }
  };

  const removeCustomExtensionPath = async (target: string) => {
    try {
      await piBridge().setPiCustomExtensions(resources.customExtensions.filter((p) => p !== target));
      await loadResources();
    } catch (error) {
      reportError(t, error);
    }
  };

  const toggleMcpEnabled = async (server: PiMcpServerItem, enabled: boolean) => {
    try {
      await piBridge().setPiMcpServerEnabled(
        server.scope,
        server.name,
        enabled,
        server.scope === "project" ? projectId : null,
      );
      await loadResources();
    } catch (error) {
      reportError(t, error);
    }
  };

  const submitMcpForm = async () => {
    if (!mcpForm) return;
    const name = mcpForm.name.trim();
    if (name === "") return;
    if (mcpForm.transport === "stdio" && mcpForm.command.trim() === "") return;
    if (mcpForm.transport === "http" && mcpForm.url.trim() === "") return;

    setSavingMcp(true);
    try {
      const parsedTimeout = mcpForm.timeoutText.trim() === "" ? undefined : Number(mcpForm.timeoutText.trim());
      const timeout =
        parsedTimeout !== undefined && Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : undefined;
      const input: PiMcpServerSaveInput = {
        scope: mcpForm.scope,
        projectId: mcpForm.scope === "project" ? projectId : null,
        ...(mcpForm.mode === "edit" && mcpForm.previousName !== undefined
          ? { previousName: mcpForm.previousName }
          : {}),
        name,
        transport: mcpForm.transport,
        enabled: mcpForm.enabled,
        exposure: mcpForm.exposure,
        ...(timeout !== undefined ? { timeout } : {}),
        ...(mcpForm.description.trim() !== "" ? { description: mcpForm.description.trim() } : {}),
        ...(mcpForm.transport === "stdio"
          ? {
              command: mcpForm.command.trim(),
              args: parseArgLines(mcpForm.argsText),
              ...(mcpForm.cwd.trim() !== "" ? { cwd: mcpForm.cwd.trim() } : {}),
              env: parseKeyValueLines(mcpForm.envText),
              ...(mcpForm.clearEnv ? { clearEnv: true } : {}),
            }
          : {
              url: mcpForm.url.trim(),
              headers: parseKeyValueLines(mcpForm.headersText),
              ...(mcpForm.clearHeaders ? { clearHeaders: true } : {}),
            }),
      };
      await piBridge().savePiMcpServer(input);
      setMcpForm(null);
      await loadResources();
      pushToast({ level: "info", message: tr(`已保存 MCP 服务器 ${name}`, `Saved MCP server ${name}`) });
    } catch (error) {
      reportError(t, error);
    } finally {
      setSavingMcp(false);
    }
  };

  const confirmDeleteMcp = async (server: PiMcpServerItem) => {
    setDeletingMcp(null);
    try {
      await piBridge().deletePiMcpServer(server.scope, server.name, server.scope === "project" ? projectId : null);
      await loadResources();
      pushToast({ level: "info", message: tr(`已移除 ${server.name}`, `Removed ${server.name}`) });
    } catch (error) {
      reportError(t, error);
    }
  };

  const installPackageSpec = async (rawSource: string) => {
    const source = rawSource.trim().replace(/^\$?\s*pi\s+install\s+/i, "");
    if (source === "") return;
    setPkgBusy(`install:${source}`);
    try {
      const { output } = await piBridge().runPiPackageAction("install", source, scope, scopedProjectId);
      setPkgOutput(output.trim());
      await loadResources();
      pushToast({ level: "info", message: tr(`已安装 ${cleanPiPackageName(source)}`, `Installed ${source}`) });
    } catch (error) {
      reportError(t, error);
    } finally {
      setPkgBusy(null);
    }
  };

  const installPackage = async () => {
    const source = pkgSource.trim();
    if (source === "") return;
    setPkgBusy("install");
    try {
      const cleaned = source.replace(/^\$?\s*pi\s+install\s+/i, "");
      const { output } = await piBridge().runPiPackageAction("install", cleaned, scope, scopedProjectId);
      setPkgOutput(output.trim());
      setPkgSource("");
      await loadResources();
      pushToast({ level: "info", message: tr(`已安装 ${cleanPiPackageName(cleaned)}`, `Installed ${cleaned}`) });
    } catch (error) {
      reportError(t, error);
    } finally {
      setPkgBusy(null);
    }
  };

  const updateAllPackages = async () => {
    setPkgBusy("update");
    try {
      const { output } = await piBridge().runPiPackageAction("update", null, scope, scopedProjectId);
      setPkgOutput(output.trim());
      await loadResources();
      pushToast({ level: "info", message: tr("扩展包已更新", "Packages updated") });
    } catch (error) {
      reportError(t, error);
    } finally {
      setPkgBusy(null);
    }
  };

  const removePackage = async (pkg: PiPackageItem) => {
    setPkgBusy(pkg.source);
    try {
      const { output } = await piBridge().runPiPackageAction(
        "remove",
        pkg.source,
        pkg.scope,
        pkg.scope === "project" ? projectId : null,
      );
      setPkgOutput(output.trim());
      await loadResources();
      pushToast({ level: "info", message: tr(`已移除 ${pkg.source}`, `Removed ${pkg.source}`) });
    } catch (error) {
      reportError(t, error);
    } finally {
      setPkgBusy(null);
    }
  };

  const transportOptions: readonly Option<"stdio" | "http">[] = [
    { value: "stdio", label: "stdio" },
    { value: "http", label: "HTTP" },
  ];

  const exposureOptions: readonly Option<PiMcpExposure>[] = PI_MCP_EXPOSURES.map((exp) => ({
    value: exp,
    label: exp,
  }));

  const modalScopeOptions: readonly Option<PiConfigScope>[] = [
    { value: "global", label: tr("全局 (~/.pi)", "Global (~/.pi)") },
    { value: "project", label: tr("当前项目 (.pi)", "Project (.pi)") },
  ];

  const canSaveMcp =
    mcpForm !== null &&
    mcpForm.name.trim() !== "" &&
    (mcpForm.transport === "stdio" ? mcpForm.command.trim() !== "" : mcpForm.url.trim() !== "");

  return (
    <div className="pis-stack" data-testid="pi-extensions-section">
      {/* 顶栏范围切换：MCP / 扩展包 / Skills / Prompt 模板共用 */}
      <div className="pis-inline-bar">
        <PiScopeBar
          scope={scope}
          onScopeChange={setScope}
          projects={projects}
          projectId={projectId}
          onProjectChange={setProjectId}
          testId="pi-ext-scope"
        />
        <IconButton
          label={tr("刷新扩展与资源", "Refresh resources")}
          disabled={loading}
          onClick={() => void loadResources()}
          testId="pi-ext-refresh"
        >
          <Restart />
        </IconButton>
      </div>

      {/* 1. 已安装插件与扩展包管理 (pi install / update / remove) */}
      <section className="pis-group" data-testid="pi-installed-plugins-section">
        <SectionHead
          title={tr("已安装插件与扩展包", "Installed plugins & packages")}
          count={visiblePackages.length}
          actions={
            <Button
              size="sm"
              icon={<Restart size={14} />}
              loading={pkgBusy === "update"}
              disabled={pkgBusy !== null}
              onClick={() => void updateAllPackages()}
              testId="pi-pkg-update-all"
            >
              {tr("全部更新", "Update all")}
            </Button>
          }
        />
        <div className="pis-card-padded">
          <div className="pis-pkg-bar">
            <TextField
              size="sm"
              mono
              width="100%"
              className="pis-pkg-input"
              value={pkgSource}
              onChange={setPkgSource}
              placeholder={tr(
                "输入插件包来源：npm:pi-web-access · git:github.com/user/repo · ./local-pkg",
                "npm:@foo/bar · git:github.com/user/repo · ./local-pkg",
              )}
              aria-label={tr("扩展包来源", "Package source")}
              onKeyDown={(event) => {
                if (event.key === "Enter" && pkgSource.trim() !== "") void installPackage();
              }}
              testId="pi-pkg-input"
            />
            <Button
              size="sm"
              variant="primary"
              loading={pkgBusy === "install"}
              disabled={pkgBusy !== null || pkgSource.trim() === ""}
              onClick={() => void installPackage()}
              testId="pi-pkg-install"
            >
              {tr("安装插件", "Install")}
            </Button>
          </div>

          {pkgOutput !== "" && (
            <pre className="pis-cli-output" data-testid="pi-pkg-output">
              {pkgOutput}
            </pre>
          )}

          {visiblePackages.length === 0 ? (
            <p className="pis-muted">
              {tr(
                "当前范围尚未安装外部插件包，可在下方「Pi 插件市场」一键浏览安装。",
                "No external Pi packages installed yet. Browse the marketplace below to install in one click.",
              )}
            </p>
          ) : (
            <div className="pis-plugin-installed-list">
              {visiblePackages.map((pkg) => {
                const displayName = cleanPiPackageName(pkg.source);
                const curated = findCuratedPiPlugin(pkg.source);
                const hue = piPluginHue(displayName);
                const initial = piPluginInitial(displayName);
                return (
                  <div
                    key={`${pkg.scope}:${pkg.source}`}
                    className="pis-plugin-installed-row"
                    data-testid={`pi-pkg-row-${pkg.source}`}
                  >
                    <span className="pis-plugin-avatar" style={{ "--pl-hue": hue } as React.CSSProperties}>
                      {initial}
                    </span>
                    <div className="pis-plugin-installed-body">
                      <div className="pis-plugin-installed-head">
                        <span className="pis-plugin-title">{displayName}</span>
                        <Badge>{pkg.kind}</Badge>
                        {curated?.version && <Badge>v{curated.version}</Badge>}
                        {scope === "project" && (
                          <Badge>{pkg.scope === "project" ? tr("项目", "project") : tr("全局", "global")}</Badge>
                        )}
                      </div>
                      <span className="pis-plugin-desc">
                        {curated ? tr(curated.zhDescription, curated.description) : pkg.source}
                      </span>
                    </div>
                    <div className="pis-plugin-installed-actions">
                      {(curated?.repoUrl ?? curated?.npmUrl) && (
                        <IconButton
                          label={tr("打开主页", "Open homepage")}
                          onClick={() =>
                            void piBridge()
                              .openExternal((curated?.repoUrl ?? curated?.npmUrl)!)
                              .catch((err: unknown) => reportError(t, err))
                          }
                        >
                          <External size={13} />
                        </IconButton>
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        loading={pkgBusy === pkg.source}
                        disabled={pkgBusy !== null}
                        onClick={() => void removePackage(pkg)}
                        testId={`pi-pkg-remove-${pkg.source}`}
                      >
                        {tr("卸载", "Remove")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* 2. Pi 插件市场 (精选推荐 + npm keywords:pi-package 实时检索) */}
      <section className="pis-group" data-testid="pi-marketplace-section">
        <SectionHead
          title={tr("Pi 插件市场", "Pi Plugin Marketplace")}
          count={filteredMarketItems.length}
          note={tr(
            "收录社区高 Star 精选插件与 npm 实时插件库，点一下直接安装到当前范围。",
            "Curated high-star Pi extensions and live npm registry search with one-click install.",
          )}
        />
        <div className="pis-card-padded">
          <div className="pis-market-toolbar">
            <TextField
              size="sm"
              type="search"
              width="100%"
              className="pis-market-search"
              leading={<Search size={14} />}
              value={marketQuery}
              onChange={setMarketQuery}
              placeholder={tr(
                "搜索插件名称、功能或标签（如 MCP、压缩、记忆、安全）…",
                "Search plugins by name or tag…",
              )}
              aria-label={tr("搜索插件市场", "Search plugin marketplace")}
              testId="pi-market-search"
            />
          </div>

          <div className="pis-market-cats" role="tablist" aria-label={tr("插件分类", "Plugin categories")}>
            <button
              type="button"
              role="tab"
              aria-selected={marketCategory === "all"}
              className="pis-market-cat"
              data-active={marketCategory === "all" || undefined}
              onClick={() => setMarketCategory("all")}
              data-testid="pi-market-cat-all"
            >
              {tr("全部", "All")}
            </button>
            {PI_PLUGIN_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={marketCategory === cat}
                className="pis-market-cat"
                data-active={marketCategory === cat || undefined}
                onClick={() => setMarketCategory(cat)}
                data-testid={`pi-market-cat-${cat}`}
              >
                {cat}
              </button>
            ))}
          </div>

          {filteredMarketItems.length === 0 ? (
            <p className="pis-muted">
              {marketLoading
                ? tr("正在检索插件市场…", "Searching plugin marketplace…")
                : tr("没有找到匹配的插件。", "No matching plugins found.")}
            </p>
          ) : (
            <div className="pis-market-grid" data-testid="pi-marketplace-grid">
              {filteredMarketItems.map((item) => {
                const installedPkg = installedPkgNames.get(item.name) ?? installedPkgNames.get(item.installSpec);
                const hue = piPluginHue(item.name);
                const initial = piPluginInitial(item.name);
                const installingThis = pkgBusy === `install:${item.installSpec}`;
                const removingThis = installedPkg !== undefined && pkgBusy === installedPkg.source;
                return (
                  <div
                    key={item.name}
                    className="pis-market-card"
                    data-installed={installedPkg !== undefined || undefined}
                    data-testid={`pi-market-card-${item.name}`}
                  >
                    <div className="pis-market-card-top">
                      <span className="pis-plugin-avatar" style={{ "--pl-hue": hue } as React.CSSProperties}>
                        {initial}
                      </span>
                      <div className="pis-market-card-title-wrap">
                        <div className="pis-market-card-title-row">
                          <span className="pis-market-card-name">{item.name}</span>
                          <Badge>v{item.version}</Badge>
                        </div>
                        <div className="pis-market-card-stats">
                          <span>@{item.author}</span>
                          {item.stars !== undefined && (
                            <span className="pis-market-stat-star">
                              <Star size={11} />
                              {formatPluginNumber(item.stars)}
                            </span>
                          )}
                          {item.downloads > 0 && <span>↓ {formatPluginNumber(item.downloads)}</span>}
                        </div>
                      </div>
                    </div>

                    <p className="pis-market-card-desc">{tr(item.zhDescription, item.description)}</p>

                    <div className="pis-market-card-foot">
                      <div className="pis-market-tags">
                        <span className="pis-market-tag" data-featured={item.featured || undefined}>
                          {item.category}
                        </span>
                        {(item.tags ?? []).slice(0, 2).map((tag) => (
                          <span key={tag} className="pis-market-tag">
                            {tag}
                          </span>
                        ))}
                      </div>
                      <div className="pis-market-actions">
                        {(item.repoUrl ?? item.npmUrl) && (
                          <IconButton
                            label={tr("查看仓库", "View repository")}
                            onClick={() =>
                              void piBridge()
                                .openExternal((item.repoUrl ?? item.npmUrl)!)
                                .catch((err: unknown) => reportError(t, err))
                            }
                          >
                            <External size={13} />
                          </IconButton>
                        )}
                        {installedPkg ? (
                          <Button
                            size="sm"
                            loading={removingThis}
                            disabled={pkgBusy !== null}
                            onClick={() => void removePackage(installedPkg)}
                            testId={`pi-market-remove-${item.name}`}
                          >
                            {tr("已装 · 卸载", "Installed · Remove")}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="primary"
                            loading={installingThis}
                            disabled={pkgBusy !== null}
                            onClick={() => void installPackageSpec(item.installSpec)}
                            testId={`pi-market-install-${item.name}`}
                          >
                            {tr("安装", "Install")}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* 3. 工作台增强插件 (灵感源于热门工作台插件：快捷短语 ⚡ + 自动智能命名 ✨) */}
      <section className="pis-group" data-testid="pi-workbench-enhancements">
        <SectionHead
          title={tr("工作台内置增强插件", "Workbench enhancements")}
          note={tr(
            "内置的会话效率与界面增强组件，无需额外占模型 Context Token。",
            "Built-in Studio productivity enhancements with zero context token overhead.",
          )}
        />
        <div className="pis-card pis-card-rows">
          <Row
            label={tr("输入框 ⚡ 快捷指令短语菜单", "Composer ⚡ quick phrases menu")}
            reset={{ tip: tr("恢复默认短语", "Reset defaults"), onReset: resetQuickPhrases }}
            testId="pi-quick-phrases-row"
          >
            {(labelId) => (
              <Switch
                checked={quickPhrases.enabled}
                labelledBy={labelId}
                onChange={setQuickPhrasesEnabled}
                testId="pi-quick-phrases-switch"
              />
            )}
          </Row>
          <Row
            label={tr("新对话首轮完成后自动智能生成标题", "Auto smart-rename new session title")}
            testId="pi-workbench-smart-rename-row"
          >
            {(labelId) => (
              <Switch
                checked={autoSmartRename}
                labelledBy={labelId}
                onChange={setAutoSmartRename}
                testId="pi-workbench-smart-rename"
              />
            )}
          </Row>
        </div>

        {quickPhrases.enabled && (
          <div className="pis-card-padded">
            <div className="pis-pkg-bar">
              <TextField
                size="sm"
                width={180}
                value={phraseTitle}
                onChange={setPhraseTitle}
                placeholder={tr("短语标题（如：精简重构）", "Phrase title")}
                aria-label={tr("短语标题", "Phrase title")}
                testId="pi-phrase-title-input"
              />
              <TextField
                size="sm"
                width="100%"
                className="pis-pkg-input"
                value={phrasePrompt}
                onChange={setPhrasePrompt}
                placeholder={tr("点击后插入输入框的提示词正文…", "Prompt text to insert…")}
                aria-label={tr("短语内容", "Phrase prompt")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && phraseTitle.trim() !== "" && phrasePrompt.trim() !== "") {
                    addQuickPhrase(phraseTitle, phrasePrompt);
                    setPhraseTitle("");
                    setPhrasePrompt("");
                  }
                }}
                testId="pi-phrase-prompt-input"
              />
              <Button
                size="sm"
                icon={<Plus size={14} />}
                disabled={phraseTitle.trim() === "" || phrasePrompt.trim() === ""}
                onClick={() => {
                  addQuickPhrase(phraseTitle, phrasePrompt);
                  setPhraseTitle("");
                  setPhrasePrompt("");
                }}
                testId="pi-phrase-add-btn"
              >
                {tr("添加短语", "Add")}
              </Button>
            </div>
            <div className="pis-selected-chips">
              {quickPhrases.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="pis-chip"
                  onClick={() => removeQuickPhrase(item.id)}
                  title={`${item.prompt}\n(${tr("点击移除", "Click to remove")})`}
                >
                  <Bolt size={11} />
                  <span>{item.title}</span>
                  <Trash size={11} />
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 4. 内置扩展 (builtin:*) */}
      <section className="pis-group">
        <SectionHead title={tr("内置扩展 (builtin:*)", "Built-in extensions (builtin:*)")} />
        <div className="pis-tool-grid" data-testid="pi-builtin-extensions">
          {BUILTIN_EXT_META.map((ext) => {
            const enabled = builtinStateMap.get(ext.id) ?? true;
            return (
              <div
                key={ext.id}
                className="pis-tool-card"
                data-enabled={enabled || undefined}
                data-testid={`pi-builtin-${ext.id}`}
              >
                <div className="pis-tool-lead">
                  <span className="pis-tool-icon" aria-hidden="true">
                    {ext.icon}
                  </span>
                  <div className="pis-tool-meta">
                    <span className="pis-tool-id">{ext.id}</span>
                    <span className="pis-tool-desc">{tr(ext.zh, ext.en)}</span>
                  </div>
                </div>
                <Switch
                  checked={enabled}
                  label={ext.id}
                  onChange={(next) => void toggleBuiltinExtension(ext.id, next)}
                  testId={`pi-builtin-switch-${ext.id}`}
                />
              </div>
            );
          })}
        </div>

        {/* 本地自定义扩展脚本路径 */}
        <div className="pis-card-padded">
          <div className="pis-pkg-bar">
            <TextField
              size="sm"
              mono
              width="100%"
              className="pis-pkg-input"
              value={extPathDraft}
              onChange={setExtPathDraft}
              placeholder={tr("添加本地扩展路径（如 ~/.pi/agent/extensions/my-ext.ts）", "Add custom extension path…")}
              aria-label={tr("自定义扩展路径", "Custom extension path")}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addCustomExtensionPath();
              }}
              testId="pi-custom-ext-input"
            />
            <Button
              size="sm"
              icon={<Plus size={14} />}
              disabled={extPathDraft.trim() === ""}
              onClick={() => void addCustomExtensionPath()}
              testId="pi-custom-ext-add"
            >
              {tr("挂载", "Add")}
            </Button>
          </div>
          {resources.customExtensions.length > 0 && (
            <div className="pis-selected-chips">
              {resources.customExtensions.map((extPath) => (
                <button
                  key={extPath}
                  type="button"
                  className="pis-chip"
                  onClick={() => void removeCustomExtensionPath(extPath)}
                  title={tr("点击移除", "Click to remove")}
                >
                  <span>{extPath}</span>
                  <Trash size={11} />
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 5. MCP 服务器 (mcp.json) */}
      <section className="pis-group">
        <SectionHead
          title={tr("MCP 服务器 (mcp.json)", "MCP servers (mcp.json)")}
          count={visibleMcpServers.length}
          actions={
            <>
              <Button
                size="sm"
                icon={<External size={14} />}
                onClick={() =>
                  void piBridge()
                    .openPiConfigFile("mcp.json")
                    .catch((err: unknown) => reportError(t, err))
                }
                testId="pi-open-mcp-json"
              >
                {tr("打开 mcp.json", "Open mcp.json")}
              </Button>
              <Button
                size="sm"
                icon={<Plus size={14} />}
                onClick={() => setMcpForm(createEmptyMcpForm(scope))}
                testId="pi-mcp-add"
              >
                {tr("添加服务器", "Add server")}
              </Button>
            </>
          }
        />
        <div className="pis-card">
          {visibleMcpServers.length === 0 ? (
            <div className="pis-card-padded">
              <p className="pis-muted">
                {tr("当前范围尚未配置 MCP 服务器。", "No MCP servers configured in this scope.")}
              </p>
            </div>
          ) : (
            visibleMcpServers.map((server) => {
              const endpoint =
                server.transport === "stdio"
                  ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
                  : (server.url ?? "");
              return (
                <ListRow
                  key={`${server.scope}:${server.name}`}
                  icon={<Plug />}
                  title={server.name}
                  testId={`pi-mcp-row-${server.name}`}
                  badges={
                    <>
                      <Badge>{server.transport}</Badge>
                      <span
                        className="pis-exposure-badge"
                        data-exposure={server.exposure}
                        data-testid={`pi-mcp-exposure-${server.name}`}
                      >
                        {server.exposure}
                      </span>
                      {scope === "project" && (
                        <Badge>{server.scope === "project" ? tr("项目", "project") : tr("全局", "global")}</Badge>
                      )}
                    </>
                  }
                  meta={server.description ? `${server.description} · ${endpoint}` : endpoint}
                  actions={
                    <>
                      <Switch
                        checked={server.enabled}
                        label={server.name}
                        onChange={(next) => void toggleMcpEnabled(server, next)}
                        testId={`pi-mcp-switch-${server.name}`}
                      />
                      <IconButton
                        label={tr("编辑", "Edit")}
                        onClick={() => setMcpForm(createEditMcpForm(server))}
                        testId={`pi-mcp-edit-${server.name}`}
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        label={tr("删除", "Delete")}
                        onClick={() => setDeletingMcp(server)}
                        testId={`pi-mcp-delete-${server.name}`}
                      >
                        <Trash />
                      </IconButton>
                    </>
                  }
                />
              );
            })
          )}
        </div>
      </section>

      {/* 6. Skills 与提示词模板 (skills & prompts/*.md) */}
      <section className="pis-group">
        <div className="pis-card pis-card-rows">
          <Row
            label={tr("注册 /skill:name 斜杠命令", "Register /skill:name commands")}
            modified={enableSkillCommands.modified}
            reset={{ tip: "true", onReset: () => void enableSkillCommands.reset() }}
            testId="pi-enable-skill-cmds-row"
          >
            {(labelId) => (
              <Switch
                checked={enableSkillCommands.value}
                labelledBy={labelId}
                onChange={(next) => void enableSkillCommands.save(next)}
                testId="pi-enable-skill-cmds"
              />
            )}
          </Row>
        </div>

        <SkillsCard scope={scope === "project" && projectId !== null ? projectId : "user"} />
      </section>

      {/* 已发现的 /prompt 模板列表 */}
      <section className="pis-group">
        <SectionHead
          title={tr("提示词模板 (prompts/*.md)", "Prompt templates (prompts/*.md)")}
          count={visiblePrompts.length}
          note={tr(
            "保存在 ~/.pi/agent/prompts/*.md 或 .pi/prompts/*.md，在对话中以 /模板名 调用。",
            "Markdown templates in ~/.pi/agent/prompts/*.md or .pi/prompts/*.md invoked as /name.",
          )}
        />
        <div className="pis-card">
          {visiblePrompts.length === 0 ? (
            <div className="pis-card-padded">
              <p className="pis-muted">{tr("未发现提示词模板文件。", "No prompt templates discovered.")}</p>
            </div>
          ) : (
            visiblePrompts.map((prompt) => (
              <ListRow
                key={`${prompt.scope}:${prompt.name}`}
                icon={<FileIcon />}
                title={`/${prompt.name}`}
                testId={`pi-prompt-row-${prompt.name}`}
                badges={
                  <>
                    <Badge>{prompt.fileName}</Badge>
                    <Badge>{prompt.scope === "project" ? tr("项目", "project") : tr("全局", "global")}</Badge>
                  </>
                }
                meta={prompt.description}
              />
            ))
          )}
        </div>
      </section>

      {/* MCP 新增 / 编辑弹窗 */}
      <Dialog
        open={mcpForm !== null}
        onClose={() => setMcpForm(null)}
        size="md"
        title={
          mcpForm?.mode === "edit"
            ? tr(`编辑 MCP 服务器 · ${mcpForm.previousName ?? ""}`, `Edit MCP server · ${mcpForm.previousName ?? ""}`)
            : tr("添加 MCP 服务器", "Add MCP server")
        }
        testId="pi-mcp-dialog"
        footer={
          <>
            <Button onClick={() => setMcpForm(null)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              loading={savingMcp}
              disabled={!canSaveMcp}
              onClick={() => void submitMcpForm()}
              testId="pi-mcp-save"
            >
              {tr("保存", "Save")}
            </Button>
          </>
        }
      >
        {mcpForm && (
          <div className="pis-dialog-form">
            <div className="pis-form-row-2">
              <FormField label={tr("配置范围", "Scope")}>
                <Segmented
                  size="sm"
                  value={mcpForm.scope}
                  options={modalScopeOptions}
                  disabled={mcpForm.mode === "edit" || projectId === null}
                  onChange={(next) => setMcpForm({ ...mcpForm, scope: next })}
                  testId="pi-mcp-form-scope"
                />
              </FormField>
              <FormField label={tr("传输类型", "Transport")}>
                <Segmented
                  size="sm"
                  mono
                  value={mcpForm.transport}
                  options={transportOptions}
                  onChange={(next) => setMcpForm({ ...mcpForm, transport: next })}
                  testId="pi-mcp-form-transport"
                />
              </FormField>
            </div>

            <FormField label={tr("服务器名称", "Server name")} htmlFor="pi-mcp-name">
              <TextField
                id="pi-mcp-name"
                mono
                width="100%"
                data-autofocus=""
                value={mcpForm.name}
                onChange={(next) => setMcpForm({ ...mcpForm, name: next })}
                placeholder="filesystem"
                testId="pi-mcp-form-name"
              />
            </FormField>

            <FormField
              label={tr("工具暴露策略 (exposure)", "Tool exposure mode")}
              help={tr(
                "codemode：注入 JS 沙箱 · deferred：按需通过 tool_search 检索 · direct：直接挂入上下文 · hidden：隐藏",
                "codemode: JS sandbox · deferred: on-demand via tool_search · direct: always in context · hidden: disabled",
              )}
            >
              <Segmented
                size="sm"
                mono
                value={mcpForm.exposure}
                options={exposureOptions}
                onChange={(next) => setMcpForm({ ...mcpForm, exposure: next })}
                testId="pi-mcp-form-exposure"
              />
            </FormField>

            {mcpForm.transport === "stdio" ? (
              <>
                <div className="pis-form-row-2">
                  <FormField label={tr("启动命令 (command)", "Command")} htmlFor="pi-mcp-cmd">
                    <TextField
                      id="pi-mcp-cmd"
                      mono
                      width="100%"
                      value={mcpForm.command}
                      onChange={(next) => setMcpForm({ ...mcpForm, command: next })}
                      placeholder="npx"
                      testId="pi-mcp-form-command"
                    />
                  </FormField>
                  <FormField label={tr("工作目录 (cwd，可选)", "Working directory (optional)")} htmlFor="pi-mcp-cwd">
                    <TextField
                      id="pi-mcp-cwd"
                      mono
                      width="100%"
                      value={mcpForm.cwd}
                      onChange={(next) => setMcpForm({ ...mcpForm, cwd: next })}
                      placeholder="/path/to/dir"
                      testId="pi-mcp-form-cwd"
                    />
                  </FormField>
                </div>

                <FormField
                  label={tr("命令参数 (args，每行一个或空格分隔)", "Arguments (one per line or space-separated)")}
                  htmlFor="pi-mcp-args"
                >
                  <Textarea
                    id="pi-mcp-args"
                    mono
                    rows={2}
                    value={mcpForm.argsText}
                    onChange={(next) => setMcpForm({ ...mcpForm, argsText: next })}
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                    testId="pi-mcp-form-args"
                  />
                </FormField>

                <FormField
                  label={tr("环境变量 (KEY=VALUE，每行一条)", "Environment variables (KEY=VALUE per line)")}
                  htmlFor="pi-mcp-env"
                  help={
                    mcpForm.existingEnvKeys.length > 0
                      ? tr(
                          `已配置键：${mcpForm.existingEnvKeys.join(", ")}（留空则保留原值）`,
                          `Configured keys: ${mcpForm.existingEnvKeys.join(", ")} (leave empty to keep)`,
                        )
                      : undefined
                  }
                >
                  <Textarea
                    id="pi-mcp-env"
                    mono
                    rows={2}
                    value={mcpForm.envText}
                    onChange={(next) => setMcpForm({ ...mcpForm, envText: next })}
                    placeholder="API_TOKEN=..."
                    testId="pi-mcp-form-env"
                  />
                </FormField>
                {mcpForm.existingEnvKeys.length > 0 && (
                  <Checkbox
                    checked={mcpForm.clearEnv}
                    onChange={(next) => setMcpForm({ ...mcpForm, clearEnv: next })}
                    testId="pi-mcp-form-clear-env"
                  >
                    {tr("清空已有环境变量", "Clear existing environment variables")}
                  </Checkbox>
                )}
              </>
            ) : (
              <>
                <FormField label="HTTP URL" htmlFor="pi-mcp-url">
                  <TextField
                    id="pi-mcp-url"
                    mono
                    width="100%"
                    value={mcpForm.url}
                    onChange={(next) => setMcpForm({ ...mcpForm, url: next })}
                    placeholder="https://example.com/mcp"
                    testId="pi-mcp-form-url"
                  />
                </FormField>

                <FormField
                  label={tr("请求头 (Header: Value，每行一条)", "HTTP headers (Header: Value per line)")}
                  htmlFor="pi-mcp-headers"
                  help={
                    mcpForm.existingHeaderKeys.length > 0
                      ? tr(
                          `已配置请求头：${mcpForm.existingHeaderKeys.join(", ")}（留空则保留原值）`,
                          `Configured headers: ${mcpForm.existingHeaderKeys.join(", ")} (leave empty to keep)`,
                        )
                      : undefined
                  }
                >
                  <Textarea
                    id="pi-mcp-headers"
                    mono
                    rows={2}
                    value={mcpForm.headersText}
                    onChange={(next) => setMcpForm({ ...mcpForm, headersText: next })}
                    placeholder="Authorization: Bearer ..."
                    testId="pi-mcp-form-headers"
                  />
                </FormField>
                {mcpForm.existingHeaderKeys.length > 0 && (
                  <Checkbox
                    checked={mcpForm.clearHeaders}
                    onChange={(next) => setMcpForm({ ...mcpForm, clearHeaders: next })}
                    testId="pi-mcp-form-clear-headers"
                  >
                    {tr("清空已有请求头", "Clear existing headers")}
                  </Checkbox>
                )}
              </>
            )}

            <div className="pis-form-row-2">
              <FormField label={tr("超时（秒，可选）", "Timeout (seconds, optional)")} htmlFor="pi-mcp-timeout">
                <NumberField
                  id="pi-mcp-timeout"
                  width="100%"
                  unit="s"
                  value={mcpForm.timeoutText}
                  onChange={(next) => setMcpForm({ ...mcpForm, timeoutText: next })}
                  placeholder="30"
                  testId="pi-mcp-form-timeout"
                />
              </FormField>
              <FormField label={tr("备注说明（可选）", "Description (optional)")} htmlFor="pi-mcp-desc">
                <TextField
                  id="pi-mcp-desc"
                  width="100%"
                  value={mcpForm.description}
                  onChange={(next) => setMcpForm({ ...mcpForm, description: next })}
                  placeholder={tr("文件系统只读服务", "Read-only filesystem server")}
                  testId="pi-mcp-form-desc"
                />
              </FormField>
            </div>
          </div>
        )}
      </Dialog>

      {/* 删除 MCP 服务器确认弹窗 */}
      {deletingMcp !== null && (
        <ConfirmDialog
          danger
          title={tr(`删除 MCP 服务器 "${deletingMcp.name}"？`, `Delete MCP server "${deletingMcp.name}"?`)}
          body={tr("该条目将从对应的 mcp.json 配置文件中移除。", "This server will be removed from mcp.json.")}
          confirmLabel={tr("删除", "Delete")}
          onConfirm={() => void confirmDeleteMcp(deletingMcp)}
          onCancel={() => setDeletingMcp(null)}
          testId="pi-mcp-delete-confirm"
        />
      )}
    </div>
  );
}
