import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, ProjectId, TaskId, TaskState, TspBatch } from "../src/shared/ipc.ts";
import { applyMessage, createDocument, type TspDocMessage } from "../src/shared/tsp/document.ts";
import { trailingErrorCardId } from "../src/shared/tsp/error-turn.ts";
import { listAgents } from "../src/shared/tsp/agent-hub.ts";
import { lastAnswerText } from "../src/shared/tsp/last-answer.ts";
import { deriveTaskStatus } from "../src/shared/tsp/task-status.ts";
import { userMessages } from "../src/shared/tsp/user-messages.ts";
import { deriveWorkingLabel } from "../src/shared/tsp/working.ts";
import type { PiLaunch } from "../src/main/pi/discover.ts";
import { PiService } from "../src/main/pi/pi-service.ts";
import { PiTaskRunner } from "../src/main/pi/pi-task-runner.ts";
import { computeTextDiffHunks, PI_SURFACE_ID, PiTspBridge } from "../src/main/pi/pi-tsp-bridge.ts";
import { fallbackSmartTitle } from "../src/main/tasks/ai-helper.ts";
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
    const [blobId] = [...bridge.document.blobs.keys()];
    expect(blobId).toMatch(/^[0-9a-f]{64}$/);

    const users = userMessages(bridge.document);
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe("Update config and run tests");

    const lastAns = lastAnswerText(bridge.document);
    expect(lastAns).toBe("Updated `src/config.ts` to port 8080 and verified tests pass.");

    const surface = bridge.document.surfaces.get(PI_SURFACE_ID)!;
    const allNodes = [...surface.nodes.values()];
    expect(allNodes.some((n) => n.p["role"] === "omp.user.tools")).toBe(false);

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

  it("returns to idle when prompt response, agent_start, and agent_end coalesce in one stdout chunk", async () => {
    const dir = await makeTempDir();
    const coalescedMock = path.join(dir, "coalesced-rpc.mjs");
    await writeFile(
      coalescedMock,
      [
        'import { StringDecoder } from "node:string_decoder";',
        'const dec = new StringDecoder("utf8");',
        'let buf = "";',
        'process.stdin.on("data", (chunk) => {',
        "  buf += dec.write(chunk);",
        '  let idx = buf.indexOf("\\n");',
        "  while (idx !== -1) {",
        '    const line = buf.slice(0, idx).replace(/\\r$/, "");',
        "    buf = buf.slice(idx + 1);",
        '    if (line.trim() !== "") {',
        "      const cmd = JSON.parse(line);",
        '      if (cmd.type === "get_state") {',
        "        process.stdout.write(JSON.stringify({",
        '          type: "response", id: cmd.id, command: "get_state", success: true,',
        '          data: { thinkingLevel: "medium", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", sessionId: "s1", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 }',
        '        }) + "\\n");',
        '      } else if (cmd.type === "get_available_thinking_levels") {',
        '        process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: true, data: { levels: ["off", "medium"] } }) + "\\n");',
        '      } else if (cmd.type === "get_session_stats") {',
        '        process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: true, data: { sessionId: "s1", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } }) + "\\n");',
        '      } else if (cmd.type === "prompt") {',
        "        // Emit response + agent_start + agent_end + agent_settled in a SINGLE write syscall!",
        "        const coalesced =",
        '          JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true, data: { disposition: "started" } }) + "\\n" +',
        '          JSON.stringify({ type: "agent_start" }) + "\\n" +',
        '          JSON.stringify({ type: "agent_end", messages: [] }) + "\\n" +',
        '          JSON.stringify({ type: "agent_settled", aborted: false }) + "\\n";',
        "        process.stdout.write(coalesced);",
        "      } else {",
        '        process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: true, data: {} }) + "\\n");',
        "      }",
        "    }",
        '    idx = buf.indexOf("\\n");',
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );

    let record: TaskRecord = {
      id: "task_coalesced" as TaskId,
      projectId: "proj_coalesced" as ProjectId,
      title: "",
      archived: false,
      sessionFile: null,
      worktreePath: null,
      worktreeBranch: null,
      worktreeBase: null,
      cwd: dir,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      thinkingLevel: null,
    };

    const runner = new PiTaskRunner(
      record,
      { id: "proj_coalesced" as ProjectId, name: "Coalesced", path: dir },
      {
        buildPiLaunch: () =>
          Promise.resolve({
            command: process.execPath,
            prefixArgs: [coalescedMock],
            env: { ELECTRON_RUN_AS_NODE: "1" },
            displayPath: coalescedMock,
          }),
        acquireSlot: () => Promise.resolve(),
        persist: (_id, patch) => {
          record = { ...record, ...patch };
          return Promise.resolve(record);
        },
        isForeground: () => true,
        onState: () => {},
        onTspBatch: () => {},
      },
    );

    try {
      await runner.sendPrompt({ text: "fast turn", whenBusy: "steer" });
      expect(runner.status).toBe("idle");
    } finally {
      await runner.dispose();
    }
  });

  it("fallbackSmartTitle strips Windows drive paths and [Image] tags without truncating to 'C'", () => {
    const title = fallbackSmartTitle(
      "[Image #1, 1568x311] C:\\pi-project\\正常聊天\\pi-studio 这个迁移自OMP的GUI项目有很多的问题，先重构设置与侧栏。",
      "已经完成重构。",
    );
    expect(title).not.toBe("C");
    expect(title).toContain("pi-studio");
    expect(title.length).toBeGreaterThan(4);

    // When firstUser is already corrupted to 'C', falls back to latestUser or answerText
    const recovered = fallbackSmartTitle("C", "已完成插件市场与并行设置窗口开发。", "加上并行设置窗口和插件市场");
    expect(recovered).toBe("加上并行设置窗口和插件市场");
  });

  it("sets command summary target on powershell tools and drops empty assistant containers on tool-calling steps", () => {
    const bridge = new PiTspBridge("Process Group Test");
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        id: "tc_ps_1",
        toolName: "powershell",
      },
    });
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "tc_ps_1",
          name: "powershell",
          arguments: { command: "Set-Location -LiteralPath 'C:\\repo'\nnpm run check" },
        },
      },
    });
    bridge.handleRpcEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "" },
          {
            type: "toolCall",
            id: "tc_ps_1",
            name: "powershell",
            arguments: { command: "Set-Location -LiteralPath 'C:\\repo'\nnpm run check" },
          },
        ],
        usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 1050 },
        model: "gemini-4-argon-high",
      },
    });

    const surface = bridge.document.surfaces.get(PI_SURFACE_ID)!;
    const main = surface.nodes.get("main")!;
    // Empty omp.assistant must have been removed, leaving only the tool node in main
    const toolNodes = main.c.map((id) => surface.nodes.get(id)!).filter((n) => n?.k === "tool");
    const asstNodes = main.c
      .map((id) => surface.nodes.get(id)!)
      .filter((n) => n?.k === "col" && n.p["role"] === "omp.assistant");
    expect(toolNodes).toHaveLength(1);
    expect(toolNodes[0]!.p["target"]).toBe("npm run check");
    expect(toolNodes[0]!.p["targetKind"]).toBe("command");
    expect(asstNodes).toHaveLength(0);
  });

  it("handles /add-dir, /dirs, and /remove-dir in PiTaskRunner with parseDirsOutput-compatible format", async () => {
    const dir = await makeTempDir();
    const extraDir = await makeTempDir();
    let record: TaskRecord = {
      id: "task_dirs" as TaskId,
      projectId: "proj_dirs" as ProjectId,
      title: "Dirs Test",
      archived: false,
      sessionFile: null,
      worktreePath: null,
      worktreeBranch: null,
      worktreeBase: null,
      cwd: dir,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      thinkingLevel: null,
    };
    const runner = new PiTaskRunner(
      record,
      { id: "proj_dirs" as ProjectId, name: "DirsProj", path: dir },
      {
        buildPiLaunch: () => Promise.resolve(FAKE_LAUNCH),
        acquireSlot: () => Promise.resolve(),
        persist: (_id, patch) => {
          record = { ...record, ...patch };
          return Promise.resolve(record);
        },
        isForeground: () => true,
        onState: () => {},
        onTspBatch: () => {},
      },
    );
    try {
      const addOut = await runner.runSessionCommand(`/add-dir ${extraDir}`);
      runner.applyWorkspaceDirsOutput(addOut);
      expect(runner.workspaceDirs).toEqual([extraDir]);

      const listOut = await runner.runSessionCommand("/dirs");
      runner.applyWorkspaceDirsOutput(listOut);
      expect(runner.workspaceDirs).toEqual([extraDir]);

      const rmOut = await runner.runSessionCommand(`/remove-dir ${extraDir}`);
      runner.applyWorkspaceDirsOutput(rmOut);
      expect(runner.workspaceDirs).toEqual([]);
    } finally {
      await runner.dispose();
    }
  });
});

