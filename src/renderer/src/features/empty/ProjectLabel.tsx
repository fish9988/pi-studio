// 输入框工具行里的工作文件夹标签：
// - 任务中（PathLabel）：只读展示文件夹图标 + 路径（省略开头、保留末尾文件夹名，悬停看完整路径）。
// - 新任务草稿（ProjectLabel）：外层可点切换已加入的项目、默认文件夹或打开新文件夹；内层保留 <span data-testid="empty-project">。
import { useState } from "react";
import type { Project } from "../../../../shared/ipc.ts";
import { useT } from "../../i18n/use-t.ts";
import { ChevronDown, Folder } from "../../icons.tsx";
import { useAppInfo } from "../../store/index.ts";
import { anchorBelow, Menu, type MenuAnchor, type MenuEntry } from "../../ui/Menu.tsx";
import { useProjects } from "../sidebar/projects-store.ts";
import { addProjectAsDraft } from "../sidebar/sidebar-actions.ts";
import { folderAliasKey, useFolderAliases } from "../sidebar/sidebar-prefs-store.ts";
import { isDefaultFolder } from "./default-folder.ts";
import { pickDraftProject } from "./draft-project.ts";
import "./empty.css";

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 极简工作目录轻标签：仅显示简短目录名（或自定义显示名 / 默认文件夹），鼠标悬停查看完整路径。 */
export function PathLabel({ path, testId = "empty-project" }: { path: string; testId?: string }) {
  const t = useT();
  const chatsDir = useAppInfo()?.chatsDir ?? null;
  const folderAliases = useFolderAliases();
  const alias = path !== "" ? folderAliases[folderAliasKey(path)] : undefined;
  const shortLabel =
    alias ??
    (chatsDir !== null && path !== "" && isDefaultFolder(path, chatsDir)
      ? t("empty.defaultFolder")
      : baseName(path) || path);

  return (
    <span className="empty-project" data-testid={testId} title={path}>
      <Folder size={13} />
      <span className="empty-project-name">{shortLabel}</span>
    </span>
  );
}

/** project 为 null = 默认文件夹；点击弹出项目快速切换菜单。 */
export function ProjectLabel({ project }: { project: Project | null }) {
  const t = useT();
  const chatsDir = useAppInfo()?.chatsDir ?? "";
  const projects = useProjects();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const currentPath = project?.path ?? chatsDir;

  const buildItems = (): MenuEntry[] => {
    const items: MenuEntry[] = [
      {
        id: "default-folder",
        label: t("empty.defaultFolder"),
        note: chatsDir !== "" ? chatsDir : undefined,
        checked: project === null,
        onSelect: () => pickDraftProject(null),
      },
    ];
    if (projects.length > 0) {
      items.push({ kind: "separator", id: "sep-projects" });
      for (const item of projects) {
        items.push({
          id: `project:${item.id}`,
          label: item.name,
          note: item.path,
          checked: project?.id === item.id,
          onSelect: () => pickDraftProject(item.id),
        });
      }
    }
    items.push(
      { kind: "separator", id: "sep-open" },
      {
        id: "open-folder",
        label: t("empty.openFolder"),
        onSelect: () => {
          void addProjectAsDraft(t);
        },
      },
    );
    return items;
  };

  return (
    <>
      <button
        type="button"
        className="empty-project-btn"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(e) => setMenu(menu ? null : anchorBelow(e.currentTarget))}
        data-testid="empty-project-picker"
      >
        <PathLabel path={currentPath} />
        <ChevronDown size={11} className="empty-project-caret" />
      </button>
      {menu !== null && (
        <Menu
          anchor={menu}
          label={t("empty.workspaceMenu")}
          items={buildItems()}
          onClose={() => setMenu(null)}
          testId="empty-project-menu"
        />
      )}
    </>
  );
}
