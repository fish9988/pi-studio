# UI/UX 深化与下阶段交接文档（Handoff）

> 生成时间：2026-11-14 | 当前分支：`main` | 最新版本：`v0.5.0`（P0-1、P0-2、4 款融合 UI 风格、分区域背景覆盖/独立透明率、9 大主题家族全部落地）

---

## 一、当前仓库状态与已完成交付（`v0.2.0` → `v0.3.0`）

### 1. 已上线版本与产物
- **Git 提交链**：
  - `25fbc7e`：`feat(ui,pi)` — 首轮 M3 Expressive × Fluent 2 × Liquid Glass 架构重构、UI 与聊天字体独立设置、过程区阅读保护、`Overview` 2×2 磁贴、模型目录与长历史分帧挂载。
  - `aeca1dd` (`v0.2.0`) → `44a195f` → `6e29d42` (`v0.3.0`)：全量替换 6 大双模式主题家族、默认折叠暗色代码块、发送后用户气泡内联 `#N` 药丸芯片、剪贴板全量复制（含图片 `<img>` 富文本）、支持图片/文件上下文的提示词优化，以及移除旧版「过程行」三卡切换。
- **GitHub Release**：`v0.3.0` 已设 `Latest`，Windows（`latest.yml` + `setup.exe` + `.blockmap`）、macOS arm64（`.dmg` + `.zip`）、Linux x64（`latest-linux.yml` + `.AppImage`）三端 CI 全绿。

### 2. 已落地的核心模块与文件索引
- **主题与令牌**：
  - `src/shared/themes.ts`：6 大双模式家族（`default` 灵动紫晶、`mica` 冰川云母、`aurora` 极光翠雾、`coral` 液态珊瑚、`amber` 钛金琥珀、`obsidian` 曜石深空），含旧版主题平滑迁移逻辑 `familyOfTheme`。
  - `src/renderer/styles/tokens.css` & `src/renderer/styles/themes.css`：全套 CSS tokens + `[data-code-dark]` Shiki 暗色代码块令牌（`scripts/check.ts` 要求 `--shiki-*` 声明只能写在 `tokens.css` 内）；`src/renderer/styles/themes/*.svg` 与 `thumbs/*.webp`（需用 `node scripts/make-theme-thumbs.ts` 同步生成）。
- **UI 与聊天字体独立设置**：
  - `src/shared/ipc.ts`、`src/main/window/window-state.ts`、`src/main/ipc/app-handlers.ts`、`src/main/window/security.ts`（开放 `local-fonts` 权限）、`src/renderer/src/app/shell-store.ts`、`src/renderer/src/app/App.tsx`（实时同步 `--font-sans` 与 `--font-display`）、`src/renderer/src/features/settings/local-fonts.ts`（`window.queryLocalFonts()` 枚举本机字体）、`src/renderer/src/features/settings/GeneralSection.tsx`。
- **代码块与消息流**：
  - `src/renderer/src/markdown/CodeBlock.tsx` & `markdown.css`：默认折叠（`standalone` 预览页与 `svg/mermaid` 图表除外）、点击标题栏/箭头展开、语言+行数+首行摘要。
  - `src/renderer/src/markdown/Markdown.tsx` & `src/renderer/src/features/tsp/nodes/{text,layout,data}.tsx` & `TspView.tsx`：发送后的用户消息将 `[Image #N, WxH]` / `[Paste #N]` / `[File #N]` 渲染为可点击内联 `#N` 药丸芯片，并将 `omp.user.images` 缩略图条（带 `#N` 角标）置顶显示。
  - `src/renderer/src/features/tsp/reading-hold.ts` & `MainFlow.tsx` & `nodes/layout.tsx`：基于焦点与选区的 `ownsReadingPosition` 阅读保护（防止正在读/划词时过程块自动收起）+ 左缘快捷收起轨 `.tsp-collapse-rail` + 合并后的单个统一过程胶囊 `.tsp-process-summary` + 右下角安全区 `.tsp-jump` 悬浮按钮。
