// 应用和设置：读写走 settings-store（userData/settings.json）；外壳状态走 window-state。
import { app, clipboard, ClipboardItem, nativeImage, shell } from "electron";
import path from "node:path";
import {
  brandStyles,
  conversationViews,
  editCommands,
  fontStyles,
  helperThinkingLevels,
  historyOrders,
  limits,
  mascotCharacters,
  preferredShells,
  processRowsLayouts,
  titleBarFades,
  type AppInfo,
  type HandlerGroup,
  type ShellState,
} from "../../shared/ipc.ts";
import { emitEvent } from "./events.ts";
import { exportDiagnostics } from "../log/diagnostics.ts";
import { openLogsFolder } from "../log/instance.ts";
import { getSettings, resolveLocale, updateSettings } from "../settings/settings-store.ts";
import { chooseBackdropImage } from "../settings/backdrop-image.ts";
import { composerFilePath } from "../files/composer-files.ts";
import { getShellState, setShellState, sidebarWidthRange } from "../window/window-state.ts";
import {
  getMainWindow,
  glassSupported,
  openSettingsWindow,
  revealOnFirstFrame,
  setTitleBarDimmed,
  setTitleBarTheme,
} from "../window/main-window.ts";
import { chatsDir } from "../tasks/chats-dir.ts";
import { studioReleaseNotes, whatsNewForThisLaunch } from "../whats-new.ts";
import { syncPreferredShellToOmp } from "./omp-handlers.ts";
import { familyOfTheme } from "../../shared/themes.ts";
import {
  parseBackdropMode,
  parseBackdropStrength,
  parseBoolean,
  parseColorMode,
  parseDraftAttachmentsPayload,
  parseExternalUrl,
  parseFontSize,
  parseInteger,
  parseLocalePreference,
  parseOneOf,
  parseRecord,
  parseString,
  parseThemePreference,
} from "./validate.ts";

function platform(): AppInfo["platform"] {
  return process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux";
}

export const appHandlers: HandlerGroup<
  | "getAppInfo"
  | "getSettings"
  | "setLocale"
  | "setTheme"
  | "setColorMode"
  | "setBackdrop"
  | "setBackdropStrength"
  | "chooseBackdropImage"
  | "setGlass"
  | "setFontSize"
  | "openExternal"
  | "openLogsFolder"
  | "exportDiagnostics"
  | "getShellState"
  | "setShellState"
  | "setTitleBarDimmed"
  | "setTitleBarTheme"
  | "windowReady"
  | "editField"
  | "openSettingsWindow"
  | "copyDraftToClipboard"
