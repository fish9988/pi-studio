// 代码块（spec 4.10）：头部语言名 + 复制；围栏闭合后才高亮（只改颜色）；全文显示（omp 的 md 节点不限行数）。
// ```svg 和 ```mermaid 围栏闭合后画成图，头部多一个切回源码的按钮。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { draftKey } from "../../../shared/ipc.ts";
import { quoteToComposer } from "../features/composer/quote.ts";
import { openInlineArtifact } from "../features/file-preview/index.ts";
import { useT } from "../i18n/use-t.ts";
import { Check, Code, CopyIcon, External, Plus } from "../icons.tsx";
import { useSelectedTaskId } from "../store/index.ts";
import { currentLocale } from "../store/settings-store.ts";
import { onThemeChange } from "../ui/theme-change.ts";
import { useHighlighted } from "./highlight.ts";
import { resolveLanguage } from "./highlight-languages.ts";
import { tokenProps, type HighlightToken } from "./highlight-tokens.ts";
import { useMermaid } from "./mermaid.ts";
import { FIGURE_TOKENS, prepareMermaidSvg, prepareSvg, svgDataUrl } from "./svg-figure.ts";
function lineClass(line: string, isDiff: boolean): string {
  if (!isDiff) return "md-line";
  if (line.startsWith("+") && !line.startsWith("+++")) return "md-line md-diff-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "md-line md-diff-del";
  return "md-line";
}

/** 离底不到这么远就算"用户还在底部"（.md-codebody 的贴底跟随）。 */
const FOLLOW_DISTANCE = 24;

/** 一行代码的 token：没高亮（围栏没闭合 / 高亮还没回来 / 语言认不出）时也包成单个无色 token。
 *  围栏闭合、高亮结果到达时只是往同一批 span 里写新文字（React 做 commitTextUpdate），
 *  不会把整行的文本节点整排换成元素子节点——选区、行内偏移和这块内的滚动位置都保住。 */
function lineTokens(tokens: HighlightToken[][] | null, index: number, line: string): readonly HighlightToken[] {
  const hit = tokens?.[index];
  return hit !== undefined && hit.length > 0 ? hit : [{ text: line, italic: false, bold: false }];
}

interface CodeBlockProps {
  code: string;
  lang: string;
  closed: boolean;
  focusLine?: number | undefined;
  standalone?: boolean | undefined;
}

