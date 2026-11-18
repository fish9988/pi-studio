// 内联 Gen UI 卡片：把 `::visualize{}` 指向的页面放进 app://preview 独立来源的 iframe，渲染成对话里的一张可交互卡片。
// 与卡片只有 postMessage（channel = pi-gen-ui，token 每次挂载随机）一条通道：不同源、不 innerHTML、不自动发消息。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DraftKey, TaskId } from "../../../shared/ipc.ts";
import { resolveTheme, themes } from "../../../shared/themes.ts";
import { quoteToComposer } from "../features/composer/quote.ts";
import { useT } from "../i18n/use-t.ts";
import { useSettings } from "../store/index.ts";
import { Button } from "../ui/controls.tsx";
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
/** 还没收到卡片的 resize 之前的默认高度。 */
const DEFAULT_HEIGHT = 360;

function readSavedState(stateKey: string): GenUiWidgetState | null {
  const raw = sessionStorage.getItem(`${STATE_STORAGE_PREFIX}${stateKey}`);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 上一次写坏的残留：当作没有状态，别让整张卡片挂掉
    return null;
  }
  return normalizeWidgetState(parsed);
}

function writeSavedState(stateKey: string, state: GenUiWidgetState): void {
  sessionStorage.setItem(`${STATE_STORAGE_PREFIX}${stateKey}`, JSON.stringify(state));
}

/** 颜色从当前主题的实时计算值取：主题切换后（data-theme 变了）再算一次，卡片跟着走。 */
function readThemeTokens(): GenUiThemeTokens {
  const style = getComputedStyle(document.documentElement);
  return {
    bg: style.getPropertyValue("--bg-raised").trim(),
    fg: style.getPropertyValue("--text").trim(),
    accent: style.getPropertyValue("--accent").trim(),
    border: style.getPropertyValue("--border").trim(),
    surface: style.getPropertyValue("--bg-tool").trim(),
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
  /** 卡片页面的完整 HTML（不含垫片，注入在 buildGenUiHtml 里做）。 */
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
  // 主题换了（data-theme 变化）才重新取色：取计算值要等属性落到 <html> 上。
  const [themeEpoch, setThemeEpoch] = useState(0);
  useEffect(() => onThemeChange(() => setThemeEpoch((value) => value + 1)), []);
  const [tokens, setTokens] = useState<GenUiThemeTokens>(readThemeTokens);
  useEffect(() => setTokens(readThemeTokens()), [theme, themeEpoch]);

  // app:// 是 secure context：每个挂载态一个随机 token，卡片消息只认它。
  const [token] = useState(() => globalThis.crypto.randomUUID());
  const [page, setPage] = useState<{ html: string; url: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const [stateSaved, setStateSaved] = useState(false);
  const [pending, setPending] = useState<{ prompt: string; text: string } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // 文档只在挂载 / html 变化时注册一次；主题变化走 postMessage，不能重新注册（那会把卡片里的交互状态清掉）。
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

  // 主题切换后把新的颜色推给卡片：它自己更新 CSS 变量并派发主题事件，不动交互状态。
  useEffect(() => {
    if (page === null) return;
    iframeRef.current?.contentWindow?.postMessage(
      { channel: GEN_UI_CHANNEL, token, type: "theme", payload: { theme, tokens } },
      "*",
    );
  }, [page, theme, token, tokens]);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = iframeRef.current;
      // 只认这张卡片自己的 iframe：别的窗口（含主窗口自身）发的同名消息一律不理。
      if (frame === null || event.source !== frame.contentWindow) return;
      const message = parseGenUiMessage(event.data, token);
      if (message === null) return;
      switch (message.type) {
        case "resize":
          setHeight(message.height);
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
            // 草稿态没有可发的任务：写进输入框，发不发由用户决定。
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
  return (
    <div className="gen-ui-card" data-testid="gen-ui-card">
      <div className="gen-ui-head">
        <span className="gen-ui-title" title={title}>
          {title}
        </span>
        {stateSaved && <span className="gen-ui-saved">{t("preview.genUiStateSaved")}</span>}
        <span className="gen-ui-actions">
          {onViewSource !== undefined && (
            <Button size="sm" variant="quiet" onClick={onViewSource}>
              {t("preview.modeSource")}
            </Button>
          )}
          {onOpenSidebar !== undefined && (
            <Button size="sm" variant="quiet" onClick={onOpenSidebar}>
              {t("preview.filesToggle")}
            </Button>
          )}
          <Button
            size="sm"
            variant="quiet"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
            data-testid="gen-ui-toggle"
          >
            {collapsed ? t("preview.genUiRun") : t("preview.genUiCollapse")}
          </Button>
        </span>
      </div>
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
    </div>
  );
}
