// Pi 插件市场精选目录与 npm 搜索解析器（纯函数与静态元数据，供主进程与渲染进程共用）。

export type PiPluginCategory = "精选推荐" | "搜索与记忆" | "上下文与压缩" | "工作流与规划" | "代码与安全" | "UI 与用量";

export const PI_PLUGIN_CATEGORIES: readonly PiPluginCategory[] = [
  "精选推荐",
  "搜索与记忆",
  "上下文与压缩",
  "工作流与规划",
  "代码与安全",
  "UI 与用量",
] as const;

export interface PiMarketplacePlugin {
  name: string;
  installSpec: string;
  version: string;
  author: string;
  description: string;
  zhDescription: string;
  category: PiPluginCategory;
  featured: boolean;
  stars?: number;
  downloads: number;
  repoUrl?: string;
  npmUrl: string;
  tags?: readonly string[];
}

export const CURATED_PI_PLUGINS: readonly PiMarketplacePlugin[] = [
  {
    name: "pi-mcp-adapter",
    installSpec: "npm:pi-mcp-adapter",
    version: "1.4.2",
    author: "nicobailon",
    description: "MCP (Model Context Protocol) lazy-loading adapter extension for Pi coding agent",
    zhDescription: "轻量级 MCP 懒加载桥接器：仅注入单个 ~200 token 代理入口，按需唤醒 MCP 服务并支持 OAuth 钥匙串。",
    category: "精选推荐",
    featured: true,
    stars: 1614,
    downloads: 1565803,
    repoUrl: "https://github.com/nicobailon/pi-mcp-adapter",
    npmUrl: "https://www.npmjs.com/package/pi-mcp-adapter",
    tags: ["MCP", "省 Token", "必备"],
  },
  {
    name: "pi-web-access",
    installSpec: "npm:pi-web-access",
    version: "1.6.0",
    author: "nicobailon",
    description: "Web search, URL fetching, GitHub repo cloning, PDF extraction, and video analysis for Pi",
    zhDescription:
      "全能联网检索与多模态阅读：支持 Exa/Brave/Tavily 多源回退搜索、网页提取、GitHub 仓库、PDF 与视频理解。",
    category: "搜索与记忆",
    featured: true,
    stars: 1684,
    downloads: 801838,
    repoUrl: "https://github.com/nicobailon/pi-web-access",
    npmUrl: "https://www.npmjs.com/package/pi-web-access",
    tags: ["联网搜索", "网页抓取", "视频/PDF"],
  },
  {
    name: "cc-safety-net",
    installSpec: "npm:cc-safety-net",
    version: "1.2.0",
    author: "kenryu42",
    description: "Zero-token hook guardrail blocking destructive Bash/PowerShell commands and credential leaks",
    zhDescription:
      "零 Token 开销安全护栏：执行前自动拦截 git reset --hard、危险删除及私钥/.env 读取，原生适配 PowerShell 与 Bash。",
    category: "代码与安全",
    featured: true,
    stars: 1280,
    downloads: 142000,
    repoUrl: "https://github.com/kenryu42/claude-code-safety-net",
    npmUrl: "https://www.npmjs.com/package/cc-safety-net",
    tags: ["安全护栏", "零 Token", "PowerShell"],
  },
  {
    name: "@plannotator/pi-extension",
    installSpec: "npm:@plannotator/pi-extension",
    version: "0.9.4",
    author: "backnotprop",
    description: "Interactive plan review with line-by-line annotations, message review, and code diff critique",
    zhDescription: "可视化架构规划与交互式批注审阅：大改动前逐行批注 Agent 计划、审阅代码 Diff 并一键批准或驳回。",
    category: "工作流与规划",
    featured: true,
    stars: 9606,
    downloads: 107084,
    repoUrl: "https://github.com/backnotprop/plannotator",
    npmUrl: "https://www.npmjs.com/package/@plannotator/pi-extension",
    tags: ["计划审阅", "Diff 批注", "高 Star"],
  },
  {
    name: "@ramarivera/pi-supermemory",
    installSpec: "npm:@ramarivera/pi-supermemory",
    version: "0.4.2",
    author: "ramarivera",
    description: "Persistent cross-session long-term memory powered by Supermemory v4 API",
    zhDescription: "Supermemory 跨会话长期记忆：自动检索并沉淀个人背景、项目决策与偏好，支持与 DSH 共用同一记忆分组。",
    category: "搜索与记忆",
    featured: true,
    stars: 420,
    downloads: 48500,
    repoUrl: "https://github.com/ramarivera/pi-supermemory",
    npmUrl: "https://www.npmjs.com/package/@ramarivera/pi-supermemory",
    tags: ["长期记忆", "Supermemory", "DSH 同源"],
  },
  {
    name: "@juicesharp/rpiv-ask-user-question",
    installSpec: "npm:@juicesharp/rpiv-ask-user-question",
    version: "1.1.3",
    author: "juicesharp",
    description: "Structured multiple-choice questionnaire tool when requirements are ambiguous",
    zhDescription: "结构化澄清提问卡片：需求模糊时让模型弹出单选/多选卡片向你确认方案，告别盲目猜测。",
    category: "工作流与规划",
    featured: true,
    stars: 919,
    downloads: 231411,
    repoUrl: "https://github.com/juicesharp/rpiv-mono",
    npmUrl: "https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question",
    tags: ["交互提问", "RPIV"],
  },
  {
    name: "pi-subagents",
    installSpec: "npm:pi-subagents",
    version: "1.8.1",
    author: "nicobailon",
    description: "Multi-agent delegation, scout/researcher/reviewer roles, and parallel review workflows",
    zhDescription: "多角色 Subagent 编排套件：内置 scout、researcher、reviewer 等角色与 /council 多模型会审工作流。",
    category: "工作流与规划",
    featured: true,
    stars: 4006,
    downloads: 558314,
    repoUrl: "https://github.com/nicobailon/pi-subagents",
    npmUrl: "https://www.npmjs.com/package/pi-subagents",
    tags: ["多智能体", "并行会审"],
  },
  {
    name: "pi-smart-compact",
    installSpec: "npm:pi-smart-compact",
    version: "0.5.1",
    author: "community",
    description: "Intelligent tiered context compaction preserving key code decisions and file paths",
    zhDescription: "智能分层上下文压缩：压缩长对话时精准保留关键文件路径、算例与架构决策，显著降低摘要失真。",
    category: "上下文与压缩",
    featured: true,
    stars: 310,
    downloads: 36200,
    npmUrl: "https://www.npmjs.com/package/pi-smart-compact",
    tags: ["智能压缩", "省 Token"],
  },
  {
    name: "pi-fold",
    installSpec: "npm:pi-fold",
    version: "0.3.4",
    author: "community",
    description: "Automatic folding of verbose tool outputs and stale file reads to save context tokens",
    zhDescription: "陈旧工具输出自动折叠：自动折叠历史轮次中冗长的命令行输出与重复文件读取，释放宝贵 Context 窗口。",
    category: "上下文与压缩",
    featured: true,
    stars: 265,
    downloads: 29400,
    npmUrl: "https://www.npmjs.com/package/pi-fold",
    tags: ["输出折叠", "Context 瘦身"],
  },
  {
    name: "pi-hashline-edit-pro",
    installSpec: "npm:pi-hashline-edit-pro",
    version: "1.0.4",
    author: "community",
    description: "Line-hash verified high-precision file editing tool for large codebases",
    zhDescription: "行哈希高精度编辑工具：通过行号与短哈希双重校验定锚，大幅降低大文件改写错位与匹配失败率。",
    category: "代码与安全",
    featured: true,
    stars: 380,
    downloads: 41800,
    npmUrl: "https://www.npmjs.com/package/pi-hashline-edit-pro",
    tags: ["精准编辑", "防错位"],
  },
  {
    name: "@dietrichgebert/ponytail",
    installSpec: "npm:@dietrichgebert/ponytail",
    version: "1.3.0",
    author: "dietrichgebert",
    description: "Minimalist senior engineer discipline skill: reuse existing code, avoid over-engineering",
    zhDescription: "极简资深工程师准则（/ponytail）：约束 Agent 优先复用现有代码与标准库，少造轮子、缩小改动面。",
    category: "代码与安全",
    featured: false,
    stars: 1450,
    downloads: 95893,
    repoUrl: "https://github.com/DietrichGebert/ponytail",
    npmUrl: "https://www.npmjs.com/package/@dietrichgebert/ponytail",
    tags: ["极简编码", "防过度设计"],
  },
  {
    name: "@juicesharp/rpiv-todo",
    installSpec: "npm:@juicesharp/rpiv-todo",
    version: "1.1.2",
    author: "juicesharp",
    description: "Persistent session todo checklist with dependency tracking",
    zhDescription: "会话级持久任务清单：支持步骤依赖追踪，跨 /reload 与自动压缩依然保留当前任务进度。",
    category: "工作流与规划",
    featured: false,
    stars: 919,
    downloads: 151513,
    repoUrl: "https://github.com/juicesharp/rpiv-mono",
    npmUrl: "https://www.npmjs.com/package/@juicesharp/rpiv-todo",
    tags: ["任务清单", "进度追踪"],
  },
  {
    name: "pi-lens",
    installSpec: "npm:pi-lens",
    version: "0.8.2",
    author: "community",
    description: "Code symbol lens, LSP diagnostics, and automatic post-edit verification",
    zhDescription: "代码符号透镜与诊断：快速透视符号定义、引用关系，并在修改文件后自动触发类型与安全检查。",
    category: "代码与安全",
    featured: false,
    stars: 512,
    downloads: 54000,
    npmUrl: "https://www.npmjs.com/package/pi-lens",
    tags: ["LSP", "代码诊断"],
  },
  {
    name: "@narumitw/pi-usage",
    installSpec: "npm:@narumitw/pi-usage",
    version: "0.6.0",
    author: "narumitw",
    description: "Real-time token consumption, cache hit rate, and cost analytics across providers",
    zhDescription: "多服务商用量与缓存看板：实时统计各模型的 Token 消耗、Prompt 缓存命中率与费用明细。",
    category: "UI 与用量",
    featured: false,
    stars: 290,
    downloads: 38900,
    npmUrl: "https://www.npmjs.com/package/@narumitw/pi-usage",
    tags: ["用量统计", "缓存分析"],
  },
  {
    name: "pi-context-view",
    installSpec: "npm:pi-context-view",
    version: "0.4.1",
    author: "community",
    description: "Visual inspector for system prompt, skills, tool definitions, and message token distribution",
    zhDescription: "Context 构成可视化检视器：清晰拆解系统提示词、Skills、工具定义与对话消息的 Token 占比。",
    category: "UI 与用量",
    featured: false,
    stars: 240,
    downloads: 27500,
    npmUrl: "https://www.npmjs.com/package/pi-context-view",
    tags: ["Context 构成", "可视化"],
  },
];

