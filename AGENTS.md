# AGENTS.md

`pi-studio`：基于 **Pi（`@earendil-works/pi-coding-agent` `v1.5.2+`）** 的原生桌面工作台（Electron + React + TypeScript，Windows 为主，同时构建 macOS Apple Silicon `.dmg`/`.zip` 与 Linux x64 `.AppImage`）。仓库地址：`https://github.com/fish9988/pi-studio`。用户当前这句话优先于本文件。

## 架构速览（新开会话必读）

本仓库从早期的 studio 底座演进而来，**所有活跃的 Agent 运行时、配置读写与设置界面均已切换至原生 Pi 链路**：

- **主进程 Pi 核心（`src/main/pi/`，唯一活跃引擎）**：
  - `discover.ts`：跨平台发现本机 `pi` CLI（Windows 将 `pi.cmd` 解析为 `node <cli.js>` 直连，避免 `cmd.exe` 吞信号），并管理 `%LOCALAPPDATA%\pi-studio\runtime` 独立运行时安装/升级；未打包测试时将 `STUDIO_TEST_PI` / `STUDIO_TEST_OMP` 自动路由到 `test/fake-pi/fake-pi.mjs`。
  - `pi-rpc-client.ts`：驱动 `pi --mode rpc` 子进程 JSONL 通信。**严格仅按 `\n`（剥离可选 `\r`）切帧**，禁用 `readline`（防止消息正文含 `U+2028`/`U+2029` 被截断）；Windows 绑定 `assignToOwnJob`，退出走 `killProcessTree`。
  - `pi-tsp-bridge.ts`：把 Pi RPC 流式事件（`message_*`、`tool_execution_*`、`extension_ui_request`）与 `~/.pi/agent/sessions/**/*.jsonl` 会话文件实时映射为 `TspDocument`，供渲染层 `TspView` 渲染对话/轨迹双视图。
  - `pi-task-runner.ts`：实现 `TaskPool` 任务生命周期、发消息、`steer` / `followUp` 队列、`/btw` 侧边问答（`pi -p --no-session --no-tools`）、`/compact`、`/export`、会话分支树及 `fork` / `clone` / 回退。
  - `pi-service.ts`：后台轻量查询（模型目录缓存、斜杠命令发现、离线 HTML 导出）。
  - `pi-config.ts` + `src/main/ipc/pi-handlers.ts` + `src/shared/pi-settings-schema.ts`：读写全局 `~/.pi/agent/` 与项目 `<cwd>/.pi/` 下的 `settings.json`、`models.json`、`auth.json`、`.env`、`mcp.json`、`keybindings.json`、`AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`、`skills/`、`prompts/`、`extensions/` 及 `pi install/remove/update/list` 包管理。
- **渲染进程关键模块（`src/renderer/src/`）**：
  - **Pi 8 大设置中心**：`features/settings/SettingsView.tsx` 与 `features/settings/pi/Pi*Section.tsx`（通用、Provider 与凭据、模型与思考、会话与 Context、扩展/包与 Skill、工具与系统提示词、网络与高级、快捷键、关于）。
  - **Pi `/` 斜杠命令与命令面板**：`src/shared/omp-output/slash-table.ts`（24 条 Pi 1.5.2 原生命令）与 `features/palette/slash-commands.ts`（**禁止合并旧 TUI 命令**，防止非 Pi 命令如 `/goal`、`/vibe` 混入菜单）。
  - **主工作区**：侧栏（`features/sidebar/`，6px 柔光任务状态圆点、左缘悬停抽屉）、首页 365 天 `.jsonl` 用量 Bento 看板（`features/conversation/EmptyState.tsx`）、对话与轨迹视图（`features/tsp/`）、四模式右侧工作台（`features/workbench/`：文件 / 变更 / 子代理 / 浏览器）、Git 评审与独立 worktree（`features/review/`）。
- **遗留命名注意**：`src/shared/omp-*` 与 `src/main/omp*` 中仍保留部分共用数据结构定义（如 `ThinkingLevel`、`ModelOption`、`AvailableSlashCommand`）及历史兼容层，但运行时入口 `src/main/tasks/runtime.ts` 与 `src/main/ipc/register.ts` 只走 `src/main/pi/`。开发新功能或修 bug 请走 `pi` 链路，详细边界见 `docs/architecture/pi-architecture.md`。

## 常用命令（Git Bash / PowerShell）

