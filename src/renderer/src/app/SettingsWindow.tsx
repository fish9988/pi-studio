// 并行设置窗口（支持「右侧并排分屏」、「可拖拽浮动窗口」、「收起为迷你条」以及「弹出为独立系统窗口」四种形态）：
// 打开设置时绝不卸载或遮蔽左侧会话栏与当前对话流，方便一边观察会话运行一边调整设置。
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Close, External } from "../icons.tsx";
import { useLocale, useT } from "../i18n/use-t.ts";
import { setSettingsPage, showView, useSettingsPage, type SettingsPage } from "../store/index.ts";
import { SettingsNav, SettingsView } from "./lazy-views.tsx";

const VALID_SETTINGS_PAGES: readonly SettingsPage[] = [
  "general",
  "models",
  "providers",
  "tools",
  "extensions",
  "context",
  "advanced",
  "about",
];

export type SettingsWindowMode = "dock" | "float";

const MODE_STORAGE_KEY = "pi-studio:settings-window-mode";

function loadInitialMode(): SettingsWindowMode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === "float" ? "float" : "dock";
  } catch {
    return "dock";
  }
}

export function isStandaloneSettingsWindow(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("window") === "settings";
}

export function initialStandaloneSection(): SettingsPage | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("section");
  if (raw && (VALID_SETTINGS_PAGES as readonly string[]).includes(raw)) {
    return raw as SettingsPage;
  }
  return null;
}

