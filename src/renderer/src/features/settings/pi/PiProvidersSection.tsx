// Pi 模型来源页（providers）：内置 Provider 与认证矩阵（auth.json / OAuth / API Key / ENV）+ 自定义 Provider（models.json）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PiProviderAuthStatus } from "../../../../../shared/pi-config-types.ts";
import { External, Restart, Search } from "../../../icons.tsx";
import { Button, FormField, IconButton, SectionHead, TextField } from "../../../ui/controls.tsx";
import { Dialog } from "../../../ui/Dialog.tsx";
import { reportError } from "../../../ui/errors.ts";
import { pushToast } from "../../dialogs/toast-store.ts";
import { CustomProviders } from "../CustomProviders.tsx";
import { ProviderLogo } from "../ProviderLogo.tsx";
import { TerminalLoginBody } from "../TerminalLoginBody.tsx";
import { piBridge } from "./pi-bridge.ts";
import { usePiText } from "./pi-shared.tsx";

const BUILTIN_PI_PROVIDERS: readonly PiProviderAuthStatus[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    supportsOAuth: true,
    acceptsApiKey: true,
    envVars: ["ANTHROPIC_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "openai",
    name: "OpenAI",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["OPENAI_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    supportsOAuth: true,
    acceptsApiKey: false,
    envVars: [],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "google",
    name: "Google Gemini",
    supportsOAuth: true,
    acceptsApiKey: true,
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "google-antigravity",
    name: "Google Antigravity",
    supportsOAuth: true,
    acceptsApiKey: false,
    envVars: [],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["DEEPSEEK_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["OPENROUTER_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    supportsOAuth: true,
    acceptsApiKey: false,
    envVars: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "xai",
    name: "xAI",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["XAI_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "groq",
    name: "Groq",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["GROQ_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "mistral",
    name: "Mistral",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["MISTRAL_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "dashscope",
    name: "DashScope",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["DASHSCOPE_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "moonshot",
    name: "Moonshot",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["MOONSHOT_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "zhipu",
    name: "Zhipu",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["ZHIPU_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "minimax",
    name: "MiniMax",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["MINIMAX_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
  {
    id: "ollama",
    name: "Ollama",
    supportsOAuth: false,
    acceptsApiKey: true,
    envVars: ["OLLAMA_API_KEY"],
    activeEnvVar: null,
    authType: null,
    accountHint: null,
    modelCount: 0,
  },
];

function mergeProviderCatalog(live: readonly PiProviderAuthStatus[]): PiProviderAuthStatus[] {
  const byId = new Map<string, PiProviderAuthStatus>();
  for (const item of live) byId.set(item.id, item);
  const merged: PiProviderAuthStatus[] = BUILTIN_PI_PROVIDERS.map((preset) => {
    const hit = byId.get(preset.id);
    if (!hit) return preset;
    byId.delete(preset.id);
    return {
      ...preset,
      ...hit,
      name: hit.name || preset.name,
      envVars: hit.envVars.length > 0 ? hit.envVars : preset.envVars,
    };
  });
  for (const extra of byId.values()) merged.push(extra);
  return merged;
}

export function PiProvidersSection() {
  const { tr, t } = usePiText();
  const [liveStatuses, setLiveStatuses] = useState<PiProviderAuthStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  // API Key 弹窗状态
  const [keyModalProvider, setKeyModalProvider] = useState<PiProviderAuthStatus | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  // OAuth 交互式终端登录弹窗状态
  const [oauthProvider, setOauthProvider] = useState<PiProviderAuthStatus | null>(null);
  const oauthSettledRef = useRef(false);

  const loadStatuses = useCallback(async () => {
    setLoading(true);
    try {
      const next = await piBridge().listPiProviderStatuses();
      setLiveStatuses(next);
    } catch (error) {
      reportError(t, error);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  const providers = useMemo(() => mergeProviderCatalog(liveStatuses), [liveStatuses]);

  const filteredProviders = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return providers;
    return providers.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.id.toLowerCase().includes(needle) ||
        item.envVars.some((env) => env.toLowerCase().includes(needle)),
    );
  }, [providers, query]);

  const configuredCount = useMemo(
    () => providers.filter((p) => p.authType !== null || p.activeEnvVar !== null).length,
    [providers],
  );

  const openApiKeyModal = (provider: PiProviderAuthStatus) => {
    setApiKeyDraft("");
    setKeyModalProvider(provider);
  };

  const submitApiKey = async () => {
    if (!keyModalProvider || apiKeyDraft.trim() === "") return;
    setSavingKey(true);
    try {
      await piBridge().saveApiKey(keyModalProvider.id, apiKeyDraft.trim());
      await piBridge().refreshModels();
      await loadStatuses();
      pushToast({
        level: "info",
        message: tr(`已保存 ${keyModalProvider.name} API Key`, `Saved ${keyModalProvider.name} API Key`),
      });
      setKeyModalProvider(null);
      setApiKeyDraft("");
    } catch (error) {
      reportError(t, error);
    } finally {
      setSavingKey(false);
    }
  };

  const startOAuthFlow = (provider: PiProviderAuthStatus) => {
    oauthSettledRef.current = false;
    setOauthProvider(provider);
    void piBridge()
      .startTerminalLogin(provider.id)
      .then(async (outcome) => {
        oauthSettledRef.current = true;
        if (outcome.ok) {
          setOauthProvider(null);
          await piBridge().refreshModels();
          await loadStatuses();
          pushToast({
            level: "info",
            message: tr(`${provider.name} 登录成功`, `Signed in to ${provider.name}`),
          });
        } else if (outcome.message !== "cancelled" && outcome.message !== "") {
          pushToast({ level: "error", message: outcome.message });
        }
      })
      .catch((error: unknown) => {
        oauthSettledRef.current = true;
        reportError(t, error);
      });
  };

  const closeOAuthModal = () => {
    if (!oauthSettledRef.current) {
      void piBridge().cancelTerminalLogin();
    }
    setOauthProvider(null);
  };

  const handleLogout = async (provider: PiProviderAuthStatus) => {
    try {
      await piBridge().logout(provider.id);
      await piBridge().refreshModels();
      await loadStatuses();
      pushToast({
        level: "info",
        message: tr(`已移除 ${provider.name} 凭据`, `Signed out of ${provider.name}`),
      });
    } catch (error) {
      reportError(t, error);
    }
  };

  const handleRefreshModels = async () => {
    try {
      await piBridge().refreshModels();
      await loadStatuses();
      pushToast({ level: "info", message: tr("模型目录已刷新", "Model catalog refreshed") });
    } catch (error) {
      reportError(t, error);
    }
  };

  return (
    <div className="pis-stack" data-testid="pi-providers-section">
      {/* 1. 内置 Provider 与认证 */}
      <section className="pis-group">
        <SectionHead
          title={tr("内置 Provider 与认证", "Built-in providers & auth")}
          count={`${configuredCount}/${providers.length}`}
          note={tr(
            "凭据保存在 ~/.pi/agent/auth.json 或读取环境变量。",
            "Credentials stored in ~/.pi/agent/auth.json or read from environment variables.",
          )}
          actions={
            <>
              <Button
                size="sm"
                icon={<External size={14} />}
                onClick={() =>
                  void piBridge()
                    .openPiConfigFile("auth.json")
                    .catch((err: unknown) => reportError(t, err))
                }
                testId="pi-open-auth-json"
              >
                auth.json
              </Button>
              <IconButton
                label={tr("刷新认证状态", "Refresh auth status")}
                disabled={loading}
                onClick={() => void loadStatuses()}
                testId="pi-providers-refresh"
              >
                <Restart />
              </IconButton>
            </>
          }
        />

        <div className="pis-provider-toolbar">
          <TextField
            size="sm"
            width={280}
            leading={<Search size={14} />}
            value={query}
            onChange={setQuery}
            placeholder={tr("搜索 Provider 或环境变量…", "Filter providers or ENV…")}
            aria-label={tr("搜索 Provider", "Filter providers")}
            testId="pi-providers-search"
          />
        </div>

        <div className="pis-provider-grid" data-testid="pi-provider-grid">
          {filteredProviders.map((provider) => {
            const isOAuth = provider.authType === "oauth";
            const isKey = provider.authType === "api_key";
            const isEnv = !isOAuth && !isKey && provider.activeEnvVar !== null;
            const active = isOAuth || isKey || isEnv;
            const tone = isOAuth ? "oauth" : isKey ? "key" : isEnv ? "env" : undefined;
            const statusText = isOAuth
              ? tr("OAuth 已登录", "OAuth signed in")
              : isKey
                ? tr("API Key 已配置", "API Key saved")
                : isEnv
                  ? `ENV: ${provider.activeEnvVar}`
                  : tr("未配置", "Not configured");

            const subtitleParts = [
              provider.accountHint ?? provider.envVars[0] ?? provider.id,
              provider.modelCount > 0 ? tr(`${provider.modelCount} 模型`, `${provider.modelCount} models`) : null,
            ].filter(Boolean);

            return (
              <div
                key={provider.id}
                className="pis-provider-card"
                data-active={active || undefined}
                data-testid={`pi-provider-${provider.id}`}
              >
                <div className="pis-provider-head">
                  <span className="pis-provider-logo" aria-hidden="true">
                    <ProviderLogo id={provider.id} name={provider.name} />
                  </span>
                  <div className="pis-provider-info">
                    <div className="pis-provider-title-row">
                      <span className="pis-provider-name">{provider.name}</span>
                    </div>
                    <span className="pis-provider-sub">{subtitleParts.join(" · ")}</span>
                  </div>
                </div>

                <div className="pis-provider-foot">
                  <span className="pis-status-pill" data-tone={tone}>
                    <span className="pis-status-dot" aria-hidden="true" />
                    {statusText}
                  </span>

                  <div className="pis-provider-actions">
                    {provider.supportsOAuth && (
                      <Button
                        size="sm"
                        onClick={() => startOAuthFlow(provider)}
                        testId={`pi-provider-oauth-${provider.id}`}
                      >
                        {tr("OAuth 登录", "OAuth")}
                      </Button>
                    )}
                    {provider.acceptsApiKey && (
                      <Button
                        size="sm"
                        onClick={() => openApiKeyModal(provider)}
                        testId={`pi-provider-key-${provider.id}`}
                      >
                        API Key
                      </Button>
                    )}
                    {provider.authType !== null && (
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => void handleLogout(provider)}
                        testId={`pi-provider-logout-${provider.id}`}
                      >
                        {tr("退出", "Sign out")}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. 自定义 Provider 与模型覆盖 (~/.pi/agent/models.json) */}
      <section className="pis-group">
        <SectionHead
          title={tr("自定义 Provider 与模型覆盖", "Custom providers & model overrides")}
          note="~/.pi/agent/models.json"
          actions={
            <>
              <Button
                size="sm"
                icon={<External size={14} />}
                onClick={() =>
                  void piBridge()
                    .openPiConfigFile("models.json")
                    .catch((err: unknown) => reportError(t, err))
                }
                testId="pi-open-models-json"
              >
                {tr("打开 models.json", "Open models.json")}
              </Button>
              <Button
                size="sm"
                icon={<Restart size={14} />}
                onClick={() => void handleRefreshModels()}
                testId="pi-refresh-models-catalog"
              >
                {tr("刷新模型目录", "Refresh catalog")}
              </Button>
            </>
          }
        />
        <CustomProviders />
      </section>

      {/* API Key 保存弹窗 */}
      <Dialog
        open={keyModalProvider !== null}
        onClose={() => setKeyModalProvider(null)}
        size="sm"
        title={
          keyModalProvider ? tr(`配置 ${keyModalProvider.name} API Key`, `${keyModalProvider.name} API Key`) : "API Key"
        }
        desc={
          keyModalProvider?.envVars[0]
            ? tr(
                `写入 ~/.pi/agent/auth.json（也可设置环境变量 ${keyModalProvider.envVars[0]}）`,
                `Saved to ~/.pi/agent/auth.json (or set ${keyModalProvider.envVars[0]})`,
              )
            : "~/.pi/agent/auth.json"
        }
        testId="pi-apikey-dialog"
        footer={
          <>
            <Button onClick={() => setKeyModalProvider(null)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              loading={savingKey}
              disabled={apiKeyDraft.trim() === ""}
              onClick={() => void submitApiKey()}
              testId="pi-apikey-save"
            >
              {tr("保存", "Save")}
            </Button>
          </>
        }
      >
        <FormField label="API Key" htmlFor="pi-apikey-input">
          <TextField
            id="pi-apikey-input"
            type="password"
            mono
            width="100%"
            data-autofocus=""
            value={apiKeyDraft}
            onChange={setApiKeyDraft}
            placeholder="sk-..."
            onKeyDown={(event) => {
              if (event.key === "Enter" && apiKeyDraft.trim() !== "") {
                event.preventDefault();
                void submitApiKey();
              }
            }}
            testId="pi-apikey-input"
          />
        </FormField>
      </Dialog>

      {/* OAuth 终端登录弹窗 */}
      <Dialog
        open={oauthProvider !== null}
        onClose={closeOAuthModal}
        size="md"
        title={oauthProvider ? `/login ${oauthProvider.id}` : "/login"}
        desc={oauthProvider?.name}
        testId="pi-oauth-dialog"
        footer={<Button onClick={closeOAuthModal}>{t("common.cancel")}</Button>}
      >
        {oauthProvider !== null && <TerminalLoginBody />}
      </Dialog>
    </div>
  );
}
