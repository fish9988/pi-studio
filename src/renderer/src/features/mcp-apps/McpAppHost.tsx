// MCP Apps 容器：读 MCP 服务器给的 `ui://` 资源 → 注册成独立文档 → `<iframe sandbox="allow-scripts">` →
// 按 ext-apps 协议做宿主侧应答（裸 JSON-RPC 2.0，见 app-bridge.ts）。
// 宿主只认 `event.source === iframe.contentWindow` 的帧：别的窗口（含主应用自己）发什么都不理。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DraftKey, ProjectId, TaskId } from "../../../../shared/ipc.ts";
import { resolveTheme, themes } from "../../../../shared/themes.ts";
import { errorDetail } from "../../../../shared/ui/errors.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import { Restart } from "../../icons.tsx";
import { useAppInfo, useSettings } from "../../store/index.ts";
import { Button, IconButton } from "../../ui/controls.tsx";
import { reportError, reportErrorNow } from "../../ui/errors.ts";
import { quoteToComposer } from "../composer/quote.ts";
import { pushToast } from "../dialogs/toast-store.ts";
import {
  buildInitializeResult,
  buildMcpAppHtml,
  clampAppHeight,
  extractTextFromContent,
  isAllowedExternalUrl,
  isJsonRpcMessage,
  isJsonRpcNotification,
  isJsonRpcRequest,
  MCP_APP_HOST_VERSION,
  MCP_APP_STYLE_TOKENS,
  resolveHostStyleVariables,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type McpAppDisplayMode,
  type McpAppHostContext,
  type McpAppTheme,
} from "./app-bridge.ts";
import "./mcp-apps.css";

export interface McpAppHostProps {
  projectId: ProjectId | null;
  server: string;
  uri: string;
  title: string;
  taskId: TaskId | null;
  quoteTarget: TaskId | DraftKey | null;
  displayMode?: "inline" | "fullscreen" | undefined;
}

type PageState = { phase: "loading" } | { phase: "ready"; url: string } | { phase: "error"; message: string };

const DEFAULT_HEIGHT = 320;
/** 少于 400 字的上下文直接接在输入框末尾，长的折叠成粘贴附件（和引用代码块同一个口径）。 */
const FOLD_AT = 400;

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

function subscribeSystemDark(listener: () => void): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

const systemDarkNow = (): boolean => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** 沙箱文档拿不到宿主的层叠样式表：这里按当前主题把 Pi 的 token 实算成字面量再注入。 */
function useHostTheme(): McpAppTheme {
  const settings = useSettings();
  const systemDark = useSyncExternalStore(subscribeSystemDark, systemDarkNow);
  const name = resolveTheme(settings?.theme ?? "default", systemDark, settings?.colorMode ?? "system");
  return themes[name].dark ? "dark" : "light";
}

/** 读 :root 上这些 token 的实算值；主题切了要重新读（只在装载与握手时调用）。 */
function readPiTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of new Set(Object.values(MCP_APP_STYLE_TOKENS))) {
    const value = style.getPropertyValue(name).trim();
    if (value !== "") tokens[name] = value;
  }
  return tokens;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface HostInputs {
  projectId: ProjectId | null;
  server: string;
  taskId: TaskId | null;
  quoteTarget: TaskId | DraftKey | null;
  displayMode: McpAppDisplayMode;
  whenBusy: "steer" | "followUp";
  theme: McpAppTheme;
  locale: string;
  hostVersion: string;
}

