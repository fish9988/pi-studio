import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addPiCustomExtension,
  addPiSkillFolder,
  buildPiPackageCommandArgs,
  deletePiCustomProvider,
  deletePiMcpServer,
  listPiAccounts,
  listPiBuiltinExtensions,
  listPiCustomExtensions,
  listPiLoginProviders,
  listPiMcpServers,
  listPiPackages,
  listPiPromptTemplates,
  listPiProviderStatuses,
  listPiSkills,
  PiSkillPicker,
  readModelDefaultsFromPiSettings,
  readPiApiKeyEnvSources,
  readPiConfigSnapshot,
  readPiKeybindings,
  readPiModelsFile,
  readPiProviderKey,
  readPiResourcesSnapshot,
  readPiSystemDoc,
  removePiCredential,
  removePiCustomExtension,
  removePiSkillFolder,
  resetPiSetting,
  runPiPackageCommand,
  savePiApiKey,
  savePiCustomProvider,
  savePiMcpServer,
  savePiProviderOverride,
  savePiSystemDoc,
  setPiBuiltinExtensionEnabled,
  setPiMcpServerEnabled,
  setPiSetting,
  setPiSkillEnabled,
  writeModelDefaultsToPiSettings,
} from "../src/main/pi-config/index.ts";
import {
  findPiBuiltinProvider,
  findPiSettingSchema,
  PI_BUILTIN_PROVIDERS,
  PI_SETTINGS_SCHEMA,
  PI_SETTINGS_TABS,
  resolveActiveToolSet,
} from "../src/shared/pi-settings-schema.ts";

describe("pi-settings-schema", () => {
  it("defines all 8 tabs, bilingual labels/descriptions, and all 23 built-in providers", () => {
    expect(PI_SETTINGS_TABS).toEqual([
      "models",
      "interaction",
      "tools",
      "compaction",
      "resources",
      "network",
      "shell",
      "appearance",
    ]);

    const seenKeys = new Set<string>();
    for (const entry of PI_SETTINGS_SCHEMA) {
      expect(seenKeys.has(entry.key)).toBe(false);
      seenKeys.add(entry.key);
      expect(PI_SETTINGS_TABS).toContain(entry.tab);
      expect(entry.labelZh.trim().length).toBeGreaterThan(0);
      expect(entry.labelEn.trim().length).toBeGreaterThan(0);
      expect(entry.descZh.trim().length).toBeGreaterThan(0);
      expect(entry.descEn.trim().length).toBeGreaterThan(0);
    }

    const requiredKeys = [
      "defaultProvider",
      "defaultModel",
      "defaultThinkingLevel",
      "modelThinkingLevels",
      "thinkingBudgets.minimal",
      "thinkingBudgets.low",
      "thinkingBudgets.medium",
      "thinkingBudgets.high",
      "enabledModels",
      "hideThinkingBlock",
      "cacheWarming",
      "showCacheMissNotices",
      "steeringMode",
      "followUpMode",
      "externalEditor",
      "doubleEscapeAction",
      "treeFilterMode",
      "defaultProjectTrust",
      "defaultTools",
      "codemode.mode",
      "codemode.inlineBudget",
      "images.autoResize",
      "images.blockImages",
      "compaction.enabled",
      "compaction.reserveTokens",
      "compaction.keepRecentTokens",
      "branchSummary.reserveTokens",
      "branchSummary.skipPrompt",
      "sessionShareDestination",
      "sessionDir",
      "packages",
      "extensions",
      "skills",
      "prompts",
      "themes",
      "enableSkillCommands",
      "transport",
      "httpProxy",
      "httpIdleTimeoutMs",
      "websocketConnectTimeoutMs",
      "retry.enabled",
      "retry.maxRetries",
      "retry.baseDelayMs",
      "retry.maxAgentDelayMs",
      "retry.provider.timeoutMs",
      "shellPath",
      "shellCommandPrefix",
      "quietStartup",
      "collapseChangelog",
      "terminal.showImages",
      "terminal.clearOnShrink",
    ];
    for (const key of requiredKeys) {
      expect(findPiSettingSchema(key), `missing schema key: ${key}`).toBeDefined();
    }

    const expectedProviders = [
      "anthropic",
      "openai",
      "openai-codex",
      "google",
      "google-gemini-cli",
      "google-antigravity",
      "google-vertex",
      "deepseek",
      "openrouter",
      "xai",
      "groq",
      "mistral",
      "cerebras",
      "github-copilot",
      "amazon-bedrock",
      "azure-openai-responses",
      "dashscope",
      "moonshot",
      "zhipu",
      "minimax",
      "ollama",
      "lmstudio",
      "vllm",
    ];
    expect(PI_BUILTIN_PROVIDERS.map((p) => p.id)).toEqual(expectedProviders);
    expect(findPiBuiltinProvider("anthropic")?.supportsOAuth).toBe(true);
    expect(findPiBuiltinProvider("openai-codex")?.acceptsApiKey).toBe(false);
  });

  it("matches the Pi 1.5.2 kernel SETTINGS_DEFAULTS for the keys it declares a default for", () => {
    const expectDefault = (key: string, value: unknown) => {
      const entry = findPiSettingSchema(key);
      expect(entry?.hasDefault, `${key} should declare a default`).toBe(true);
      expect(entry?.defaultValue).toEqual(value);
    };
    expectDefault("cacheWarming", "idle");
    expectDefault("showCacheMissNotices", false);
    expectDefault("hideThinkingBlock", false);
    expectDefault("httpIdleTimeoutMs", 300000);
    expectDefault("websocketConnectTimeoutMs", 15000);

    // Pi 只把这两个透传给 SDK，自己没有固定默认（未填时跟随 httpIdleTimeoutMs / 由 SDK 决定）。
    for (const key of ["retry.provider.timeoutMs", "retry.provider.maxRetries"]) {
      const entry = findPiSettingSchema(key);
      expect(entry?.hasDefault, `${key} should not claim a default`).toBe(false);
      expect(entry?.defaultValue).toBeNull();
    }
  });
});

