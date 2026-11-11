---
name: release
description: 发一个新版本：结束占着 release\ 的进程、更新 CHANGELOG 与版本号、打 Windows 安装包、推送 main 和 tag、上传 GitHub Release、确认 Windows / macOS / Linux 三端构建全绿。只在仓库所有者明确要求发版时使用。
---

# 发版

**只在仓库所有者明确要求发版时执行**。只改了测试、文档、开发脚本（安装包内容不变）时不发版。发版前确保工作区干净并通过 `npm run check`、相关单测与 E2E 冒烟。

## 1. 定版本号与更新日志

修 bug 升第三位（如 `0.1.1` → `0.1.2`），加功能升第二位（如 `0.1.x` → `0.2.0`）。版本号必须高于已发布的最新 Release（同版本号重打不会触发客户端自动更新）。确认 `CHANGELOG.md` 与 `CHANGELOG.en.md` 均已补好本版本的更新条目（中英文一一对应）。

## 2. 结束占着 `release\` 的进程

从仓库 `release\` 下启动的 `pi-studio.exe`（如 `release\win-unpacked\pi-studio.exe`）会占着文件导致打包 `EBUSY`，按路径精确结束；**装好的版本（`%LOCALAPPDATA%\Programs\pi-studio`）绝不能碰**：

```bash
powershell -NoProfile -Command '$r = (Resolve-Path release).Path; Get-Process pi-studio -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$r\*" } | Stop-Process -Force'
```

## 3. 版本升级、检查与打包

- 若本地存在 `.githooks/no-mention.local.txt`，可直接运行：
  ```bash
  npm run release -- <版本> --dry-run
  npm run release -- <版本>
  ```
- 若当前克隆环境无 `.githooks/no-mention.local.txt`：
  1. 将 `CHANGELOG.md` 的 `## [未发布]` 与 `CHANGELOG.en.md` 的 `## [Unreleased]` 推进为 `## [<版本>] - YYYY-MM-DD`（保留空的未发布标题供后续使用）；
  2. 运行 `npm version <版本> --no-git-tag-version`；
  3. 运行 `npm run check`、`npx vitest run`、`npm run dist`（产出 `release/pi-studio-<版本>-setup.exe`、`.blockmap`、`latest.yml` 并自动通过 `scripts/check-package.ts` 校验 `app.asar`）；
  4. 清理 `release/` 下旧版本的 `pi-studio-*-setup.exe*`；
  5. 提交 `chore(release): v<版本>` 并创建附注标签 `git tag -a v<版本> -m "v<版本>"`。
- **注意**：绝不在本机运行 `scripts/smoke-packaged.ts`（它会读写用户真实的 `%APPDATA%\pi-studio`，仅在 CI 干净环境中跑）。

## 4. 推送并上传 Windows 安装包到 GitHub Release

先清掉环境变量里可能无权限的 `GITHUB_TOKEN`，让 `gh` 使用 keyring 登录的 `fish9988` 账号；先推 `main`，再推 `v<版本>` 标签，然后上传 Windows 更新源与安装包：

```bash
git push origin main
git push origin v<版本>
env -u GITHUB_TOKEN node scripts/publish-release.ts <版本> release/latest.yml release/pi-studio-<版本>-setup.exe release/pi-studio-<版本>-setup.exe.blockmap
```

（PowerShell 下用 `Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue` 代替 `env -u GITHUB_TOKEN`。）

## 5. 确认 Windows / macOS / Linux 三端 GitHub Actions 与产物齐全

推送 `v<版本>` 标签会自动触发：
- `.github/workflows/windows.yml`（检查 + 单测 + E2E + 打包校验 + 窗口冒烟）
- `.github/workflows/mac.yml`（构建并自动上传 `pi-studio-<版本>-arm64.dmg` 与 `pi-studio-<版本>-arm64-mac.zip` 到该 Release）
- `.github/workflows/linux.yml`（构建并自动上传 `pi-studio-<版本>-x86_64.AppImage` 与 `latest-linux.yml` 到该 Release）

核查构建状态与最终 Release 附件列表：

```bash
env -u GITHUB_TOKEN gh run list --repo fish9988/pi-studio --limit 6
env -u GITHUB_TOKEN gh release view v<版本> --repo fish9988/pi-studio --json tagName,url,assets
```

## 6. 报告

写明版本号、提交号和 tag、Release 链接与三端全部安装包清单，以及三端 GitHub Actions 的结果。
