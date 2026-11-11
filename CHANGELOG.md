# 更新日志

pi-studio 每个版本的变化，写给用户看。版本号按 [SemVer](https://semver.org/lang/zh-CN/)：修 bug 升第三位，加功能升第二位。

写法：

- 还没发版的改动记在"未发布"下面，按"新增 / 修复 / 变更"分组，每条一句话，说用户能看到的变化，不写内部实现。同一条英文写进 `CHANGELOG.en.md` 的"Unreleased"。
- 发版脚本（`npm run release -- <版本>`）把两个文件的"未发布"都改成 `[<版本>] - <日期>`，任一边没有条目就不发；GitHub Release 的说明英文在前、中文在后；应用里的"更新日志"按界面语言读打包进去的这两个文件。

## [未发布]

## [0.1.1] - 2026-11-11

### 修复

- 修复在极快响应（如缓存命中、本机即时响应或 macOS / Linux 管道合并帧）下，任务完成后状态仍停留在运行中的问题。

## [0.1.0] - 2026-11-11

### 新增

- 发布基于 `@earendil-works/pi-coding-agent`（Pi 1.5.2+）的首个原生桌面端版本，通过 `pi --mode rpc` 直接连接本机 `pi`，与终端版完整共用 `~/.pi/agent/` 的设置、凭据与会话历史。
- 全新设计 8 大分区 Pi 专属设置中心（通用、Provider 与凭据、模型与思考、会话与 Context、扩展与包和 Skill、工具与系统提示词、网络与高级、快捷键、关于），支持全局与项目级 `.pi/` 双作用域读写。
- 全面适配 Pi 1.5.2 斜杠命令体系（`/settings`、`/model`、`/thinking`、`/scoped-models`、`/mcp`、`/login`、`/logout`、`/new`、`/resume`、`/name`、`/session`、`/usage`、`/tree`、`/fork`、`/clone`、`/compact`、`/copy`、`/export`、`/reload`、`/btw`、`/git`、`/hotkeys`、`/changelog`、`/delete`），并支持 7 档思考强度（`off` 至 `max`）连续滑块调节。
- 空白首页提供 365 天 `.jsonl` 会话用量热力图与按模型堆叠柱状图看板、字符波纹背景动效，侧栏收起时支持左缘悬停临时滑出抽屉，任务状态采用极简柔光状态圆点。
- 内置文件树与预览、单文件变更对比、Git 评审与按行暂存、独立 worktree 任务、内置终端、会话分支树与导出 HTML 功能，提供 18 套深浅主题。
