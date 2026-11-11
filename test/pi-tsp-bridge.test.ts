import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, ProjectId, TaskId, TaskState, TspBatch } from "../src/shared/ipc.ts";
import { applyMessage, createDocument, type TspDocMessage } from "../src/shared/tsp/document.ts";
import { trailingErrorCardId } from "../src/shared/tsp/error-turn.ts";
import { lastAnswerText } from "../src/shared/tsp/last-answer.ts";
import { deriveTaskStatus } from "../src/shared/tsp/task-status.ts";
import { userMessages } from "../src/shared/tsp/user-messages.ts";
import { deriveWorkingLabel } from "../src/shared/tsp/working.ts";
import type { PiLaunch } from "../src/main/pi/discover.ts";
import { PiService } from "../src/main/pi/pi-service.ts";
import { PiTaskRunner } from "../src/main/pi/pi-task-runner.ts";
import { computeTextDiffHunks, PI_SURFACE_ID, PiTspBridge } from "../src/main/pi/pi-tsp-bridge.ts";
import type { TaskRecord } from "../src/main/tasks/task-registry.ts";

const FAKE_PI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fake-pi", "fake-pi.mjs");

const FAKE_LAUNCH: PiLaunch = {
  command: process.execPath,
  prefixArgs: [FAKE_PI_PATH],
  env: { ELECTRON_RUN_AS_NODE: "1" },
  displayPath: FAKE_PI_PATH,
};

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-tsp-bridge-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d !== undefined) {
      await rm(d, { recursive: true, force: true });
    }
  }
});

describe("PiTspBridge — surface initialization & diff helpers", () => {
  it("opens inline omp.session surface s:1 with main, dock.hud, dock.dialog, and layer", () => {
    const bridge = new PiTspBridge("Test Session");
    expect(bridge.seq).toBe(2);

    const surface = bridge.document.surfaces.get(PI_SURFACE_ID);
    expect(surface).toBeDefined();
    expect(surface?.mode).toBe("inline");
    expect(surface?.role).toBe("omp.session");
    expect(surface?.nodes.has("main")).toBe(true);
    expect(surface?.nodes.has("dock")).toBe(true);
    expect(surface?.nodes.has("dock.hud")).toBe(true);
    expect(surface?.nodes.has("dock.dialog")).toBe(true);
    expect(surface?.nodes.has("layer")).toBe(true);
  });

  it("computes unified diff hunks and +A −R counts accurately", () => {
    const oldText = "line 1\nconst x = 1;\nline 3\n";
    const newText = "line 1\nconst x = 2;\nconst y = 3;\nline 3\n";
    const diff = computeTextDiffHunks(oldText, newText);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]!.lines).toContain("-const x = 1;");
    expect(diff.hunks[0]!.lines).toContain("+const x = 2;");
    expect(diff.hunks[0]!.lines).toContain("+const y = 3;");
  });
});