- **输入框全量复制与多模态提示词优化**：
  - `src/renderer/src/features/composer/EnhancePromptButton.tsx` & `ComposerInput.tsx` & `src/main/ipc/app-handlers.ts`（`copyDraftToClipboard` 用 Electron 44 `ClipboardItem` 同步写 `text/plain`、`text/html` 含 `<img>` 与单图 PNG）& `src/main/tasks/ai-helper.ts`（`enhancePrompt` 将草稿图片写入临时目录并通过 `pi -p -- @img ...` 传给辅助模型，仅替换文本，完整保留附件）。

---

## 二、用户最新反馈与下阶段 P0 待办（新会话优先处理）

用户在实机体验 `v0.3.0` 后给出明确反馈，以下三项为**最高优先级**：

### P0-1：回退顶栏多图标回归，恢复「单个右栏切换按钮」（对应反馈 `[Image #1]`）
- **现状问题**：`v0.3.0` 在 `src/renderer/src/app/TopBar.tsx` 与 `src/renderer/src/app/app.css` 中把 `.topbar-legacy-toggles` 改成了直接可见（导致顶栏右侧一下子出现 6 个图标：Files / Changes / Agents / Browser / Terminal / Settings）。
- **用户明确要求**：**顶栏右侧只需要保留一个工作台/侧栏切换按钮（如 `FilesToggle` / `[|]`，加上有仓库时的 Git 分支轻胶囊），所有子面板工具（Review / Files / Terminal / Browser / Extensions / Subagents）全部收进右侧 `Overview` 面板里切换**，设置入口继续放在左侧栏底部即可。
- **实施注意**：
  1. 清理 `TopBar.tsx` 中多余的可见图标按钮（如 `topbar-settings`）；
  2. 将 `.topbar-legacy-toggles` 恢复为视觉隐藏兜底（或重构相关 E2E 测试改为经快捷键 / `Overview` 磁贴触发：`test/e2e/main-ui.e2e.ts:603`、`test/e2e/browser.e2e.ts`、`test/e2e/git-worktree.e2e.ts:336` 会查找 `topbar-changes` / `topbar-browser` / `topbar-terminal`，若隐藏需注意 `git-worktree.e2e.ts:336` 对 `toBeVisible()` 的断言，同步更新该用例即可）；
  3. 同步更新 `test/e2e/pi-ui-redesign.e2e.ts` 中通过 `topbar-settings` 打开设置页的步骤（改用 `Control+,` 或侧栏底部设置按钮）。

### P0-2：视觉向用户认可的 SVG 初版原型对齐（对应反馈 `[Image #2]`、`[Image #3]`）
用户贴出了早期认可的 `fluent-mica` SVG 原型图，与当前 `v0.3.0` 相比，需要重点打磨以下视觉与排版细节：
1. **默认浅色气质与代码块色差选项**：
   - 原型图核心特征：**冷白纯净主画布 `#FFFFFF` + 桌面冰蓝云母层 `#EBF1FA` + 浅冷灰代码块 `#F2F5FA` + 克制清晰的 Fluent `#0F6CBD` 天青主色 + 高光玻璃条收拢面包屑与发送浮岛**。
   - 当前 `v0.3.0` 将默认主题设为了紫晶（`default`），且强制浅色下也用深靛蓝代码块（`[data-code-dark]`）。建议：
     - 评估将**「冰川云母（Glacier Mica：#EBF1FA / #FFFFFF / #0F6CBD）」设为默认主题**（或把原型图的冷灰代码块 `#F2F5FA` 与深色代码块做成可随主题区分：例如经典云母浅色用 `#F2F5FA` 浅冷灰代码卡，Expressive 紫晶保留深靛蓝代码卡，或提供浅/深代码块风格选项），同时确保 `test/themes.test.ts` 的 WCAG 对比度全部通过。
2. **左侧栏信息密度重构**：
   - 对比原型图 `[Image #2]`：当前侧栏 `HistorySection.tsx` 的标题行把 `会话`、`进行中`、`文件夹`、`时间` 与折叠按钮挤在窄宽同一行里，略显拥挤。
   - 建议参考原型图：把 `会话` 与操作区整理得更舒展（例如两行或更轻量的胶囊 Tab：`文件夹 | 时间` + 独立的 `运行中 N` 状态徽标），移除多余视觉噪音，保留清晰的左侧 `3px` 主题色选中条与紧凑计数。
