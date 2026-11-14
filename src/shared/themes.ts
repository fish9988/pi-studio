// 内置配色主题与独立深浅色模式（ColorMode × ThemeFamily → 具体 CSS [data-theme]）。
// 融合 Material 3 Expressive、Microsoft Fluent 2 与 Apple Liquid Glass 三大设计语言：
// - default（灵动紫晶）：Porcelain 浅瓷云母 / Cosmic 暗夜深空 + Indigo-Violet 渐变高光；
// - claude（Claude Code）：Anthropic 陶土珊瑚 #d97757，暖象牙白 / 深暖炭灰双模式；
// - mica（冰川云母）：Windows 11 Fluent 2 天青蓝；
// - aurora（极光翠雾）：Google Material 3 苍翠极光；
// - coral（液态珊瑚）：Apple Liquid Glass 珊瑚霓虹；
// - amber（钛金琥珀）：Pro Titanium 琥珀暖金；
// - obsidian（曜石深空）：Studio Graphite 极客钴灰；
// - sage（鼠尾草晨雾）：护眼森系，清晨草雾与翡翠微光；
// - dusk（暮紫黄昏）：twilight 薰衣草薄雾与紫罗兰玫瑰微光；
// - slate（海岸青灰）：coastal 海盐薄雾与青蓝微光。三族与前述六族凑成 3×3 画廊。

export const colorModeNames = ["system", "light", "dark"] as const;
export type ColorMode = (typeof colorModeNames)[number];

export function isColorMode(value: string): value is ColorMode {
  return (colorModeNames as readonly string[]).includes(value);
}

export const themeFamilyNames = [
  "default",
  "claude",
  "mica",
  "aurora",
  "sage",
  "slate",
  "dusk",
  "coral",
  "amber",
  "obsidian",
] as const;

export type ThemeFamily = (typeof themeFamilyNames)[number];

export function isThemeFamily(value: string): value is ThemeFamily {
  return (themeFamilyNames as readonly string[]).includes(value);
}

export const themeNames = [
  "light",
  "dark",
  "claude-light",
  "claude-dark",
  "mica-light",
  "mica-dark",
  "aurora-light",
  "aurora-dark",
  "coral-light",
  "coral-dark",
  "amber-light",
  "amber-dark",
  "obsidian-light",
  "obsidian-dark",
  "sage-light",
  "sage-dark",
  "slate-light",
  "slate-dark",
  "dusk-light",
  "dusk-dark",
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
  mica: { light: "mica-light", dark: "mica-dark" },
  aurora: { light: "aurora-light", dark: "aurora-dark" },
  coral: { light: "coral-light", dark: "coral-dark" },
  amber: { light: "amber-light", dark: "amber-dark" },
  obsidian: { light: "obsidian-light", dark: "obsidian-dark" },
  sage: { light: "sage-light", dark: "sage-dark" },
  slate: { light: "slate-light", dark: "slate-dark" },
  dusk: { light: "dusk-light", dark: "dusk-dark" },
} as const satisfies Record<ThemeFamily, { light: ThemeName; dark: ThemeName }>;

