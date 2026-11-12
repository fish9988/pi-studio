// 设置导航（spec §4.19，direction-3.2 §4 第 1 条）：进设置时占侧栏的位置（App.tsx 在侧栏位置渲染 SettingsNav），
// 顶上 `‹ 返回任务  Esc`、搜索全部设置、8 节按语义分 5 组（外观 / 智能 / 能力 / 会话 / 系统，组间一条细分隔，每节一个 14px 图标）；
// 窗口窄到侧栏变抽屉、或侧栏被收起时，导航变成内容顶上的一个下拉 + 搜索框（SettingsCompactNav，由 SettingsView 渲染）。
// 当前节和搜索词在 ui-store（SettingsView 读同一份）。当前节 = 胶囊底 + 左侧强调色条 + aria-current="page"（不只靠颜色）。
import type { KeyboardEvent, ReactNode } from "react";
import { useT } from "../../i18n/use-t.ts";
import {
  ChevronLeft,
  Close,
  Comment,
  Globe,
  Info,
  Plug,
  Puzzle,
  Search,
  Sliders,
  Sparkle,
  Terminal,
  Users,
} from "../../icons.tsx";
import {
  setSettingsPage,
  setSettingsQuery,
  showView,
  useAppInfo,
  useSettingsPage,
  useSettingsQuery,
  type SettingsPage,
} from "../../store/index.ts";
import { Button, IconButton, TextField } from "../../ui/controls.tsx";
import { Select } from "../../ui/Select.tsx";

/** 导航里的一个分组（组名只是分类标签，8 节本身仍是平级的）。 */
type NavGroup = "appearance" | "intelligence" | "capabilities" | "session" | "system";

// 按 Pi 的核心配置域排成 8 节（~/.pi/agent 与项目级 .pi 共用同一套分区），8 节分 5 组。
const navGroups: readonly { id: NavGroup; pages: readonly SettingsPage[] }[] = [
  { id: "appearance", pages: ["general"] },
  { id: "intelligence", pages: ["models", "providers"] },
  { id: "capabilities", pages: ["tools", "extensions"] },
  { id: "session", pages: ["context"] },
  { id: "system", pages: ["advanced", "about"] },
];

/** 8 节（导航顺序；紧凑导航的下拉也用它）。 */
export const settingsPages: readonly SettingsPage[] = navGroups.flatMap((group) => group.pages);

/** 每节一个 16 栅格 / 1.5 描边的线性图标（和 icons.tsx 里其余图标同一套）。 */
const pageIcons: Record<SettingsPage, ReactNode> = {
  general: <Sliders />,
  models: <Sparkle />,
  providers: <Plug />,
  tools: <Terminal />,
  extensions: <Puzzle />,
  context: <Comment />,
  agents: <Users />,
  advanced: <Globe />,
  about: <Info />,
};

/** 某一节的图标（导航和页头共用一个，见 SettingsView）。 */
export function settingsPageIcon(page: SettingsPage): ReactNode {
  return pageIcons[page];
}

// 同一时刻只挂一个搜索框（侧栏里的，或内容顶上的）：Ctrl+F 聚焦它。
let searchInput: HTMLInputElement | null = null;

export function focusSettingsSearch(): void {
  searchInput?.focus();
  searchInput?.select();
}

function closeSettings(): void {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("window") === "settings") {
    window.close();
    return;
  }
  showView("conversation");
}

/** Ctrl+F 聚焦搜索；Esc 回到进入设置前的视图（搜索框里有内容时它先自己清掉，已 preventDefault）。导航和内容共用。 */
export function onSettingsKeyDown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    focusSettingsSearch();
  } else if (event.key === "Escape" && !event.defaultPrevented) closeSettings();
}

function SearchBox({ width }: { width: number | string }) {
  const t = useT();
  const query = useSettingsQuery();
  return (
    <TextField
      size="sm"
      width={width}
      type="search"
      ref={(node) => {
        if (node !== null) searchInput = node;
        else searchInput = null;
      }}
      value={query}
      placeholder={t("settings.search.placeholder")}
      aria-label={t("settings.search.hint")}
      leading={<Search size={14} />}
      trailing={
        query === "" ? undefined : (
          <IconButton
            label={t("settings.search.clear")}
            onClick={() => {
              setSettingsQuery("");
              searchInput?.focus();
            }}
          >
            <Close size={12} />
          </IconButton>
        )
      }
      onChange={setSettingsQuery}
      onKeyDown={(event) => {
        // 有内容时 Esc 先清搜索，不退出设置页。
        if (event.key === "Escape" && query !== "") {
          event.preventDefault();
          setSettingsQuery("");
        }
      }}
      testId="settings-search"
    />
  );
}

/** 侧栏位置的设置导航。 */
export function SettingsNav() {
  const t = useT();
  const page = useSettingsPage();
  const query = useSettingsQuery();
  const info = useAppInfo();
  const searching = query.trim() !== "";
  return (
    <nav className="snav" aria-label={t("settings.sections")} data-testid="settings-nav" onKeyDown={onSettingsKeyDown}>
      <div className="snav-top">
        <Button
          variant="quiet"
          size="sm"
          className="snav-back"
          icon={<ChevronLeft size={14} />}
          hint="Esc"
          onClick={closeSettings}
          testId="settings-back"
        >
          {t("settings.back")}
        </Button>
        <div className="snav-search">
          <SearchBox width="100%" />
        </div>
      </div>
      <div className="snav-groups">
        {navGroups.map((group) => (
          <div key={group.id} className="snav-group">
            <div className="snav-group-label">{t(`settings.group.${group.id}`)}</div>
            {group.pages.map((item) => (
              <button
                key={item}
                type="button"
                className="snav-item"
                aria-current={!searching && page === item ? "page" : undefined}
                onClick={() => setSettingsPage(item)}
                data-testid={`settings-nav-${item}`}
              >
                <span className="snav-item-icon" aria-hidden="true">
                  {pageIcons[item]}
                </span>
                <span className="snav-item-text">{t(`settings.${item}`)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {info !== null && (
        <div className="snav-foot" data-testid="settings-nav-version">
          {info.version}
        </div>
      )}
    </nav>
  );
}

/** 侧栏变抽屉（或被收起）时内容顶上的导航：节下拉 + 搜索框。 */
export function SettingsCompactNav() {
  const t = useT();
  const page = useSettingsPage();
  const query = useSettingsQuery();
  const searching = query.trim() !== "";
  return (
    <div className="snav-compact" data-testid="settings-nav-compact" onKeyDown={onSettingsKeyDown}>
      {/* 搜索时下拉没有选中项（选回当前这一节也要能退出搜索），占位文字是当前节名（占位色，淡）；
          2026-10-29 审计 SET-21：原来占位写"搜索设置"，像是有一节叫这个 */}
      <Select<SettingsPage>
        size="sm"
        value={searching ? ("" as SettingsPage) : page}
        placeholder={t(`settings.${page}`)}
        options={settingsPages.map((item) => ({ value: item, label: t(`settings.${item}`) }))}
        label={t("settings.sections")}
        onChange={setSettingsPage}
        testId="settings-nav-select"
      />
      <div className="snav-compact-search">
        <SearchBox width={220} />
      </div>
    </div>
  );
}
