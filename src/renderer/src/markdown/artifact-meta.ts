// 从 HTML 围栏代码提取 Artifact 卡片展示标题与判定逻辑（纯函数，便于单测）。

/** 从闭合的 HTML 代码中提取简洁标题：优先 `<title>`，其次首个 `<h1>`，最后回退到首个有效内容行。 */
export function extractHtmlArtifactTitle(code: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(code);
  if (titleMatch?.[1]) {
    const clean = titleMatch[1].replace(/\s+/g, " ").trim();
    if (clean !== "") return clean.length > 64 ? `${clean.slice(0, 63)}…` : clean;
  }
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(code);
  if (h1Match?.[1]) {
    const clean = h1Match[1]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (clean !== "") return clean.length > 64 ? `${clean.slice(0, 63)}…` : clean;
  }
  const lines = code.split(/\r?\n/);
  const meaningful = lines
    .map((line) => line.trim())
    .find(
      (line) =>
        line !== "" &&
        !/^<!doctype\b/i.test(line) &&
        !/^<\/?(?:html|head|body|meta|link|script|style)\b/i.test(line) &&
        !line.startsWith("<!--"),
    );
  const candidate = meaningful ?? lines.find((line) => line.trim() !== "")?.trim() ?? "";
  if (candidate === "") return "preview.html";
  return candidate.length > 64 ? `${candidate.slice(0, 63)}…` : candidate;
}

/** 非独立预览态且已闭合的 html / htm 围栏块默认渲染为紧凑型 Artifact 卡片。 */
export function isHtmlArtifactCodeBlock(opts: {
  lang: string;
  closed: boolean;
  standalone?: boolean | undefined;
}): boolean {
  if (opts.standalone || !opts.closed) return false;
  const kind = opts.lang.trim().toLowerCase();
  return kind === "html" || kind === "htm";
}
