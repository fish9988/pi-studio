// 设置和应用信息：getSettings / getAppInfo 的结果，加上 settings 事件。
// 兼容开发态热更新（主进程尚未重启、settings.colorMode 尚为 undefined 时）：用本地缓存兜底保存新主题与独立深浅色模式，不弹报错气泡；
// 主进程重启就绪后（settings.colorMode 已定义）自动完全以主进程为准。
import type { AppInfo, ColorMode, Locale, StudioSettings, ThemePreference } from "../../../shared/ipc.ts";
import { familyOfTheme, isColorMode, isThemeFamily, isThemeName } from "../../../shared/themes.ts";
import { createStore, useStoreValue } from "./create-store.ts";

interface SettingsState {
  settings: StudioSettings | null;
  appInfo: AppInfo | null;
  error: string | null;
}

const APPEARANCE_FALLBACK_KEY = "pi-studio:appearance-fallback";

interface LocalAppearanceFallback {
  theme?: ThemePreference;
  colorMode?: ColorMode;
}

function readLocalFallback(): LocalAppearanceFallback {
  try {
    const raw = window.localStorage.getItem(APPEARANCE_FALLBACK_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: LocalAppearanceFallback = {};
    if (
      typeof parsed["theme"] === "string" &&
      (parsed["theme"] === "system" || isThemeFamily(parsed["theme"]) || isThemeName(parsed["theme"]))
    ) {
      out.theme = parsed["theme"];
    }
    if (typeof parsed["colorMode"] === "string" && isColorMode(parsed["colorMode"])) {
      out.colorMode = parsed["colorMode"];
    }
    return out;
  } catch {
    return {};
  }
}

function writeLocalFallback(patch: LocalAppearanceFallback): void {
  try {
    const next = { ...readLocalFallback(), ...patch };
    window.localStorage.setItem(APPEARANCE_FALLBACK_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
}

function clearLocalFallback(): void {
  try {
    window.localStorage.removeItem(APPEARANCE_FALLBACK_KEY);
  } catch {
    // ignore
  }
}

function mergeIncomingSettings(incoming: StudioSettings): StudioSettings {
  // 新版主进程始终返回 colorMode；若 colorMode 为 undefined 说明当前窗口连的是尚未重启的旧主进程，合并本地外观覆盖。
  if (incoming.colorMode !== undefined) {
    clearLocalFallback();
    return incoming;
  }
  const local = readLocalFallback();
  return {
    ...incoming,
    theme: local.theme ?? incoming.theme,
    colorMode: local.colorMode ?? "system",
  };
}

const settingsStore = createStore<SettingsState>({ settings: null, appInfo: null, error: null });

function reportError(what: string, error: unknown): void {
  console.error(`${what} 失败`, error);
  settingsStore.set({ ...settingsStore.get(), error: error instanceof Error ? error.message : String(error) });
}

function loadAppInfo(): void {
  window.studio.getAppInfo().then(
    (appInfo) => settingsStore.set({ ...settingsStore.get(), appInfo }),
    (error: unknown) => reportError("getAppInfo", error),
  );
}

export function startSettingsStore(): void {
  window.studio.onSettings((settings) => {
    settingsStore.set({ ...settingsStore.get(), settings: mergeIncomingSettings(settings) });
    loadAppInfo();
  });
  window.studio.getSettings().then(
    (settings) => settingsStore.set({ ...settingsStore.get(), settings: mergeIncomingSettings(settings) }),
    (error: unknown) => reportError("getSettings", error),
  );
  loadAppInfo();
}

/** 切换主题风格（兼容主进程未重启时的本地即时生效，不弹 IPC 校验报错）。 */
export async function setAppearanceTheme(theme: ThemePreference): Promise<void> {
  const cur = settingsStore.get();
  writeLocalFallback({ theme });
  if (cur.settings !== null) {
    settingsStore.set({ ...cur, settings: { ...cur.settings, theme } });
  }
  try {
    await window.studio.setTheme(theme);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("不是已知的主题")) {
      return;
    }
    throw error;
  }
}

/** 切换独立深浅色模式（兼容 preload / 主进程尚未重启时的即时切换）。 */
export async function setAppearanceColorMode(colorMode: ColorMode): Promise<void> {
  const cur = settingsStore.get();
  const normalizedTheme = cur.settings !== null ? familyOfTheme(cur.settings.theme) : "default";
  writeLocalFallback({ colorMode, theme: normalizedTheme });
  if (cur.settings !== null) {
    settingsStore.set({
      ...cur,
      settings: { ...cur.settings, colorMode, theme: normalizedTheme },
    });
  }
  const api = window.studio as unknown as { setColorMode?: (mode: ColorMode) => Promise<void> };
  if (typeof api.setColorMode === "function") {
    try {
      await api.setColorMode(colorMode);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes("No handler registered") && !msg.includes("不是已知的")) {
        throw error;
      }
    }
  }
  // 旧主进程未重启时：借用旧版已有的主题通道同步 Electron nativeTheme 的深浅状态
  const legacySync: ThemePreference = colorMode === "dark" ? "dark" : colorMode === "light" ? "light" : "system";
  await window.studio.setTheme(legacySync as ThemePreference).catch(() => {});
  const after = settingsStore.get();
  if (after.settings !== null) {
    settingsStore.set({
      ...after,
      settings: { ...after.settings, colorMode, theme: normalizedTheme },
    });
  }
}

/** 当前界面语言（非 React 代码用；还没载入时按中文）。 */
export function currentLocale(): Locale {
  return settingsStore.get().appInfo?.locale ?? "zh-CN";
}

export function useSettings(): StudioSettings | null {
  return useStoreValue(settingsStore, (state) => state.settings);
}

/** 设置读到了，或者读失败了（失败时界面要显示出错，不能一直等）。 */
export function useSettingsSettled(): boolean {
  return useStoreValue(settingsStore, (state) => state.settings !== null || state.error !== null);
}

export function useAppInfo(): AppInfo | null {
  return useStoreValue(settingsStore, (state) => state.appInfo);
}

/** 当前平台（非 React 代码用；还没载入时按 win32，与 TerminalPanel 一致）。 */
export function currentPlatform(): AppInfo["platform"] {
  return settingsStore.get().appInfo?.platform ?? "win32";
}
