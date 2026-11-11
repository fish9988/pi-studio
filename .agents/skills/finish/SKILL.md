---
name: finish
description: 一轮改动做完、检查通过之后的收尾：写 CHANGELOG「未发布」、提交到 main、推送、看三端 CI、清理临时文件和进程、写完成说明。用户说"收尾""提交""做完了""finish"，或改动已经验证完、准备交付时用。
---

# 收尾

前提：`npm run check` 通过，相关单测、必要的 Playwright E2E 跑过（见 `AGENTS.md` 与 `docs/architecture/testing.md`）。按顺序做完再报告。

## 1. CHANGELOG

- 用户能看到的改动记进 `CHANGELOG.md` 的 `## [未发布]` 下，按 `### 新增` / `### 修复` / `### 变更` 分组；每条一句话，说用户能看到的变化，不写内部实现。同一条的英文写进 `CHANGELOG.en.md` 的 `## [Unreleased]`（`### Added` / `### Fixed` / `### Changed`），两边条目一一对应。
- 只改了测试、文档、开发脚本、agent 配置（安装包内容不变）时不记。
- 换行保持 LF，避免混用换行导致整片 diff。

## 2. 提交

1. 确认 hook 已启用：`git config core.hooksPath` 应为 `.githooks`（不是就运行 `git config core.hooksPath .githooks`）。
2. 提交到 `main`：多个代理共用工作区时不跑 `checkout` / `restore` / `stash` / `reset` / `clean`。
3. 只 `git add` 这次改的文件，避免把无关临时文件带进来。
4. 提交信息按 `feat:` / `fix:` / `test:` / `chore:` / `docs:` 规范撰写，不写本机私人路径或敏感信息。
5. `git show --stat HEAD` 确认只有这次改的文件。hook 失败就修好问题再提交，不用 `--no-verify`。

## 3. 推送与观察 CI

- `git push origin main`。不 `--force`，不改写已推送的历史（要做先问仓库所有者）。
- 推送后用 `gh` 查看触发的三端 CI（注意先清掉本机可能无权限的 `GITHUB_TOKEN`，让 `gh` 走 keyring 登录的 `fish9988` 账号）：
  - Bash：`env -u GITHUB_TOKEN gh run list --repo fish9988/pi-studio --limit 5`
  - PowerShell：`Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue; gh run list --repo fish9988/pi-studio --limit 5`
- 不发版。只有仓库所有者明确要求发版/上架时才用 skill `release`。

## 4. 清理

- 临时脚本、临时目录、临时截图用完即删（截图放系统临时目录，不放仓库）。
- 只结束自己测试启动的残留进程；本机已安装的 `%LOCALAPPDATA%\Programs\pi-studio`、`%LOCALAPPDATA%\Programs\omp-studio` 以及同级目录 `../omp-studio` 绝不触碰。
- 常驻 shell 里若临时设过 `HOME` / `PI_CODING_AGENT_DIR` / `STUDIO_USER_DATA`，确认未污染后续命令。

## 5. 犯错的记录

这一轮里返工过、或者查了半天才找到原因的问题：优先变成 lint 规则、单测、`scripts/check.ts` 扫描或 hook；做不到时，Pi 相关细节写进 `docs/architecture/pi-architecture.md`，通用准则在 `AGENTS.md` 对应小节补一行。

## 6. 完成说明

写清楚：

- 改了什么（文件链接与用户能看到的变化）；
- 跑过哪些命令、结果如何，哪些没试、为什么；
- 提交号、是否已推送及 GitHub Actions 状态；
- 留下的问题或需要仓库所有者决定的事项。
