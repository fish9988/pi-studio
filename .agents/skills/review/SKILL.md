---
name: review
description: 改动做完、提交前让独立的评审员看 diff：收集 diff、在全新上下文里起只读评审子代理、合并去重、修 Important、最多 3 轮。用户说"评审""review""看看这次改动"，或中等以上改动收尾时用。
---

# 评审一次改动

评审员的完整关注点见 `docs/agents/reviewer.md` 与 `AGENTS.md`，这里讲主代理怎么组织。评审员只读，修改由主代理完成。

## 1. 准备

1. 先跑 `npm run check`，过了再评审：lint、格式、类型和仓库规则扫描由它机械拦截；没过就先修。
2. 定范围，写成评审员能直接执行的命令：
   - 已提交在分支上：`git diff <基准>...HEAD`（基准一般是 `main`）。
   - 还没提交：`git diff` 加上新文件（`git ls-files --others --exclude-standard` 列出的文件需读全文）；只评暂存区：`git diff --staged`。
   - 第 2、3 轮只给上一轮之后的增量改动。
3. 写一段客观改动说明：目标、改了哪些文件、跑过哪些命令和原样结果、哪些没试。不要塞入主观预期结论。

## 2. 起评审员（全新上下文、只读）

在当前宿主（Pi / T3 Code / 子代理工具）中起一个全新上下文的只读子代理，要求其对照 `AGENTS.md`、`docs/architecture/pi-architecture.md` 与 `docs/agents/reviewer.md` 审查上述范围：重点核查进程泄漏、POSIX/Windows/macOS 跨平台差异、`~/.pi/agent` 密钥与原子写边界、IPC 参数校验及状态机竞态。

## 3. 合并与核实

1. 合并去重评审意见。
2. 逐条核实 Important：复现或核对 `文件:行号`；不成立的标"不采纳"并写明原因。

## 4. 修复与复审

1. 修所有采纳的 Important；Nit 顺手能改的改，不改的列出原因。
2. 修完重跑相关单测 / E2E 与 `npm run check`。
3. 最多 3 轮，第 3 轮后仍存争议的交给仓库所有者决定。

## 5. 报告

在完成说明里附上评审轮次、已修复的 Important（含 `文件:行号`）以及未采纳或留待决定的条目。