describe("PiTspBridge — subagent 工具的 details → 右侧 Subagent 面板", () => {
  const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 1200, turns: 3 };

  /** 一条 Pi 的 SingleResult（只填面板和详情用得到的字段）。 */
  function singleResult(agent: string, task: string, status: string): Record<string, unknown> {
    return {
      agent,
      agentSource: "user",
      task,
      status,
      exitCode: 0,
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "grep", arguments: { pattern: "x" } }] },
        { role: "assistant", content: [{ type: "text", text: `${agent} 的结论` }] },
      ],
      stderr: "",
      usage,
      model: "anthropic/claude-test",
    };
  }

  it("renders one agent node per completed result so listAgents() lists them", () => {
    const bridge = new PiTspBridge("Subagent Parallel");
    const args = {
      tasks: [
        { agent: "scout", task: "find the file" },
        { agent: "reviewer", task: "review the diff" },
      ],
    };
    const details = {
      mode: "parallel",
      isError: false,
      results: [
        singleResult("scout", "find the file", "completed"),
        singleResult("reviewer", "review the diff", "completed"),
      ],
    };

    bridge.handleRpcEvent({ type: "tool_execution_start", toolCallId: "tc_sub", toolName: "subagent", args });
    bridge.handleRpcEvent({
      type: "tool_execution_end",
      toolCallId: "tc_sub",
      toolName: "subagent",
      result: { content: [{ type: "text", text: "scout 的结论\nreviewer 的结论" }], details },
      isError: false,
      durationMs: 5000,
    });

    const surface = bridge.document.surfaces.get(PI_SURFACE_ID)!;
    const agentNodes = [...surface.nodes.values()].filter((node) => node.k === "agent");
    expect(agentNodes).toHaveLength(2);

    const agents = listAgents(bridge.document);
    expect(agents.map((agent) => agent.name)).toEqual(["scout", "reviewer"]);
    expect(agents.every((agent) => agent.status === "done")).toBe(true);
    expect(agents[0]?.task).toBe("find the file");
    expect(agents[0]?.model).toBe("anthropic/claude-test");
    expect(agents[0]?.agent).toBe("user");
    expect(agents[0]?.stats.tools).toBe(1);
    expect(agents[0]?.stats.requests).toBe(3);
    expect(agents[0]?.stats.tokens).toBe(1200);
    expect(agents[0]?.stats.cost).toBe(0.02);

    // 详情缓存：messages 原样给出，output 取最后一条 assistant 文本。
    const record = bridge.getSubagentRecord("reviewer");
    expect(record?.messages).toHaveLength(2);
    expect(record?.output).toBe("reviewer 的结论");
    expect(record?.model).toBe("anthropic/claude-test");
    expect(bridge.getSubagentRecord("nope")).toBeNull();
  });

  it("shows running rows from args while streaming and settles them from partial details", () => {
    const bridge = new PiTspBridge("Subagent Streaming");
    const args = {
      tasks: [
        { agent: "scout", task: "a" },
        { agent: "reviewer", task: "b" },
      ],
    };
    bridge.handleRpcEvent({ type: "tool_execution_start", toolCallId: "tc_up", toolName: "subagent", args });

    let agents = listAgents(bridge.document);
    expect(agents.map((agent) => agent.name)).toEqual(["scout", "reviewer"]);
    expect(agents.every((agent) => agent.status === "running")).toBe(true);

    bridge.handleRpcEvent({
      type: "tool_execution_update",
      toolCallId: "tc_up",
      toolName: "subagent",
      args,
      partialResult: {
        content: [{ type: "text", text: "scout 在跑" }],
        details: { mode: "parallel", isError: false, results: [singleResult("scout", "a", "running")] },
      },
    });

    agents = listAgents(bridge.document);
    // 流式阶段：scout 拿到 details 里的用量，还没开始的那条不发假用量（null = 未知）。
    expect(agents.find((agent) => agent.name === "scout")?.status).toBe("running");
    expect(agents.find((agent) => agent.name === "scout")?.stats.requests).toBe(3);
    expect(agents.find((agent) => agent.name === "reviewer")?.stats.requests).toBeNull();
    expect(agents.find((agent) => agent.name === "reviewer")?.stats.tokens).toBeNull();
    // 同一行只更新不重建（id 稳定，多次 update 也不会重复）。
    const surface = bridge.document.surfaces.get(PI_SURFACE_ID)!;
    expect([...surface.nodes.values()].filter((node) => node.k === "agent")).toHaveLength(2);
  });

  it("keeps chain mode badges, step and per-agent error text", () => {
    const bridge = new PiTspBridge("Subagent Chain");
    const args = {
      chain: [
        { agent: "scout", task: "find" },
        { agent: "planner", task: "plan" },
      ],
    };
    const failed = { ...singleResult("planner", "plan", "failed"), errorMessage: "model overloaded" };
    bridge.handleRpcEvent({
      type: "tool_execution_end",
      toolCallId: "tc_chain",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "chain 失败" }],
        details: {
          mode: "chain",
          isError: true,
          results: [singleResult("scout", "find", "completed"), { ...failed, step: 2 }],
        },
      },
      isError: true,
    });
    void args;

    const agents = listAgents(bridge.document);
    expect(agents.map((agent) => agent.name)).toEqual(["scout", "planner"]);
    expect(agents[0]?.status).toBe("done");
    expect(agents[1]?.status).toBe("failed");

    const planner = [...bridge.document.surfaces.get(PI_SURFACE_ID)!.nodes.values()].find(
      (node) => node.k === "agent" && node.p["name"] === "planner",
    )!;
    expect(JSON.stringify(planner.p["badges"])).toContain("chain");
    expect(JSON.stringify(planner.p["badges"])).toContain("step 2");
    const errorChild = planner.c?.map((id) => bridge.document.surfaces.get(PI_SURFACE_ID)!.nodes.get(id));
    expect(errorChild?.some((node) => node?.p["text"] === "model overloaded")).toBe(true);
  });

  it("falls back to args when the tool result carries no details", () => {
    const bridge = new PiTspBridge("Subagent No Details");
    bridge.handleRpcEvent({
      type: "tool_execution_start",
      toolCallId: "tc_plain",
      toolName: "subagent",
      args: { agent: "scout", task: "look around" },
    });
    let agents = listAgents(bridge.document);
    expect(agents.map((agent) => agent.name)).toEqual(["scout"]);
    expect(agents[0]?.status).toBe("running");

    bridge.handleRpcEvent({
      type: "tool_execution_end",
      toolCallId: "tc_plain",
      toolName: "subagent",
      result: { content: [{ type: "text", text: "no structured details" }] },
      isError: false,
      durationMs: 10,
    });
    agents = listAgents(bridge.document);
    expect(agents).toHaveLength(1);
    // 卡结束后不能还挂着「运行中」/「等待」。
    expect(agents[0]?.status).toBe("done");
  });
});

