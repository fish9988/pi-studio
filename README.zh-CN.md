<div align="center">
  <img src="docs/images/icon.png" width="128" height="128" alt="pi-studio 图标">
  <h1>pi-studio</h1>
  <p><a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent">Pi Coding Agent</a>（<code>pi</code>）原生桌面工作台。直接连接本机 <code>pi --mode rpc</code>，与终端版无缝共用 <code>~/.pi/agent</code> 下的设置、凭据、MCP、Skill 与会话历史。</p>
  <p><a href="README.md">English</a> · <b>简体中文</b></p>
  <p>
    <a href="#下载">下载</a> ·
    <a href="CHANGELOG.md">更新日志</a> ·
    <a href="https://github.com/fish9988/pi-studio/issues">反馈</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Windows-x64-0078D4?logo=windows&logoColor=white" alt="Windows x64">
    <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple&logoColor=white" alt="macOS Apple Silicon">
    <img src="https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white" alt="Electron 44">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
  </p>
</div>

## 为什么选择 pi-studio

- **直连本机真实 `pi`。** 每个任务直接拉起本机安装的 `@earendil-works/pi-coding-agent`（`pi --mode rpc`），实时流式呈现思考链、工具执行、文件内联 Diff 与扩展交互弹窗，Windows 下纳入 Job Object 守护子进程树。
- **与终端版零迁移互通。** 全局配置（`~/.pi/agent/settings.json`）、自定义模型（`models.json`）、凭据（`auth.json` 与 `.env`）、MCP 服务器（`mcp.json`）、Skill（`skills/`）和会话树（`sessions/*.jsonl`）与终端 `pi` 完全共用，同时支持项目级 `.pi/` 覆盖。
- **专为 Pi 1.5+ 重构的设置与命令。** 8 大分区专属设置中心，内置 24 条 Pi 原生 `/` 斜杠命令（`/thinking`、`/scoped-models`、`/clone`、`/tree`、`/fork`、`/compact`、`/mcp`、`/reload` 等）与 7 档思考强度（`off` → `max`）滑块。
- **完整桌面研发工作台。** 无边框一体式面板与 18 套主题，收起侧栏左缘悬停滑出抽屉与极简柔光状态点，首页 365 天用量 Bento 看板与字符波纹动效，右侧四模式工作台（文件 / 变更 / Subagent / 浏览器）、按行 Git 暂存评审、独立 worktree 与内置终端。

## 下载

| Windows（x64） | macOS（Apple 芯片） | Linux（x64） |
| --- | --- | --- |
| [`pi-studio-<版本>-setup.exe`](https://github.com/fish9988/pi-studio/releases/latest) | [`pi-studio-<版本>-arm64.dmg`](https://github.com/fish9988/pi-studio/releases/latest) | [`pi-studio-<版本>-x86_64.AppImage`](https://github.com/fish9988/pi-studio/releases/latest) |

### 前置依赖

请先通过 npm 全局安装 `pi` CLI（确保 `pi` 在系统 `PATH` 中可用）：

```bash
npm install -g @earendil-works/pi-coding-agent
```

## 开发

需要 Node.js 24 及以上版本。

```powershell
npm ci
npm run dev        # 开发模式（热更新）
npm run check      # 类型检查 + oxlint + CSS 与仓库规范门禁
npm test           # 单元测试（Vitest）
npm run dist       # 打包 Windows NSIS 安装程序（输出到 release/）
```

## 许可证

[MIT](LICENSE)
