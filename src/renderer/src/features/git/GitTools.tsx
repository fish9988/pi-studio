// 顶栏右侧极简 Git 分支轻胶囊（Antigravity × DSH）：
// - 显示分支简称（如 `master`），有未提交改动时带精致小圆点；
// - 左键点击直接在右侧并排分栏工作台中打开 `Review` 标签页（绝不全屏遮挡聊天流）；
// - 右键打开快捷 Git 动作菜单（提交 / 推送 / 创建 PR / 合并回 / 丢弃 worktree）。
import { useEffect, useState, type MouseEvent } from "react";
import type { GitStatus } from "../../../../shared/git.ts";
import type { TaskId } from "../../../../shared/ipc.ts";
import { useT } from "../../i18n/use-t.ts";
import { ArrowUp, Branch, Commit, Diff, External, Trash } from "../../icons.tsx";
import { useTask } from "../../store/index.ts";
import { openReview } from "../../store/review-store.ts";
import { reportError } from "../../ui/errors.ts";
import { Menu, type MenuAnchor, type MenuEntry } from "../../ui/Menu.tsx";
import { mergeBack, pushBranch } from "./git-actions.ts";
import { openGitDialog } from "./git-dialog-store.ts";
import { useGitVersion, useTaskWorktree } from "./git-store.ts";
import "./git.css";

export function GitTools({ taskId }: { taskId: TaskId }) {
  const t = useT();
  const task = useTask(taskId);
  const updatedAt = task?.updatedAt ?? 0;
  const version = useGitVersion(taskId);
  const worktree = useTaskWorktree(taskId, updatedAt);
  const [loaded, setLoaded] = useState<{ taskId: TaskId; status: GitStatus | null } | null>(null);
  const status = loaded?.taskId === taskId ? loaded.status : null;
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  useEffect(() => {
    let current = true;
    window.studio.getGitStatus(taskId).then(
      (value) => current && setLoaded({ taskId, status: value }),
      () => current && setLoaded({ taskId, status: null }),
    );
    return () => {
      current = false;
    };
  }, [taskId, updatedAt, version]);

  if (status?.kind !== "ok") return null;
  const label = worktree?.branch ?? status.branch.head ?? t("git.merge.detached");
  const ahead = worktree?.commitsAhead ?? 0;
  const untracked = status.files.filter((file) => file.unstaged === "untracked").length;
  const changed = status.files.length - untracked;
  const isDirty = changed + untracked > 0;
  const summary = [
    t("git.bar.branch", { branch: label }),
    worktree && t("git.bar.worktree", { base: worktree.baseBranch }),
    changed > 0 && t("git.bar.changed", { count: changed }),
    untracked > 0 && t("git.bar.untracked", { count: untracked }),
    ahead > 0 && t("git.bar.ahead", { count: ahead }),
  ]
    .filter((part) => typeof part === "string")
    .join(" · ");

  const menuItems = (): MenuEntry[] => {
    const items: MenuEntry[] = [
      {
        id: "review",
        label: t("review.open"),
        icon: <Diff />,
        onSelect: () => openReview(taskId),
      },
      { kind: "separator", id: "sep-review" },
      {
        id: "commit",
        label: t("git.menu.commit"),
        icon: <Commit />,
        onSelect: () => openGitDialog({ kind: "commit", taskId }),
      },
      {
        id: "push",
        label: t("git.menu.push"),
        icon: <ArrowUp />,
        ...(!status.canPush && {
          disabledReason: status.branch.head === null ? t("git.push.detached") : t("git.push.noRemote"),
        }),
        onSelect: () => void pushBranch(t, taskId),
      },
    ];
    if (status.canPush) {
      items.push({
        id: "pr",
        label: t("git.menu.pr"),
        icon: <External />,
        onSelect: () => openGitDialog({ kind: "pr", taskId, defaultTitle: task?.title ?? "" }),
      });
    }
    if (worktree) {
      items.push(
        {
          id: "merge",
          label: t("git.menu.merge", { base: worktree.baseBranch }),
          icon: <Branch />,
          onSelect: () => void mergeBack(t, taskId, worktree),
        },
        { kind: "separator", id: "sep-danger" },
        {
          id: "discard",
          label: t("git.menu.discard"),
          icon: <Trash />,
          tone: "danger",
          onSelect: () => openGitDialog({ kind: "discard", taskId, branch: worktree.branch }),
        },
      );
    }
    return items;
  };

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, returnFocus: event.currentTarget });
  };

  return (
    <>
      <button
        type="button"
        className="topbar-branch"
        data-testid="git-menu"
        data-dirty={isDirty ? "true" : undefined}
        data-worktree={worktree !== null || undefined}
        aria-label={`${summary} · ${t("review.open")}`}
        title={summary}
        onClick={() => openReview(taskId)}
        onContextMenu={handleContextMenu}
      >
        <Branch size={13} />
        <span className="topbar-branch-name" data-testid="git-branch">
          {label}
        </span>
        {isDirty && <span className="topbar-branch-dirty" data-testid="git-dirty-dot" aria-hidden="true" />}
        {ahead > 0 && (
          <span className="topbar-branch-ahead" data-testid="git-ahead">
            ↑{ahead}
          </span>
        )}
      </button>
      {task?.prNumber != null && (
        <button
          type="button"
          className="topbar-pr"
          data-testid="git-pr-badge"
          aria-label={t("git.pr.badge", { number: task.prNumber })}
          title={t("git.pr.badge", { number: task.prNumber })}
          onClick={() => window.studio.openTaskPullRequest(taskId).catch((error: unknown) => reportError(t, error))}
        >
          #{task.prNumber}
        </button>
      )}
      {menu && <div className="git-menu-scrim" />}
      {menu && <Menu anchor={menu} items={menuItems()} label={t("git.bar.menu")} onClose={() => setMenu(null)} />}
    </>
  );
}
