import { describe, expect, it } from "vitest";
import { extractHtmlArtifactTitle, isHtmlArtifactCodeBlock } from "../src/renderer/src/markdown/artifact-meta.ts";

describe("CodeBlock HTML Artifact 卡片元数据与判定", () => {
  it("仅对非独立预览态且已闭合的 html / htm 围栏块启用 Artifact 卡片", () => {
    expect(isHtmlArtifactCodeBlock({ lang: "html", closed: true, standalone: false })).toBe(true);
    expect(isHtmlArtifactCodeBlock({ lang: "HTML", closed: true, standalone: undefined })).toBe(true);
    expect(isHtmlArtifactCodeBlock({ lang: "htm", closed: true })).toBe(true);
    expect(isHtmlArtifactCodeBlock({ lang: "html", closed: false })).toBe(false);
    expect(isHtmlArtifactCodeBlock({ lang: "html", closed: true, standalone: true })).toBe(false);
    expect(isHtmlArtifactCodeBlock({ lang: "svg", closed: true })).toBe(false);
    expect(isHtmlArtifactCodeBlock({ lang: "tsx", closed: true })).toBe(false);
  });

  it("优先提取 <title>，其次 <h1>，否则回退到首条有意义的 HTML 行", () => {
    expect(
      extractHtmlArtifactTitle("<!DOCTYPE html><html><head><title>交互式  仪表盘</title></head><body></body></html>"),
    ).toBe("交互式 仪表盘");

    expect(
      extractHtmlArtifactTitle("<!doctype html>\n<html>\n<body>\n<h1>数据对比视图</h1>\n<p>内容</p>\n</body>\n</html>"),
    ).toBe("数据对比视图");

    expect(extractHtmlArtifactTitle('<!DOCTYPE html>\n<html>\n<body>\n<div class="card">Hello</div>')).toBe(
      '<div class="card">Hello</div>',
    );

    expect(extractHtmlArtifactTitle("   \n  ")).toBe("preview.html");
  });
});