export const themes = {
  light: {
    dark: false,
    app: "#ffffff",
    sidebar: "#eef1fa",
    text: "#131629",
    scrim: "rgba(19, 22, 41, 0.34)",
    art: false,
  },
  dark: {
    dark: true,
    app: "#121727",
    sidebar: "#0b0f1b",
    text: "#f2f4fc",
    scrim: "rgba(5, 8, 18, 0.62)",
    art: false,
  },
  "claude-light": {
    dark: false,
    app: "#ffffff",
    sidebar: "#fafafa",
    text: "#161616",
    scrim: "rgba(22, 22, 22, 0.32)",
    art: true,
  },
  "claude-dark": {
    dark: true,
    app: "#191919",
    sidebar: "#1f1f1f",
    text: "#fdfdfd",
    scrim: "rgba(10, 10, 10, 0.64)",
    art: true,
  },
  "mica-light": {
    dark: false,
    app: "#ffffff",
    sidebar: "#ebf2fb",
    text: "#0f172a",
    scrim: "rgba(15, 23, 42, 0.34)",
    art: true,
  },
  "mica-dark": {
    dark: true,
    app: "#121b2b",
    sidebar: "#0a111d",
    text: "#f1f5f9",
    scrim: "rgba(4, 8, 16, 0.62)",
    art: true,
  },
  "aurora-light": {
    dark: false,
    app: "#ffffff",
    sidebar: "#e9f5f1",
    text: "#0f1f1c",
    scrim: "rgba(12, 28, 25, 0.34)",
    art: true,
  },
  "aurora-dark": {
    dark: true,
    app: "#10201e",
    sidebar: "#081413",
    text: "#ecf7f4",
    scrim: "rgba(4, 10, 9, 0.62)",
    art: true,
  },
  "coral-light": {
    dark: false,
    app: "#ffffff",
    sidebar: "#fbeff2",
    text: "#1e1218",
    scrim: "rgba(30, 14, 22, 0.34)",
    art: true,
  },
  "coral-dark": {
    dark: true,
    app: "#22121b",
    sidebar: "#170c12",
    text: "#fcf1f5",
    scrim: "rgba(10, 4, 8, 0.62)",
    art: true,
  },
  "amber-light": {
    dark: false,
    app: "#ffffff",
    sidebar: "#f5f1e8",
    text: "#1b1610",
    scrim: "rgba(27, 22, 16, 0.32)",
    art: true,
  },
  "amber-dark": {
    dark: true,
    app: "#1e1a13",
    sidebar: "#14110c",
    text: "#f8f4ec",
    scrim: "rgba(8, 7, 4, 0.62)",
    art: true,
  },
  "obsidian-light": {
    dark: false,
    app: "#ffffff",
    sidebar: "#eff1f5",
    text: "#111827",
    scrim: "rgba(17, 24, 39, 0.34)",
    art: false,
  },
  "obsidian-dark": {
    dark: true,
    app: "#13161e",
    sidebar: "#0b0d12",
    text: "#f3f4f6",
    scrim: "rgba(4, 5, 8, 0.62)",
    art: false,
  },
  "sage-light": {
    dark: false,
    app: "#ffffff",
    sidebar: "#eaf3ed",
    text: "#0f1f16",
    scrim: "rgba(15, 31, 22, 0.34)",
    art: true,
  },
  "sage-dark": {
    dark: true,
    app: "#111d17",
    sidebar: "#0a140f",
    text: "#edf7f1",
    scrim: "rgba(6, 12, 9, 0.62)",
    art: true,
  },
  "slate-light": {
    dark: false,
    app: "#ffffff",
    sidebar: "#ebf2f6",
    text: "#0f1b24",
    scrim: "rgba(15, 27, 36, 0.34)",
    art: true,
  },
  "slate-dark": {
    dark: true,
    app: "#111c24",
    sidebar: "#0a1319",
    text: "#edf5fa",
    scrim: "rgba(4, 8, 12, 0.62)",
    art: true,
  },
  "dusk-light": {
    dark: false,
    app: "#ffffff",
    sidebar: "#f2ecfa",
    text: "#191229",
    scrim: "rgba(25, 18, 41, 0.34)",
    art: true,
  },
  "dusk-dark": {
    dark: true,
    app: "#161126",
    sidebar: "#0e0a1a",
    text: "#f3efff",
    scrim: "rgba(8, 5, 16, 0.62)",
    art: true,
  },
} as const satisfies Record<ThemeName, ThemeSpec>;

export function isThemeName(value: string): value is ThemeName {
  return Object.hasOwn(themes, value);
}

/** 任意主题偏好（家族名、具体色板名或旧版主题名）归属的主题家族。 */
export function familyOfTheme(preference: string): ThemeFamily {
  if (preference === "system" || preference === "default" || preference === "light" || preference === "dark") {
    return "default";
  }
  if (isThemeFamily(preference)) return preference;
  if (preference.startsWith("claude-")) return "claude";
  if (preference.startsWith("mica-")) return "mica";
  if (preference.startsWith("aurora-")) return "aurora";
  if (preference.startsWith("coral-")) return "coral";
  if (preference.startsWith("amber-")) return "amber";
  if (preference.startsWith("obsidian-")) return "obsidian";
  if (preference.startsWith("sage-")) return "sage";
  if (preference.startsWith("slate-")) return "slate";
  if (preference.startsWith("dusk-")) return "dusk";
  // 兼容旧版配置迁移
  if (preference === "deepseek" || preference.startsWith("deepseek-") || preference.startsWith("whale-")) return "mica";
  if (preference === "openai" || preference.startsWith("openai-")) return "aurora";
  if (preference === "sakura" || preference.startsWith("sakura-") || preference === "night-sakura") return "coral";
  if (preference === "ink" || preference.startsWith("ink-")) return "obsidian";
  if (
    preference === "pi" ||
    preference.startsWith("pi-") ||
    preference === "gemini" ||
    preference.startsWith("gemini-")
  )
    return "default";
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
    if (colorMode === "system") return preference;
    return themeFamilies[familyOfTheme(preference)][dark ? "dark" : "light"];
  }
  return themeFamilies[familyOfTheme(preference)][dark ? "dark" : "light"];
}