- **收工前必跑**：`npm run check`（依次执行 `oxlint --deny-warnings`、`prettier --check .`、`tsc -b` 与 `scripts/check.ts` 仓库安全/规范扫描；pre-commit hook 也会跑）。
- **格式化**：`npm run format`。
- **单测**：
  - Pi 核心单测：`npx vitest run test/pi-rpc-client.test.ts test/pi-tsp-bridge.test.ts test/pi-config.test.ts test/pi-slash-table.test.ts test/model-catalog-cache.test.ts`
  - 按改动跑关联单测：`npx vitest related <改过的源文件> --run`；全量：`npx vitest run`。
- **端到端测试（Playwright）**：先 `npm run build`，再运行：
  - 主流程冒烟：`npx playwright test test/e2e/main-ui.e2e.ts -g "没有项目时直接发送"`
  - Pi 设置与 `/` 命令冒烟：`npx playwright test test/e2e/pi-settings.e2e.ts`
  - 跑会启动 Electron 的命令时，输出不要接 `| head`（管道提前关闭会导致子进程来不及清理）。
- **本地开发预览与打包**：
  - 开发热更：`npm run dev`
  - Windows 安装包构建：`npm run dist`（生成 `release/pi-studio-<版本>-setup.exe`、`release/win-unpacked/pi-studio.exe` 并跑 `scripts/check-package.ts` 校验 `app.asar`）。
- **GitHub CLI 鉴权**：本机环境变量里可能带有无仓库写权限的 `GITHUB_TOKEN`，运行 `gh` 或 `scripts/publish-release.ts` 前先清除它（Bash：`env -u GITHUB_TOKEN gh ...`；PowerShell：`Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue`），使 `gh` 使用 keyring 登录的 `fish9988` 账号。

## 动手前读

- Pi 运行时、RPC 协议、配置文件映射与防坑细节：`docs/architecture/pi-architecture.md`。
- 测试、隔离与回放规范：`docs/architecture/testing.md`。
- Electron 安全、CSP、日志脱敏与密钥边界：`docs/architecture/security.md`。
- 性能与渲染卡顿排查：`docs/architecture/performance.md`。
- macOS / Linux 打包与自动更新细节：`docs/architecture/mac.md`、`docs/architecture/linux.md`、`docs/architecture/auto-update.md`。

## 先停下来问

说明理由和备选方案，等仓库所有者确认再动手：

- 更换技术栈（构建、测试、打包、lint、状态管理、i18n）或新增任何 npm 依赖。
- 在 `pi-config.ts` 已纳管范围之外新增对用户真实 `~/.pi` 目录的自动写入逻辑。
- 使用 `@earendil-works/pi-coding-agent` RPC 规范中不存在的命令或事件字段。
- `--force` 推送、改写已推送的 git 历史、删除已发布的 tag / Release、修改代码签名或自动更新源。
- 新增把用户代码或会话内容发送到外部第三方服务的功能。

## 红线（不可逆，或会动到所有者的机器）

- **严禁修改同级兄弟目录**（如 `../omp-studio`、`../dsh-claude-style`）：所有改动严格限制在 `pi-studio` 仓库目录内。
- **不碰所有者正在使用的真实环境与已装应用**：
  - 不碰 `%LOCALAPPDATA%\Programs\pi-studio`、`%LOCALAPPDATA%\Programs\omp-studio`、`%APPDATA%\pi-studio`、`%APPDATA%\omp-studio`。
  - PATH 上用户自己安装的全局 `pi` 只读：不改其安装目录、不覆盖其二进制。
  - **严禁在本机运行 `scripts/smoke-packaged.ts`**：打包后的 `pi-studio.exe` 不读 `STUDIO_USER_DATA`，在 Windows 上会直接读写 `%APPDATA%\pi-studio`；该脚本仅在干净的 CI 机器上运行。
- **`~/.pi/agent` 与终端版 `pi` 共用**：
  - 修改配置必须经 `pi-config.ts` 的 `atomicWrite`（保留未知字段，写前留 `.bak` 语义），API Key / OAuth 凭据**只进不出**（绝不返回明文给渲染进程、绝不写入日志）。
  - 单测与 E2E 一律通过临时目录隔离 `PI_CODING_AGENT_DIR` 与 `STUDIO_USER_DATA`；常驻 shell 里绝不 `export` 这两个隔离变量（只作单条命令前缀或放进子进程 `env`）。
