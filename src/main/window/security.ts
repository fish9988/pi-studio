// 会话级安全：权限只放行应用自己页面（主框架）的“写剪贴板”，其余一律拒绝；禁用手动页面缩放（spec §5.1：缩放只走设置 → 通用 → 字号）。
// CSP 在 index.html 的 <meta>（构建时注入，见 electron.vite.config.ts）：file:// 页面没有响应头可改。
import { session, type WebContents } from "electron";

/**
 * 放行的权限（仅限主框架自己的应用页面）：
 *  - clipboard-sanitized-write：navigator.clipboard.writeText（复制按钮、选中即复制）；读剪贴板照旧拒绝。
 *  - local-fonts：window.queryLocalFonts()，用于在设置页检索并列出本机全部已安装字体。
 * 文件预览里的 HTML 沙箱 iframe 不算主框架，一律拒绝。
 */
const allowedPermissions = new Set(["clipboard-sanitized-write", "local-fonts"]);

export function installSessionSecurity(isAppUrl: (url: string) => boolean): void {
  const { defaultSession } = session;
  const allowed = (permission: string, url: string | undefined, isMainFrame: boolean) => {
    if (!allowedPermissions.has(permission) || !isMainFrame || url === undefined) return false;
    try {
      return isAppUrl(url);
    } catch {
      return false;
    }
  };
  defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) =>
    callback(allowed(permission, details.requestingUrl, details.isMainFrame)),
  );
  defaultSession.setPermissionCheckHandler((_webContents, permission, _origin, details) =>
    allowed(permission, details.requestingUrl, details.isMainFrame),
  );
  defaultSession.setDevicePermissionHandler(() => false);
}

/** 拦下 Chromium 默认的缩放快捷键和捏合缩放：页面缩放只由设置里的字号决定（window/main-window.ts 的 applyFontSize）。 */
export function blockZoom(webContents: WebContents): void {
  void webContents.setVisualZoomLevelLimits(1, 1);
  webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control || input.alt) return;
    if (["+", "-", "=", "0", "_"].includes(input.key)) event.preventDefault();
  });
}