describe("resolveActiveToolSet", () => {
  it("falls back to Pi's built-in defaults only when defaultTools is unset", () => {
    expect([...resolveActiveToolSet([], false)]).toEqual(["read", "bash", "edit", "write"]);
  });

  it('treats an explicit empty defaultTools as "disabled all tools"', () => {
    // Pi 语义：显式 [] 是“禁用全部工具”，不是“未设置”。旧实现会在这里回退成 4 个默认工具。
    const active = resolveActiveToolSet([], true);
    expect(active.size).toBe(0);
    // 全部禁用后只打开一个工具，写入的应该就是这一个（不会把默认的 4 个偷偷写活）。
    active.add("grep");
    expect([...active]).toEqual(["grep"]);
  });

  it("applies +name / -name modifiers on top of the defaults", () => {
    expect([...resolveActiveToolSet(["+grep"], true)]).toEqual(["read", "bash", "edit", "write", "grep"]);
    expect([...resolveActiveToolSet(["-bash"], true)]).toEqual(["read", "edit", "write"]);
    expect([...resolveActiveToolSet(["+grep", "-bash"], true)]).toEqual(["read", "edit", "write", "grep"]);
  });

  it("replaces the defaults with a plain-name list and ignores unknown ids", () => {
    expect([...resolveActiveToolSet(["ls", "grep"], true)]).toEqual(["ls", "grep"]);
    expect([...resolveActiveToolSet(["ls", "not-a-tool"], true)]).toEqual(["ls"]);
    expect([...resolveActiveToolSet(["+not-a-tool"], true)]).toEqual(["read", "bash", "edit", "write"]);
  });
});

