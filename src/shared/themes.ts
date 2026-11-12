// 内置配色主题与独立深浅色模式（ColorMode × ThemeFamily → 具体 CSS [data-theme]）。
// 外观模式（colorMode：跟随系统 / 浅色 / 深色）完全独立于主题风格（theme：默认 / Claude Code / Pi / DeepSeek / Gemini / OpenAI / 樱粉 / 水墨）；
// 每一套主题都同时提供完整的浅色（light）与深色（dark）色板，主进程用这里的登记同步 BrowserWindow 背景色与系统三键（titleBarOverlay）。

export const colorModeNames = ["system", "light", "dark"] as const;
export type ColorMode = (typeof colorModeNames)[number];

export function isColorMode(value: string): value is ColorMode {
  return (colorModeNames as readonly string[]).includes(value);
}

export const themeFamilyNames = ["default", "claude", "pi", "deepseek", "gemini", "openai", "sakura", "ink"] as const;

export type ThemeFamily = (typeof themeFamilyNames)[number];

export function isThemeFamily(value: string): value is ThemeFamily {
  return (themeFamilyNames as readonly string[]).includes(value);
}

export const themeNames = [
  "light",
  "dark",
  "claude-light",
  "claude-dark",
  "pi-light",
  "pi-dark",
  "deepseek-light",
  "deepseek-dark",
  "gemini-light",
  "gemini-dark",
  "openai-light",
  "openai-dark",
  "sakura",
  "sakura-dark",
  "ink",
  "ink-dark",
] as const;

export type ThemeName = (typeof themeNames)[number];

/** 用户设置里的主题偏好：支持选主题家族（随独立 colorMode 自动切深浅），也兼容显式传具体色板名或 "system"。 */
export type ThemePreference = "system" | ThemeFamily | ThemeName;

export interface ThemeSpec {
  dark: boolean;
  /** --bg-app（主区底色，6 位 hex）。 */
  app: `#${string}`;
  /** --bg-sidebar（6 位 hex）。 */
  sidebar: `#${string}`;
  /** --text（6 位 hex）。 */
  text: `#${string}`;
  /** --bg-scrim（`rgba(r, g, b, a)`，用于遮罩混合算系统三键底色）。 */
  scrim: `rgba(${string})`;
  /** 是否自带主区背景插图（`src/renderer/styles/themes/<name>.svg`）。 */
  art: boolean;
}

export const themeFamilies = {
  default: { light: "light", dark: "dark" },
  claude: { light: "claude-light", dark: "claude-dark" },
  pi: { light: "pi-light", dark: "pi-dark" },
  deepseek: { light: "deepseek-light", dark: "deepseek-dark" },
  gemini: { light: "gemini-light", dark: "gemini-dark" },
  openai: { light: "openai-light", dark: "openai-dark" },
  sakura: { light: "sakura", dark: "sakura-dark" },
  ink: { light: "ink", dark: "ink-dark" },
} as const satisfies Record<ThemeFamily, { light: ThemeName; dark: ThemeName }>;

