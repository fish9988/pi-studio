// 内联 Gen UI 交互画布：默认无框透明直接融入对话流（悬停/聚焦显微胶囊，支持弹出宽屏放大）。
// 与页面只有 postMessage（channel = pi-gen-ui，token 每次挂载随机）一条通道：不同源、不 innerHTML、不自动发消息。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DraftKey, TaskId } from "../../../shared/ipc.ts";
import { resolveTheme, themes } from "../../../shared/themes.ts";
import { quoteToComposer } from "../features/composer/quote.ts";
import { useT } from "../i18n/use-t.ts";
import { ChevronDown, ChevronRight, Code, External, Maximize } from "../icons.tsx";
import { useSettings } from "../store/index.ts";
import { Button } from "../ui/controls.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { reportError } from "../ui/errors.ts";
import { onThemeChange } from "../ui/theme-change.ts";
import {
  buildGenUiHtml,
  clampGenUiHeight,
  GEN_UI_CHANNEL,
  normalizeWidgetState,
  parseGenUiMessage,
  type GenUiThemeTokens,
  type GenUiWidgetState,
} from "./gen-ui-directive.ts";
import "./gen-ui.css";

/** widget 状态按 stateKey 隔离存在 sessionStorage：刷新对话不丢，关掉会话就清。 */
const STATE_STORAGE_PREFIX = "pi-gen-ui-state:";
/** 还没收到页面 resize 之前的默认高度。 */
const DEFAULT_HEIGHT = 320;

function readSavedState(stateKey: string): GenUiWidgetState | null {
  const raw = sessionStorage.getItem(`${STATE_STORAGE_PREFIX}${stateKey}`);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeWidgetState(parsed);
}

function writeSavedState(stateKey: string, state: GenUiWidgetState): void {
  sessionStorage.setItem(`${STATE_STORAGE_PREFIX}${stateKey}`, JSON.stringify(state));
}

/** 从宿主实时计算色阶与字体，沙箱透明融入当前主题。 */
function readThemeTokens(): GenUiThemeTokens {
  const style = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : style;
  return {
    bg: "transparent",
    fg: style.getPropertyValue("--text").trim(),
    mutedFg: style.getPropertyValue("--text-2").trim() || style.getPropertyValue("--text-3").trim(),
    accent: style.getPropertyValue("--accent").trim(),
    border: style.getPropertyValue("--border").trim(),
    surface: style.getPropertyValue("--bg-raised").trim(),
    card: style.getPropertyValue("--bg-tool").trim(),
    fontFamily: bodyStyle.fontFamily,
    fontSize: bodyStyle.fontSize,
  };
}

function subscribeSystemDark(listener: () => void): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

const systemDarkNow = (): boolean => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** 追问正文：卡片给了 modelContent 就作为 JSON 代码块附在问题后面，模型能直接读状态。 */
function composeFollowUpText(prompt: string, modelContent: unknown): string {
  if (modelContent === undefined) return prompt;
  const json = JSON.stringify(modelContent, null, 2);
  if (json === undefined) return prompt;
  return `${prompt}\n\n\`\`\`json\n${json}\n\`\`\``;
}

export interface GenUiCardProps {
  /** 页面的完整 HTML（不含垫片，注入在 buildGenUiHtml 里做）。 */
  html: string;
  title: string;
  /** widget 状态的存储键（按卡片区分）。 */
  stateKey: string;
  /** 追问发到哪个任务；null 表示草稿态，只能写进输入框。 */
  taskId: TaskId | null;
  /** 引用 / 草稿态追问的目标草稿（任务 id 或 `new:<projectId>`）。 */
  quoteTarget: TaskId | DraftKey | null;
  onOpenSidebar?: (() => void) | undefined;
  onViewSource?: (() => void) | undefined;
}

