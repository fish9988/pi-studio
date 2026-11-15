import { describe, expect, it } from "vitest";
import {
  htmlPreviewMaxChars,
  htmlPreviewResponse,
  registerHtmlPreview,
  releaseHtmlPreview,
} from "../src/main/window/html-preview-store.ts";

describe("独立 HTML 预览文档", () => {
  it("UTF-8 文档与主应用分源，只有预览响应允许脚本且强制沙箱隔离", async () => {
    const html = "<!doctype html><title>中文绘图</title><script>draw()</script>";
    const url = registerHtmlPreview(html);
    try {
      expect(url).toMatch(/^app:\/\/preview\/[\da-f-]+$/);
      const response = htmlPreviewResponse(url);
      expect(await response.text()).toBe(html);
      expect(response.headers.get("Content-Type")).toContain("charset=utf-8");
      const csp = response.headers.get("Content-Security-Policy")!;
      expect(csp).toContain("sandbox allow-scripts;");
      expect(csp).not.toContain("allow-same-origin");
      expect(csp).not.toContain("allow-popups");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      releaseHtmlPreview(url);
    }
    expect(htmlPreviewResponse(url).status).toBe(404);
  });

  it("未知地址、路径穿越和非预览来源不能获取文档；hash 导航仍指向原文档", async () => {
    const url = registerHtmlPreview("diagram");
    try {
      expect(await htmlPreviewResponse(`${url}#tab2`).text()).toBe("diagram");
      expect(htmlPreviewResponse(url.replace("preview", "studio")).status).toBe(404);
      expect(htmlPreviewResponse("app://preview/../../package.json").status).toBe(404);
      expect(htmlPreviewResponse("app://preview/unknown").status).toBe(404);
    } finally {
      releaseHtmlPreview(url);
    }
  });

  it("拒绝过大的内容，限制未释放文档数量", () => {
    expect(() => registerHtmlPreview("x".repeat(htmlPreviewMaxChars + 1))).toThrow("too large");
    const urls = Array.from({ length: 33 }, () => registerHtmlPreview("test"));
    try {
      expect(htmlPreviewResponse(urls[0]!).status).toBe(404);
      expect(htmlPreviewResponse(urls.at(-1)!).status).toBe(200);
    } finally {
      urls.forEach(releaseHtmlPreview);
    }
  });
});