export const themes = {
  light: {
    dark: false,
    app: "#faf9f5",
    sidebar: "#f3f1ea",
    text: "#1f1e1d",
    scrim: "rgba(20, 20, 19, 0.34)",
    art: false,
  },
  dark: {
    dark: true,
    app: "#21201e",
    sidebar: "#191918",
    text: "#f2f0ea",
    scrim: "rgba(10, 10, 9, 0.56)",
    art: false,
  },
  "claude-light": {
    dark: false,
    app: "#faf9f5",
    sidebar: "#f0eee6",
    text: "#141413",
    scrim: "rgba(20, 20, 19, 0.32)",
    art: false,
  },
  "claude-dark": {
    dark: true,
    app: "#1f1e1c",
    sidebar: "#171716",
    text: "#f5f3ed",
    scrim: "rgba(10, 10, 9, 0.56)",
    art: false,
  },
  "pi-light": {
    dark: false,
    app: "#fbfafe",
    sidebar: "#f2eff9",
    text: "#171326",
    scrim: "rgba(24, 17, 46, 0.36)",
    art: true,
  },
  "pi-dark": {
    dark: true,
    app: "#141219",
    sidebar: "#100e16",
    text: "#f0edf7",
    scrim: "rgba(5, 3, 10, 0.62)",
    art: true,
  },
  "deepseek-light": {
    dark: false,
    app: "#fafcfe",
    sidebar: "#edf2fb",
    text: "#101725",
    scrim: "rgba(10, 22, 44, 0.36)",
    art: true,
  },
  "deepseek-dark": {
    dark: true,
    app: "#0d151f",
    sidebar: "#0a1017",
    text: "#e9f2f9",
    scrim: "rgba(3, 8, 14, 0.62)",
    art: true,
  },
  "gemini-light": {
    dark: false,
    app: "#fbfbfe",
    sidebar: "#eef1fb",
    text: "#141824",
    scrim: "rgba(12, 18, 40, 0.36)",
    art: true,
  },
  "gemini-dark": {
    dark: true,
    app: "#131421",
    sidebar: "#0e0f19",
    text: "#e9ebf6",
    scrim: "rgba(4, 5, 12, 0.62)",
    art: true,
  },
  "openai-light": {
    dark: false,
    app: "#f9f9f7",
    sidebar: "#f1f2f0",
    text: "#16191a",
    scrim: "rgba(16, 19, 17, 0.34)",
    art: false,
  },
  "openai-dark": {
    dark: true,
    app: "#212121",
    sidebar: "#171717",
    text: "#ececea",
    scrim: "rgba(0, 0, 0, 0.62)",
    art: false,
  },
  sakura: {
    dark: false,
    app: "#fcfafb",
    sidebar: "#f3eff0",
    text: "#1e181b",
    scrim: "rgba(42, 20, 28, 0.32)",
    art: true,
  },
  "sakura-dark": {
    dark: true,
    app: "#1b1519",
    sidebar: "#141014",
    text: "#f4e9ef",
    scrim: "rgba(8, 4, 6, 0.62)",
    art: true,
  },
  ink: {
    dark: false,
    app: "#f7f3e9",
    sidebar: "#efeade",
    text: "#1c1a15",
    scrim: "rgba(24, 22, 18, 0.32)",
    art: true,
  },
  "ink-dark": {
    dark: true,
    app: "#191713",
    sidebar: "#131110",
    text: "#ece6d9",
    scrim: "rgba(6, 5, 4, 0.62)",
    art: true,
  },
} as const satisfies Record<ThemeName, ThemeSpec>;

export function isThemeName(value: string): value is ThemeName {
  return Object.hasOwn(themes, value);
}

/** 任意主题偏好（家族名、具体色板名或旧配置值）归属的主题家族。 */
export function familyOfTheme(preference: string): ThemeFamily {
  if (preference === "system" || preference === "default" || preference === "light" || preference === "dark") {
    return "default";
  }
  if (isThemeFamily(preference)) return preference;
  if (preference.startsWith("claude-")) return "claude";
  if (preference.startsWith("pi-")) return "pi";
  if (preference.startsWith("deepseek-") || preference.startsWith("whale-")) return "deepseek";
  if (preference.startsWith("gemini-")) return "gemini";
  if (preference.startsWith("openai-")) return "openai";
  if (preference.startsWith("sakura") || preference === "night-sakura") return "sakura";
  if (preference.startsWith("ink")) return "ink";
  return "default";
}

/**
 * 根据主题偏好 + 独立外观模式（colorMode）+ 系统深浅色解析出最终的 CSS [data-theme] 色板名。
 * 对未知字符串安全回退到基础深/浅色，杜绝热更新或跨版本配置引发的 undefined 白屏。
 */
export function resolveTheme(preference: string, systemDark: boolean, colorMode: ColorMode = "system"): ThemeName {
  const dark = colorMode === "dark" ? true : colorMode === "light" ? false : systemDark;
  if (preference === "system" || preference === "default") {
    return dark ? "dark" : "light";
  }
  if (isThemeFamily(preference)) {
    return themeFamilies[preference][dark ? "dark" : "light"];
  }
  if (isThemeName(preference)) {
    return preference;
  }
  return dark ? "dark" : "light";
}
