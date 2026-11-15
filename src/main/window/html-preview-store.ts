// HTML 预览使用独立来源和响应 CSP，避免 srcdoc 继承应用的 script-src 限制。
// 文档只存在内存中；随机地址、数量上限和显式释放避免无限缓存，不提供磁盘读取能力。
import { randomUUID } from "node:crypto";

const documents = new Map<string, string>();
export const HTML_PREVIEW_ORIGIN = "app://preview";
const maxDocuments = 32;
// 文件读取上限为 2 MiB；为注入的沙箱兼容脚本预留 16 KiB。
export const htmlPreviewMaxChars = 2 * 1024 * 1024 + 16 * 1024;

export function registerHtmlPreview(html: string): string {
  if (html.length > htmlPreviewMaxChars) throw new Error("HTML preview is too large");
  const url = `${HTML_PREVIEW_ORIGIN}/${randomUUID()}`;
  documents.set(url, html);
  if (documents.size > maxDocuments) documents.delete(documents.keys().next().value!);
  return url;
}

export function releaseHtmlPreview(url: string): void {
  documents.delete(url);
}

export function htmlPreviewResponse(requestUrl: string): Response {
  const url = new URL(requestUrl);
  url.hash = "";
  const html = documents.get(url.href);
  if (html === undefined) return new Response("Preview expired", { status: 404 });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // 仅预览文档允许自身脚本；无同源权限、无表单/弹窗/顶层导航，不能读取 app://studio。
      "Content-Security-Policy": [
        "sandbox allow-scripts",
        "default-src 'none'",
        "script-src 'unsafe-inline' https: http: data: blob:",
        "style-src 'unsafe-inline' https: http: data:",
        "img-src https: http: data: blob:",
        "font-src https: http: data:",
        "media-src https: http: data: blob:",
        "connect-src https: http:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; "),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
