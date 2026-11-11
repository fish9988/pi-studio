// Pi 工具与沙箱页（tools）：内置工具矩阵（defaultTools）、CodeMode 沙箱与内联预算、图像输入处理。
import { useMemo, type ReactNode } from "react";
import { PI_BUILTIN_TOOLS, type PiBuiltinToolId } from "../../../../../shared/pi-config-types.ts";
import { Code, Eye, FileIcon, Folder, Pencil, Search, Sparkle, Terminal } from "../../../icons.tsx";
import { Button, Row, SectionHead, Segmented, Switch, type Option } from "../../../ui/controls.tsx";
import { asBoolean, asNumber, asStringArray, PiNumberCommitField, usePiSetting, usePiText } from "./pi-shared.tsx";

type CodeModeSetting = "on" | "only";

const DEFAULT_ACTIVE_TOOLS: readonly PiBuiltinToolId[] = ["read", "bash", "edit", "write"];

const asCodeMode = (raw: unknown, fallback: CodeModeSetting): CodeModeSetting =>
  raw === "on" || raw === "only" ? raw : fallback;

function resolveActiveToolSet(rawList: readonly string[], modified: boolean): Set<PiBuiltinToolId> {
  if (!modified || rawList.length === 0) return new Set(DEFAULT_ACTIVE_TOOLS);
  const allModifiers = rawList.every((token) => token.startsWith("+") || token.startsWith("-"));
  const set = new Set<PiBuiltinToolId>(allModifiers ? DEFAULT_ACTIVE_TOOLS : []);
  const known = new Set<string>(PI_BUILTIN_TOOLS);
  for (const entry of rawList) {
    if (entry.startsWith("+")) {
      const id = entry.slice(1);
      if (known.has(id)) set.add(id as PiBuiltinToolId);
    } else if (entry.startsWith("-")) {
      const id = entry.slice(1);
      if (known.has(id)) set.delete(id as PiBuiltinToolId);
    } else if (known.has(entry)) {
      set.add(entry as PiBuiltinToolId);
    }
  }
  return set;
}

interface ToolMeta {
  id: PiBuiltinToolId;
  icon: ReactNode;
  zh: string;
  en: string;
}

const TOOL_CATALOG: readonly ToolMeta[] = [
  { id: "read", icon: <Eye size={14} />, zh: "读取文件与图片内容", en: "Read file & image contents" },
  { id: "bash", icon: <Terminal size={14} />, zh: "执行 Bash 命令", en: "Execute Bash commands" },
  { id: "powershell", icon: <Terminal size={14} />, zh: "原生 PowerShell 执行", en: "Run PowerShell commands" },
  { id: "edit", icon: <Pencil size={14} />, zh: "精确差异替换编辑", en: "Exact diff file edits" },
  { id: "write", icon: <FileIcon size={14} />, zh: "创建或覆盖写入文件", en: "Create or overwrite files" },
  { id: "grep", icon: <Search size={14} />, zh: "正则全文搜索", en: "Regex content search" },
  { id: "find", icon: <Folder size={14} />, zh: "按文件名匹配查找", en: "Find files by glob/path" },
  { id: "ls", icon: <Folder size={14} />, zh: "列出目录内容", en: "List directory entries" },
  { id: "codemode", icon: <Code size={14} />, zh: "JS 沙箱批量编排工具", en: "JS sandbox tool orchestration" },
  { id: "tool_search", icon: <Sparkle size={14} />, zh: "延迟工具按需检索", en: "On-demand deferred tool lookup" },
];

