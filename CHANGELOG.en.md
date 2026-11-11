# Changelog

What changed in each pi-studio release, written for users. Versions follow [SemVer](https://semver.org/): bug fixes bump the patch number, new features bump the minor number.

How to write it:

- This is the English twin of `CHANGELOG.md`. Every entry goes into both files under "Unreleased", grouped as Added / Fixed / Changed, one sentence each about what users see, no implementation details.
- The release script (`npm run release -- <version>`) turns "Unreleased" in both files into `[<version>] - <date>` and refuses to release when either one is empty. The GitHub Release shows this file's section first, then the Chinese one; the in-app changelog follows the UI language.

## [Unreleased]

## [0.1.0] - 2026-11-11

### Added

- Initial desktop release of `pi-studio` built natively on `@earendil-works/pi-coding-agent` (`pi --mode rpc`), sharing settings, credentials, and session history in `~/.pi/agent/` directly with the terminal `pi` CLI.
- Redesigned the Settings center into 8 Pi-native sections (General, Providers & Credentials, Models & Thinking, Session & Context, Extensions / Packages & Skills, Tools & System Prompts, Network & Advanced, Shortcuts, and About) with Global and Project (`.pi/`) scope switching.
- Replaced slash commands with 24 Pi 1.5.2 commands (`/settings`, `/model`, `/thinking`, `/scoped-models`, `/mcp`, `/login`, `/logout`, `/new`, `/resume`, `/name`, `/session`, `/usage`, `/tree`, `/fork`, `/clone`, `/compact`, `/copy`, `/export`, `/reload`, `/btw`, `/git`, `/hotkeys`, `/changelog`, `/delete`) and a 7-level thinking effort slider (`off` through `max`).
- Added a home Bento usage overview card backed by `~/.pi/agent/sessions/**/*.jsonl`, an interactive glyph-wave ripple backdrop, left-edge peek sidebar drawer, and minimal soft-halo task status dots.
- Included the four-mode right workbench (Files / Changes / Subagent / Browser), line-level Git review and worktree management, built-in terminal, session tree navigation, HTML session export, and 18 synchronized light and dark themes.
