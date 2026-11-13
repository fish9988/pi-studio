# Changelog

What changed in each pi-studio release, written for users. Versions follow [SemVer](https://semver.org/): bug fixes bump the patch number, new features bump the minor number.

How to write it:

- This is the English twin of `CHANGELOG.md`. Every entry goes into both files under "Unreleased", grouped as Added / Fixed / Changed, one sentence each about what users see, no implementation details.
- The release script (`npm run release -- <version>`) turns "Unreleased" in both files into `[<version>] - <date>` and refuses to release when either one is empty. The GitHub Release shows this file's section first, then the Chinese one; the in-app changelog follows the UI language.

## [Unreleased]

## [0.2.0] - 2026-11-13

### Added

- Refreshed the full UI with Glacier Mica (light) and Abyssal Glass (dark) default palettes, an `18px` rounded floating main canvas, translucent glass topbar pills, and a `22px` floating composer island across all 8 dual-mode theme families.
- Added independent UI font and chat prose font customization in Settings › General: choose sans-serif or serif separately and pick any installed system font via searchable local font discovery.
- Added reading-position protection and a left-gutter collapse rail in the conversation process flow so active text selections or focused thinking/tool sections are never collapsed mid-read.
- Redesigned the right workbench Overview with a 2×2 tinted tile grid (Review / Files / Terminal / Browser) and grouped cards for touched files, subagents, and background tasks.
- Added deferred progressive mounting for long conversation histories alongside per-level thinking map overrides and live model catalog capability synchronization.

### Changed

- Updated sidebar and settings navigation with left active indicator bars, pill search/segmented controls, and softer tinted thinking blocks distinct from main assistant prose.

## [0.1.7] - 2026-11-13

### Added

- Composer drafts now persist pasted snippets, images, and attached files across task switches and restarts.
- Added lightweight quoting to the composer from terminal selections (toolbar button and context menu), assistant replies, and page selections (`Ctrl+Shift+Q`).
- Queued messages, extension widgets, compaction cancellations/errors, and extension error notices now appear cleanly in the conversation dock.

### Fixed

- Fixed "Tools & Terminal" showing default tools as active when all tools were explicitly disabled, which could silently re-enable them on toggle.
- Aligned prompt cache warming and network timeout defaults with the engine, labeled CLI-only settings, and removed unresponsive legacy buttons on the setup screen.
- Usage counters now display `—` when usage is unavailable instead of `$0`, and native slash commands (`/llama`, `/import`, `/share`, `/bug`, `/trust`) send without a second confirmation.
- Stripped UTF-8 BOM when reading config and task registry files, improved Windows process-tree cleanup logging, and derived auto-compaction thresholds from actual model settings.

## [0.1.6] - 2026-11-13

### Added

- Redesigned Settings: the nav is grouped (Appearance / Intelligence / Capabilities / Session / System) with icons, the section title sticks while you scroll, and each group of settings sits in its own card; in narrow windows (docked or standalone) container queries stack labels above controls.
- The theme gallery is now a card grid: preview, name and a check mark on the selected one; light/dark stays a separate switch.

### Changed

- Rebuilt the Pi / DeepSeek / Gemini / OpenAI / Sakura / Ink palettes for both light and dark ("Default" and Claude Code are unchanged): every pair measured against WCAG (body text ≥4.5:1, control borders ≥3:1), code blocks keep a visible step from the page, and border weight is now consistent across all twelve palettes.
- Redrew those themes' background art: no more details that compete with the text, only gradients, grids, glows, stars, a cherry branch and mountain silhouettes — you notice the mood, not the picture.

## [0.1.5] - 2026-11-13

### Added

- Added a "Classic" process-row layout (the default — exactly what you saw before) and made "Flat" and "Column" genuinely different: Flat removes the left indent and puts a hairline between steps, Column wraps the whole step list in a bordered box.

### Fixed

- Fixed shell settings such as the process-row layout and the desktop pet not taking effect: they now apply to the conversation immediately from any window (including the standalone settings window) without a restart.

## [0.1.4] - 2026-11-13

### Fixed

- Fixed the whale-girl and little-whale desktop pets not appearing in the installed build (they worked in dev; the packaged app only found the sprite sheets under `assets/mascot/`).

## [0.1.3] - 2026-11-13

### Fixed

- Fixed channels that push thinking or process commentary through the body text stream (DeepSeek-style models and relays): that content now folds into a collapsible "Commentary" process row, and only the real answer stays in the message body.
- Fixed the process card you expanded by hand collapsing again as soon as the next streaming event arrived: a manual expand or collapse now survives streaming updates, re-renders and history reloads.
- Fixed prose that discusses angle brackets and XML-like tags (`<tag>`, `Array<string>`, `<｜DSML｜…>`) or snake_case names (`text_start/text_delta`) being folded away as thinking content or shown in italics; such text now renders as plain body text.
- Fixed the process list showing a bare tool title with no file path or progress indicator while the tool arguments are still streaming.
- Fixed the elapsed time in the process card header freezing while tools keep appending; it now ticks live while running.
- Fixed the newest lines of a streaming code block being hidden, and the whole code block being repainted when the fence closes (which dropped any selected text).
- Fixed the viewport jumping back to the bottom or elsewhere when a conversation-line jump, a fold toggle and streaming output overlap.

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
