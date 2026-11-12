// 顶栏左侧清爽面包屑：`文件夹名 / 会话标题`（双击或点击标题原地重命名，悬停显示完整路径与标题）。
import { useEffect, useRef, useState } from "react";
import { isScratchChatCwd, taskTitle } from "../../../shared/ui/sidebar-model.ts";
import { useDraftProject } from "../features/empty/use-draft-project.ts";
import { useProjects } from "../features/sidebar/projects-store.ts";
import { folderAliasKey, useFolderAliases } from "../features/sidebar/sidebar-prefs-store.ts";
import { useT } from "../i18n/use-t.ts";
import { Restart } from "../icons.tsx";
import { useMainView, useSelectedTaskId, useTask } from "../store/index.ts";
import { IconButton } from "../ui/controls.tsx";
import { reportError } from "../ui/errors.ts";
import { withShortcut } from "./platform-keys.ts";
import { restartBlockedKey, restartSession } from "./restart-session.ts";

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function TaskCrumb() {
  const t = useT();
  const view = useMainView();
  const taskId = useSelectedTaskId();
  const task = useTask(taskId);
  const projects = useProjects();
  const folderAliases = useFolderAliases();
  const draftProject = useDraftProject();
  const [restarting, setRestarting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);

  useEffect(() => {
    setRenaming(false);
  }, [taskId, view]);

  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  if (taskId === null || task === null) {
    const draftAlias = draftProject ? folderAliases[folderAliasKey(draftProject.path)] : undefined;
    const draftFolder = draftAlias ?? (draftProject ? draftProject.name || baseName(draftProject.path) : null);
    return (
      <div
        className="crumb"
        data-testid="topbar-crumb"
        title={draftProject ? `${draftProject.path} / ${t("menu.newTask")}` : t("menu.newTask")}
      >
        {draftFolder && (
          <>
            <span className="crumb-folder">{draftFolder}</span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
          </>
        )}
        <span className="crumb-title">{t("menu.newTask")}</span>
      </div>
    );
  }

  const matchedProject =
    (task.projectId !== null ? projects.find((p) => p.id === task.projectId) : undefined) ??
    projects.find((p) => p.path.toLowerCase() === task.cwd.toLowerCase());
  const folderAlias = folderAliases[folderAliasKey(task.cwd)];
  const folderName = folderAlias ?? matchedProject?.name ?? (isScratchChatCwd(task.cwd) ? null : baseName(task.cwd));

  const title = taskTitle(task) || t("task.untitled");
  const fullTooltip = `${task.cwd}\n${title}`;
  const blocked = restartBlockedKey(task);
  const restart = () => {
    setRestarting(true);
    void restartSession(t, task).finally(() => setRestarting(false));
  };
  const beginRename = () => {
    skipBlurRef.current = false;
    setDraft(title);
    setRenaming(true);
  };
  const commitRename = () => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    const next = draft.trim();
    setRenaming(false);
    if (next === "" || next === title) return;
    window.studio.renameTask(task.id, next).catch((error: unknown) => reportError(t, error));
  };

  return (
    <div className="crumb" data-testid="topbar-crumb">
      {folderName && (
        <>
          <span className="crumb-folder" title={task.cwd}>
            {folderName}
          </span>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
        </>
      )}
      {renaming ? (
        <input
          ref={inputRef}
          type="text"
          className="crumb-rename-input"
          value={draft}
          aria-label={t("task.renameLabel")}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              skipBlurRef.current = true;
              setRenaming(false);
            }
          }}
          data-testid="topbar-rename-input"
        />
      ) : (
        <button
          type="button"
          className="crumb-title crumb-title-btn"
          title={fullTooltip}
          onClick={beginRename}
          onDoubleClick={beginRename}
        >
          {title}
        </button>
      )}
      <IconButton
        className="crumb-restart"
        label={t("task.restart")}
        tip={blocked === null ? withShortcut(t("task.restartTip"), "Ctrl Shift R") : t(blocked)}
        disabled={blocked !== null || restarting}
        testId="topbar-restart"
        onClick={restart}
      >
        <Restart size={13} />
      </IconButton>
    </div>
  );
}