describe("pi-config backend", () => {
  let rootDir = "";
  let agentDir = "";
  let projectDir = "";
  let homeDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "pi-config-test-"));
    agentDir = path.join(rootDir, "agent");
    projectDir = path.join(rootDir, "project");
    homeDir = path.join(rootDir, "home");
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(projectDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    if (rootDir !== "") {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reads/writes/resets nested dot-keys, cleans empty parent objects, and detects project overrides", async () => {
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        $schema: "https://pi.dev/schemas/settings.schema.json",
        customPluginFlag: { keepMe: true },
        compaction: { keepRecentTokens: 32000 },
      }),
      "utf8",
    );

    const w1 = await setPiSetting(agentDir, "compaction.reserveTokens", "24576");
    expect(w1).toEqual({
      key: "compaction.reserveTokens",
      value: 24576,
      hasValue: true,
      redacted: false,
    });

    await setPiSetting(agentDir, "retry.provider.timeoutMs", "90000");

    const raw1 = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(raw1["$schema"]).toBe("https://pi.dev/schemas/settings.schema.json");
    expect(raw1["customPluginFlag"]).toEqual({ keepMe: true });
    expect(raw1["compaction"]).toEqual({ keepRecentTokens: 32000, reserveTokens: 24576 });
    expect(raw1["retry"]).toEqual({ provider: { timeoutMs: 90000 } });

    // Project override on compaction.reserveTokens
    await setPiSetting(agentDir, "compaction.reserveTokens", "8192", "project", projectDir);

    const wGlobalOverridden = await setPiSetting(agentDir, "compaction.reserveTokens", "12000", "global", projectDir);
    expect(wGlobalOverridden.overriddenBy).toBe("project");
    expect(wGlobalOverridden.value).toBe(8192);

    const snap = await readPiConfigSnapshot(agentDir, "1.5.2", projectDir);
    expect(snap.ompVersion).toBe("1.5.2");
    expect(snap.projectOverrides).toContain("compaction.reserveTokens");
    const reserveItem = snap.items.find((i) => i.key === "compaction.reserveTokens");
    expect(reserveItem?.value).toBe(8192);
    expect(reserveItem?.hasValue).toBe(true);

    // Reject global-only key in project scope and invalid enum
    await expect(setPiSetting(agentDir, "cacheWarming", '"idle"', "project", projectDir)).rejects.toThrow(/global/i);
    await expect(setPiSetting(agentDir, "codemode.mode", '"invalid"')).rejects.toThrow();

    // Reset nested key retry.provider.timeoutMs -> cleans both provider: {} and retry: {}
    const resetRetry = await resetPiSetting(agentDir, "retry.provider.timeoutMs");
    expect(resetRetry.hasValue).toBe(false);
    // Pi 内核没有给 retry.provider.timeoutMs 固定默认值（未填时跟随 httpIdleTimeoutMs）。
    expect(resetRetry.value).toBeNull();
    const raw2 = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect("retry" in raw2).toBe(false);

    // Reset project override falls back to global value 12000
    const resetProj = await resetPiSetting(agentDir, "compaction.reserveTokens", "project", projectDir);
    expect(resetProj.hasValue).toBe(true);
    expect(resetProj.value).toBe(12000);

    // Model defaults helper
    await writeModelDefaultsToPiSettings(agentDir, { provider: "anthropic", modelId: "claude-sonnet-4-6" }, "high");
    expect(await readModelDefaultsFromPiSettings(agentDir, projectDir)).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      thinkingLevel: "high",
    });
  });

  it("manages auth.json credentials and env var sources without leaking any secrets", async () => {
    const secretApiKey = "sk-ant-super-secret-value-12345";
    const secretAccess = "oauth-access-token-xyz-98765";
    const secretRefresh = "oauth-refresh-token-abc-54321";

    await writeFile(path.join(agentDir, ".env"), "DEEPSEEK_API_KEY=ds-env-secret-999\n", "utf8");
    await writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: secretAccess,
          refresh: secretRefresh,
          expires: Date.now() + 3_600_000,
          email: "dev@example.com",
        },
      }),
      "utf8",
    );

    await savePiApiKey(agentDir, "anthropic", secretApiKey);

    if (process.platform !== "win32") {
      const st = await stat(path.join(agentDir, "auth.json"));
      expect(st.mode & 0o777).toBe(0o600);
    }

    const statuses = await listPiProviderStatuses(agentDir, [
      { provider: "anthropic" },
      { provider: "anthropic" },
      { provider: "deepseek" },
    ]);
    const serializedStatuses = JSON.stringify(statuses);
    expect(serializedStatuses).not.toContain(secretApiKey);
    expect(serializedStatuses).not.toContain(secretAccess);
    expect(serializedStatuses).not.toContain(secretRefresh);
    expect(serializedStatuses).not.toContain("ds-env-secret-999");

    const anthropic = statuses.find((s) => s.id === "anthropic");
    expect(anthropic?.authType).toBe("api_key");
    expect(anthropic?.modelCount).toBe(2);

    const codex = statuses.find((s) => s.id === "openai-codex");
    expect(codex?.authType).toBe("oauth");
    expect(codex?.accountHint).toBe("dev@example.com");

    const deepseek = statuses.find((s) => s.id === "deepseek");
    expect(deepseek?.activeEnvVar).toBe("DEEPSEEK_API_KEY");

    const loginProviders = await listPiLoginProviders(agentDir);
    expect(loginProviders.find((p) => p.id === "openai-codex")?.authenticated).toBe(true);
    expect(loginProviders.find((p) => p.id === "google-gemini-cli")?.authenticated).toBe(false);

    const accounts = await listPiAccounts(agentDir);
    expect(JSON.stringify(accounts)).not.toContain(secretApiKey);
    expect(JSON.stringify(accounts)).not.toContain(secretAccess);
    expect(accounts.map((a) => a.provider).sort()).toEqual(["anthropic", "openai-codex"]);
    expect((await listPiAccounts(agentDir, "openai-codex"))[0]?.label).toBe("dev@example.com");

    const envSources = await readPiApiKeyEnvSources(agentDir);
    expect(envSources["deepseek"]).toEqual({ name: "DEEPSEEK_API_KEY", source: "env-file" });

    expect(await removePiCredential(agentDir, "anthropic")).toBe(true);
    expect(await removePiCredential(agentDir, "anthropic")).toBe(false);
    expect((await listPiAccounts(agentDir, "anthropic")).length).toBe(0);
  });

  it("performs models.json CRUD, preserves unknown fields, and syncs .env keys", async () => {
    expect(await readPiModelsFile(agentDir)).toEqual({
      path: path.join(agentDir, "models.json"),
      exists: false,
      providers: [],
    });

    const addRes = await savePiCustomProvider(
      agentDir,
      {
        id: "my-gateway",
        baseUrl: "https://api.example.com/v1/",
        api: "openai-completions",
        key: { kind: "env", name: "MY_GATEWAY_TOKEN", value: "gw-secret-777" },
        models: [
          {
            id: "qwen-coder",
            name: "Qwen Coder",
            reasoning: true,
            images: true,
            contextWindow: 131072,
            maxTokens: 16384,
          },
        ],
      },
      "add",
    );
    expect(addRes.ok).toBe(true);

    // Duplicate add fails with 'exists'
    const dupRes = await savePiCustomProvider(
      agentDir,
      {
        id: "my-gateway",
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        key: { kind: "none" },
        models: [{ id: "m1", reasoning: null, images: null, contextWindow: null, maxTokens: null }],
      },
      "add",
    );
    expect(dupRes).toEqual({ ok: false, code: "exists" });

    // Verify Pi $ENV_VAR format on disk & bare name returned by readPiProviderKey
    const onDisk = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(onDisk.providers["my-gateway"]?.["apiKey"]).toBe("$MY_GATEWAY_TOKEN");
    expect(await readPiProviderKey(agentDir, "my-gateway")).toBe("MY_GATEWAY_TOKEN");
    expect(await readFile(path.join(agentDir, ".env"), "utf8")).toContain("MY_GATEWAY_TOKEN=gw-secret-777");

    const info = await readPiModelsFile(agentDir);
    expect(info.exists).toBe(true);
    expect(info.providers).toHaveLength(1);
    expect(info.providers[0]).toMatchObject({
      id: "my-gateway",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      key: { kind: "env", name: "MY_GATEWAY_TOKEN", source: "env-file" },
      oauthShaping: false,
    });
    expect(JSON.stringify(info)).not.toContain("gw-secret-777");

    // Builtin override editing via savePiProviderOverride
    await writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(
        {
          $schema: "https://pi.dev/schemas/models.schema.json",
          providers: {
            ...onDisk.providers,
            anthropic: {
              headers: { "X-Custom": "1" },
              modelOverrides: {
                "claude-sonnet-4-6": { name: "Custom Label", maxTokens: 8192 },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const ovRes = await savePiProviderOverride(agentDir, "anthropic", {
      key: { kind: "keep" },
      models: [
        {
          id: "claude-sonnet-4-6",
          reasoning: true,
          images: null,
          contextWindow: 200000,
          maxTokens: 32768,
        },
      ],
    });
    expect(ovRes.ok).toBe(true);

    const afterOv = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as {
      $schema: string;
      providers: Record<string, Record<string, unknown>>;
    };
    expect(afterOv.$schema).toBe("https://pi.dev/schemas/models.schema.json");
    expect(afterOv.providers["anthropic"]?.["headers"]).toEqual({ "X-Custom": "1" });
    const anthropicOverrides = afterOv.providers["anthropic"]?.["modelOverrides"] as
      Record<string, Record<string, unknown>> | undefined;
    expect(anthropicOverrides?.["claude-sonnet-4-6"]).toEqual({
      name: "Custom Label",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 32768,
    });

    // Deleting my-gateway cleans up unused MY_GATEWAY_TOKEN from .env
    const delRes = await deletePiCustomProvider(agentDir, "my-gateway");
    expect(delRes.ok).toBe(true);
    expect(await readFile(path.join(agentDir, ".env"), "utf8")).not.toContain("MY_GATEWAY_TOKEN");
  });

  it("manages MCP servers across scopes and preserves env/header secrets on edit and rename", async () => {
    const created = await savePiMcpServer(agentDir, projectDir, {
      scope: "global",
      projectId: null,
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret_999" },
      enabled: true,
      exposure: "codemode",
      description: "GitHub MCP",
    });
    expect(created.envKeys).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    expect(JSON.stringify(created)).not.toContain("ghp_secret_999");

    // Edit description and rename without passing env -> secret MUST be preserved!
    const renamed = await savePiMcpServer(agentDir, projectDir, {
      scope: "global",
      projectId: null,
      previousName: "github",
      name: "github-enterprise",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      enabled: true,
      exposure: "deferred",
      description: "Updated GitHub MCP",
    });
    expect(renamed.name).toBe("github-enterprise");
    expect(renamed.envKeys).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);

    const rawMcp = JSON.parse(await readFile(path.join(agentDir, "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { env?: Record<string, string>; enabled?: boolean }>;
    };
    expect(rawMcp.mcpServers["github"]).toBeUndefined();
    expect(rawMcp.mcpServers["github-enterprise"]?.env?.["GITHUB_PERSONAL_ACCESS_TOKEN"]).toBe("ghp_secret_999");

    // Toggle enabled -> disabled -> clearEnv
    const toggled = await setPiMcpServerEnabled(agentDir, projectDir, "global", "github-enterprise", false);
    expect(toggled.enabled).toBe(false);

    const cleared = await savePiMcpServer(agentDir, projectDir, {
      scope: "global",
      projectId: null,
      name: "github-enterprise",
      transport: "stdio",
      command: "npx",
      clearEnv: true,
      enabled: true,
      exposure: "direct",
    });
    expect(cleared.envKeys).toEqual([]);

    // Project HTTP MCP server with headers preservation
    await savePiMcpServer(agentDir, projectDir, {
      scope: "project",
      projectId: null,
      name: "sentry",
      transport: "http",
      url: "https://mcp.sentry.dev/mcp",
      headers: { Authorization: "Bearer sentry_secret_token" },
      enabled: true,
      exposure: "codemode",
    });
    await savePiMcpServer(agentDir, projectDir, {
      scope: "project",
      projectId: null,
      name: "sentry",
      transport: "http",
      url: "https://mcp.sentry.dev/mcp",
      enabled: true,
      exposure: "direct",
    });

    const allServers = await listPiMcpServers(agentDir, projectDir);
    expect(allServers.map((s) => `${s.scope}:${s.name}`)).toEqual(["global:github-enterprise", "project:sentry"]);
    expect(allServers[1]?.headerKeys).toEqual(["Authorization"]);
    expect(JSON.stringify(allServers)).not.toContain("sentry_secret_token");

    expect(await deletePiMcpServer(agentDir, projectDir, "project", "sentry")).toBe(true);
    expect(await listPiMcpServers(agentDir, projectDir)).toHaveLength(1);
  });

  it("toggles builtin:* extensions, manages custom extensions, skills, prompts, docs, keybindings, and packages", async () => {
    // 1. Builtin & custom extensions
    expect((await listPiBuiltinExtensions(agentDir)).every((e) => e.enabled)).toBe(true);

    const afterDisable = await setPiBuiltinExtensionEnabled(agentDir, "builtin:mcp", false);
    expect(afterDisable.find((e) => e.id === "builtin:mcp")?.enabled).toBe(false);
    const settingsAfterDisable = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")) as {
      extensions?: string[];
    };
    expect(settingsAfterDisable.extensions).toEqual(["-builtin:mcp"]);

    // Project re-enables builtin:mcp with +builtin:mcp
    const projOverride = await setPiBuiltinExtensionEnabled(agentDir, "builtin:mcp", true, "project", projectDir);
    expect(projOverride.find((e) => e.id === "builtin:mcp")?.enabled).toBe(true);

    await setPiBuiltinExtensionEnabled(agentDir, "builtin:mcp", true, "global");
    await addPiCustomExtension(agentDir, "./extensions/audit.ts");
    expect(await listPiCustomExtensions(agentDir)).toEqual(["./extensions/audit.ts"]);
    await removePiCustomExtension(agentDir, "./extensions/audit.ts");
    expect(await listPiCustomExtensions(agentDir)).toEqual([]);

    // 2. Skills (add, pick, list, toggle -path, remove)
    const srcSkillA = path.join(rootDir, "src-skill-a");
    await mkdir(srcSkillA, { recursive: true });
    await writeFile(
      path.join(srcSkillA, "SKILL.md"),
      "---\nname: code-review\ndescription: Thorough PR review workflow\n---\n# Code Review\n",
      "utf8",
    );

    const addedSkill = await addPiSkillFolder(srcSkillA, "omp", "user", {
      agentDir,
      projectDir,
      homeDir,
    });
    expect(addedSkill.name).toBe("code-review");

    const srcSkillB = path.join(rootDir, "src-skill-b");
    await mkdir(srcSkillB, { recursive: true });
    await writeFile(
      path.join(srcSkillB, "SKILL.md"),
      "---\nname: shared-helper\ndescription: Shared cross-agent skill\n---\nBody\n",
      "utf8",
    );
    const picker = new PiSkillPicker();
    const candidate = await picker.pick(srcSkillB);
    await picker.add(candidate.token, "shared", { agentDir, homeDir });

    let skills = await listPiSkills(agentDir, projectDir, homeDir);
    expect(skills.map((s) => `${s.name}:${s.provider}:${s.disabled}`)).toEqual([
      "code-review:pi:false",
      "shared-helper:agents:false",
    ]);

    await setPiSkillEnabled(agentDir, "code-review", false, { projectDir, homeDir });
    const rawSettingsSkills = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")) as {
      skills?: string[];
    };
    expect(rawSettingsSkills.skills).toEqual(["-skills/code-review"]);

    skills = await listPiSkills(agentDir, projectDir, homeDir);
    expect(skills.find((s) => s.name === "code-review")?.disabled).toBe(true);

    await setPiSkillEnabled(agentDir, "code-review", true, { projectDir, homeDir });
    skills = await listPiSkills(agentDir, projectDir, homeDir);
    expect(skills.find((s) => s.name === "code-review")?.disabled).toBe(false);

    await removePiSkillFolder("code-review", "user", { agentDir, projectDir, homeDir });
    skills = await listPiSkills(agentDir, projectDir, homeDir);
    expect(skills.map((s) => s.name)).toEqual(["shared-helper"]);

    // 3. Prompt templates
    await mkdir(path.join(agentDir, "prompts"), { recursive: true });
    await writeFile(
      path.join(agentDir, "prompts", "commit.md"),
      "---\ndescription: Write conventional git commit\n---\nSummarize staged diff: $@",
      "utf8",
    );
    await mkdir(path.join(projectDir, ".pi", "prompts"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".pi", "prompts", "deploy.md"),
      "\nRun production deployment checklist for $1\nSecond line",
      "utf8",
    );

    const prompts = await listPiPromptTemplates(agentDir, projectDir);
    expect(prompts).toEqual([
      {
        name: "commit",
        scope: "global",
        description: "Write conventional git commit",
        fileName: "commit.md",
      },
      {
        name: "deploy",
        scope: "project",
        description: "Run production deployment checklist for $1",
        fileName: "deploy.md",
      },
    ]);

    // 4. System prompt docs (AGENTS.md, SYSTEM.md, APPEND_SYSTEM.md)
    expect(await readPiSystemDoc(agentDir, projectDir, "project", "AGENTS.md")).toEqual({
      kind: "AGENTS.md",
      scope: "project",
      exists: false,
      content: "",
    });
    await savePiSystemDoc(agentDir, projectDir, "project", "AGENTS.md", "# Project Rules\n");
    await savePiSystemDoc(agentDir, projectDir, "project", "SYSTEM.md", "Custom system prompt");
    expect(await readFile(path.join(projectDir, "AGENTS.md"), "utf8")).toBe("# Project Rules\n");
    expect(await readFile(path.join(projectDir, ".pi", "SYSTEM.md"), "utf8")).toBe("Custom system prompt");

    // Clearing SYSTEM.md removes the file cleanly
    const clearedDoc = await savePiSystemDoc(agentDir, projectDir, "project", "SYSTEM.md", "   \n ");
    expect(clearedDoc.exists).toBe(false);
    await expect(stat(path.join(projectDir, ".pi", "SYSTEM.md"))).rejects.toThrow();

    // 5. Keybindings
    await writeFile(
      path.join(agentDir, "keybindings.json"),
      JSON.stringify({
        "app.thinking.toggle": [],
        "app.model.cycleForward": ["ctrl+shift+m"],
        "app.session.new": "alt+shift+n",
      }),
      "utf8",
    );
    const bindings = await readPiKeybindings(agentDir, "linux");
    expect(bindings.find((b) => b.action === "app.thinking.toggle")).toBeUndefined();
    expect(bindings.find((b) => b.action === "app.model.cycleForward")?.chords).toEqual(["ctrl+shift+m"]);
    expect(bindings.find((b) => b.action === "app.session.new")?.chords).toEqual(["alt+shift+n"]);

    // 6. Pi Packages list & CLI execution without shell
    await setPiSetting(
      agentDir,
      "packages",
      JSON.stringify(["npm:@example/pi-pack@1.0.0", { source: "git:github.com/example/repo@v2" }, "./local-pack"]),
    );
    expect(await listPiPackages(agentDir, projectDir)).toEqual([
      { source: "npm:@example/pi-pack@1.0.0", scope: "global", kind: "npm" },
      { source: "git:github.com/example/repo@v2", scope: "global", kind: "git" },
      { source: "./local-pack", scope: "global", kind: "local" },
    ]);

    expect(buildPiPackageCommandArgs("install", "npm:@a/b", "project")).toEqual([
      "install",
      "npm:@a/b",
      "-l",
      "--approve",
    ]);
    expect(buildPiPackageCommandArgs("update", null, "global")).toEqual(["update", "--extensions"]);
    expect(() => buildPiPackageCommandArgs("install", "--malicious-flag", "global")).toThrow();

    const mockCliScript = path.join(rootDir, "mock-pi-cli.mjs");
    await writeFile(
      mockCliScript,
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR }));\n",
      "utf8",
    );
    const cmdRes = await runPiPackageCommand(
      { command: process.execPath, args: [mockCliScript], agentDir },
      "install",
      "npm:@scope/demo",
      "project",
      projectDir,
    );
    const echoed = JSON.parse(cmdRes.stdout) as {
      argv: string[];
      cwd: string;
      agentDir: string;
    };
    expect(echoed.argv).toEqual(["install", "npm:@scope/demo", "-l", "--approve"]);
    expect(await realpath(echoed.cwd)).toBe(await realpath(projectDir));
    expect(echoed.agentDir).toBe(agentDir);

    const resourcesSnap = await readPiResourcesSnapshot(agentDir, projectDir);
    expect(resourcesSnap.packages).toHaveLength(3);
    expect(resourcesSnap.prompts).toHaveLength(2);
    expect(resourcesSnap.enableSkillCommands).toBe(true);
  });
});
