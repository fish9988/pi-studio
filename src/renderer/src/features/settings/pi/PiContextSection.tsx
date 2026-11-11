// Pi 上下文与指令文档页（context）：自动压缩开关 + 全局/项目指令文档编辑器（AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md）。
import { useCallback, useEffect, useState } from "react";
import { PI_SYSTEM_DOC_KINDS, type PiSystemDocKind } from "../../../../../shared/pi-config-types.ts";
import { Button, Row, SectionHead, Segmented, Switch, Textarea, type Option } from "../../../ui/controls.tsx";
import { reportError } from "../../../ui/errors.ts";
import { pushToast } from "../../dialogs/toast-store.ts";
import { piBridge } from "./pi-bridge.ts";
import { asBoolean, asNumber, PiScopeBar, usePiScopeState, usePiSetting, usePiText } from "./pi-shared.tsx";

export function PiContextSection() {
  const { tr, t } = usePiText();

  // 1. 自动压缩
  const compactionEnabled = usePiSetting("compaction.enabled", true, asBoolean);
  const reserveTokens = usePiSetting("compaction.reserveTokens", 16384, asNumber);
  const keepRecentTokens = usePiSetting("compaction.keepRecentTokens", 20000, asNumber);
  const hasCustomThresholds = reserveTokens.modified || keepRecentTokens.modified;

  const resetCustomThresholds = async () => {
    if (reserveTokens.modified) await reserveTokens.reset();
    if (keepRecentTokens.modified) await keepRecentTokens.reset();
  };

  // 2. 全局与项目指令文档 (AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md)
  const { scope, setScope, projects, projectId, setProjectId } = usePiScopeState();
  const [docKind, setDocKind] = useState<PiSystemDocKind>("AGENTS.md");
  const [savedContent, setSavedContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [docExists, setDocExists] = useState(false);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [savingDoc, setSavingDoc] = useState(false);

  const scopedProjectId = scope === "project" ? projectId : null;

  const loadDoc = useCallback(async () => {
    setLoadingDoc(true);
    try {
      const doc = await piBridge().getPiSystemDoc(scope, docKind, scopedProjectId);
      setSavedContent(doc.content);
      setDraftContent(doc.content);
      setDocExists(doc.exists);
    } catch (error) {
      reportError(t, error);
    } finally {
      setLoadingDoc(false);
    }
  }, [scope, docKind, scopedProjectId, t]);

  useEffect(() => {
    void loadDoc();
  }, [loadDoc]);

  const handleSaveDoc = async () => {
    setSavingDoc(true);
    try {
      await piBridge().savePiSystemDoc(scope, docKind, draftContent, scopedProjectId);
      setSavedContent(draftContent);
      setDocExists(true);
      pushToast({
        level: "info",
        message: tr(`已保存 ${docKind}`, `Saved ${docKind}`),
      });
    } catch (error) {
      reportError(t, error);
    } finally {
      setSavingDoc(false);
    }
  };

  const docKindOptions: readonly Option<PiSystemDocKind>[] = PI_SYSTEM_DOC_KINDS.map((kind) => ({
    value: kind,
    label: kind,
  }));

  const dirty = draftContent !== savedContent;

  return (
    <div className="pis-stack" data-testid="pi-context-section">
      {/* 1. 自动压缩 */}
      <section className="pis-group">
        <SectionHead
          title={tr("自动压缩", "Auto-compaction")}
          actions={
            hasCustomThresholds ? (
              <Button size="sm" onClick={() => void resetCustomThresholds()} testId="pi-compaction-thresholds-reset">
                {tr("恢复默认压缩阈值", "Reset custom thresholds")}
              </Button>
            ) : undefined
          }
        />
        <div className="pis-card pis-card-rows">
          <Row
            label={tr("启用自动压缩", "Enable auto-compaction")}
            modified={compactionEnabled.modified}
            reset={{ tip: "true", onReset: () => void compactionEnabled.reset() }}
            testId="pi-compaction-enabled-row"
          >
            {(labelId) => (
              <Switch
                checked={compactionEnabled.value}
                labelledBy={labelId}
                onChange={(next) => void compactionEnabled.save(next)}
                testId="pi-compaction-enabled"
              />
            )}
          </Row>
        </div>
      </section>

      {/* 2. 全局与项目指令文档 */}
      <section className="pis-group">
        <SectionHead
          title={tr("全局与项目指令文档", "Global & project instruction files")}
          note={tr(
            "AGENTS.md 注入仓库规则 · SYSTEM.md 替换默认系统提示词 · APPEND_SYSTEM.md 追加系统提示词。",
            "AGENTS.md: workspace rules · SYSTEM.md: replace system prompt · APPEND_SYSTEM.md: append system prompt.",
          )}
        />
        <div className="pis-card-padded">
          <div className="pis-doc-toolbar">
            <Segmented
              size="sm"
              mono
              value={docKind}
              options={docKindOptions}
              label={tr("文档类型", "Document kind")}
              onChange={(next) => setDocKind(next)}
              testId="pi-doc-kind"
            />
            <PiScopeBar
              scope={scope}
              onScopeChange={setScope}
              projects={projects}
              projectId={projectId}
              onProjectChange={setProjectId}
              testId="pi-doc-scope"
            />
          </div>

          <Textarea
            mono
            className="pis-doc-textarea"
            disabled={loadingDoc}
            value={draftContent}
            onChange={setDraftContent}
            placeholder={tr(`在此编写 ${docKind} Markdown 指令…`, `Write ${docKind} Markdown instructions here…`)}
            aria-label={docKind}
            testId="pi-doc-editor"
          />

          <div className="pis-doc-foot">
            <span className="pis-muted">
              {loadingDoc
                ? tr("正在读取…", "Loading…")
                : dirty
                  ? tr("有未保存的改动", "Unsaved changes")
                  : docExists
                    ? tr("已与磁盘同步", "Synced with disk")
                    : tr("文件尚未创建（点击保存自动创建）", "File not created yet (Save to create)")}
            </span>
            <div className="pis-inline-end">
              {dirty && (
                <Button size="sm" onClick={() => setDraftContent(savedContent)} testId="pi-doc-discard">
                  {tr("还原", "Revert")}
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                loading={savingDoc}
                disabled={loadingDoc || (!dirty && docExists)}
                onClick={() => void handleSaveDoc()}
                testId="pi-doc-save"
              >
                {tr("保存", "Save")}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
