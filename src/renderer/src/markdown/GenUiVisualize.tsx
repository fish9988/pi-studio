// `::visualize{path="..." title="..."}` 指令块：从当前任务/草稿工作区读取 HTML 文件，并在对话流内渲染成 Gen UI 交互卡片。
import { useEffect, useState } from "react";
import { draftKey, type DraftKey, type TaskId } from "../../../shared/ipc.ts";
import { filesTarget } from "../features/file-preview/files-target.ts";
import { openFilePreview } from "../features/file-preview/preview-store.ts";
import { useT } from "../i18n/use-t.ts";
import { useSelectedTaskId, useTask } from "../store/index.ts";
import { GenUiCard } from "./GenUiCard.tsx";
import type { VisualizeDirective } from "./gen-ui-directive.ts";

type LoadState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; html: string; resolvedPath: string };

export function GenUiVisualize({ directive }: { directive: VisualizeDirective }) {
  const t = useT();
  const taskId = useSelectedTaskId();
  const task = useTask(taskId);
  const panelKey = taskId ?? draftKey(task?.projectId ?? null);
  const quoteTarget: TaskId | DraftKey | null = taskId ?? (task?.projectId ? draftKey(task.projectId) : null);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const target = filesTarget(panelKey);
    window.studio.readPreviewFile(target, directive.path).then(
      (file) => {
        if (cancelled) return;
        if (
          file.kind === "missing" ||
          (file.kind !== "html" && file.kind !== "text") ||
          typeof file.text !== "string"
        ) {
          setState({ status: "missing" });
          return;
        }
        setState({ status: "ready", html: file.text, resolvedPath: file.path });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [panelKey, directive.path]);

  if (state.status === "loading") {
    return (
      <div className="gen-ui-card" data-testid="gen-ui-visualize-loading">
        <div className="gen-ui-body">
          <p className="gen-ui-note">{t("preview.genUiLoading")}</p>
        </div>
      </div>
    );
  }

  if (state.status === "missing") {
    return (
      <div className="gen-ui-card" data-testid="gen-ui-visualize-missing">
        <div className="gen-ui-body">
          <p className="gen-ui-note">{t("preview.genUiMissingFile", { path: directive.path })}</p>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="gen-ui-card" data-testid="gen-ui-visualize-error">
        <div className="gen-ui-body">
          <p className="gen-ui-note" role="alert">
            {t("preview.readFailed", { message: state.message })}
          </p>
        </div>
      </div>
    );
  }

  const title = directive.title?.trim() || state.resolvedPath.split(/[\\/]/).pop() || directive.path;
  return (
    <GenUiCard
      html={state.html}
      title={title}
      stateKey={`${panelKey}:vis:${state.resolvedPath}`}
      taskId={taskId}
      quoteTarget={quoteTarget}
      onOpenSidebar={() => openFilePreview(panelKey, state.resolvedPath)}
    />
  );
}
