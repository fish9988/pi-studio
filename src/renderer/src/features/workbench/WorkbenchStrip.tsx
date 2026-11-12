// 右栏统一工作台切换条：开始 | 文件 | 变更 | 子代理 | 浏览器 | 终端，在右栏面板顶部共用，单击直达。
import type { TaskId } from "../../../../shared/ipc.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import { Compass, Diff, Folder, Globe, Terminal, Users } from "../../icons.tsx";
import { toggleTerminalFocus } from "../terminal/index.ts";
import { switchWorkbenchTab, type WorkbenchTab } from "./workbench-store.ts";
import "./workbench.css";

export function WorkbenchStrip({
  active,
  taskId,
  launcherActive = false,
  onSelectLauncher,
  onSelectFiles,
}: {
  active: WorkbenchTab;
  taskId: TaskId | null;
  launcherActive?: boolean;
  onSelectLauncher?(): void;
  onSelectFiles?(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const isZh = locale === "zh-CN";
  if (taskId === null && !onSelectLauncher) return null;

  const items = [
    ...(onSelectLauncher
      ? [{ id: "start" as const, label: isZh ? "开始" : "Start", icon: <Compass size={13} /> }]
      : []),
    { id: "files" as const, label: t("review.wbFiles"), icon: <Folder size={13} /> },
    ...(taskId !== null
      ? [
          { id: "changes" as const, label: t("review.wbChanges"), icon: <Diff size={13} /> },
          { id: "agents" as const, label: t("review.wbAgents"), icon: <Users size={13} /> },
          { id: "browser" as const, label: t("review.wbBrowser"), icon: <Globe size={13} /> },
        ]
      : []),
  ];

  return (
    <nav className="wb-strip" aria-label={t("review.wbLabel")} data-testid="workbench-strip">
      {items.map((item) => {
        const current = item.id === "start" ? launcherActive : !launcherActive && active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className="wb-strip-btn"
            aria-current={current ? "page" : undefined}
            data-active={current ? "" : undefined}
            data-testid={`wb-tab-${item.id}`}
            onClick={() => {
              if (item.id === "start") {
                onSelectLauncher?.();
                return;
              }
              if (item.id === "files" && active === "files") {
                onSelectFiles?.();
                return;
              }
              if (taskId !== null && (!current || launcherActive)) {
                onSelectFiles?.();
                switchWorkbenchTab(item.id, taskId);
              }
            }}
          >
            {item.icon}
            <span className="wb-strip-label">{item.label}</span>
          </button>
        );
      })}
      {taskId !== null && (
        <button
          type="button"
          className="wb-strip-btn wb-strip-btn-terminal"
          title={isZh ? "切换底部终端 (Ctrl+`)" : "Toggle Terminal (Ctrl+`)"}
          data-testid="wb-tab-terminal"
          onClick={() => toggleTerminalFocus(taskId)}
        >
          <Terminal size={13} />
          <span className="wb-strip-label">{isZh ? "终端" : "Term"}</span>
        </button>
      )}
    </nav>
  );
}