export function McpAppHost({
  projectId,
  server,
  uri,
  title,
  taskId,
  quoteTarget,
  displayMode = "inline",
}: McpAppHostProps) {
  const t = useT();
  const locale = useLocale();
  const settings = useSettings();
  const appInfo = useAppInfo();
  const theme = useHostTheme();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [page, setPage] = useState<PageState>({ phase: "loading" });
  const [handshaked, setHandshaked] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // 消息处理在只订阅一次的监听里跑，用 ref 拿最新的这组输入（重订阅会让在途请求的应答丢掉）。
  const inputsRef = useRef<HostInputs>({
    projectId,
    server,
    taskId,
    quoteTarget,
    displayMode,
    whenBusy: settings?.enterWhileRunning ?? "steer",
    theme,
    locale,
    hostVersion: appInfo?.version ?? MCP_APP_HOST_VERSION,
  });
  useEffect(() => {
    inputsRef.current = {
      projectId,
      server,
      taskId,
      quoteTarget,
      displayMode,
      whenBusy: settings?.enterWhileRunning ?? "steer",
      theme,
      locale,
      hostVersion: appInfo?.version ?? MCP_APP_HOST_VERSION,
    };
  });

  // 1. 读资源 → 注入样式与垫片 → 注册成独立文档（卸载 / 重连时释放）。
  useEffect(() => {
    let disposed = false;
    let allocated: string | null = null;
    setPage({ phase: "loading" });
    setHandshaked(false);
    setPendingMessage(null);
    void (async () => {
      const resource = await window.studio.readMcpAppResource(projectId, server, uri);
      const html = buildMcpAppHtml({
        html: resource.html,
        channelToken: crypto.randomUUID(),
        theme: inputsRef.current.theme,
        piTokens: readPiTokens(),
      });
      const url = await window.studio.registerHtmlPreview(html);
      allocated = url;
      if (disposed) {
        void window.studio.releaseHtmlPreview(url).catch(reportErrorNow);
        return;
      }
      setPage({ phase: "ready", url });
    })().catch((error: unknown) => {
      if (disposed) return;
      setPage({ phase: "error", message: errorDetail(error) });
    });
    return () => {
      disposed = true;
      if (allocated !== null) void window.studio.releaseHtmlPreview(allocated).catch(reportErrorNow);
    };
  }, [projectId, server, uri, nonce]);

  // 2. 应用 ↔ 宿主：只认本沙箱 iframe 的裸 JSON-RPC 2.0 帧。
  useEffect(() => {
    const post = (message: JsonRpcMessage): void => {
      iframeRef.current?.contentWindow?.postMessage(message, "*");
    };
    const succeed = (id: JsonRpcId, result: unknown): void => post({ jsonrpc: "2.0", id, result });
    const fail = (id: JsonRpcId, code: number, message: string): void =>
      post({ jsonrpc: "2.0", id, error: { code, message } });

    const applyHeight = (params: unknown): void => {
      if (inputsRef.current.displayMode !== "inline") return;
      const reported = asRecord(params)?.["height"];
      if (typeof reported !== "number") return;
      setHeight((current) => clampAppHeight(reported, current));
    };

    const buildContext = (): McpAppHostContext => {
      const inputs = inputsRef.current;
      return {
        theme: inputs.theme,
        displayMode: inputs.displayMode,
        // 只声明真正支持的显示模式：宿主没有实现 ui/request-display-mode，别给应用假的期望。
        availableDisplayModes: [inputs.displayMode],
        platform: "desktop",
        locale: inputs.locale,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        userAgent: navigator.userAgent,
        styles: { variables: resolveHostStyleVariables(readPiTokens()) },
      };
    };

    const answer = async (request: JsonRpcRequest): Promise<void> => {
      const inputs = inputsRef.current;
      try {
        switch (request.method) {
          case "ui/initialize":
            succeed(request.id, buildInitializeResult(buildContext(), inputs.hostVersion));
            return;
          case "tools/call": {
            const params = asRecord(request.params);
            const name = params?.["name"];
            if (typeof name !== "string" || name === "") {
              fail(request.id, JSON_RPC_INVALID_PARAMS, "tools/call needs a tool name");
              return;
            }
            const args = asRecord(params?.["arguments"]) ?? {};
            const result = await window.studio.callMcpAppTool(inputs.projectId, inputs.server, name, args);
            const payload: Record<string, unknown> = { content: result.content };
            if (result.structuredContent !== undefined) payload["structuredContent"] = result.structuredContent;
            if (result.isError !== undefined) payload["isError"] = result.isError;
            succeed(request.id, payload);
            return;
          }
          case "resources/read": {
            const target = asRecord(request.params)?.["uri"];
            if (typeof target !== "string" || target === "") {
              fail(request.id, JSON_RPC_INVALID_PARAMS, "resources/read needs a uri");
              return;
            }
            const resource = await window.studio.readMcpAppResource(inputs.projectId, inputs.server, target);
            succeed(request.id, {
              contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.html }],
            });
            return;
          }
          case "ui/update-model-context": {
            const text = extractTextFromContent(asRecord(request.params)?.["content"]);
            if (text !== "") {
              quoteToComposer(inputs.quoteTarget, text, { fold: text.length > FOLD_AT });
              pushToast({ message: t("preview.quoteToChat") });
            }
            succeed(request.id, {});
            return;
          }
          case "ui/message": {
            const text = extractTextFromContent(asRecord(request.params)?.["content"]);
            if (text !== "") setPendingMessage(text);
            succeed(request.id, {});
            return;
          }
          case "ui/open-link": {
            const target = asRecord(request.params)?.["url"];
            if (typeof target !== "string" || !isAllowedExternalUrl(target)) {
              fail(request.id, JSON_RPC_INVALID_PARAMS, "only http/https links can be opened");
              return;
            }
            await window.studio.openExternal(target.trim());
            succeed(request.id, {});
            return;
          }
          case "ui/size-changed":
            applyHeight(request.params);
            succeed(request.id, {});
            return;
          default:
            fail(request.id, JSON_RPC_METHOD_NOT_FOUND, `unsupported method: ${request.method}`);
        }
      } catch (error) {
        // 请求失败必须回一条 error 应答：不回的话应用侧会一直挂着等结果。
        fail(request.id, JSON_RPC_INTERNAL_ERROR, errorDetail(error));
      }
    };

    const answerNotification = (notification: JsonRpcNotification): void => {
      switch (notification.method) {
        case "ui/notifications/initialized":
          setHandshaked(true);
          return;
        case "ui/size-changed":
        case "ui/notifications/size-changed":
          applyHeight(notification.params);
          return;
      }
    };

    const onMessage = (event: MessageEvent): void => {
      const frame = iframeRef.current?.contentWindow ?? null;
      if (frame === null || event.source !== frame) return;
      const data: unknown = event.data;
      if (!isJsonRpcMessage(data)) return;
      if (isJsonRpcRequest(data)) {
        void answer(data);
        return;
      }
      if (isJsonRpcNotification(data)) answerNotification(data);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [t]);

  const status = page.phase === "error" ? "error" : handshaked ? "ready" : "loading";

  const reconnect = (): void => {
    setPendingMessage(null);
    void window.studio
      .closeMcpAppServer(server)
      .then(() => setNonce((value) => value + 1))
      .catch((error: unknown) => {
        reportError(t, error);
        setNonce((value) => value + 1);
      });
  };

  const sendPending = (): void => {
    if (pendingMessage === null) return;
    const text = pendingMessage;
    setPendingMessage(null);
    if (taskId === null) {
      quoteToComposer(quoteTarget, text, { fold: text.length > FOLD_AT });
      return;
    }
    void window.studio
      .sendPrompt(taskId, { text, whenBusy: inputsRef.current.whenBusy })
      .catch((error: unknown) => reportError(t, error));
  };

  const quotePending = (): void => {
    if (pendingMessage === null) return;
    const text = pendingMessage;
    setPendingMessage(null);
    quoteToComposer(quoteTarget, text, { fold: text.length > FOLD_AT });
  };

  return (
    <section
      className="mcp-app-host"
      data-display-mode={displayMode}
      data-testid="mcp-app-host"
      aria-label={`${t("preview.mcpAppsTitle")} · ${title}`}
    >
      <div className="mcp-app-bar">
        <span className="mcp-app-title" title={uri}>
          {title}
        </span>
        <span className="mcp-app-server" title={server}>
          {server}
        </span>
        <span className="mcp-app-status" data-state={status} />
        <IconButton
          className="mcp-app-reconnect"
          label={t("preview.mcpAppsReconnect")}
          testId="mcp-app-reconnect"
          onClick={reconnect}
        >
          <Restart />
        </IconButton>
      </div>
      {page.phase === "loading" && <p className="mcp-app-note">{t("preview.loading")}</p>}
      {page.phase === "error" && (
        <p className="mcp-app-note mcp-app-note-error" role="alert">
          {t("preview.mcpAppsError", { message: page.message })}
        </p>
      )}
      {page.phase === "ready" && (
        <iframe
          key={page.url}
          ref={iframeRef}
          className="mcp-app-frame"
          data-testid="mcp-app-frame"
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={page.url}
          style={displayMode === "inline" ? { height } : undefined}
        />
      )}
      {pendingMessage !== null && (
        <div className="mcp-app-confirm" role="group" aria-label={t("preview.genUiConfirmSend")}>
          <span className="mcp-app-confirm-text" title={pendingMessage}>
            {pendingMessage}
          </span>
          <Button size="sm" variant="quiet" testId="mcp-app-message-dismiss" onClick={() => setPendingMessage(null)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="secondary" testId="mcp-app-message-quote" onClick={quotePending}>
            {t("preview.quoteToChat")}
          </Button>
          {taskId !== null && (
            <Button size="sm" variant="primary" testId="mcp-app-message-send" onClick={sendPending}>
              {t("composer.send")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