export function PiToolsSection() {
  const { tr } = usePiText();
  const defaultTools = usePiSetting("defaultTools", [] as string[], asStringArray);
  const codeMode = usePiSetting<CodeModeSetting>("codemode.mode", "on", asCodeMode);
  const inlineBudget = usePiSetting("codemode.inlineBudget", 3000, asNumber);
  const autoResize = usePiSetting("images.autoResize", true, asBoolean);
  const blockImages = usePiSetting("images.blockImages", false, asBoolean);

  const activeSet = useMemo(
    () => resolveActiveToolSet(defaultTools.value, defaultTools.modified),
    [defaultTools.value, defaultTools.modified],
  );

  const toggleTool = (toolId: PiBuiltinToolId, enabled: boolean) => {
    const next = new Set(activeSet);
    if (enabled) next.add(toolId);
    else next.delete(toolId);
    const ordered = PI_BUILTIN_TOOLS.filter((id) => next.has(id));
    void defaultTools.save(ordered);
  };

  const codeModeOptions: readonly Option<CodeModeSetting>[] = [
    { value: "on", label: tr("常规混合 (on)", "Hybrid (on)") },
    { value: "only", label: tr("仅通过 CodeMode 编排 (only)", "CodeMode only (only)") },
  ];

  return (
    <div className="pis-stack" data-testid="pi-tools-section">
      {/* 1. 内置工具矩阵 */}
      <section className="pis-group">
        <SectionHead
          title={tr("内置工具矩阵 (defaultTools)", "Built-in tools (defaultTools)")}
          count={`${activeSet.size}/${PI_BUILTIN_TOOLS.length}`}
          actions={
            defaultTools.modified ? (
              <Button size="sm" onClick={() => void defaultTools.reset()} testId="pi-tools-reset">
                {tr("恢复默认", "Reset")}
              </Button>
            ) : undefined
          }
        />
        <div className="pis-tool-grid" data-testid="pi-tools-grid">
          {TOOL_CATALOG.map((tool) => {
            const enabled = activeSet.has(tool.id);
            return (
              <div
                key={tool.id}
                className="pis-tool-card"
                data-enabled={enabled || undefined}
                data-testid={`pi-tool-${tool.id}`}
              >
                <div className="pis-tool-lead">
                  <span className="pis-tool-icon" aria-hidden="true">
                    {tool.icon}
                  </span>
                  <div className="pis-tool-meta">
                    <span className="pis-tool-id">{tool.id}</span>
                    <span className="pis-tool-desc">{tr(tool.zh, tool.en)}</span>
                  </div>
                </div>
                <Switch
                  checked={enabled}
                  label={tool.id}
                  onChange={(next) => toggleTool(tool.id, next)}
                  testId={`pi-tool-switch-${tool.id}`}
                />
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. CodeMode 沙箱与内联预算 */}
      <section className="pis-group">
        <SectionHead title={tr("CodeMode 沙箱与内联预算", "CodeMode sandbox & inline budget")} />
        <div className="pis-card pis-card-rows">
          <Row
            label={tr("工具编排模式 (codemode.mode)", "CodeMode orchestration")}
            modified={codeMode.modified}
            reset={{ tip: "on", onReset: () => void codeMode.reset() }}
            testId="pi-codemode-mode-row"
          >
            {(labelId) => (
              <Segmented
                size="sm"
                value={codeMode.value}
                options={codeModeOptions}
                labelledBy={labelId}
                onChange={(next) => void codeMode.save(next)}
                testId="pi-codemode-mode"
              />
            )}
          </Row>
          <Row
            label={tr("内联输出预算 (codemode.inlineBudget)", "Inline output budget")}
            modified={inlineBudget.modified}
            reset={{ tip: "3000 tok", onReset: () => void inlineBudget.reset() }}
            testId="pi-codemode-budget-row"
          >
            {(labelId) => (
              <PiNumberCommitField
                value={inlineBudget.value}
                min={256}
                max={200000}
                unit="tok"
                labelledBy={labelId}
                onCommit={(next) => void inlineBudget.save(next)}
                testId="pi-codemode-budget"
              />
            )}
          </Row>
        </div>
      </section>

      {/* 3. 图像输入处理 */}
      <section className="pis-group">
        <SectionHead title={tr("图像输入处理", "Image input handling")} />
        <div className="pis-card pis-card-rows">
          <Row
            label={tr("自动缩放至 2000×2000 (images.autoResize)", "Auto-resize to 2000×2000")}
            modified={autoResize.modified}
            reset={{ tip: "true", onReset: () => void autoResize.reset() }}
            testId="pi-images-resize-row"
          >
            {(labelId) => (
              <Switch
                checked={autoResize.value}
                labelledBy={labelId}
                onChange={(next) => void autoResize.save(next)}
                testId="pi-images-resize"
              />
            )}
          </Row>
          <Row
            label={tr("阻断图片发送 (images.blockImages)", "Block image inputs")}
            modified={blockImages.modified}
            reset={{ tip: "false", onReset: () => void blockImages.reset() }}
            testId="pi-images-block-row"
          >
            {(labelId) => (
              <Switch
                checked={blockImages.value}
                labelledBy={labelId}
                onChange={(next) => void blockImages.save(next)}
                testId="pi-images-block"
              />
            )}
          </Row>
        </div>
      </section>
    </div>
  );
}