export function GenUiCard({ html, title, stateKey, taskId, quoteTarget, onOpenSidebar, onViewSource }: GenUiCardProps) {
  const t = useT();
  const settings = useSettings();
  const systemDark = useSyncExternalStore(subscribeSystemDark, systemDarkNow);
  const dark = themes[resolveTheme(settings?.theme ?? "default", systemDark, settings?.colorMode ?? "system")].dark;
  const theme: "light" | "dark" = dark ? "dark" : "light";
  const [themeEpoch, setThemeEpoch] = useState(0);
  useEffect(() => onThemeChange(() => setThemeEpoch((value) => value + 1)), []);
  const [tokens, setTokens] = useState<GenUiThemeTokens>(readThemeTokens);
  useEffect(() => setTokens(readThemeTokens()), [theme, themeEpoch]);

  const [token] = useState(() => globalThis.crypto.randomUUID());
  const [page, setPage] = useState<{ html: string; url: string } | null>(null);
  const [expandedPage, setExpandedPage] = useState<{ html: string; url: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [stateSaved, setStateSaved] = useState(false);
  const [pending, setPending] = useState<{ prompt: string; text: string } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const modalIframeRef = useRef<HTMLIFrameElement | null>(null);

  const themeRef = useRef(theme);
  const tokensRef = useRef(tokens);
  useEffect(() => {
    themeRef.current = theme;
    tokensRef.current = tokens;
  }, [theme, tokens]);

  useEffect(() => {
    if (html.trim() === "") {
      setPage(null);
      return;
    }
    let disposed = false;
    let allocated: string | null = null;
    setLoadError(null);
    const built = buildGenUiHtml({
      html,
      token,
      theme: themeRef.current,
      tokens: tokensRef.current,
      initialState: readSavedState(stateKey),
    });
    const release = (url: string): void => {
      void window.studio.releaseHtmlPreview(url).catch((error: unknown) => reportError(t, error));
    };
    void window.studio.registerHtmlPreview(built).then(
      (url) => {
        allocated = url;
        if (disposed) release(url);
        else setPage({ html, url });
      },
      (error: unknown) => {
        if (disposed) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        reportError(t, error);
      },
    );
    return () => {
      disposed = true;
      if (allocated !== null) release(allocated);
    };
  }, [html, stateKey, t, token]);

  // 弹出放大视图按需注册一次并携带最新状态快照。
  useEffect(() => {
    if (!expanded || html.trim() === "") {
      setExpandedPage(null);
      return;
    }
    let disposed = false;
    let allocated: string | null = null;
    const built = buildGenUiHtml({
      html,
      token,
      theme: themeRef.current,
      tokens: tokensRef.current,
      initialState: readSavedState(stateKey),
    });
    const release = (url: string): void => {
      void window.studio.releaseHtmlPreview(url).catch((error: unknown) => reportError(t, error));
    };
    void window.studio.registerHtmlPreview(built).then(
      (url) => {
        allocated = url;
        if (disposed) release(url);
        else setExpandedPage({ html, url });
      },
      (error: unknown) => {
        if (!disposed) reportError(t, error);
      },
    );
    return () => {
      disposed = true;
      if (allocated !== null) release(allocated);
    };
  }, [expanded, html, stateKey, t, token]);

  // 主题切换后把新的颜色推给已挂载的 iframe：不重建不丢交互状态。
  useEffect(() => {
    const payload = { channel: GEN_UI_CHANNEL, token, type: "theme", payload: { theme, tokens } };
    if (page !== null) iframeRef.current?.contentWindow?.postMessage(payload, "*");
    if (expandedPage !== null) modalIframeRef.current?.contentWindow?.postMessage(payload, "*");
  }, [expandedPage, page, theme, token, tokens]);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const inlineWin = iframeRef.current?.contentWindow ?? null;
      const modalWin = modalIframeRef.current?.contentWindow ?? null;
      const isInline = inlineWin !== null && event.source === inlineWin;
      const isModal = modalWin !== null && event.source === modalWin;
      if (!isInline && !isModal) return;
      const message = parseGenUiMessage(event.data, token);
      if (message === null) return;
      switch (message.type) {
        case "resize":
          if (isInline) setHeight(message.height);
          break;
        case "state":
          writeSavedState(stateKey, message.state);
          setStateSaved(true);
          break;
        case "quote":
          quoteToComposer(quoteTarget, message.text, { fold: message.text.length > 400 });
          break;
        case "openExternal":
          void window.studio.openExternal(message.href).catch((error: unknown) => reportError(t, error));
          break;
        case "followUp": {
          const text = composeFollowUpText(message.prompt, message.modelContent);
          if (taskId === null) {
            quoteToComposer(quoteTarget, text, { fold: text.length > 400 });
            break;
          }
          setPending({ prompt: message.prompt, text });
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [quoteTarget, stateKey, t, taskId, token]);

  const sendPending = (): void => {
    if (pending === null || taskId === null) return;
    void window.studio
      .sendPrompt(taskId, { text: pending.text, images: [], whenBusy: "followUp" })
      .then(() => setPending(null))
      .catch((error: unknown) => reportError(t, error));
  };

  const frame = page !== null && page.html === html ? page : null;
  const modalFrame = expandedPage !== null && expandedPage.html === html ? expandedPage : null;

  return (
    <div className="gen-ui-card" data-testid="gen-ui-card" data-collapsed={collapsed ? "" : undefined}>
      {collapsed ? (
        <div className="gen-ui-collapsed-bar">
          <button
            type="button"
            className="gen-ui-collapsed-btn"
            aria-expanded="false"
            onClick={() => setCollapsed(false)}
            data-testid="gen-ui-toggle"
          >
            <ChevronRight size={14} />
            <span className="gen-ui-collapsed-title" title={title}>
              {title}
            </span>
            <span className="gen-ui-collapsed-hint">{t("preview.genUiRun")}</span>
          </button>
        </div>
      ) : (
        <div className="gen-ui-surface">
          {(stateSaved || frame !== null) && (
            <div className="gen-ui-overlay-bar" data-saved={stateSaved ? "true" : undefined}>
              {stateSaved && <span className="gen-ui-saved">{t("preview.genUiStateSaved")}</span>}
              {frame !== null && (
                <div className="gen-ui-float-actions" role="toolbar" aria-label={title}>
                  <button
                    type="button"
                    className="gen-ui-icon-btn"
                    title={title}
                    aria-label={title}
                    onClick={() => setExpanded(true)}
                  >
                    <Maximize size={14} />
                  </button>
                  {onViewSource !== undefined && (
                    <button
                      type="button"
                      className="gen-ui-icon-btn"
                      title={t("preview.modeSource")}
                      aria-label={t("preview.modeSource")}
                      onClick={onViewSource}
                    >
                      <Code size={14} />
                    </button>
                  )}
                  {onOpenSidebar !== undefined && (
                    <button
                      type="button"
                      className="gen-ui-icon-btn"
                      title={t("preview.filesToggle")}
                      aria-label={t("preview.filesToggle")}
                      onClick={onOpenSidebar}
                    >
                      <External size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="gen-ui-icon-btn"
                    title={t("preview.genUiCollapse")}
                    aria-label={t("preview.genUiCollapse")}
                    aria-expanded="true"
                    onClick={() => setCollapsed(true)}
                    data-testid="gen-ui-toggle"
                  >
                    <ChevronDown size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {pending !== null && (
        <div className="gen-ui-confirm" data-testid="gen-ui-confirm">
          <p className="gen-ui-confirm-hint">{t("preview.genUiConfirmSend")}</p>
          <p className="gen-ui-confirm-prompt">{pending.prompt}</p>
          <div className="gen-ui-confirm-actions">
            <Button size="sm" variant="primary" onClick={sendPending} data-testid="gen-ui-confirm-send">
              {t("preview.genUiFollowUp")}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}

      <div className="gen-ui-body" data-collapsed={collapsed ? "" : undefined}>
        {loadError !== null ? (
          <p className="gen-ui-note" role="alert">
            {t("preview.readFailed", { message: loadError })}
          </p>
        ) : html.trim() === "" ? (
          <p className="gen-ui-note">{t("preview.genUiMissingFile", { path: title })}</p>
        ) : frame === null ? (
          <p className="gen-ui-note">{t("preview.genUiLoading")}</p>
        ) : (
          <iframe
            ref={iframeRef}
            key={frame.url}
            className="gen-ui-frame"
            style={{ height: clampGenUiHeight(height) }}
            title={title}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={frame.url}
          />
        )}
      </div>

      <Dialog open={expanded} onClose={() => setExpanded(false)} title={title} size="lg">
        {modalFrame === null ? (
          <p className="gen-ui-note">{t("preview.genUiLoading")}</p>
        ) : (
          <iframe
            ref={modalIframeRef}
            key={modalFrame.url}
            className="gen-ui-modal-frame"
            title={title}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={modalFrame.url}
          />
        )}
      </Dialog>
    </div>
  );
}
