// 顶栏右侧统一侧边栏切换按钮（100% 对齐 DSH 右分栏图标）：单击展开/收起右侧工作台（保留已开标签页）。
import type { TerminalKey } from "../../../../shared/ipc.ts";
import { withShortcut } from "../../app/platform-keys.ts";
import { useT } from "../../i18n/use-t.ts";
import { IconButton } from "../../ui/controls.tsx";
import { toggleDshSidebar, useDshWorkspace } from "../workbench/dsh-workbench-store.ts";

export function RightSidebarIcon({ shown }: { shown: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="2" stroke="currentColor" strokeWidth="1.35" />
      <line x1="10.25" y1="3" x2="10.25" y2="13" stroke="currentColor" strokeWidth="1.35" />
      {shown && <rect x="10.8" y="3.8" width="2.3" height="8.4" rx="0.6" fill="currentColor" opacity="0.32" />}
    </svg>
  );
}

export function FilesToggle({ panelKey }: { panelKey: TerminalKey }) {
  const t = useT();
  const ws = useDshWorkspace(panelKey);
  return (
    <IconButton
      label={t("preview.filesToggle")}
      tip={withShortcut(t("preview.filesToggle"), "Ctrl Shift E")}
      pressed={ws.open}
      expanded={ws.open}
      testId="topbar-files"
      onClick={() => toggleDshSidebar(panelKey)}
    >
      <RightSidebarIcon shown={ws.open} />
    </IconButton>
  );
}