describe("PiTspBridge — 工具参数流式生成时列表就有路径与进行中状态", () => {
  const surfaceOf = (bridge: PiTspBridge) => bridge.document.surfaces.get(PI_SURFACE_ID)!;

  const onlyToolNode = (bridge: PiTspBridge) => {
    const tools = [...surfaceOf(bridge).nodes.values()].filter((node) => node.k === "tool");
    expect(tools).toHaveLength(1);
    return tools[0]!;
  };

  it("fills the path in place from toolcall_delta and keeps the node id stable to the end", () => {
    const bridge = new PiTspBridge("Tool Delta");
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "tc_write_1", toolName: "write" },
    });
    const started = onlyToolNode(bridge);
    // 参数还没到：只有工具名，但计时已经开始（age 0，渲染层自己走字）。
    expect(started.p["target"]).toBeUndefined();
    expect(started.p["status"]).toBe("pending");
    expect(started.p["age"]).toBe(0);

    // 线上 delta 只是参数 JSON 文本的碎片，路径在前几个碎片里就已经完整。
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"src/a.ts","content":"第一行' },
    });

    const updated = onlyToolNode(bridge);
    expect(updated.id).toBe(started.id);
    expect(updated.p["target"]).toBe("src/a.ts");
    expect(updated.p["targetKind"]).toBe("path");
    expect(updated.p["status"]).toBe("pending");
    expect(updated.p["age"]).toBe(0);
    expect(JSON.stringify(surfaceOf(bridge).nodes.get("dock.hud.working.label")?.p["spans"])).toContain("src/a.ts");

    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "tc_write_1",
          name: "write",
          arguments: { path: "src/a.ts", content: "第一行\n第二行" },
        },
      },
    });
    const ended = onlyToolNode(bridge);
    expect(ended.id).toBe(started.id);
    expect(ended.p["target"]).toBe("src/a.ts");
    expect(ended.p["status"]).toBe("pending");

    bridge.handleRpcEvent({
      type: "tool_execution_start",
      toolCallId: "tc_write_1",
      toolName: "write",
      args: { path: "src/a.ts", content: "第一行\n第二行" },
    });
    const running = onlyToolNode(bridge);
    expect(running.id).toBe(started.id);
    expect(running.p["status"]).toBe("running");
    expect(running.p["target"]).toBe("src/a.ts");
    expect(running.p["age"]).toBe(0);

    bridge.handleRpcEvent({
      type: "tool_execution_end",
      toolCallId: "tc_write_1",
      toolName: "write",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });
    const done = onlyToolNode(bridge);
    expect(done.id).toBe(started.id);
    expect(done.p["status"]).toBe("done");
    expect(done.p["target"]).toBe("src/a.ts");
    // 完成时只留总耗时，不再留着定时器。
    expect(typeof done.p["took"]).toBe("number");
    expect(done.p["age"]).toBeUndefined();
  });

  it("ignores half-written argument JSON without throwing or creating bad ops", () => {
    const bridge = new PiTspBridge("Tool Bad Json");
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "tc_bad", toolName: "write" },
    });
    const before = onlyToolNode(bridge);

    // 半截 JSON（字符串没闭合） + partial 里是一段没写完的 JSON 文本：都抳不出参数，也不能抛异常。
    const partial = {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: "tc_bad",
          name: "write",
          arguments: '{"path":"src/b' as unknown as Record<string, unknown>,
        },
      ],
    };
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"src/b', partial },
    });

    const after = onlyToolNode(bridge);
    expect(after.id).toBe(before.id);
    expect(after.p["target"]).toBeUndefined();
    expect(after.p["status"]).toBe("pending");
  });

  it("lazily creates the tool card when toolcall_delta arrives before toolcall_start", () => {
    const bridge = new PiTspBridge("Tool Delta First");
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"path":"src/late.ts"}',
        partial: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc_late", name: "read", arguments: {} }],
        },
      },
    });

    const node = onlyToolNode(bridge);
    expect(node.p["key"]).toBe("tc_late");
    expect(node.p["name"]).toBe("read");
    expect(node.p["target"]).toBe("src/late.ts");
  });
});

