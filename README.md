<div align="center">
  <img src="docs/images/icon.png" width="128" height="128" alt="pi-studio icon">
  <h1>pi-studio</h1>
  <p>A native desktop studio for <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent">Pi Coding Agent</a> (<code>pi</code>). Runs your local <code>pi --mode rpc</code> directly and shares credentials, settings, extensions, MCP servers, skills, and sessions in <code>~/.pi/agent</code>.</p>
  <p><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="#download">Download</a> ·
    <a href="CHANGELOG.en.md">Changelog</a> ·
    <a href="https://github.com/fish9988/pi-studio/issues">Feedback</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Windows-x64-0078D4?logo=windows&logoColor=white" alt="Windows x64">
    <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple&logoColor=white" alt="macOS Apple Silicon">
    <img src="https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white" alt="Electron 44">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
  </p>
</div>

## Why pi-studio

- **Powered by real `pi`.** Every task spawns your installed `@earendil-works/pi-coding-agent` (`pi --mode rpc`) directly without shell wrappers, streaming live assistant replies, thinking traces, tool executions, and extension UI dialogs.
- **Zero migration.** Settings (`settings.json`), custom providers (`models.json`), credentials (`auth.json` & `.env`), MCP servers (`mcp.json`), skills (`skills/`), and session trees (`sessions/*.jsonl`) live in `~/.pi/agent` and `.pi/`, shared seamlessly with terminal `pi`.
- **Tailored for Pi 1.5+.** Purpose-built 8-section Settings center, 24 Pi-native `/` slash commands (`/thinking`, `/scoped-models`, `/clone`, `/tree`, `/fork`, `/compact`, `/mcp`, `/reload`, …), and a 7-level thinking effort slider (`off` → `max`).
- **Full desktop engineering workbench.** Flush borderless layout across 18 themes, left-edge peek sidebar with minimal status dots, Bento usage heatmap & model chart, 4-mode right inspector (Files / Git Changes / Subagent / Browser), per-line Git staging, Git worktrees, and built-in terminal.

## Download

| Windows (x64) | macOS (Apple silicon) | Linux (x64) |
| --- | --- | --- |
| [`pi-studio-<version>-setup.exe`](https://github.com/fish9988/pi-studio/releases/latest) | [`pi-studio-<version>-arm64.dmg`](https://github.com/fish9988/pi-studio/releases/latest) | [`pi-studio-<version>-x86_64.AppImage`](https://github.com/fish9988/pi-studio/releases/latest) |

### Prerequisites

Install `pi` globally via npm so `pi` is available on your `PATH`:

```bash
npm install -g @earendil-works/pi-coding-agent
```

## Development

Requires Node.js 24 or later.

```powershell
npm ci
npm run dev        # development with hot reload
npm run check      # typecheck + oxlint + CSS & repo invariants
npm test           # unit tests (Vitest)
npm run dist       # Windows NSIS installer -> release/
```

## License

[MIT](LICENSE)
