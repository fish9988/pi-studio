// 设置 → 通用 → 外观的主题画廊：
// 外观深浅色模式（跟随系统 / 浅色 / 深色）独立于主题风格之外；
// 每个主题家族（默认 / Claude Code / Pi / DeepSeek / Gemini / OpenAI / 樱粉 / 水墨）都完整兼容浅色与深色：
//  - 选择「跟随系统」时，每张卡片左右对半同时预览该主题的浅色与深色效果；
//  - 选择「浅色」或「深色」时，所有卡片实时切换为对应深浅色板的迷你界面预览。
// 卡片：仓库里现成的 thumbs/*.webp 缩略图 + 名称；选中态是强调色描边 + 名字后的勾号（不只靠颜色区分，见 settings.css）。
import {
  familyOfTheme,
  themeFamilies,
  themeFamilyNames,
  type ColorMode,
  type ThemeFamily,
  type ThemeName,
  type ThemePreference,
} from "../../../../shared/themes.ts";
import { useT } from "../../i18n/use-t.ts";
import { Check } from "../../icons.tsx";
import { setAppearanceTheme } from "../../store/index.ts";
import { reportError } from "../../ui/errors.ts";

const thumbFiles = import.meta.glob<string>("../../../styles/themes/thumbs/*.webp", {
  query: "?url&no-inline",
  import: "default",
  eager: true,
});
/** 具体色板名 → WebP 缩略图地址；无背景插图的主题为 undefined。 */
const thumbs = new Map(
  Object.entries(thumbFiles).map(([file, url]) => [file.slice(file.lastIndexOf("/") + 1, -".webp".length), url]),
);

function MiniUi({ theme }: { theme: ThemeName }) {
  const thumb = thumbs.get(theme);
  return (
    <span className="st-theme-mini" data-theme={theme}>
      <span className="st-theme-side" />
      <span className="st-theme-main" style={thumb === undefined ? undefined : { backgroundImage: `url("${thumb}")` }}>
        <span className="st-theme-bubble" />
        <span className="st-theme-dot" />
        {thumb === undefined && (
          <span className="st-theme-skeleton" aria-hidden="true">
            <span className="st-theme-skeleton-line" />
            <span className="st-theme-skeleton-code" />
          </span>
        )}
      </span>
    </span>
  );
}

export function ThemeGallery({ value, colorMode = "system" }: { value: ThemePreference; colorMode?: ColorMode }) {
  const t = useT();
  const activeFamily: ThemeFamily = familyOfTheme(value);

  return (
    <div className="st-theme-gallery" role="group" aria-label={t("settings.theme")} data-testid="theme-gallery">
      {themeFamilyNames.map((family) => {
        const pair = themeFamilies[family];
        const selected = family === activeFamily;
        return (
          <button
            key={family}
            type="button"
            className="st-theme-card"
            aria-pressed={selected}
            onClick={() => void setAppearanceTheme(family).catch((error: unknown) => reportError(t, error))}
            data-testid={`theme-card-${family}`}
          >
            <span className="st-theme-preview" aria-hidden="true">
              {colorMode === "system" ? (
                <>
                  <MiniUi theme={pair.light} />
                  <MiniUi theme={pair.dark} />
                </>
              ) : (
                <MiniUi theme={colorMode === "dark" ? pair.dark : pair.light} />
              )}
            </span>
            <span className="st-theme-meta">
              <span className="st-theme-name">{t(`settings.theme.${family}`)}</span>
              {selected && (
                <span className="st-theme-check" aria-hidden="true">
                  <Check size={11} />
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
