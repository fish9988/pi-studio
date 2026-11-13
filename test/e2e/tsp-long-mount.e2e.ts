// 长历史会话（几百轮）打开时的挂载：对话列先只画最后一截、其余在后面的帧里补齐（features/tsp/MainFlow.tsx 的 useDeferredHead）。
// 这几条用例守的是"分帧不能改变结果"：最终全部挂载（不丢历史）、一开始吸底、跳到第一条老消息时那一块已经被补出来并落到视口里。
import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchApp, openTaskRow, type LaunchedApp } from "./launch.ts";

const TURNS = 200;
const SESSION_ID = "01a00000-0000-7000-8000-0000000000fe";

/** 页面里量滚动位置用到的最小类型（e2e 的类型检查没有 DOM 类型）。 */
type PageScrollBox = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  querySelector(selector: string): { getBoundingClientRect(): { top: number } } | null;
  getBoundingClientRect(): { top: number };
};

/** 长会话文件：每轮 用户消息 / 思考 + 读文件 / 工具结果 / 跑测试 / 工具结果 / 回答。 */
function sessionText(cwd: string): string {
  const lines: string[] = [
    JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-10-18T00:00:00.000Z", cwd }),
  ];
  let n = 0;
  const msg = (message: Record<string, unknown>): void => {
    n += 1;
    lines.push(
      JSON.stringify({
        type: "message",
        id: `m${n}`,
        parentId: n === 1 ? null : `m${n - 1}`,
        timestamp: new Date(Date.UTC(2026, 9, 18, 0, 0, n)).toISOString(),
        message,
      }),
    );
  };
  for (let turn = 0; turn < TURNS; turn += 1) {
    msg({ role: "user", content: [{ type: "text", text: `第 ${turn + 1} 轮：检查 pi-rpc-client.ts 的分帧逻辑。` }] });
    msg({
      role: "assistant",
      content: [
        { type: "thinking", thinking: `先读文件确认分帧方式（第 ${turn + 1} 轮）。` },
        { type: "toolCall", id: `c${turn}a`, name: "read", arguments: { path: "src/main/pi/pi-rpc-client.ts" } },
      ],
    });
    msg({
      role: "toolResult",
      toolCallId: `c${turn}a`,
      toolName: "read",
      content: [{ type: "text", text: `第 ${turn + 1} 轮读到 42 行。\n`.repeat(4) }],
    });
    msg({
      role: "assistant",
      content: [{ type: "toolCall", id: `c${turn}b`, name: "bash", arguments: { command: "npx vitest run" } }],
    });
    msg({
      role: "toolResult",
      toolCallId: `c${turn}b`,
      toolName: "bash",
      content: [{ type: "text", text: `第 ${turn + 1} 轮：3 passed (1.2s)` }],
    });
    msg({
      role: "assistant",
      content: [{ type: "text", text: `第 ${turn + 1} 轮核对完：**只按换行切帧**，改动在 \`pi-rpc-client.ts\`。` }],
    });
  }
  return `${lines.join("\n")}\n`;
}

test("恢复长会话：全部历史最终都挂载、吸底、对话线能跳回第一条", async () => {
  test.setTimeout(240_000);
  const work = await mkdtemp(path.join(os.tmpdir(), "tsp long mount "));
  const agentDir = path.join(work, "agent");
  const project = path.join(work, "项目");
  const bucket = path.join(agentDir, "sessions", "--long-mount--");
  await mkdir(bucket, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(bucket, "2026-10-18T00-00-00-000Z_long.jsonl"), sessionText(project), "utf8");
  let launched: LaunchedApp | null = null;
  try {
    launched = await launchApp({ PI_CODING_AGENT_DIR: agentDir });
    const { page } = launched;
    await page.evaluate((id) => globalThis.studio.resumeSession(id), SESSION_ID);
    await openTaskRow(page, 0);
    // 挂载那一刻对话列先只有最后一截：块数少于最终值（分帧生效），但不会有几百毫秒一次把整份插进来。
    const column = page.locator('.tsp-surface[data-mode="inline"] .tsp-column');
    const users = page.locator('[data-testid="tsp-view"] [data-role="omp.user"]');
    await expect(users.last()).toBeVisible({ timeout: 60_000 });
    // 最终全部挂载：一条不少（历史不能因为分帧丢掉）。
    await expect(users).toHaveCount(TURNS, { timeout: 60_000 });
    await expect(column.locator(".tsp-process-group")).toHaveCount(TURNS, { timeout: 60_000 });
    // 分帧补完以后仍然是吸底（最新一条在视口里）。
    const scroller = page.locator('[data-testid="tsp-view"]:visible .tsp-surface[data-mode="inline"] .tsp-scroller');
    const atBottom = await scroller.evaluate((node) => {
      const el = node as unknown as PageScrollBox;
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    });
    expect(atBottom).toBeLessThan(48);
    // 跳到第一条：点对话线的第一个刻度，滚过去以后第一条用户消息在视口顶部附近（分帧有 flush，老消息一定找得到）。
    await page.getByTestId("conversation-line").hover();
    await page.getByTestId("conversation-line-tick").first().click();
    await expect
      .poll(
        async () =>
          scroller.evaluate((node) => {
            const el = node as unknown as PageScrollBox;
            const first = el.querySelector('[data-role="omp.user"]');
            if (first === null) return Number.POSITIVE_INFINITY;
            return Math.abs(first.getBoundingClientRect().top - el.getBoundingClientRect().top - 16);
          }),
        { timeout: 10_000 },
      )
      .toBeLessThan(24);

    // 超过保留的 5 个视图后再回来：中段阅读位置恢复时不能先挂尾部片段，把保存的位置夹错。
    const originalId = await page.getByTestId("tsp-view").getAttribute("data-task-id");
    expect(originalId).not.toBeNull();
    const originalTop = await scroller.evaluate((node) => (node as unknown as PageScrollBox).scrollTop);
    for (let index = 0; index < 5; index += 1) {
      const nextId = await page.evaluate(async () => {
        const [project] = await globalThis.studio.listProjects();
        return (await globalThis.studio.createTask({ projectId: project!.id })).id;
      });
      await page.locator(`[data-nav="task:${nextId}"]`).click();
    }
    await expect(page.locator(`[data-testid="tsp-view"][data-task-id="${originalId}"]`)).toHaveCount(0);
    // 经应用已有的任务聚焦事件返回（侧栏会把没有进程的历史任务合并成会话行）。
    await launched.app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send("studio:event:focusTask", id);
    }, originalId);
    await expect(users).toHaveCount(TURNS);
    await expect
      .poll(() => scroller.evaluate((node) => (node as unknown as PageScrollBox).scrollTop))
      .toBeCloseTo(originalTop, -1);
  } finally {
    await launched?.close();
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
