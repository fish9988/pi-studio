# Changelog

What changed in each pi-studio release, written for users. Versions follow [SemVer](https://semver.org/): bug fixes bump the patch number, new features bump the minor number.

How to write it:

- This is the English twin of `CHANGELOG.md`. Every entry goes into both files under "Unreleased", grouped as Added / Fixed / Changed, one sentence each about what users see, no implementation details.
- The release script (`npm run release -- <version>`) turns "Unreleased" in both files into `[<version>] - <date>` and refuses to release when either one is empty. The GitHub Release shows this file's section first, then the Chinese one; the in-app changelog follows the UI language.

## [Unreleased]

## [0.1.2] - 2026-11-11

### Added

- Redesigned Settings as a parallel window supporting side-by-side docking, draggable floating mode, minimized corner pill, and standalone OS window pop-out without covering the active conversation.
- Added Pi plugin management and a categorized Plugin Marketplace with curated packages, live npm `keywords:pi-package` search, one-click install/uninstall, and a composer Quick Phrases menu.
- Upgraded Context breakdown into a 9-category multi-color composition bar (System prompt, Skills, Built-in tools, MCP tools, User messages, Assistant replies, Thinking, Tool calls, Tool results) with live session turn/tool/file/command telemetry chips.
- Added `@file` composer reference insertion, file content copy, and Markdown heading outline navigation in the right file preview pane, plus automatic update syncing for private GitHub Releases via `gh` CLI.

### Fixed

- Fixed multi-step tool turns being split into separate process boxes by intermediate empty text blocks and per-step usage footers, consolidating all thoughts and tool calls of a turn into a single unified collapsible card with command and query summaries.
- Fixed smart session rename truncating prompts that start with a Windows drive path (`C:\...`) into a single letter `"C"`.
- Fixed `readPreviewFile` failing with `path must be relative` when previewing cross-directory files from the default chat folder, and stopped `read` tool calls from generating false deliverable cards.

### Changed

- Streamlined compaction, general, and advanced settings, updated the composer thinking indicator to a pill badge, added folder icons and nested tree guides to the sidebar, and added direct session deletion.

## [0.1.1] - 2026-11-11

### Fixed

- Fixed a race where tasks could stay marked as running after finishing a very fast turn (such as cached responses or coalesced pipe frames on macOS and Linux).

## [0.1.0] - 2026-11-11

### Added

- Initial desktop release of `pi-studio` built natively on `@earendil-works/pi-coding-agent` (`pi --mode rpc`), sharing settings, credentials, and session history in `~/.pi/agent/` directly with the terminal `pi` CLI.
- Redesigned the Settings center into 8 Pi-native sections (General, Providers & Credentials, Models & Thinking, Session & Context, Extensions / Packages & Skills, Tools & System Prompts, Network & Advanced, Shortcuts, and About) with Global and Project (`.pi/`) scope switching.
- Replaced slash commands with 24 Pi 1.5.2 commands (`/settings`, `/model`, `/thinking`, `/scoped-models`, `/mcp`, `/login`, `/logout`, `/new`, `/resume`, `/name`, `/session`, `/usage`, `/tree`, `/fork`, `/clone`, `/compact`, `/copy`, `/export`, `/reload`, `/btw`, `/git`, `/hotkeys`, `/changelog`, `/delete`) and a 7-level thinking effort slider (`off` through `max`).
- Added a home Bento usage overview card backed by `~/.pi/agent/sessions/**/*.jsonl`, an interactive glyph-wave ripple backdrop, left-edge peek sidebar drawer, and minimal soft-halo task status dots.
- Included the four-mode right workbench (Files / Changes / Subagent / Browser), line-level Git review and worktree management, built-in terminal, session tree navigation, HTML session export, and 18 synchronized light and dark themes.
