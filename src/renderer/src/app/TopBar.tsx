// 顶栏 = 任务条（spec §3.1）：左段与侧栏同宽共底色（标志+字标、切换侧栏按钮）；
// 右侧主画布顶栏：左 可点击改名的任务标题 + 重开；中 [对话 | 轨迹] 胶囊切换；
// 右 工作区快捷打开菜单（Open ▾）+ 任务工具（分支、评审、文件、子代理、浏览器、终端、任务菜单 ⋯），再往右是 titleBarOverlay 绘制的系统三键。
import { useState } from "react";
import { AgentsToggle } from "../features/agents/index.ts";
import { BrowserToggle } from "../features/browser/index.ts";
import { pushToast } from "../features/dialogs/index.ts";
import { useDraftProject } from "../features/empty/use-draft-project.ts";
import { FilesToggle } from "../features/file-preview/index.ts";
import { DraftGitTools, GitTools } from "../features/git/index.ts";
import { SessionMenu } from "../features/session-info/index.ts";
import { addProjectAsDraft } from "../features/sidebar/sidebar-actions.ts";
import { TerminalToggle, toggleTerminalFocus, useDraftTerminalKey } from "../features/terminal/index.ts";
import { ChangesToggle } from "../features/workbench/index.ts";
import { useT } from "../i18n/use-t.ts";
import { ChevronDown, CopyIcon, Diff, Folder, Terminal } from "../icons.tsx";
import { useAppInfo, useMainView, useSelectedTaskId, useTask } from "../store/index.ts";
import { openReview } from "../store/review-store.ts";
import { IconButton } from "../ui/controls.tsx";
import { reportError } from "../ui/errors.ts";
import { anchorBelowEnd, Menu, type MenuAnchor, type MenuEntry } from "../ui/Menu.tsx";
import { PixelLogo } from "../ui/PixelLogo.tsx";
import { SidebarIcon } from "./icons.tsx";
import { shortcutLabel, withShortcut } from "./platform-keys.ts";
import { TaskCrumb } from "./TaskCrumb.tsx";

interface TopBarProps {
  sidebarShown: boolean;
  onToggleSidebar(): void;
}

function WorkspaceOpenMenu() {
  const t = useT();
  const taskId = useSelectedTaskId();
  const task = useTask(taskId);
  const draftKey = useDraftTerminalKey();
  const draftProject = useDraftProject();
  const appInfo = useAppInfo();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  const cwd = task?.cwd ?? draftProject?.path ?? appInfo?.chatsDir ?? "";
  const buildEntries = (): MenuEntry[] => {
    const entries: MenuEntry[] = [
      {
        id: "openExplorer",
        label: t("menu.openExplorer"),
        icon: <Folder size={14} />,
        onSelect: () => {
          if (taskId !== null) {
            window.studio.openTaskFolder(taskId).catch((error: unknown) => reportError(t, error));
          } else if (draftProject !== null) {
            window.studio.revealProject(draftProject.id).catch((error: unknown) => reportError(t, error));
          } else {
            void addProjectAsDraft(t);
          }
        },
      },
      {
        id: "openTerminal",
        label: t("menu.openTerminal"),
        icon: <Terminal size={14} />,
        shortcut: shortcutLabel("Ctrl `"),
        onSelect: () => toggleTerminalFocus(taskId ?? draftKey),
      },
    ];
    if (cwd !== "") {
      entries.push({
        id: "copyWorkspacePath",
        label: t("menu.copyWorkspacePath"),
        icon: <CopyIcon size={14} />,
        onSelect: () => {
          navigator.clipboard
            .writeText(cwd)
            .then(() => pushToast({ level: "info", message: t("menu.copiedWorkspacePath") }))
            .catch((error: unknown) => reportError(t, error));
        },
      });
    }
    if (taskId !== null) {
      entries.push(
        { kind: "separator", id: "sep-review" },
        {
          id: "openReview",
          label: t("menu.openReview"),
          icon: <Diff size={14} />,
          shortcut: shortcutLabel("Ctrl Shift D"),
          onSelect: () => openReview(taskId),
        },
      );
    }
    return entries;
  };

  return (
    <>
      <button
        type="button"
        className="topbar-open-btn"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title={cwd !== "" ? `${t("menu.openIn")} · ${cwd}` : t("menu.openIn")}
        onClick={(event) => setMenu(menu ? null : anchorBelowEnd(event.currentTarget))}
        data-testid="topbar-open-in"
      >
        <Folder size={13} />
        <span className="topbar-open-label">{t("menu.openIn")}</span>
        <ChevronDown size={11} />
      </button>
      {menu !== null && (
        <Menu
          anchor={menu}
          label={t("menu.openIn")}
          items={buildEntries()}
          onClose={() => setMenu(null)}
          testId="topbar-open-menu"
        />
      )}
    </>
  );
}

/** 对话页上出现：工作区快捷菜单、分支、评审、文件面板、子代理面板、浏览器、终端、任务菜单 ⋯。最右一条竖线把它们和系统三键隔开。 */
function TaskTools() {
  const view = useMainView();
  const taskId = useSelectedTaskId();
  const task = useTask(taskId);
  const draftKey = useDraftTerminalKey();
  const draftProject = useDraftProject();
  if (view !== "conversation" || (taskId !== null && task === null)) return null;
  return (
    <div className="topbar-tools" data-testid="topbar-tools">
      <WorkspaceOpenMenu />
      {taskId !== null && <GitTools taskId={taskId} />}
      {taskId === null && draftProject !== null && <DraftGitTools projectId={draftProject.id} />}
      <FilesToggle panelKey={taskId ?? draftKey} />
      {taskId !== null && <ChangesToggle taskId={taskId} />}
      {taskId !== null && <AgentsToggle taskId={taskId} />}
      {taskId !== null && <BrowserToggle taskId={taskId} />}
      <TerminalToggle terminalKey={taskId ?? draftKey} />
      {taskId !== null && <SessionMenu taskId={taskId} />}
      <span className="topbar-divider" aria-hidden="true" />
    </div>
  );
}

export function TopBar(props: TopBarProps) {
  const t = useT();
  return (
    <header className="topbar" data-testid="topbar">
      <div className="topbar-left">
        <span className="topbar-brand" data-testid="topbar-brand">
          <PixelLogo unit={2} />
        </span>
        <IconButton
          label={t("menu.toggleSidebar")}
          tip={withShortcut(t("menu.toggleSidebar"), "Ctrl B")}
          testId="topbar-sidebar"
          expanded={props.sidebarShown}
          onClick={props.onToggleSidebar}
        >
          <SidebarIcon shown={props.sidebarShown} />
        </IconButton>
      </div>
      <div className="topbar-main">
        <TaskCrumb />
        <div className="topbar-center" />
        <TaskTools />
      </div>
    </header>
  );
}