const CURATED_BY_NAME = new Map<string, PiMarketplacePlugin>(CURATED_PI_PLUGINS.map((p) => [p.name, p]));
const NOISY_INTERNAL_PACKAGE_RE = /^@agimon-ai\/po-/i;

export function findCuratedPiPlugin(nameOrSource: string): PiMarketplacePlugin | undefined {
  const clean = cleanPiPackageName(nameOrSource);
  return CURATED_BY_NAME.get(clean);
}

export function cleanPiPackageName(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("npm:")) {
    const rest = trimmed.slice(4);
    if (rest.startsWith("@")) {
      const slash = rest.indexOf("/");
      if (slash > 0) {
        const atVer = rest.indexOf("@", slash + 1);
        return atVer > 0 ? rest.slice(0, atVer) : rest;
      }
      return rest;
    }
    const atVer = rest.indexOf("@");
    return atVer > 0 ? rest.slice(0, atVer) : rest;
  }
  const withoutGit = trimmed
    .replace(/^git\+/, "")
    .replace(/^git:/, "")
    .replace(/\.git$/, "")
    .replace(/#.*$/, "")
    .replace(/[\\/]+$/, "");
  const parts = withoutGit.split(/[\\/:]/).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

export function piPluginInitial(name: string): string {
  const bare = cleanPiPackageName(name)
    .replace(/^@[^/]+\//, "")
    .replace(/^pi[-_]/i, "");
  return (Array.from(bare)[0] ?? "P").toUpperCase();
}

export function piPluginHue(name: string): number {
  let hash = 0;
  const clean = cleanPiPackageName(name);
  for (const ch of clean) {
    hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  }
  return hash % 360;
}

export function formatPluginNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 将 npm registry 搜索结果与本地精选目录合并去重。 */
export function mergeNpmSearchWithCurated(npmJson: unknown, query: string): PiMarketplacePlugin[] {
  const needle = query.trim().toLowerCase();
  const matchedCurated = CURATED_PI_PLUGINS.filter(
    (p) =>
      needle === "" ||
      p.name.toLowerCase().includes(needle) ||
      p.description.toLowerCase().includes(needle) ||
      p.zhDescription.toLowerCase().includes(needle) ||
      p.author.toLowerCase().includes(needle) ||
      (p.tags ?? []).some((t) => t.toLowerCase().includes(needle)),
  );

  const byName = new Map<string, PiMarketplacePlugin>();
  for (const item of matchedCurated) {
    byName.set(item.name, item);
  }

  const objects = (npmJson as { objects?: unknown } | null)?.objects;
  if (Array.isArray(objects)) {
    for (const obj of objects) {
      const pkg = (obj as { package?: Record<string, unknown> })?.package;
      const name = asStr(pkg?.["name"]);
      if (!pkg || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) continue;
      if (NOISY_INTERNAL_PACKAGE_RE.test(name)) continue;

      const existing = byName.get(name);
      const links = (pkg["links"] ?? {}) as Record<string, unknown>;
      const weekly = (obj as { downloads?: { weekly?: unknown } })?.downloads?.weekly;
      const downloads = typeof weekly === "number" && Number.isFinite(weekly) ? weekly : 0;
      const version = asStr(pkg["version"]) || existing?.version || "latest";
      const repo = asStr(links["repository"])
        .replace(/^git\+/, "")
        .replace(/\.git$/, "");
      const publisher = asStr((pkg["publisher"] as { username?: unknown } | undefined)?.username);
      const maintainers = Array.isArray(pkg["maintainers"]) ? pkg["maintainers"] : [];
      const firstMaintainer = asStr((maintainers[0] as { username?: unknown } | undefined)?.username);
      const author = !publisher || /^github[ -]actions$/i.test(publisher) ? firstMaintainer || publisher : publisher;

      if (existing) {
        byName.set(name, {
          ...existing,
          version,
          downloads: Math.max(existing.downloads, downloads),
          ...(repo.startsWith("https://") && !existing.repoUrl ? { repoUrl: repo } : {}),
        });
      } else {
        const desc = asStr(pkg["description"]).trim();
        byName.set(name, {
          name,
          installSpec: `npm:${name}`,
          version,
          author: author || "community",
          description: desc,
          zhDescription: desc || "Pi 社区扩展包",
          category: "精选推荐",
          featured: false,
          downloads,
          ...(repo.startsWith("https://") ? { repoUrl: repo } : {}),
          npmUrl: asStr(links["npm"]).startsWith("https://")
            ? asStr(links["npm"])
            : `https://www.npmjs.com/package/${name}`,
        });
      }
    }
  }

  return [...byName.values()].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return b.downloads - a.downloads;
  });
}
