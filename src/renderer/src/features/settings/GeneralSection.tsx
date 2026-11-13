// 设置 → 通用：外观（主题画廊；格子里背景图、浓度、毛玻璃、语言、字号、减少动效、选中即复制）；通知与回顾（omp 的 ask / completion / error 通知、空闲回顾 + studio 的完成提示音）；
// 任务运行中发消息的方式（studio 的 Enter + omp 的插话/稍后处理方式，两两一行）；空闲任务多久关进程；快捷键（只读，三列；studio 的键，加转发给 omp 的键）。格子排法见 settings.css 的 .st-cells。
import { Fragment, useEffect, useMemo } from "react";
import {
  defaultFontSize,
  fontSizeSteps,
  type BackdropMode,
  type BackdropStrength,
  type BrandStyle,
  type ColorMode,
  type FontStyle,
  type IdleClose,
  type LocalePreference,
  type MascotCharacter,
  type PreferredShell,
} from "../../../../shared/ipc.ts";
import type { MessageKey } from "../../../../shared/i18n/index.ts";
import { chordKeys } from "../../../../shared/tsp/omp-keybindings.ts";
import { useT } from "../../i18n/use-t.ts";
import { shortcutKeys } from "../../app/platform-keys.ts";
import {
  setBrandStyle,
  setChatFontFamily,
  setChatFontStyle,
  setHomeRipple,
  setMascotCharacter,
  setPreferredShell,
  setProcessRowsLayout,
  setUiFontFamily,
  setUiFontStyle,
  useShellValue,
} from "../../app/shell-store.ts";
import { setAppearanceColorMode, useAppInfo, useSettings } from "../../store/index.ts";
import { Badge, Button, Row, SectionHead, Segmented, Switch } from "../../ui/controls.tsx";
import { reportError } from "../../ui/errors.ts";
import { Select, type SelectOption } from "../../ui/Select.tsx";
import { useInstalledFonts } from "./local-fonts.ts";
import { systemReducesMotion } from "./motion-preference.ts";
import { refreshOmpKeybindings, useOmpKeybindings } from "./omp-keybindings-store.ts";
import { ThemeGallery } from "./ThemeGallery.tsx";

/** 转发给 Pi 的键的作用文字（动作 ID → i18n）；键位来自主进程（默认键位 + 用户 keybindings.json）。 */
const ompActionLabels: Readonly<Record<string, MessageKey>> = {
  "app.thinking.cycle": "shortcut.ompThinkingCycle",
  "app.thinking.toggle": "shortcut.ompThinkingToggle",
  "app.model.cycleForward": "shortcut.ompModelForward",
  "app.model.cycleBackward": "shortcut.ompModelBackward",
  "app.model.selectTemporary": "shortcut.ompModelTemporary",
  "app.history.search": "shortcut.ompHistorySearch",
  "app.retry": "shortcut.ompRetry",
  "app.message.dequeue": "shortcut.ompDequeue",
};

/** 只读的快捷键表（spec §5.1 的主要几条）；键名本身不翻译，"Ctrl" 写的是应用主修饰键，mac 上显示成 ⌘（shortcutKeys）。 */
const shortcuts: { label: MessageKey; keys: string[] }[] = [
  { label: "shortcut.palette", keys: ["Ctrl", "K"] },
  { label: "shortcut.newTask", keys: ["Ctrl", "N"] },
  { label: "shortcut.focusSearch", keys: ["Ctrl", "F"] },
  { label: "shortcut.openFolder", keys: ["Ctrl", "Shift", "O"] },
  { label: "shortcut.settings", keys: ["Ctrl", ","] },
  { label: "shortcut.toggleSidebar", keys: ["Ctrl", "B"] },
  { label: "shortcut.focusComposer", keys: ["Ctrl", "L"] },
  { label: "shortcut.toggleTerminal", keys: ["Ctrl", "`"] },
  { label: "shortcut.send", keys: ["Enter"] },
  { label: "shortcut.newline", keys: ["Shift", "Enter"] },
  { label: "shortcut.later", keys: ["Ctrl", "Enter"] },
  { label: "shortcut.stop", keys: ["Esc"] },
  { label: "shortcut.toggleProcess", keys: ["Ctrl", "O"] },
  { label: "shortcut.nthTask", keys: ["Ctrl", "1…9"] },
  { label: "shortcut.prevNext", keys: ["Ctrl", "Shift", "[ / ]"] },
  { label: "shortcut.regions", keys: ["F6"] },
  { label: "shortcut.review", keys: ["Ctrl", "Shift", "D"] },
  { label: "shortcut.toggleFiles", keys: ["Ctrl", "Shift", "E"] },
  { label: "shortcut.toggleBrowser", keys: ["Ctrl", "Shift", "B"] },
  { label: "shortcut.reviewFiles", keys: ["J / K"] },
  { label: "shortcut.reviewHunks", keys: ["N / P"] },
  { label: "shortcut.reviewLayout", keys: ["V"] },
];