export function SettingsWindow({ compactNav }: { compactNav: boolean }) {
  const t = useT();
  const locale = useLocale();
  const isZh = locale === "zh-CN";
  const currentSection = useSettingsPage();
  const [mode, setMode] = useState<SettingsWindowMode>(loadInitialMode);
  const [minimized, setMinimized] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);

  const toggleMode = useCallback(() => {
    setMinimized(false);
    setMode((prev) => {
      const next: SettingsWindowMode = prev === "dock" ? "float" : "dock";
      try {
        window.localStorage.setItem(MODE_STORAGE_KEY, next);
      } catch {
        // ignore
      }
      if (next === "dock") setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const popOutNativeWindow = useCallback(() => {
    void window.studio
      .openSettingsWindow(currentSection)
      .then(() => {
        showView("conversation");
      })
      .catch(() => {});
  }, [currentSection]);

  const onBarPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (mode !== "float" || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, select, a")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: offset.x,
      origY: offset.y,
      moved: false,
    };
  };

  const onBarPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    drag.moved = true;
    const maxX = Math.max(80, Math.floor(window.innerWidth * 0.35));
    const maxY = Math.max(60, Math.floor(window.innerHeight * 0.35));
    setOffset({
      x: Math.max(-maxX, Math.min(maxX, drag.origX + dx)),
      y: Math.max(-maxY, Math.min(maxY, drag.origY + dy)),
    });
  };

  const onBarPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (minimized && !drag.moved) setMinimized(false);
  };

  const useCompactInside = compactNav || mode === "dock";

  return (
    <aside
      className="settings-win"
      data-mode={mode}
      data-minimized={minimized || undefined}
      data-testid="settings-window"
      aria-label={t("settings.sections")}
      style={
        mode === "float" && !minimized && (offset.x !== 0 || offset.y !== 0)
          ? { transform: `translate3d(${Math.round(offset.x)}px, ${Math.round(offset.y)}px, 0)` }
          : undefined
      }
    >
      <div
        className="settings-win-bar"
        onPointerDown={onBarPointerDown}
        onPointerMove={onBarPointerMove}
        onPointerUp={onBarPointerUp}
        onPointerCancel={onBarPointerUp}
        onDoubleClick={() => setOffset({ x: 0, y: 0 })}
      >
        <div className="settings-win-title">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="9" cy="7" r="1" />
            <circle cx="15" cy="7" r="1" />
            <circle cx="9" cy="12" r="1" />
            <circle cx="15" cy="12" r="1" />
            <circle cx="9" cy="17" r="1" />
            <circle cx="15" cy="17" r="1" />
          </svg>
          <span>
            {minimized
              ? isZh
                ? "设置 · 已收起（点击展开）"
                : "Settings · Folded"
              : mode === "dock"
                ? isZh
                  ? "设置窗口（右侧并排 · 可边看会话边调设置）"
                  : "Settings (Side-by-side parallel view)"
                : isZh
                  ? "设置窗口（浮动模式 · 可拖拽）"
                  : "Settings Window (Floating · Draggable)"}
          </span>
        </div>

        <div className="settings-win-actions">
          <button
            type="button"
            className="settings-win-btn"
            onClick={() => setMinimized((v) => !v)}
            title={minimized ? (isZh ? "展开设置窗口" : "Expand") : isZh ? "收起为角落迷你条" : "Minimize"}
            data-testid="settings-win-minimize"
          >
            <span>{minimized ? (isZh ? "展开" : "Expand") : isZh ? "收起" : "Fold"}</span>
          </button>
          {!minimized && (
            <>
              <button
                type="button"
                className="settings-win-btn"
                onClick={toggleMode}
                title={
                  mode === "dock"
                    ? isZh
                      ? "切换为居中可拖拽浮动窗口"
                      : "Switch to floating window"
                    : isZh
                      ? "切换为右侧并排分屏"
                      : "Dock side-by-side"
                }
                data-testid="settings-win-mode"
              >
                <span>{mode === "dock" ? (isZh ? "浮动窗口" : "Float") : isZh ? "右侧并排" : "Dock"}</span>
              </button>
              <button
                type="button"
                className="settings-win-btn"
                onClick={popOutNativeWindow}
                title={isZh ? "打开为独立的操作系统窗口" : "Open in a separate OS window"}
                data-testid="settings-win-popout"
              >
                <External size={12} />
                <span>{isZh ? "独立新窗口" : "New Window"}</span>
              </button>
            </>
          )}
          <button
            type="button"
            className="settings-win-btn settings-win-close"
            onClick={() => showView("conversation")}
            title={isZh ? "关闭设置 (Esc)" : "Close settings (Esc)"}
            aria-label={isZh ? "关闭设置" : "Close settings"}
            data-testid="settings-win-close"
          >
            <Close size={13} />
          </button>
        </div>
      </div>

      {!minimized && (
        <div className="settings-win-body">
          {!compactNav && (
            <div className="settings-win-nav">
              <SettingsNav />
            </div>
          )}
          <div className="settings-win-content">
            <SettingsView compactNav={useCompactInside && compactNav} />
          </div>
        </div>
      )}
    </aside>
  );
}

/** 独立操作系统窗口模式下的设置根视图（通过 `?window=settings` 启动）。 */
export function StandaloneSettingsWindowRoot() {
  const locale = useLocale();
  const isZh = locale === "zh-CN";

  useEffect(() => {
    const initial = initialStandaloneSection();
    if (initial !== null) {
      setSettingsPage(initial);
    }
    const onSection = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === "string" && (VALID_SETTINGS_PAGES as readonly string[]).includes(detail)) {
        setSettingsPage(detail as SettingsPage);
      }
    };
    window.addEventListener("studio:settings-section", onSection);
    return () => window.removeEventListener("studio:settings-section", onSection);
  }, []);

  return (
    <div className="settings-standalone-root" data-testid="settings-standalone">
      <header className="settings-standalone-topbar">
        <span className="settings-standalone-brand">{isZh ? "pi-studio · 设置" : "pi-studio · Settings"}</span>
      </header>
      <div className="settings-standalone-body">
        <div className="settings-win-nav">
          <SettingsNav />
        </div>
        <div className="settings-win-content">
          <SettingsView compactNav={false} />
        </div>
      </div>
    </div>
  );
}
