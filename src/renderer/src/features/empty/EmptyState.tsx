// 没选任务时的主区（spec §4.7）。两种版式：
//   studio（默认）：背景字符波纹场 + 贴底的草稿输入框；上方是在剩余空间里竖直居中的 Studio 概览：
//     像素 π + "开始一个任务"（升级后第一次启动附带最近更新）、Bento 用量仪表盘卡片。概览比窗口高时整页滚动，输入框始终贴底。
//   zcode（现代工作台）：融进主面板底色的极简首页——视觉重心偏中上的时段问候、正中的草稿输入框、下面一排真实可用的快捷动作。
//     不铺第二层底色（否则主区里会露出一块颜色不同的拼接断层），也不重复标题条。
import { useEffect } from "react";
import { draftKey } from "../../../../shared/ipc.ts";
import { useLocale, useT } from "../../i18n/use-t.ts";
import { useAppInfo } from "../../store/index.ts";
import { Folder, Hourglass, Plus, Terminal } from "../../icons.tsx";
import { Button } from "../../ui/controls.tsx";
import { describeError } from "../../ui/errors.ts";
import { DraftComposer } from "../composer/index.ts";
import { setUsageDialogOpen } from "../composer/usage-store.ts";
import { openFilesPanel } from "../file-preview/index.ts";
import { refreshProjects, useProjectsState } from "../sidebar/projects-store.ts";
import { addProjectAsDraft } from "../sidebar/sidebar-actions.ts";
import { setTerminalOpen } from "../terminal/terminal-store.ts";
import { openDshToolTab } from "../workbench/dsh-workbench-store.ts";
import { EmptyMark } from "./EmptyMark.tsx";
import { HomeRippleCanvas } from "./HomeRippleCanvas.tsx";
import { ProjectLabel } from "./ProjectLabel.tsx";
import { UsageCard } from "./UsageCard.tsx";
import { useDraftProject } from "./use-draft-project.ts";
import { WhatsNew } from "./WhatsNew.tsx";
import "./empty.css";

/** 按当前小时取一句时段问候：5–9 早、9–12 上午、12–14 中午、14–18 下午、18–23 晚上，23–5 是深夜。
 *  读时钟这一步放在组件外：渲染过程中直接 new Date() 会被 react(purity) 拦下。 */
function currentGreeting(zh: boolean): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 9) return zh ? "早上好" : "Good morning";
  if (hour >= 9 && hour < 12) return zh ? "上午好" : "Good morning";
  if (hour >= 12 && hour < 14) return zh ? "中午好" : "Good afternoon";
  if (hour >= 14 && hour < 18) return zh ? "下午好" : "Good afternoon";
  if (hour >= 18 && hour < 23) return zh ? "晚上好" : "Good evening";
  return zh ? "夜深了" : "Working late";
}

export function EmptyState({ variant = "studio" }: { variant?: "studio" | "zcode" }) {
  const t = useT();
  const zh = useLocale() === "zh-CN";
  const { loaded, error } = useProjectsState();
  const project = useDraftProject();
  const appInfo = useAppInfo();
  const whatsNew = appInfo?.whatsNew ?? null;

  // 草稿输入框出现后焦点放进去（程序设置的焦点不显示焦点框，只有键盘操作才显示）。
  useEffect(() => {
    if (!loaded) return;
    const active = document.activeElement;
    if (active === null || active === document.body)
      document.querySelector<HTMLElement>("[data-composer-input]")?.focus({ preventScroll: true });
  }, [loaded]);

  if (!loaded && error === null)
    return <div className="empty" data-testid="empty-state" data-kind="loading" aria-busy="true" />;
  if (!loaded) {
    return (
      <div className="empty" data-testid="empty-state" data-kind="error">
        <div className="empty-card" role="alert">
          <p className="empty-error">{t("empty.loadFailed", { message: describeError(t, error) })}</p>
          <Button variant="primary" onClick={() => void refreshProjects()}>
            {t("common.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (variant === "zcode") {
    const panelKey = draftKey(project?.id ?? null);
    // 打开工作台的文件页（草稿键，任务还没建也能浏览工作区文件）。
    const openFiles = () => {
      openFilesPanel(panelKey);
      openDshToolTab(panelKey, "files");
    };
    // 在草稿目录新开一个终端标签并聚焦：新标签真的建在草稿键下时才去开底部终端面板。
    const openTerminal = () => {
      const created = openDshToolTab(panelKey, "terminal", { forceNewTerminal: true });
      if (created.kind === "terminal" && created.terminalKey === panelKey)
        setTerminalOpen(panelKey, true, { focus: true });
    };
    const greeting = currentGreeting(zh);
    return (
      <div className="empty zempty" data-testid="empty-state" data-kind={project === null ? "no-project" : "project"}>
        <div className="zempty-body">
          <header className="zempty-hero">
            <h1 className="zempty-greeting">
              {zh ? `${greeting}，今天想构建什么？` : `${greeting} — what are you building today?`}
            </h1>
            {(project !== null || whatsNew !== null) && (
              <div className="zempty-sub">
                {project !== null && (
                  <span className="zempty-folder" title={project.path}>
                    <Folder size={12} />
                    <span className="zempty-folder-name">{project.name}</span>
                  </span>
                )}
                {whatsNew !== null && <WhatsNew summary={whatsNew} />}
              </div>
            )}
          </header>
          <div className="empty-draft zempty-draft" data-testid="empty-draft">
            <DraftComposer projectId={project?.id ?? null} projectTools={<ProjectLabel project={project} />} />
          </div>
          <div className="zempty-quick-row">
            <button
              type="button"
              className="zempty-quick"
              data-testid="empty-quick-files"
              onClick={openFiles}
              title={zh ? "在工作台浏览工作区文件" : "Browse workspace files"}
            >
              <Folder size={13} />
              {zh ? "打开文件" : "Open files"}
            </button>
            <button
              type="button"
              className="zempty-quick"
              data-testid="empty-quick-terminal"
              onClick={openTerminal}
              title={zh ? "在草稿目录新开一个终端" : "New shell in this folder"}
            >
              <Terminal size={13} />
              {zh ? "新建终端" : "New terminal"}
            </button>
            <button
              type="button"
              className="zempty-quick"
              data-testid="empty-quick-project"
              onClick={() => void addProjectAsDraft(t)}
              title={t("empty.openFolder")}
            >
              <Plus size={13} />
              {zh ? "选择项目目录" : "Choose folder"}
            </button>
            <button
              type="button"
              className="zempty-quick"
              data-testid="empty-quick-usage"
              onClick={() => setUsageDialogOpen(true)}
              title={t("slash.usageDesc")}
            >
              <Hourglass size={13} />
              {zh ? "用量统计" : "Usage"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="empty" data-testid="empty-state" data-kind={project === null ? "no-project" : "project"}>
      <HomeRippleCanvas />
      <div className="empty-main">
        <div className="empty-head">
          <EmptyMark />
          <h1 className="empty-title">{t("empty.title")}</h1>
          {whatsNew !== null && <WhatsNew summary={whatsNew} />}
        </div>
        <UsageCard />
      </div>
      <div className="empty-draft" data-testid="empty-draft">
        <DraftComposer projectId={project?.id ?? null} projectTools={<ProjectLabel project={project} />} />
      </div>
    </div>
  );
}