export function GeneralSection() {
  const t = useT();
  const settings = useSettings();
  const glassSupported = useAppInfo()?.glassSupported ?? false;
  const systemMotion = systemReducesMotion();
  const guard = (promise: Promise<unknown>) => void promise.catch((error: unknown) => reportError(t, error));
  const ompKeybindings = useOmpKeybindings();
  useEffect(() => void refreshOmpKeybindings(), []);

  const localeOptions = [
    { value: "system", label: t("settings.language.system") },
    { value: "zh-CN", label: t("settings.language.zh") },
    { value: "en", label: t("settings.language.en") },
  ] as const;
  const colorMode: ColorMode = settings?.colorMode ?? "system";
  const colorModeOptions = (["system", "light", "dark"] as const).map((value) => ({
    value,
    label: t(`settings.colorMode.${value}`),
  }));
  const brandStyle = useShellValue("brandStyle") ?? "pi";
  const brandOptions = (["pi", "claude", "deepseek"] as const).map((value) => ({
    value,
    label: t(`settings.brandStyle.${value}`),
  }));
  const mascot = useShellValue("mascot") ?? "clawd";
  const mascotOptions = (["clawd", "deepy", "whalegirl", "omp", "off"] as const).map((value) => ({
    value,
    label: t(`settings.mascot.${value}`),
  }));
  const homeRipple = useShellValue("homeRipple") ?? true;
  const processRows = useShellValue("processRows") ?? "classic";
  const backdrop = settings?.backdrop ?? "theme";
  const backdropOptions = (["theme", "custom", "none"] as const).map((value) => ({
    value,
    label: t(`settings.backdrop.${value}`),
  }));
  const strengthOptions = (["low", "medium", "high"] as const).map((value) => ({
    value,
    label: t(`settings.backdropStrength.${value}`),
  }));
  const fontSizeOptions = fontSizeSteps.map((size) => ({ value: `${size}` as const, label: `${size}pt` }));
  const uiFontStyle = useShellValue("uiFontStyle") ?? "sans";
  const uiFontFamily = useShellValue("uiFontFamily") ?? "";
  const chatFontStyle = useShellValue("chatFontStyle") ?? "sans";
  const chatFontFamily = useShellValue("chatFontFamily") ?? "";
  const fontStyleOptions = (["sans", "serif"] as const).map((value) => ({
    value,
    label: t(`settings.fontStyle.${value}`),
  }));
  const { fonts: installedFonts, loading: fontsLoading, refresh: refreshFonts } = useInstalledFonts();
  const buildFontOptions = useMemo(
    () =>
      (currentFamily: string): SelectOption<string>[] => {
        const names = new Set(installedFonts);
        if (currentFamily !== "") names.add(currentFamily);
        const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        return [
          { value: "", label: t("settings.font.default") },
          ...sorted.map((family) => ({ value: family, label: family })),
        ];
      },
    [installedFonts, t],
  );
  const uiFontOptions = useMemo(() => buildFontOptions(uiFontFamily), [buildFontOptions, uiFontFamily]);
  const chatFontOptions = useMemo(() => buildFontOptions(chatFontFamily), [buildFontOptions, chatFontFamily]);
  const enterOptions = [
    { value: "steer", label: t("settings.enterBehavior.steer") },
    { value: "followUp", label: t("settings.enterBehavior.later") },
  ] as const;
  const idleCloseOptions = (["15m", "1h", "4h", "never"] as const).map((value) => ({
    value,
    label: t(`settings.idleClose.${value}`),
  }));
  const preferredShell = useShellValue("preferredShell") ?? "auto";
  const shellOptions = (["auto", "pwsh", "powershell", "cmd", "git-bash"] as const).map((value) => ({
    value,
    label: t(`settings.preferredShell.${value}`),
  }));
  return (
    <>
      <SectionHead title={t("settings.appearance")} />
      <div className="st-cells">
        <Row label={t("settings.colorMode")}>
          {(labelId) => (
            <Segmented<ColorMode>
              size="sm"
              value={colorMode}
              options={colorModeOptions}
              labelledBy={labelId}
              onChange={(next) => guard(setAppearanceColorMode(next))}
              testId="setting-color-mode"
            />
          )}
        </Row>
      </div>
      <ThemeGallery value={settings?.theme ?? "default"} colorMode={colorMode} />
      <div className="st-cells">
        <Row label={t("settings.brandStyle")}>
          {(labelId) => (
            <Segmented<BrandStyle>
              size="sm"
              value={brandStyle}
              options={brandOptions}
              labelledBy={labelId}
              onChange={(next) => setBrandStyle(next)}
              testId="setting-brand-style"
            />
          )}
        </Row>
        <Row label={t("settings.mascot")}>
          {(labelId) => (
            <Segmented<MascotCharacter>
              size="sm"
              value={mascot}
              options={mascotOptions}
              labelledBy={labelId}
              onChange={(next) => setMascotCharacter(next)}
              testId="setting-mascot"
            />
          )}
        </Row>
        <Row label={t("settings.processRows")}>
          {(labelId) => (
            <div
              className="st-process-cards"
              role="radiogroup"
              aria-labelledby={labelId}
              data-testid="setting-process-rows"
            >
              {(["flat", "column", "classic"] as const).map((layout) => {
                const active = processRows === layout;
                return (
                  <button
                    key={layout}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className="st-process-card"
                    data-active={active ? "" : undefined}
                    onClick={() => setProcessRowsLayout(layout)}
                    data-testid={`setting-process-rows-${layout}`}
                  >
                    <span className="st-process-sample" data-layout={layout} aria-hidden="true">
                      <span className="st-process-sample-head">{t("settings.processRows.sampleHead")}</span>
                      <span className="st-process-sample-body">
                        <span className="st-process-sample-row" data-kind="thought">
                          <span className="st-process-sample-icon" />
                          <span className="st-process-sample-title">{t("settings.processRows.sampleThought")}</span>
                          <span className="st-process-sample-sep" />
                          <span className="st-process-sample-text">{t("settings.processRows.sampleThought1")}</span>
                        </span>
                        <span className="st-process-sample-row" data-kind="tool">
                          <span className="st-process-sample-icon" />
                          <span className="st-process-sample-title">{t("settings.processRows.sampleTool")}</span>
                          <span className="st-process-sample-sep" />
                          <span className="st-process-sample-text">*.md</span>
                        </span>
                        <span className="st-process-sample-row" data-kind="thought">
                          <span className="st-process-sample-icon" />
                          <span className="st-process-sample-title">{t("settings.processRows.sampleThought")}</span>
                          <span className="st-process-sample-sep" />
                          <span className="st-process-sample-text">{t("settings.processRows.sampleThought2")}</span>
                        </span>
                      </span>
                    </span>
                    <span className="st-process-card-label">{t(`settings.processRows.${layout}`)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Row>
        <Row label={t("settings.backdrop")}>
          {(labelId) => (
            <>
              <Segmented<BackdropMode>
                size="sm"
                value={backdrop}
                options={backdropOptions}
                labelledBy={labelId}
                // 自选图片还没选过：先弹文件对话框（主进程复制好图再切到 custom；取消返回 false，什么都不改）。
                onChange={(next) =>
                  guard(
                    next === "custom" && (settings?.customBackdrop ?? null) === null
                      ? window.studio.chooseBackdropImage()
                      : window.studio.setBackdrop(next),
                  )
                }
                testId="setting-backdrop"
              />
              {backdrop === "custom" && (
                <Button
                  size="sm"
                  onClick={() => guard(window.studio.chooseBackdropImage())}
                  testId="setting-backdrop-choose"
                >
                  {t("settings.backdrop.choose")}
                </Button>
              )}
            </>
          )}
        </Row>
        {backdrop !== "none" && (
          <Row label={t("settings.backdropStrength")}>
            {(labelId) => (
              <Segmented<BackdropStrength>
                size="sm"
                value={settings?.backdropStrength ?? "medium"}
                options={strengthOptions}
                labelledBy={labelId}
                onChange={(next) => guard(window.studio.setBackdropStrength(next))}
                testId="setting-backdrop-strength"
              />
            )}
          </Row>
        )}
        {glassSupported && (
          <Row label={t("settings.glass")}>
            {(labelId) => (
              <Switch
                checked={settings?.glass ?? false}
                labelledBy={labelId}
                onChange={(next) => guard(window.studio.setGlass(next))}
                testId="setting-glass"
              />
            )}
          </Row>
        )}
        <Row label={t("settings.language")}>
          {(labelId) => (
            <Segmented<LocalePreference>
              size="sm"
              value={settings?.locale ?? "system"}
              options={localeOptions}
              labelledBy={labelId}
              onChange={(next) => void window.studio.setLocale(next)}
              testId="setting-language"
            />
          )}
        </Row>
        <Row label={t("settings.fontSize")}>
          {(labelId) => (
            <Select<`${number}`>
              size="sm"
              value={`${settings?.fontSize ?? defaultFontSize}`}
              options={fontSizeOptions}
              labelledBy={labelId}
              onChange={(next) => void window.studio.setFontSize(Number(next))}
              testId="setting-font-size"
            />
          )}
        </Row>
        <Row label={t("settings.uiFontStyle")}>
          {(labelId) => (
            <Segmented<FontStyle>
              size="sm"
              value={uiFontStyle}
              options={fontStyleOptions}
              labelledBy={labelId}
              onChange={(next) => setUiFontStyle(next)}
              testId="setting-ui-font-style"
            />
          )}
        </Row>
        <Row label={t("settings.uiFontFamily")}>
          {(labelId) => (
            <>
              <Select<string>
                size="sm"
                width="220px"
                value={uiFontFamily}
                options={uiFontOptions}
                search={t("settings.font.search")}
                labelledBy={labelId}
                onChange={(next) => setUiFontFamily(next)}
                testId="setting-ui-font-family"
              />
              <Button size="sm" loading={fontsLoading} onClick={refreshFonts} testId="setting-font-refresh">
                {t("settings.font.refresh")}
              </Button>
            </>
          )}
        </Row>
        <Row label={t("settings.chatFontStyle")}>
          {(labelId) => (
            <Segmented<FontStyle>
              size="sm"
              value={chatFontStyle}
              options={fontStyleOptions}
              labelledBy={labelId}
              onChange={(next) => setChatFontStyle(next)}
              testId="setting-chat-font-style"
            />
          )}
        </Row>
        <Row label={t("settings.chatFontFamily")}>
          {(labelId) => (
            <Select<string>
              size="sm"
              width="220px"
              value={chatFontFamily}
              options={chatFontOptions}
              search={t("settings.font.search")}
              labelledBy={labelId}
              onChange={(next) => setChatFontFamily(next)}
              testId="setting-chat-font-family"
            />
          )}
        </Row>
        <Row label={t("settings.motion")}>
          {(labelId) => (
            <>
              <Switch
                checked={(settings?.reduceMotion ?? false) || systemMotion}
                disabled={systemMotion}
                labelledBy={labelId}
                onChange={(next) => void window.studio.setReduceMotion(next)}
                testId="setting-motion"
              />
              {systemMotion && <Badge>{t("settings.motion.system")}</Badge>}
            </>
          )}
        </Row>
        <Row label={t("settings.homeRipple")}>
          {(labelId) => (
            <Switch
              checked={homeRipple}
              disabled={(settings?.reduceMotion ?? false) || systemMotion}
              labelledBy={labelId}
              onChange={(next) => setHomeRipple(next)}
              testId="setting-home-ripple"
            />
          )}
        </Row>
        <Row label={t("settings.copyOnSelect")} info={t("settings.copyOnSelect.desc")}>
          {(labelId) => (
            <Switch
              checked={settings?.copyOnSelect ?? true}
              labelledBy={labelId}
              onChange={(next) => void window.studio.setCopyOnSelect(next)}
              testId="setting-copy-on-select"
            />
          )}
        </Row>
        <Row label={t("settings.toolHeadsOnly")}>
          {(labelId) => (
            <Switch
              checked={settings?.toolHeadsOnly ?? false}
              labelledBy={labelId}
              onChange={(next) => void window.studio.setToolHeadsOnly(next)}
              testId="setting-tool-heads-only"
            />
          )}
        </Row>
        <Row label={t("settings.autoCollapseTools")} info={t("settings.autoCollapseTools.desc")}>
          {(labelId) => (
            <Switch
              checked={settings?.autoCollapseTools ?? true}
              labelledBy={labelId}
              onChange={(next) => void window.studio.setAutoCollapseTools(next)}
              testId="setting-auto-collapse-tools"
            />
          )}
        </Row>
        <Row label={t("settings.autoCollapseDiffs")} info={t("settings.autoCollapseDiffs.desc")}>
          {(labelId) => (
            <Switch
              checked={settings?.autoCollapseDiffs ?? true}
              labelledBy={labelId}
              onChange={(next) => void window.studio.setAutoCollapseDiffs(next)}
              testId="setting-auto-collapse-diffs"
            />
          )}
        </Row>
        <Row label={t("settings.preferredShell")} info={t("settings.preferredShell.desc")}>
          {(labelId) => (
            <Select<PreferredShell>
              size="sm"
              value={preferredShell}
              options={shellOptions}
              labelledBy={labelId}
              onChange={(next) => setPreferredShell(next)}
              testId="setting-preferred-shell"
            />
          )}
        </Row>
      </div>
      <SectionHead title={t("settings.notifications")} />
      <div className="st-cells" data-testid="notify-settings">
        <Row label={t("settings.soundOnDone")}>
          {(labelId) => (
            <Switch
              checked={settings?.soundOnDone ?? false}
              labelledBy={labelId}
              onChange={(next) => void window.studio.setSoundOnDone(next)}
              testId="setting-sound-on-done"
            />
          )}
        </Row>
      </div>
      <SectionHead title={t("settings.whileRunning")} />
      <div className="st-cells">
        <Row label={t("settings.enterBehavior")}>
          {(labelId) => (
            <Segmented<"steer" | "followUp">
              size="sm"
              value={settings?.enterWhileRunning ?? "steer"}
              options={enterOptions}
              labelledBy={labelId}
              onChange={(next) => void window.studio.setEnterWhileRunning(next)}
              testId="setting-enter"
            />
          )}
        </Row>
      </div>
      <SectionHead title={t("settings.idleTasks")} />
      <div className="st-cells">
        <Row label={t("settings.idleClose")} info={t("settings.idleClose.desc")}>
          {(labelId) => (
            <Select<IdleClose>
              size="sm"
              value={settings?.idleClose ?? "1h"}
              options={idleCloseOptions}
              labelledBy={labelId}
              onChange={(next) => void window.studio.setIdleClose(next)}
              testId="setting-idle-close"
            />
          )}
        </Row>
      </div>
      <section id="settings-shortcuts" tabIndex={-1} className="st-section">
        <SectionHead title={t("settings.shortcuts")} />
        <div className="st-kb-grid">
          {shortcuts.map((shortcut) => (
            <div key={shortcut.label} className="st-kb-row">
              <span>{t(shortcut.label)}</span>
              {shortcutKeys(shortcut.keys.join(" ")).map((key) => (
                <kbd key={key} className="kbd">
                  {key}
                </kbd>
              ))}
            </div>
          ))}
        </div>
        <SectionHead title={t("settings.shortcuts.omp")} />
        <div className="st-kb-grid" data-testid="omp-shortcuts">
          {ompKeybindings.map((binding) => (
            <div key={binding.action} className="st-kb-row" data-testid={`omp-shortcut-${binding.action}`}>
              <span>{t(ompActionLabels[binding.action] ?? "shortcut.ompThinkingCycle")}</span>
              {binding.chords.map((chord, index) => (
                <Fragment key={chord}>
                  {index > 0 && <span className="st-kb-or">/</span>}
                  {chordKeys(chord).map((key) => (
                    <kbd key={key} className="kbd">
                      {key}
                    </kbd>
                  ))}
                </Fragment>
              ))}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