- **多个子代理共用工作区时**：谁都不跑 `git checkout` / `restore` / `stash` / `reset` / `clean`；看原内容用 `git show HEAD:<path>` 或 `git diff`。
- **不留孤儿进程**：所有退出路径必须关掉 `pi` 子进程与终端 pty，新增退出入口统一走 `src/main/window/shutdown.ts`。
- **仓库公开**：被跟踪文件、CHANGELOG 和提交信息里绝不能包含本机私人路径、真实密钥或敏感信息（`npm run check` 会扫描拦截）。

## 代码看不出来的跨平台与协议坑

- **POSIX 管道单帧合并竞态**（`pi-task-runner.ts`）：在 macOS / Linux 管道中，子进程连续写出的 `response(prompt)`、`agent_start`、`agent_end` 常合并为单个 `stdout` 数据块；同步事件回调会先于 `await client.prompt()` 的 Promise 微任务恢复执行。对乐观状态翻转必须校验 `#agentLifecycleSeq`，否则极快完成的轮次会把已归回 `idle` 的状态机重新卡死在 `running`（回归用例见 `test/pi-tsp-bridge.test.ts`）。
- **macOS 临时目录软链**：macOS 的 `os.tmpdir()`（`/var/folders/...`）实际软链到 `/private/var/folders/...`，子进程内 `process.cwd()` 返回解析后的真实路径；测试中断言路径相等一律两边 `await realpath(...)`。
- **macOS 应用主修饰键**：应用级快捷键在 macOS 上是 `Meta`（`⌘`），Windows / Linux 上是 `Control`（见 `src/renderer/src/app/platform-keys.ts` 的 `primaryMod`）；编写跨平台 Playwright E2E 按键时须按 `process.platform === "darwin" ? "Meta+..." : "Control+..."` 分支。
- **安全与扫描硬规则**（`scripts/check.ts` 机械拦截）：
  - 起子进程禁 `shell: true`，参数一律传数组；
  - `BrowserWindow` 必须开启 `contextIsolation` 与 `sandbox`，禁 `nodeIntegration` 与 `webviewTag`；
  - 除 `src/renderer/src/markdown/render.ts` 的 KaTeX 渲染外禁 `dangerouslySetInnerHTML`；
  - 渲染进程整秒刷新统一走 `features/conversation/use-now.ts`，禁散落 `setInterval(..., 1000)`。
- **Windows PowerShell 细节**：临时 `.ps1` 只用 ASCII 或带 BOM 的 UTF-8；从 bash 调 PowerShell 时整条命令用单引号包裹，防止 `$_`、`$r` 被 bash 提前展开；结束占用 `release\` 的进程时必须按 `$_.Path -like "$r\*"` 精确过滤，绝不按进程名通杀。
- **界面极简克制**：不堆砌冗余副标题、解释性小字和多余状态符号；能靠分组、对齐、控件本身表达清楚的就不多写字（危险操作确认、错误提示和数据丢失警告除外）。

## 怎么干活

- **先判大小**：小改直接做；跨模块（渲染 ↔ preload ↔ IPC ↔ 主进程 ↔ `pi`）、改协议/配置格式或大改界面结构时，先参考 `.agents/skills/plan/SKILL.md` 列清计划再动手。
- **沿整条链路核查**：渲染进程 → `preload/index.ts` → `shared/ipc.ts` & `main/ipc/validate.ts` → `main/ipc/*-handlers.ts` → `main/pi/*` → 界面回显。
- **验证与收尾**：改完跑通 `npm run check`、对应单测与必要的 Playwright E2E；回归测试应确认去掉修复会失败。评审参考 `.agents/skills/review/SKILL.md`，提交收尾参考 `.agents/skills/finish/SKILL.md`。
- **发版**：仅在仓库所有者明确要求发版/打包上架时执行，流程见 `.agents/skills/release/SKILL.md`（推送 `main` 与 `v<版本>` 标签会同时触发 `.github/workflows/{windows,mac,linux}.yml` 自动构建并上传 macOS `.dmg`/`.zip` 与 Linux `.AppImage` 到同一 GitHub Release）。

## 犯错之后

优先把教训固化成 `oxlint` 规则、单测/E2E、`scripts/check.ts` 扫描项或 git hook；无法机械拦截的，再写入 `docs/architecture/pi-architecture.md` 或在本文件对应小节补一行「正确做法 + 原因」。
