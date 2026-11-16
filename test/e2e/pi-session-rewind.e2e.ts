import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, openTaskRow, setLocale } from "./launch.ts";

test("中途撤回保留此前消息，扩展退出追加状态也不会清空对话", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "pi-studio-rewind-e2e-"));
  const projectDir = path.join(work, "project");
  const agentDir = path.join(work, "agent");
  const sessionsDir = path.join(agentDir, "sessions", "--rewind--");
  await mkdir(projectDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  const sessionId = "019a0000-0000-7000-8000-000000000010";
  const sessionFile = path.join(sessionsDir, `2026-11-12T01-00-00-000Z_${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-11-12T01:00:00.000Z",
      cwd: projectDir,
    }),
  ];
  for (let i = 1; i <= 20; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `u${i}`,
        parentId: i === 1 ? null : `a${i - 1}`,
        message: { role: "user", content: [{ type: "text", text: `撤回验证问题 ${i}` }] },
      }),
      JSON.stringify({
        type: "message",
        id: `a${i}`,
        parentId: `u${i}`,
        message: { role: "assistant", content: [{ type: "text", text: `撤回验证回答 ${i}` }] },
      }),
    );
  }
  await writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");
  const launched = await launchApp({ PI_CODING_AGENT_DIR: agentDir, FAKE_PI_SHUTDOWN_ENTRY: "1" });
  try {
    const { page } = launched;
    await setLocale(page, "zh-CN");
    await launched.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, projectDir);
    await page.evaluate(async (id) => {
      await globalThis.studio.addProject();
      await globalThis.studio.resumeSession(id);
    }, sessionId);
    await openTaskRow(page);
    const users = page.locator('.tsp-card[data-role="omp.user"]');
    await expect(users).toHaveCount(20);
    const target = users.nth(9);
    await target.hover();
    await target.getByTestId("user-msg-retract").click();
    await page.getByTestId("confirm-undo-submit").click();
    await expect(page.getByTestId("confirm-undo-dialog")).toHaveCount(0);
    await expect(users).toHaveCount(9);
    await expect(users.first()).toContainText("撤回验证问题 1");
    await expect(users.last()).toContainText("撤回验证问题 9");
    await expect(page.getByText("撤回验证回答 9", { exact: true })).toBeVisible();
    await expect(page.getByTestId("composer-input")).toHaveText("撤回验证问题 10");
    const kept = await readFile(sessionFile, "utf8");
    expect(kept).toContain('"id":"u1"');
    expect(kept).toContain('"id":"a9"');
    expect(kept).not.toContain('"id":"u10"');
    expect((await readdir(sessionsDir)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
    await page.getByTestId("composer-input").fill("撤回后继续提问");
    await page.keyboard.press("Enter");
    await expect(users).toHaveCount(10);
    await expect(users.last()).toContainText("撤回后继续提问");
    await expect(page.getByText("Fake Pi reply to: 撤回后继续提问", { exact: true })).toBeVisible();
    await expect(users.first()).toContainText("撤回验证问题 1");
  } finally {
    await launched.close();
    await rm(work, { recursive: true, force: true, maxRetries: 5 });
  }
});