3. **主区头部与整体精致度**：
   - 对话页内的 `StudioHeader`（每条对话顶部都出现一次大图标 + `pi studio v0.1.x`）占用了首屏黄金高度，可评估收窄为极简标题条或仅在空状态展示（注意 `test/e2e/tsp.e2e.ts:221` 断言 `[data-testid="tsp-view"] [data-testid="studio-header"] [data-testid="pixel-logo"]` 存在，如移除需同步调整该用例）。
   - 底部桌宠图标在窄窗下仍易贴边裁切，进一步缩小或改用不遮挡内容的安全锚点。

### P0-3：已知历史非回归 E2E 用例说明
以下失败为接手前仓库迁移遗留，与本次 UI 改动无关（后续如要全绿可顺手清理）：
- `test/e2e/main-ui.e2e.ts` 第 166 行、520 行：断言 `draft-composer` 内有 `usage-cost`，而 `DraftComposer.tsx` 已改用 `DraftContextMeter`。
- `test/e2e/settings-functional.e2e.ts` 与 `test/e2e/files-panel.e2e.ts` 第 333 行、`test/e2e/file-preview.e2e.ts` 第 116+ 行：仍启动旧 `STUDIO_TEST_OMP` 假进程。

---

## 三、新会话必守规则与常用命令

1. **红线与检查门禁**：
   - 提交与发版前必跑：`npm run check`（`oxlint --deny-warnings` + `prettier --check .` + `tsc -b` + `scripts/check.ts`）。
   - `scripts/check.ts` 机械禁令：`src/renderer/src/features/(tsp|sidebar)/` 禁 `:has()`（除 `tsp.css` 2 处白名单）、`--shiki-*` 仅允许写在 `tokens.css`、CSS 禁止跨模块同名独立类选择器（`css-duplicate-class`）、渲染进程整秒计时统一走 `use-now.ts`。
   - **禁止在本机运行 `scripts/smoke-packaged.ts`**，禁止触碰已安装的 `%LOCALAPPDATA%\Programs\pi-studio` 与 `%APPDATA%\pi-studio`。
2. **改完主题/SVG 后必跑**：
   - PowerShell 下清除 `ELECTRON_RUN_AS_NODE` 后执行 `node scripts/make-theme-thumbs.ts`，随后跑 `npx vitest run test/themes.test.ts`。
3. **验证与发版流程**（详见 `.agents/skills/release/SKILL.md`）：
   - 构建与主测试：`npm run build` → `npx vitest run` → `npx playwright test test/e2e/pi-ui-redesign.e2e.ts test/e2e/themes.e2e.ts test/e2e/studio-polish.e2e.ts test/e2e/backdrop.e2e.ts test/e2e/pi-settings.e2e.ts`
   - 打包与发版：先更新 `CHANGELOG.md` / `CHANGELOG.en.md`，`npm version <x.y.z> --no-git-tag-version` → `npm run dist` → 提交并打 tag → 清除 `Env:GITHUB_TOKEN` 后 `git push origin main` & `git push origin v<x.y.z>` → `node scripts/publish-release.ts <x.y.z> release/latest.yml release/pi-studio-<x.y.z>-setup.exe release/pi-studio-<x.y.z>-setup.exe.blockmap`。

---

## 四、给下一位助手的建议开场指令

> 请先阅读 `AGENTS.md` 和 `docs/agents/handoff-ui-refinement.md`，了解当前 `v0.3.0` 状态与用户最新截图反馈。优先处理 `P0-1`（顶栏右侧仅保留单个右栏切换按钮，去掉多余可见图标）与 `P0-2`（将视觉、配色、代码块冷灰/暗色层次与侧栏布局向 `docs/agents/handoff-ui-refinement.md` 记录的用户 SVG 原型风格精修对齐），跑通 `npm run check`、单测及 Playwright E2E，并实机截图自检确认后再汇报或发版。
