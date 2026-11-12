// DSH 风格居中模态设置弹窗（默认弹出居中圆角对话框 `min(880px, 90vw) × min(640px, 85vh)`，带通透暗化与微毛玻璃遮罩，
// 支持 Esc 或点击遮罩关闭；右上角保留可选的「停靠至侧边」与「独立新窗口」按钮）。
import { useCallback, useEffect, useState } from "react";
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

export type SettingsWindowMode = "modal" | "dock";

const MODE_STORAGE_KEY = "pi-studio:settings-layout-mode";

function loadInitialMode(): SettingsWindowMode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === "dock" ? "dock" : "modal";
  } catch {
    return "modal";
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

  const toggleMode = useCallback(() => {
    setMode((prev) => {
      const next: SettingsWindowMode = prev === "modal" ? "dock" : "modal";
      try {
        window.localStorage.setItem(MODE_STORAGE_KEY, next);
      } catch {
        // ignore
      }
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

  useEffect(() => {
    if (mode !== "modal") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("[role='dialog'], [role='menu'], [role='listbox']")) {
        return;
      }
      if (active instanceof HTMLInputElement && active.type === "search" && active.value !== "") {
        return;
      }
      event.preventDefault();
      showView("conversation");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode]);

  const dialogContent = (
    <aside
      className="settings-win"
      data-mode={mode}
      data-testid="settings-window"
      role={mode === "modal" ? "dialog" : undefined}
      aria-modal={mode === "modal" ? true : undefined}
      aria-label={t("settings.sections")}
    >
      <div className="settings-win-bar">
        <div className="settings-win-title">
          <span>{isZh ? "设置" : "Settings"}</span>
        </div>

        <div className="settings-win-actions">
          <button
            type="button"
            className="settings-win-btn"
            onClick={toggleMode}
            title={
              mode === "modal"
                ? isZh
                  ? "停靠至右侧分栏（无遮罩观察界面变化）"
                  : "Dock to right side"
                : isZh
                  ? "恢复为居中模态对话框"
                  : "Center modal"
            }
            data-testid="settings-win-mode"
          >
            <span>{mode === "modal" ? (isZh ? "停靠至侧边" : "Dock") : isZh ? "居中弹窗" : "Modal"}</span>
          </button>
          <button
            type="button"
            className="settings-win-btn"
            onClick={popOutNativeWindow}
            title={isZh ? "打开为独立的操作系统窗口" : "Open in standalone window"}
            data-testid="settings-win-popout"
          >
            <External size={12} />
            <span>{isZh ? "独立窗口" : "Window"}</span>
          </button>
          <button
            type="button"
            className="settings-win-btn settings-win-close"
            onClick={() => showView("conversation")}
            title={isZh ? "关闭设置 (Esc)" : "Close settings (Esc)"}
            aria-label={isZh ? "关闭设置" : "Close settings"}
            data-testid="settings-win-close"
          >
            <Close size={14} />
          </button>
        </div>
      </div>

      <div className="settings-win-body">
        {!compactNav && (
          <div className="settings-win-nav">
            <SettingsNav />
          </div>
        )}
        <div className="settings-win-content">
          <SettingsView compactNav={compactNav} />
        </div>
      </div>
    </aside>
  );

  if (mode === "modal") {
    return (
      <div
        className="settings-modal-scrim"
        data-testid="settings-modal-scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            showView("conversation");
          }
        }}
      >
        {dialogContent}
      </div>
    );
  }

  return dialogContent;
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
