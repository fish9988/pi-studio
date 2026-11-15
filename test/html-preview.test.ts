import { describe, expect, it } from "vitest";
import { injectHtmlPreviewShim } from "../src/renderer/src/features/file-preview/html-preview.ts";

describe("injectHtmlPreviewShim", () => {
  it("在 <head> 后注入沙箱兼容垫片并保留原始文档结构", () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>Demo</title></head><body>Hi</body></html>';
    const out = injectHtmlPreviewShim(html);
    expect(out.startsWith("<!doctype html><html><head><script>")).toBe(true);
    expect(out).toContain("localStorage");
    expect(out).toContain("replaceState");
    expect(out).toContain('<meta charset="utf-8"><title>Demo</title></head><body>Hi</body></html>');
  });

  it("缺少 <head> 时回退到 <html> 后或文档开头", () => {
    expect(injectHtmlPreviewShim("<html><body>Hi</body></html>")).toMatch(/^<html><script>/);
    expect(injectHtmlPreviewShim("<div>Fragment</div>")).toMatch(/^<script>.*<div>Fragment<\/div>$/);
  });
});
