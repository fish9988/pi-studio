// 极简主窗口顶栏（Antigravity × DSH）：
// - 左段与侧栏同宽共底色（紧凑品牌标识 + 侧栏收起按钮同一行对齐）；
// - 主区左侧：清爽面包屑 `文件夹名 / 会话标题`；
// - 主区右侧：仅保留干净的 Git 分支轻胶囊（带脏状态小圆点，点击在右侧分栏打开 Review）+ 唯一统一的右侧工作台切换图标 `[|]`。
import { AgentsToggle } from "../features/agents/index.ts";
import { BrowserToggle } from "../features/browser/index.ts";
import { useDraftProject } from "../features/empty/use-draft-project.ts";
import { FilesToggle } from "../features/file-preview/index.ts";
import { DraftGitTools, GitTools } from "../features/git/index.ts";
import { TerminalToggle, useDraftTerminalKey } from "../features/terminal/index.ts";
import { ChangesToggle } from "../features/workbench/index.ts";
import { useT } from "../i18n/use-t.ts";
import { showView, useSelectedTaskId, useTask } from "../store/index.ts";
import { IconButton } from "../ui/controls.tsx";
import { PixelLogo } from "../ui/PixelLogo.tsx";
import { GearIcon } from "../features/sidebar/icons.tsx";
import { SidebarIcon } from "./icons.tsx";
import { withShortcut } from "./platform-keys.ts";
import { TaskCrumb } from "./TaskCrumb.tsx";

interface TopBarProps {
  sidebarShown: boolean;
  onToggleSidebar(): void;
}

function TaskTools() {
  const t = useT();
  const taskId = useSelectedTaskId();
  const task = useTask(taskId);
  const draftKey = useDraftTerminalKey();
  const draftProject = useDraftProject();
  if (taskId !== null && task === null) return null;
  return (
    <div className="topbar-tools" data-testid="topbar-tools">
      {taskId !== null && <GitTools taskId={taskId} />}
      {taskId === null && draftProject !== null && <DraftGitTools projectId={draftProject.id} />}
      <FilesToggle panelKey={taskId ?? draftKey} />
      <span className="topbar-legacy-toggles">
        {taskId !== null && <ChangesToggle taskId={taskId} />}
        {taskId !== null && <AgentsToggle taskId={taskId} />}
        {taskId !== null && <BrowserToggle taskId={taskId} />}
        <TerminalToggle terminalKey={taskId ?? draftKey} />
      </span>
      <IconButton
        label={t("sidebar.settings")}
        tip={withShortcut(t("sidebar.settings"), "Ctrl ,")}
        testId="topbar-settings"
        onClick={() => showView("settings")}
      >
        <GearIcon />
      </IconButton>
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
          <PixelLogo unit={1.6} />
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