export const CodeBlock = memo(function CodeBlock({ code, lang, closed, focusLine, standalone }: CodeBlockProps) {
  const t = useT();
  const taskId = useSelectedTaskId();
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  /** 代码块自己的贴底跟随：用户手动上滑就放开，围栏闭合后也不再接管。 */
  const follow = useRef(true);
  // ```svg 围栏闭合后画成图（svg-figure.ts）；```mermaid 先在 worker 里画成 SVG（mermaid.ts），画好之前照常显示源码。
  // 头部的 <> 切回源码，画不出来时也退回源码。
  const kind = closed ? lang.toLowerCase() : "";
  const figure = kind === "svg" || kind === "mermaid";
  const previewableExt: "html" | "svg" | "md" | null =
    kind === "html" || kind === "htm"
      ? "html"
      : kind === "svg" || kind === "mermaid"
        ? "svg"
        : kind === "md" || kind === "markdown"
          ? "md"
          : null;
  const mermaid = useMermaid(kind === "mermaid" ? code : null);
  const [showSource, setShowSource] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const failed = imageFailed || (mermaid !== null && "error" in mermaid);
  const mermaidSvg = mermaid !== null && "svg" in mermaid ? mermaid.svg : null;
  const prepare = useCallback(
    (style: CSSStyleDeclaration) =>
      mermaidSvg === null
        ? prepareSvg(code, readPalette(style))
        : prepareMermaidSvg(mermaidSvg, { bg: token(style, "--bg-tool"), fg: token(style, "--text") }),
    [code, mermaidSvg],
  );
  const ready = figure && !failed && (kind === "svg" || mermaidSvg !== null);
  const drawing = ready && !showSource;
  const tokens = useHighlighted(code, closed && !drawing ? lang : null);
  const lines = code.split("\n");
  const isDiff = resolveLanguage(lang) === "diff";

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (focusLine === undefined || focusLine < 1 || drawing) return;
    const target = preRef.current?.querySelector<HTMLElement>("[data-focus-line]");
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusLine, code, drawing]);

  // .md-codebody 自己有 max-height + 滚动条：流式追加时贴着底走，用户一旦上滑就停。
  useEffect(() => {
    const el = preRef.current;
    if (el === null) return;
    const onScroll = () => {
      follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < FOLLOW_DISTANCE;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [drawing]);

  // 新内容到了：还在底部就贴到底。直接用 ref 设 scrollTop（不用 ResizeObserver，免得和自己的滚动互相触发）。
  // 围栏闭合（这一轮不再追加）后停止跟随，把这块的滚动控制权交还给用户。
  useEffect(() => {
    const el = preRef.current;
    if (el === null) return;
    if (closed) {
      follow.current = false;
      return;
    }
    if (!follow.current) return;
    el.scrollTop = el.scrollHeight;
  }, [code, closed]);

  const copy = () => {
    navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      (error: unknown) => console.error("复制失败", error),
    );
  };
  const quote = () => quoteToComposer(taskId, code, { lang });
  const zh = currentLocale() === "zh-CN";

  return (
    <div className="md-codeblock" data-anchor data-testid="codeblock" data-figure={drawing || undefined}>
      <div className="md-codehead">
        <span className="md-codelang">{lang === "" ? "text" : lang}</span>
        <span className="md-codeactions">
          {previewableExt !== null && (kind !== "mermaid" || mermaidSvg !== null) && (
            <button
              type="button"
              className="md-codebtn"
              aria-label={t("code.previewSidebar")}
              title={t("code.previewSidebar")}
              data-testid="codeblock-preview-sidebar"
              onClick={() => {
                const panelKey = taskId ?? draftKey(null);
                const content = kind === "mermaid" ? (mermaidSvg ?? code) : code;
                const name =
                  previewableExt === "html" ? "preview.html" : previewableExt === "svg" ? "figure.svg" : "document.md";
                openInlineArtifact(panelKey, {
                  id: `cb-${code.length}`,
                  name,
                  ext: previewableExt,
                  content,
                });
              }}
            >
              <External size={14} />
            </button>
          )}
          {ready && (
            <button
              type="button"
              className="md-codebtn"
              aria-pressed={showSource}
              aria-label={t("code.source")}
              title={t("code.source")}
              data-testid="codeblock-source"
              onClick={() => setShowSource((value) => !value)}
            >
              <Code size={14} />
            </button>
          )}
          <button
            type="button"
            className="md-codebtn"
            onClick={quote}
            aria-label={zh ? "引用到输入框" : "Quote to composer"}
            title={zh ? "引用到输入框" : "Quote to composer"}
            data-testid="codeblock-quote-composer"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="md-codebtn"
            onClick={copy}
            aria-label={t("code.copy")}
            title={t("code.copy")}
          >
            {copied ? <Check size={14} /> : <CopyIcon size={14} />}
          </button>
        </span>
        <span className="md-sr" aria-live="polite">
          {copied ? t("common.copied") : ""}
        </span>
      </div>
      {drawing ? (
        <FigureImage prepare={prepare} alt={t("code.figure")} onFail={() => setImageFailed(true)} />
      ) : (
        <>
          {failed && <p className="md-figure-note">{t("code.figureFailed")}</p>}
          <pre ref={preRef} className="md-codebody" style={standalone ? { maxHeight: "none" } : undefined}>
            <code>
              {lines.map((line, index) => (
                <span
                  key={index}
                  className={lineClass(line, isDiff)}
                  data-focus-line={focusLine === index + 1 ? "" : undefined}
                >
                  {lineTokens(tokens, index, line).map((token, i) => (
                    <span key={i} {...tokenProps(token)}>
                      {token.text}
                    </span>
                  ))}
                  {"\n"}
                </span>
              ))}
            </code>
          </pre>
        </>
      )}
    </div>
  );
});

function token(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

/** 当前主题下每个图色名的实际颜色（tokens.css）。 */
function readPalette(style: CSSStyleDeclaration): Record<string, string> {
  return Object.fromEntries(Object.entries(FIGURE_TOKENS).map(([name, value]) => [name, token(style, value)]));
}

/** 图本身：<img> 显示（不执行脚本、不加载外部资源）；切换主题时按新颜色重画。 */
function FigureImage({
  prepare,
  alt,
  onFail,
}: {
  prepare: (style: CSSStyleDeclaration) => string;
  alt: string;
  onFail: () => void;
}) {
  const [theme, setTheme] = useState(0);
  useEffect(() => onThemeChange(() => setTheme((value) => value + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const src = useMemo(() => svgDataUrl(prepare(getComputedStyle(document.documentElement))), [prepare, theme]);
  return (
    <div className="md-figure">
      <img src={src} alt={alt} data-testid="codeblock-figure" onError={onFail} />
    </div>
  );
}