describe("PiTspBridge — 漏进正文通道的思维/旁白折叠成过程段", () => {
  const textBlocksOf = (bridge: PiTspBridge): { role: unknown; text: string }[] => {
    const surface = bridge.document.surfaces.get(PI_SURFACE_ID)!;
    const out: { role: unknown; text: string }[] = [];
    for (const node of surface.nodes.values()) {
      if (node.k !== "md") continue;
      const text = node.p["text"];
      if (typeof text === "string") out.push({ role: node.p["role"], text });
    }
    return out;
  };

  it("hydrates a commentary-phase text block as a folded process section, not as body text", () => {
    const bridge = new PiTspBridge("Leak Hydration");
    const jsonl = [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\tmp" }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "改代码", timestamp: 1767225601000 },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "现在把桥接文件里的判断加上，然后再跑测试。",
              textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
            },
            { type: "toolCall", id: "tc_1", name: "read", arguments: { path: "a.ts" } },
          ],
          stopReason: "toolUse",
          timestamp: 1767225602000,
        },
      }),
      JSON.stringify({
        type: "toolResult",
        id: "tr1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tc_1",
          toolName: "read",
          content: [{ type: "text", text: "file body" }],
          isError: false,
          timestamp: 1767225603000,
        },
      }),
    ].join("\n");

    bridge.hydrateFromSessionJsonl(jsonl);
    const blocks = textBlocksOf(bridge);
    expect(blocks.some((b) => b.role === "omp.thinking.body")).toBe(true);
    // 正文区不该出现这段旁白。
    expect(blocks.filter((b) => b.role === undefined).map((b) => b.text)).toEqual(["改代码"]);
    expect(lastAnswerText(bridge.document)).toBeNull();
  });

  it("splits a leaked thinking-tagged text block into folded thinking plus the real answer", () => {
    const bridge = new PiTspBridge("Tagged Leak");
    const jsonl = [
      JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\tmp" }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "<thinking>思考一下怎么改</thinking>\n\n改好了，三处都修了。" }],
          stopReason: "stop",
          timestamp: 1767225601000,
        },
      }),
    ].join("\n");

    bridge.hydrateFromSessionJsonl(jsonl);
    const blocks = textBlocksOf(bridge);
    expect(blocks.find((b) => b.role === "omp.thinking.body")?.text).toBe("思考一下怎么改");
    expect(blocks.find((b) => b.role === undefined)?.text).toBe("改好了，三处都修了。");
    expect(lastAnswerText(bridge.document)).toBe("改好了，三处都修了。");
  });

  it("folds a live text block whose final content is commentary phase", () => {
    const bridge = new PiTspBridge("Live Leak");
    const signature = JSON.stringify({ v: 1, id: "msg_9", phase: "commentary" });
    bridge.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "让我先看一下文件" },
    });
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "让我先看一下文件",
        partial: {
          role: "assistant",
          content: [{ type: "text", text: "让我先看一下文件", textSignature: signature }],
        },
      },
    });

    const blocks = textBlocksOf(bridge);
    expect(blocks.find((b) => b.role === "omp.thinking.body")?.text).toBe("让我先看一下文件");
    expect(blocks.filter((b) => b.role === undefined)).toEqual([]);
  });

  it("keeps final-answer text as body text", () => {
    const bridge = new PiTspBridge("Real Answer");
    const signature = JSON.stringify({ v: 1, id: "msg_10", phase: "final_answer" });
    bridge.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "9.8 更大。",
        partial: {
          role: "assistant",
          content: [{ type: "text", text: "9.8 更大。", textSignature: signature }],
        },
      },
    });

    const blocks = textBlocksOf(bridge);
    expect(blocks.filter((b) => b.role === undefined).map((b) => b.text)).toEqual(["9.8 更大。"]);
    expect(blocks.some((b) => b.role === "omp.thinking.body")).toBe(false);
  });

  it("keeps a single folded paragraph for commentary text and leaves it before the tool card", () => {
    const bridge = new PiTspBridge("Live Leak Order");
    const signature = JSON.stringify({ v: 1, id: "msg_11", phase: "commentary" });
    const textBlock = { type: "text" as const, text: "让我先读一下文件，然后改。", textSignature: signature };
    bridge.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    bridge.handleRpcEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: textBlock.text,
        partial: { role: "assistant", content: [textBlock] },
      },
    });
    bridge.handleRpcEvent({
      type: "tool_execution_start",
      toolCallId: "tc_after",
      toolName: "read",
      args: { path: "a.ts" },
    });
    bridge.handleRpcEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [textBlock, { type: "toolCall", id: "tc_after", name: "read", arguments: { path: "a.ts" } }],
        stopReason: "toolUse",
      },
    });

    const surface = bridge.document.surfaces.get(PI_SURFACE_ID)!;
    const thinkingBodies = [...surface.nodes.values()].filter(
      (node) => node.k === "md" && node.p["role"] === "omp.thinking.body",
    );
    expect(thinkingBodies).toHaveLength(1);
    expect(surface.nodes.has("tc_after")).toBe(false);
    const toolNodes = [...surface.nodes.values()].filter((node) => node.k === "tool");
    expect(toolNodes).toHaveLength(1);
    // 过程段排在工具卡片之前（先折叠旁白，再是工具）。
    const order = (surface.nodes.get("main")?.c ?? []).map((id) => surface.nodes.get(id)?.k);
    expect(order.indexOf("col")).toBeLessThan(order.indexOf("tool"));
    expect(textBlocksOf(bridge).filter((b) => b.role === undefined)).toEqual([]);
  });

  it("keeps body text that only talks about tags as body text", () => {
    const bridge = new PiTspBridge("Tag Talk");
    const jsonl = [
      JSON.stringify({ type: "session", version: 3, id: "s3", timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\tmp" }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "这段讲 </thinking> 标签的行为，另一段讲思考" },
            { type: "text", text: "用 <tag> 包起来，Array<string> 是类型，Map<K, V> 也是" },
          ],
          stopReason: "stop",
          timestamp: 1767225601000,
        },
      }),
    ].join("\n");

    bridge.hydrateFromSessionJsonl(jsonl);
    const blocks = textBlocksOf(bridge);
    // 两段都是正文：不能被折成过程段，也不能被从中间切开。
    expect(blocks.some((b) => b.role === "omp.thinking.body")).toBe(false);
    expect(lastAnswerText(bridge.document)).toBe(
      "这段讲 </thinking> 标签的行为，另一段讲思考\n\n用 <tag> 包起来，Array<string> 是类型，Map<K, V> 也是",
    );
  });
});