> = {
  getAppInfo: async () => {
    const locale = resolveLocale();
    return {
      version: app.getVersion(),
      platform: platform(),
      locale,
      isPackaged: app.isPackaged,
      glassSupported,
      chatsDir: chatsDir(),
      whatsNew: whatsNewForThisLaunch(),
      releaseNotes: studioReleaseNotes(app.getVersion(), locale),
      runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    };
  },
  getSettings: async () => getSettings(),
  setLocale: async (value) => updateSettings({ locale: parseLocalePreference(value) }),
  setTheme: async (value) => updateSettings({ theme: parseThemePreference(value) }),
  setColorMode: async (value) => {
    const colorMode = parseColorMode(value);
    const currentTheme = getSettings().theme;
    updateSettings({ colorMode, theme: familyOfTheme(currentTheme) });
  },
  setBackdrop: async (value) => {
    const backdrop = parseBackdropMode(value);
    // custom 要先有图：渲染进程没选过图时走 chooseBackdropImage，那里复制好图再切过来。
    if (backdrop === "custom" && getSettings().customBackdrop === null)
      throw new Error("no custom backdrop chosen yet");
    updateSettings({ backdrop });
  },
  setBackdropStrength: async (value) => updateSettings({ backdropStrength: parseBackdropStrength(value) }),
  chooseBackdropImage: () => chooseBackdropImage(getMainWindow()),
  setGlass: async (value) => updateSettings({ glass: parseBoolean(value, "glass") }),
  setFontSize: async (value) => updateSettings({ fontSize: parseFontSize(value) }),
  openExternal: async (value) => shell.openExternal(parseExternalUrl(value)),
  openLogsFolder: () => openLogsFolder(),
  exportDiagnostics: () => exportDiagnostics(),
  getShellState: async () => getShellState(),
  setShellState: async (value) => {
    const record = parseRecord(value, "shellState");
    const patch: Partial<ShellState> = {
      ...(record["sidebarWidth"] !== undefined && {
        sidebarWidth: parseInteger(record["sidebarWidth"], "sidebarWidth", ...sidebarWidthRange),
      }),
      ...(record["sidebarCollapsed"] !== undefined && {
        sidebarCollapsed: parseBoolean(record["sidebarCollapsed"], "sidebarCollapsed"),
      }),
      ...(record["terminalHeight"] !== undefined && {
        terminalHeight: parseInteger(record["terminalHeight"], "terminalHeight", ...limits.terminalHeightRange),
      }),
      ...(record["historyOrder"] !== undefined && {
        historyOrder: parseOneOf(record["historyOrder"], "historyOrder", historyOrders),
      }),
      ...(record["chatWidth"] !== undefined && {
        chatWidth:
          record["chatWidth"] === 0 ? 0 : parseInteger(record["chatWidth"], "chatWidth", ...limits.chatWidthRange),
      }),
      ...(record["brandStyle"] !== undefined && {
        brandStyle: parseOneOf(record["brandStyle"], "brandStyle", brandStyles),
      }),
      ...(record["mascot"] !== undefined && {
        mascot: parseOneOf(record["mascot"], "mascot", mascotCharacters),
      }),
      ...(record["processRows"] !== undefined && {
        processRows: parseOneOf(record["processRows"], "processRows", processRowsLayouts),
      }),
      ...(record["helperModel"] !== undefined && {
        helperModel: parseString(record["helperModel"], "helperModel", 200),
      }),
      ...(record["helperThinking"] !== undefined && {
        helperThinking: parseOneOf(record["helperThinking"], "helperThinking", helperThinkingLevels),
      }),
      ...(record["autoSmartRename"] !== undefined && {
        autoSmartRename: parseBoolean(record["autoSmartRename"], "autoSmartRename"),
      }),
      ...(record["preferredShell"] !== undefined && {
        preferredShell: parseOneOf(record["preferredShell"], "preferredShell", preferredShells),
      }),
      ...(record["conversationView"] !== undefined && {
        conversationView: parseOneOf(record["conversationView"], "conversationView", conversationViews),
      }),
      ...(record["homeRipple"] !== undefined && {
        homeRipple: parseBoolean(record["homeRipple"], "homeRipple"),
      }),
      ...(record["uiFontStyle"] !== undefined && {
        uiFontStyle: parseOneOf(record["uiFontStyle"], "uiFontStyle", fontStyles),
      }),
      ...(record["uiFontFamily"] !== undefined && {
        uiFontFamily: parseString(record["uiFontFamily"], "uiFontFamily", 160, { allowEmpty: true }),
      }),
      ...(record["chatFontStyle"] !== undefined && {
        chatFontStyle: parseOneOf(record["chatFontStyle"], "chatFontStyle", fontStyles),
      }),
      ...(record["chatFontFamily"] !== undefined && {
        chatFontFamily: parseString(record["chatFontFamily"], "chatFontFamily", 160, { allowEmpty: true }),
      }),
    };
    setShellState(patch);
    // 外壳状态是双窗口共享的（设置可以开成独立窗口）：改完推一份给所有窗口，
    // 主窗口里的桌宠/过程行排布/侧栏宽度才会立刻跟着变，不用等重启。
    emitEvent("shellState", patch);
    if (record["preferredShell"] !== undefined) {
      const pref = parseOneOf(record["preferredShell"], "preferredShell", preferredShells);
      void syncPreferredShellToOmp(pref);
    }
  },
  setTitleBarDimmed: async (dimmed, fade) =>
    setTitleBarDimmed(parseBoolean(dimmed, "dimmed"), parseOneOf(fade, "fade", titleBarFades)),
  setTitleBarTheme: async (theme, crossfade) =>
    setTitleBarTheme(parseThemePreference(theme), parseBoolean(crossfade, "crossfade")),
  windowReady: async () => revealOnFirstFrame(),
  // 作用于主窗口里当前获得焦点的输入框，和系统编辑菜单的同名命令一样；粘贴由 Chromium 自己读剪贴板、发 paste 事件。
  editField: async (value) => {
    getMainWindow()?.webContents[parseOneOf(value, "command", editCommands)]();
  },
  openSettingsWindow: async (section) => {
    const parsedSection =
      section === undefined || section === null ? undefined : parseString(section, "section", 64, { allowEmpty: true });
    openSettingsWindow(parsedSection);
  },
  copyDraftToClipboard: async (value) => {
    const payload = parseDraftAttachmentsPayload(value);
    const images = payload.images ?? [];
    const fileIds = payload.fileIds ?? [];
    const resolvedPaths = fileIds.map((id) => composerFilePath(id));
    const fileNames = resolvedPaths.map((p, i) => (p ? path.basename(p) : `file-${i + 1}`));
    // 把 `\uE000file:N\uE001` 替换为可读的文件引用；图片占位符在 HTML 中转成 <img>，纯文本中保留清晰标注。
    const plainText = payload.text
      .replace(/\uE000file:([1-9]\d*)\uE001/g, (_, idxStr: string) => {
        const idx = Number(idxStr) - 1;
        const p = resolvedPaths[idx];
        return p ? `@${p}` : `@${fileNames[idx] ?? `file-${idx + 1}`}`;
      })
      .trim();
    const escapeHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const imageTag = (idx: number): string => {
      const img = images[idx];
      if (!img) return "";
      return `<img src="data:${img.mimeType};base64,${img.data}" alt="Image #${idx + 1}" />`;
    };
    const referencedImages = new Set<number>();
    const htmlBody = escapeHtml(
      payload.text.replace(/\uE000file:([1-9]\d*)\uE001/g, (_, idxStr: string) => {
        const idx = Number(idxStr) - 1;
        return `@${fileNames[idx] ?? `file-${idx + 1}`}`;
      }),
    )
      .replace(/\[Image #([1-9]\d*)(?:,[^\]\n]*)?\]/g, (_, numStr: string) => {
        const idx = Number(numStr) - 1;
        if (idx >= 0 && idx < images.length) {
          referencedImages.add(idx);
          return imageTag(idx);
        }
        return `[Image #${numStr}]`;
      })
      .replace(/\r?\n/g, "<br/>");
    const trailingImages = images
      .map((_, idx) => (referencedImages.has(idx) ? "" : imageTag(idx)))
      .filter((tag) => tag !== "")
      .join("");
    const html = `<div>${htmlBody}${trailingImages ? `<div>${trailingImages}</div>` : ""}</div>`;
    const textValue = plainText || images.map((_, i) => `[Image #${i + 1}]`).join(" ");
    if (images.length > 0) {
      const items: Record<string, string | Blob> = {
        "text/plain": textValue,
        "text/html": html,
      };
      if (images.length === 1) {
        const png = nativeImage.createFromBuffer(Buffer.from(images[0]!.data, "base64")).toPNG();
        items["image/png"] = new Blob([new Uint8Array(png)], { type: "image/png" });
      }
      await clipboard.write([new ClipboardItem(items)]);
    } else {
      await clipboard.writeText(plainText);
    }
  },
};