describe("PiTspBridge — session JSONL hydration & shared TSP selectors", () => {
  it("hydrates active branch from v3 session file (ignoring abandoned branches) with tools, diffs, blobs, and compaction", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");

    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "sess_1",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      }),
      JSON.stringify({
        type: "session_info",
        id: "info1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        name: "Hydrated Feature Work",
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: "info1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Update config and run tests" },
            { type: "image", data: ONE_PIXEL_PNG_BASE64, mimeType: "image/png" },
          ],
          timestamp: 1767225602000,
        },
      }),
      // Abandoned side-branch off info1 — must NOT appear in active branch!
      JSON.stringify({
        type: "message",
        id: "abandoned_u",
        parentId: "info1",
        timestamp: "2026-01-01T00:00:02.500Z",
        message: {
          role: "user",
          content: "Abandoned branch message",
          timestamp: 1767225602500,
        },
      }),
      // Active branch continues from u1 -> compact1 -> a1 -> tr1 -> tr2 -> a2
      JSON.stringify({
        type: "compaction",
        id: "compact1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "Earlier setup steps compacted.",
        firstKeptEntryId: "u1",
        tokensBefore: 48000,
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "compact1",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need to edit src/config.ts and run vitest." },
            {
              type: "toolCall",
              id: "tc_edit",
              name: "edit",
              arguments: {
                path: "src/config.ts",
                oldText: "export const port = 3000;\n",
                newText: "export const port = 8080;\nexport const host = '127.0.0.1';\n",
              },
            },
            {
              type: "toolCall",
              id: "tc_bash",
              name: "bash",
              arguments: { command: "npm test" },
            },
          ],
          stopReason: "toolUse",
          timestamp: 1767225604000,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "tr1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tc_edit",
          toolName: "edit",
          content: [{ type: "text", text: "Edited src/config.ts" }],
          isError: false,
          timestamp: 1767225604350,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "tr2",
        parentId: "tr1",
        timestamp: "2026-01-01T00:00:06.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tc_bash",
          toolName: "bash",
          content: [{ type: "text", text: "PASS all tests\n" }],
          isError: false,
          timestamp: 1767225605200,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a2",
        parentId: "tr2",
        timestamp: "2026-01-01T00:00:07.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "Updated `src/config.ts` to port 8080 and verified tests pass." }],
          usage: {
            input: 1200,
            output: 85,
            totalTokens: 1285,
            cost: { total: 0.0048 },
          },
          stopReason: "stop",
          timestamp: 1767225607000,
        },
      }),
    ];

    await writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");

    const bridge = new PiTspBridge();
    let observedTitle = "";
    bridge.onTitleChange((t) => {
      observedTitle = t;
    });

    await bridge.hydrateFromSessionFile(sessionFile);

    expect(observedTitle).toBe("Hydrated Feature Work");
    expect(bridge.hydrationMeta.leafId).toBe("a2");
    expect(bridge.document.blobs.size).toBe(1);

    const users = userMessages(bridge.document);
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe("Update config and run tests");

    const lastAns = lastAnswerText(bridge.document);
    expect(lastAns).toBe("Updated `src/config.ts` to port 8080 and verified tests pass.");

    const surface = bridge.document.surfaces.get(PI_SURFACE_ID)!;
    const allNodes = [...surface.nodes.values()];

    const editTool = allNodes.find((n) => n.k === "tool" && n.p["name"] === "edit");
    expect(editTool).toBeDefined();
    expect(editTool?.p["target"]).toBe("src/config.ts");
    expect(editTool?.p["targetKind"]).toBe("path");
    expect(editTool?.p["meta"]).toEqual(["+2 −1"]);

    const diffNode = allNodes.find((n) => n.k === "diff");
    expect(diffNode).toBeDefined();
    expect(diffNode?.p["path"]).toBe("src/config.ts");

    const bashTool = allNodes.find((n) => n.k === "tool" && n.p["name"] === "bash");
    expect(bashTool?.p["command"]).toBe("npm test");

    const thinkingSec = allNodes.find((n) => n.k === "section" && n.p["role"] === "omp.thinking");
    expect(thinkingSec?.p["collapsed"]).toBe(true);

    const compactSec = allNodes.find((n) => n.k === "section" && n.p["role"] === "omp.compaction");
    expect(compactSec).toBeDefined();
  });
});