describe("PiTspBridge — 压缩失败 / 扩展报错 / 排队与 widget（平时 0 占位）", () => {
  const surfaceOf = (bridge: PiTspBridge) => bridge.document.surfaces.get(PI_SURFACE_ID)!;
  const dockChildren = (bridge: PiTspBridge): string[] => [...(surfaceOf(bridge).nodes.get("dock")?.c ?? [])];
  const spanTexts = (bridge: PiTspBridge, nodeId: string): string =>
    (surfaceOf(bridge).nodes.get(nodeId)?.c ?? [])
      .map((id) => JSON.stringify(surfaceOf(bridge).nodes.get(id)?.p["spans"]))
      .join(" ");

  it("compaction_start 的 HUD 写清触发原因", () => {
    const bridge = new PiTspBridge("Compact");
    for (const [reason, label] of [
      ["overflow", "Compacting context (overflow)…"],
      ["threshold", "Compacting context (threshold)…"],
      ["manual", "Compacting context (manual)…"],
      ["something-new", "Compacting context…"],
    ] as const) {
      bridge.handleRpcEvent({ type: "compaction_start", reason });
      expect(deriveWorkingLabel(bridge.document)).toBe(label);
    }
  });

  it("compaction_end aborted：发一条 info 通知、清掉 HUD，不往消息流插节点", () => {
    const bridge = new PiTspBridge("Compact Aborted");
    const notes: { message: string; level: string }[] = [];
    bridge.onNotify((info) => notes.push(info));
    bridge.handleRpcEvent({ type: "compaction_start", reason: "threshold" });
    const mainBefore = [...(surfaceOf(bridge).nodes.get("main")?.c ?? [])];

    bridge.handleRpcEvent({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false });

    expect(notes).toEqual([{ message: "Compaction cancelled", level: "info" }]);
    expect([...(surfaceOf(bridge).nodes.get("main")?.c ?? [])]).toEqual(mainBefore);
    expect(surfaceOf(bridge).nodes.get("dock.hud")?.c).toEqual([]);
  });

  it("compaction_end 带 errorMessage：插一张错误卡并清掉 HUD（不再静默丢弃）", () => {
    const bridge = new PiTspBridge("Compact Error");
    bridge.handleRpcEvent({ type: "compaction_start", reason: "manual" });
    bridge.handleRpcEvent({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
      errorMessage: "summarizer failed",
    });

    const nodes = [...surfaceOf(bridge).nodes.values()];
    expect(nodes.some((n) => n.p["role"] === "omp.error")).toBe(true);
    expect(nodes.find((n) => n.p["role"] === "omp.error.body")?.p["text"]).toBe("summarizer failed");
    expect(surfaceOf(bridge).nodes.get("dock.hud")?.c).toEqual([]);
  });

  it("compaction_end 有结果时照旧生成压缩段", () => {
    const bridge = new PiTspBridge("Compact Ok");
    bridge.handleRpcEvent({ type: "compaction_start", reason: "threshold" });
    bridge.handleRpcEvent({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        summary: "已压缩的摘要",
        firstKeptEntryId: "entry_100",
        tokensBefore: 120_000,
        estimatedTokensAfter: 8_000,
      },
    });
    const nodes = [...surfaceOf(bridge).nodes.values()];
    expect(nodes.some((n) => n.p["role"] === "omp.compaction")).toBe(true);
    expect(surfaceOf(bridge).nodes.get("dock.hud")?.c).toEqual([]);
  });

  it("extension_error 只发一条 error 通知，不污染消息流", () => {
    const bridge = new PiTspBridge("Ext Error");
    const notes: { message: string; level: string }[] = [];
    bridge.onNotify((info) => notes.push(info));
    const mainBefore = [...(surfaceOf(bridge).nodes.get("main")?.c ?? [])];

    bridge.handleRpcEvent({
      type: "extension_error",
      extensionPath: "/home/u/.pi/agent/extensions/git.ts",
      event: "tool_call",
      error: "boom",
    });

    expect(notes).toEqual([{ message: "Extension error (git.ts): boom", level: "error" }]);
    expect([...(surfaceOf(bridge).nodes.get("main")?.c ?? [])]).toEqual(mainBefore);
  });

  it("setWidget 动态挂 dock.widget，清空后连节点一起摧掉", () => {
    const bridge = new PiTspBridge("Widget");
    expect(dockChildren(bridge)).toEqual(["dock.hud", "dock.dialog"]);

    bridge.handleRpcEvent({
      type: "extension_ui_request",
      id: "w1",
      method: "setWidget",
      widgetKey: "git",
      widgetLines: ["main ↑2", "working tree clean"],
    });
    expect(dockChildren(bridge)).toEqual(["dock.hud", "dock.dialog", "dock.widget"]);
    const first = spanTexts(bridge, "dock.widget");
    expect(first).toContain("main ↑2");
    expect(first).toContain("working tree clean");

    // 同一个 key 再写一次：节点原地替换，不会多出一层。
    bridge.handleRpcEvent({
      type: "extension_ui_request",
      id: "w2",
      method: "setWidget",
      widgetKey: "git",
      widgetLines: ["main ↑3"],
    });
    expect(dockChildren(bridge)).toEqual(["dock.hud", "dock.dialog", "dock.widget"]);
    const second = spanTexts(bridge, "dock.widget");
    expect(second).toContain("main ↑3");
    expect(second).not.toContain("working tree clean");

    // widgetLines 缺省 = 清掉这个 widget；最后一个没了就连 dock.widget 节点一起摧掉。
    bridge.handleRpcEvent({ type: "extension_ui_request", id: "w3", method: "setWidget", widgetKey: "git" });
    expect(surfaceOf(bridge).nodes.has("dock.widget")).toBe(false);
    expect(dockChildren(bridge)).toEqual(["dock.hud", "dock.dialog"]);
  });

  it("queue_update 只在真有排队内容时挂 dock.queue，两边都空就摧掉", () => {
    const bridge = new PiTspBridge("Queue");
    expect(dockChildren(bridge)).toEqual(["dock.hud", "dock.dialog"]);

    bridge.handleRpcEvent({ type: "queue_update", steering: ["use tabs"], followUp: ["then run tests"] });
    expect(dockChildren(bridge)).toContain("dock.queue");
    const text = spanTexts(bridge, "dock.queue");
    expect(text).toContain("[Steering] use tabs");
    expect(text).toContain("[Queued] then run tests");

    bridge.handleRpcEvent({ type: "queue_update", steering: [], followUp: [] });
    expect(surfaceOf(bridge).nodes.has("dock.queue")).toBe(false);
    expect(dockChildren(bridge)).toEqual(["dock.hud", "dock.dialog"]);

    // 本来就空的队列再报一次：不发帧，文档序号不动。
    const seqBefore = bridge.seq;
    expect(bridge.handleRpcEvent({ type: "queue_update", steering: [], followUp: [] })).toEqual([]);
    expect(bridge.seq).toBe(seqBefore);
  });

  it("message_end 的用量脚注带上本轮真实耗时", () => {
    const bridge = new PiTspBridge("Elapsed");
    bridge.handleRpcEvent({ type: "turn_start" });
    // 把本轮开始时间往前拨 1.4 秒，模拟一轮真实耗时。
    (bridge as unknown as { turnStartedAtMs: number }).turnStartedAtMs = Date.now() - 1400;
    bridge.handleRpcEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        model: "anthropic/claude-sonnet-4-5",
        usage: { input: 700, output: 28, cacheRead: 0, cacheWrite: 0, totalTokens: 728 },
        timestamp: Date.now(),
      },
    });

    const nodes = [...surfaceOf(bridge).nodes.values()];
    const footer = nodes.find((n) => n.p["role"] === "omp.turn.usage");
    expect(footer).toBeDefined();
    const footerSpan = JSON.stringify(surfaceOf(bridge).nodes.get(`${footer!.id}/text`)?.p["spans"]);
    expect(footerSpan).toContain("1.4s");
    expect(footerSpan).toContain("728 tok");
  });
});
