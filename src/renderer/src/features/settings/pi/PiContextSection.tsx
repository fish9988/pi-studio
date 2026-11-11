// Pi 上下文与指令文档页（context）：自动压缩与分支摘要参数 + 全局/项目指令文档编辑器（AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md）。
import { useCallback, useEffect, useState } from "react";
import { PI_SYSTEM_DOC_KINDS, type PiSystemDocKind } from "../../../../../shared/pi-config-types.ts";
import { Button, Row, SectionHead, Segmented, Switch, Textarea, type Option } from "../../../ui/controls.tsx";
import { reportError } from "../../../ui/errors.ts";
import { pushToast } from "../../dialogs/toast-store.ts";
import { piBridge } from "./pi-bridge.ts";
import {
  asBoolean,
  asNumber,
  PiNumberCommitField,
  PiScopeBar,
  usePiScopeState,
  usePiSetting,
  usePiText,
} from "./pi-shared.tsx";

type ShareDestination = "auto" | "gist" | "radius";

const asShareDest = (raw: unknown, fallback: ShareDestination): ShareDestination =>
  raw === "auto" || raw === "gist" || raw === "radius" ? raw : fallback;

export function PiContextSection() {
  const { tr, t } = usePiText();

  // 1. 自动压缩与分支摘要
  const compactionEnabled = usePiSetting("compaction.enabled", true, asBoolean);
  const reserveTokens = usePiSetting("compaction.reserveTokens", 16384, asNumber);
  const keepRecentTokens = usePiSetting("compaction.keepRecentTokens", 20000, asNumber);
  const branchReserveTokens = usePiSetting("branchSummary.reserveTokens", 16384, asNumber);
  const branchSkipPrompt = usePiSetting("branchSummary.skipPrompt", false, asBoolean);
  const shareDest = usePiSetting<ShareDestination>("sessionShareDestination", "auto", asShareDest);

  const shareOptions: readonly Option<ShareDestination>[] = [
    { value: "auto", label: "auto" },
    { value: "gist", label: "GitHub Gist" },
    { value: "radius", label: "Radius" },
  ];

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
      {/* 1. 自动压缩与分支摘要 */}
      <section className="pis-group">
        <SectionHead title={tr("自动压缩与分支摘要", "Auto-compaction & branch summaries")} />
        <div className="pis-card pis-card-rows">
          <Row
            label={tr("启用上下文自动压缩 (compaction.enabled)", "Enable auto-compaction")}
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

          <Row
            label={tr("压缩预留缓冲区 (compaction.reserveTokens)", "Compaction reserve tokens")}
            modified={reserveTokens.modified}
            reset={{ tip: "16384 tok", onReset: () => void reserveTokens.reset() }}
            testId="pi-compaction-reserve-row"
          >
            {(labelId) => (
              <PiNumberCommitField
                value={reserveTokens.value}
                min={1024}
                max={200000}
                unit="tok"
                labelledBy={labelId}
                onCommit={(next) => void reserveTokens.save(next)}
                testId="pi-compaction-reserve"
              />
            )}
          </Row>

          <Row
            label={tr("压缩保留最近上下文 (compaction.keepRecentTokens)", "Keep recent tokens")}
            modified={keepRecentTokens.modified}
            reset={{ tip: "20000 tok", onReset: () => void keepRecentTokens.reset() }}
            testId="pi-compaction-keep-row"
          >
            {(labelId) => (
              <PiNumberCommitField
                value={keepRecentTokens.value}
                min={1024}
                max={500000}
                unit="tok"
                labelledBy={labelId}
                onCommit={(next) => void keepRecentTokens.save(next)}
                testId="pi-compaction-keep"
              />
            )}
          </Row>

          <Row
            label={tr("分支摘要预留预算 (branchSummary.reserveTokens)", "Branch summary reserve tokens")}
            modified={branchReserveTokens.modified}
            reset={{ tip: "16384 tok", onReset: () => void branchReserveTokens.reset() }}
            testId="pi-branch-reserve-row"
          >
            {(labelId) => (
              <PiNumberCommitField
                value={branchReserveTokens.value}
                min={1024}
                max={200000}
                unit="tok"
                labelledBy={labelId}
                onCommit={(next) => void branchReserveTokens.save(next)}
                testId="pi-branch-reserve"
              />
            )}
          </Row>

          <Row
            label={tr("切分支跳过摘要确认弹窗 (branchSummary.skipPrompt)", "Skip branch summary prompt")}
            modified={branchSkipPrompt.modified}
            reset={{ tip: "false", onReset: () => void branchSkipPrompt.reset() }}
            testId="pi-branch-skip-row"
          >
            {(labelId) => (
              <Switch
                checked={branchSkipPrompt.value}
                labelledBy={labelId}
                onChange={(next) => void branchSkipPrompt.save(next)}
                testId="pi-branch-skip"
              />
            )}
          </Row>

          <Row
            label={tr("会话分享目标 (sessionShareDestination)", "Session share destination")}
            modified={shareDest.modified}
            reset={{ tip: "auto", onReset: () => void shareDest.reset() }}
            testId="pi-share-dest-row"
          >
            {(labelId) => (
              <Segmented
                size="sm"
                value={shareDest.value}
                options={shareOptions}
                labelledBy={labelId}
                onChange={(next) => void shareDest.save(next)}
                testId="pi-share-dest"
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