describe("PiTspBridge — live streaming RPC events & extension UI dialogs", () => {
  it("streams live RPC events into mirrored TspDocument with exact firstSeq progression", () => {
    const bridge = new PiTspBridge("Live Stream");
    const mirror = createDocument();
    // Hydrate initial snapshot into mirror via replay
    const batches: { firstSeq: number; messages: TspDocMessage[] }[] = [];
    let mirrorSeq = bridge.seq;
    for (const sf of bridge.document.surfaces.values()) {
      expect(sf.id).toBe(PI_SURFACE_ID);
    }

    // Create a second bridge or track incremental frames on a fresh mirror initialized with init frames
    const liveBridge = new PiTspBridge("Stream Mirror");
    // Re-apply initial state by snapshotting seq = 2
    applyMessage(mirror, {
      verb: "o",
      body: { id: PI_SURFACE_ID, mode: "inline", title: "Stream Mirror", role: "omp.session" },
    });
    applyMessage(mirror, {
      verb: "f",
      body: {
        sf: PI_SURFACE_ID,
        s: 1,
        ops: [
          ["add", "main", PI_SURFACE_ID, null, { id: "main", k: "col", p: { gap: "md" } }],
          [
            "add",
            "dock",
            PI_SURFACE_ID,
            null,
            {
              id: "dock",
              k: "col",
              p: { gap: "xs" },
              c: [
                { id: "dock.hud", k: "col", p: { gap: "xs" } },
                { id: "dock.dialog", k: "col", p: { gap: "xs" } },
              ],
            },
          ],
          ["add", "layer", PI_SURFACE_ID, null, { id: "layer", k: "col" }],
        ],
      },
    });
    mirrorSeq = 2;

    liveBridge.onFrames((messages, firstSeq) => {
      expect(firstSeq).toBe(mirrorSeq + 1);
      for (const m of messages) {
        const res = applyMessage(mirror, m);
        expect(res.errors).toEqual([]);
      }
      mirrorSeq += messages.length;
      batches.push({ firstSeq, messages });
    });

    // Optimistic user message + deduplicated message_start
    liveBridge.appendOptimisticUserMessage("Hello bridge!");
    liveBridge.handleRpcEvent({ type: "agent_start" });
    expect(deriveTaskStatus(mirror).working).toBe(true);
    expect(deriveWorkingLabel(mirror)).toBe("Working…");

    liveBridge.handleRpcEvent({ type: "turn_start" });
    liveBridge.handleRpcEvent({
      type: "message_start",
      message: { role: "user", content: "Hello bridge!", timestamp: Date.now() },
    });
    expect(userMessages(mirror)).toHaveLength(1);

    const partialAsst = { role: "assistant" as const, content: [] };
    liveBridge.handleRpcEvent({ type: "message_start", message: partialAsst });
    liveBridge.handleRpcEvent({
      type: "message_update",
      message: partialAsst,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    expect(deriveWorkingLabel(mirror)).toBe("Thinking…");

    liveBridge.handleRpcEvent({
      type: "message_update",
      message: partialAsst,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Step 1..." },
    });
    liveBridge.handleRpcEvent({
      type: "message_update",
      message: partialAsst,
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Step 1..." },
    });

    liveBridge.handleRpcEvent({
      type: "tool_execution_start",
      toolCallId: "tc_1",
      toolName: "bash",
      args: { command: "ls -la" },
    });
    liveBridge.handleRpcEvent({
      type: "tool_execution_update",
      toolCallId: "tc_1",
      toolName: "bash",
      args: { command: "ls -la" },
      partialResult: { content: [{ type: "text", text: "total 4\n" }] },
    });
    liveBridge.handleRpcEvent({
      type: "tool_execution_end",
      toolCallId: "tc_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "total 4\nREADME.md\n" }] },
      isError: false,
      durationMs: 25,
    });

    liveBridge.handleRpcEvent({
      type: "message_update",
      message: partialAsst,
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    });
    liveBridge.handleRpcEvent({
      type: "message_update",
      message: partialAsst,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Here is " },
    });
    liveBridge.handleRpcEvent({
      type: "message_update",
      message: partialAsst,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "the result." },
    });
    liveBridge.handleRpcEvent({
      type: "message_update",
      message: partialAsst,
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Here is the result." },
    });

    liveBridge.handleRpcEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the result." }],
        usage: {
          input: 60,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 100,
          cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 },
        },
        stopReason: "stop",
      },
    });
    liveBridge.handleRpcEvent({ type: "agent_end", messages: [] });
    liveBridge.handleRpcEvent({ type: "agent_settled", aborted: false });

    expect(deriveTaskStatus(mirror).working).toBe(false);
    expect(lastAnswerText(mirror)).toBe("Here is the result.");
    expect(batches.length).toBeGreaterThan(5);
  });

  it("renders error card on assistant stopReason === 'error'", () => {
    const bridge = new PiTspBridge();
    bridge.appendOptimisticUserMessage("Trigger failure");
    bridge.handleRpcEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Rate limit exceeded",
      },
    });
    const surface = bridge.document.surfaces.get(PI_SURFACE_ID)!;
    expect(trailingErrorCardId(surface.nodes)).not.toBeNull();
  });

  it("resolves select, confirm, input, and editor extension_ui_requests via TspEvent and TspKeys", () => {
    const bridge = new PiTspBridge();

    // 1. select via activate event
    bridge.handleRpcEvent({
      type: "extension_ui_request",
      id: "req_sel",
      method: "select",
      title: "Choose environment",
      options: ["staging", "production"],
    });
    expect(deriveTaskStatus(bridge.document).ask?.approval).toBe(false);

    const selResp = bridge.handleTspEvent({
      ev: "activate",
      sf: PI_SURFACE_ID,
      id: "dlg_req_sel/list",
      item: "dlg_req_sel/opt.1",
    });
    expect(selResp).toEqual({ id: "req_sel", value: "production" });
    expect(deriveTaskStatus(bridge.document).ask).toBeNull();

    // 2. confirm via approve button action
    bridge.handleRpcEvent({
      type: "extension_ui_request",
      id: "req_conf",
      method: "confirm",
      title: "Delete branch?",
      message: "Cannot be undone",
    });
    expect(deriveTaskStatus(bridge.document).ask?.approval).toBe(true);

    const confResp = bridge.handleTspEvent({
      ev: "action",
      sf: PI_SURFACE_ID,
      id: "dlg_req_conf/btn.approve",
      act: "approve",
    });
    expect(confResp).toEqual({ id: "req_conf", confirmed: true });

    // 3. input via edit + Enter key
    bridge.handleRpcEvent({
      type: "extension_ui_request",
      id: "req_in",
      method: "input",
      title: "Tag name",
      prefill: "v1.",
    });
    bridge.handleTspEvent({
      ev: "edit",
      sf: PI_SURFACE_ID,
      id: "dlg_req_in/input",
      from: 3,
      to: 3,
      text: "5.2",
      cursor: 6,
      len: 3,
    });
    const inResp = bridge.handleTspKeys("\r");
    expect(inResp).toEqual({ id: "req_in", value: "v1.5.2" });

    // 4. editor cancel via Esc key
    bridge.handleRpcEvent({
      type: "extension_ui_request",
      id: "req_ed",
      method: "editor",
      title: "Release notes",
    });
    const cancelResp = bridge.handleTspKeys("\x1b");
    expect(cancelResp).toEqual({ id: "req_ed", cancelled: true });
  });
});

describe("PiService & PiTaskRunner integration with fake-pi", () => {
  it("runs PiService catalog queries and PiTaskRunner prompt + side-question end-to-end", async () => {
    const dir = await makeTempDir();
    const service = new PiService(() => Promise.resolve(FAKE_LAUNCH), { cwd: dir });

    try {
      const models = await service.listModelOptions();
      expect(models).toHaveLength(3);
      expect(models[0]!.key).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
      expect(models[0]!.reasoning).toBe(true);
      expect(models[0]!.acceptsImages).toBe(true);

      const defModel = await service.readDefaultModel();
      expect(defModel?.key.modelId).toBe("claude-sonnet-4-5");

      const slash = await service.listSlashCommands(dir);
      expect(slash.map((c) => c.name)).toContain("review");

      const taskId = "task_test_1" as TaskId;
      const projectId = "proj_1" as ProjectId;
      let record: TaskRecord = {
        id: taskId,
        projectId,
        title: "",
        sessionFile: null,
        forkFrom: null,
        archived: false,
        keepAlive: false,
        worktreePath: null,
        worktreeBranch: null,
        worktreeBase: null,
        cwd: dir,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        thinkingLevel: null,
      };
      const project: Project = {
        id: projectId,
        name: "Test Project",
        path: dir,
      };

      const states: TaskState[] = [];
      const batches: TspBatch[] = [];

      const runner = new PiTaskRunner(record, project, {
        buildPiLaunch: () => Promise.resolve(FAKE_LAUNCH),
        acquireSlot: () => Promise.resolve(),
        persist: (_id, patch) => {
          record = { ...record, ...patch };
          return Promise.resolve(record);
        },
        isForeground: () => true,
        onState: (st) => states.push(st),
        onTspBatch: (b) => batches.push(b),
        listModels: (refresh) => service.listModelOptions(refresh),
        listSlashCommands: (cwd) => service.listSlashCommands(cwd),
      });

      try {
        await runner.sendPrompt({ text: "Please apply [edit] to app", whenBusy: "steer" });

        // Wait until runner settles back to idle
        const deadline = Date.now() + 10_000;
        while (runner.status !== "idle" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 30));
        }

        expect(runner.status).toBe("idle");
        expect(record.title).toContain("Please apply [edit]");
        expect(record.sessionFile).toBeTruthy();
        expect(batches.length).toBeGreaterThan(0);

        // Test side question (`/btw`)
        const btwId = await runner.askBtw("Suggest a commit message for diff");
        const btwDeadline = Date.now() + 10_000;
        while (Date.now() < btwDeadline) {
          const list = await runner.getBtw();
          const item = list.find((r) => r.id === btwId);
          if (item?.status === "complete") {
            expect(item.answer).toContain("chore: update project files");
            break;
          }
          await new Promise((r) => setTimeout(r, 30));
        }

        const btwFinal = await runner.getBtw();
        expect(btwFinal[0]?.status).toBe("complete");
      } finally {
        await runner.dispose();
      }
    } finally {
      await service.close();
    }
  });
});
