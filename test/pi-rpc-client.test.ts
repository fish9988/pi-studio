import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PiLaunch } from "../src/main/pi/discover.ts";
import { PiRpcClient, PiRpcError, type PiRpcEvent } from "../src/main/pi/pi-rpc-client.ts";

const FAKE_PI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fake-pi", "fake-pi.mjs");

const FAKE_LAUNCH: PiLaunch = {
  command: process.execPath,
  prefixArgs: [FAKE_PI_PATH],
  env: { ELECTRON_RUN_AS_NODE: "1" },
  displayPath: FAKE_PI_PATH,
};

const tempDirs: string[] = [];
const activeClients: PiRpcClient[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-rpc-client-test-"));
  tempDirs.push(dir);
  return dir;
}

function createClient(sessionDir: string, extra?: Partial<ConstructorParameters<typeof PiRpcClient>[0]>): PiRpcClient {
  const client = new PiRpcClient({
    launch: FAKE_LAUNCH,
    cwd: sessionDir,
    sessionDir,
    ...extra,
  });
  activeClients.push(client);
  return client;
}

function waitForSettled(client: PiRpcClient): Promise<PiRpcEvent[]> {
  return new Promise((resolve) => {
    const collected: PiRpcEvent[] = [];
    const off = client.onEvent((ev) => {
      collected.push(ev);
      if (ev.type === "agent_settled") {
        off();
        resolve(collected);
      }
    });
  });
}

afterEach(async () => {
  while (activeClients.length > 0) {
    const c = activeClients.pop();
    if (c !== undefined) {
      await c.close(1_500);
    }
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d !== undefined) {
      await rm(d, { recursive: true, force: true });
    }
  }
});

describe("PiRpcClient", () => {
  it("queries state, models, thinking levels, commands, session stats, compact, and exportHtml", async () => {
    const dir = await makeTempDir();
    const client = createClient(dir);

    const state = await client.getState();
    expect(state.model?.provider).toBe("anthropic");
    expect(state.model?.id).toBe("claude-sonnet-4-5");
    expect(state.isStreaming).toBe(false);
    expect(state.sessionFile).toBeTruthy();

    const { models } = await client.getAvailableModels();
    expect(models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
      "google/gemini-2.5-flash",
    ]);

    const levels = await client.getAvailableThinkingLevels();
    expect(levels.levels).toContain("high");
    expect(levels.levels).toContain("max");

    const switched = await client.setModel("openai", "gpt-5");
    expect(switched.id).toBe("gpt-5");

    const cycled = await client.cycleModel();
    expect(cycled?.model.id).toBe("gemini-2.5-flash");

    await client.setModel("anthropic", "claude-sonnet-4-5");
    await client.setThinkingLevel("high");
    expect((await client.getState()).thinkingLevel).toBe("high");
    const cycledThinking = await client.cycleThinkingLevel();
    expect(cycledThinking?.level).toBe("xhigh");

    const { commands } = await client.getCommands();
    expect(commands.length).toBeGreaterThanOrEqual(3);

    await client.setSessionName("RPC Test Session");
    const namedState = await client.getState();
    expect(namedState.sessionName).toBe("RPC Test Session");

    const compactRes = await client.compact("keep key decisions");
    expect(compactRes.summary).toContain("keep key decisions");

    const htmlPath = path.join(dir, "exported.html");
    const exported = await client.exportHtml(htmlPath);
    expect(exported.path).toBe(htmlPath);
    expect(existsSync(htmlPath)).toBe(true);
    const htmlContent = await readFile(htmlPath, "utf8");
    expect(htmlContent).toContain("Pi Session Export");

    await expect(client.setModel("invalid", "nonexistent")).rejects.toBeInstanceOf(PiRpcError);
  });

  it("streams prompt turns and preserves U+2028 / U+2029 inside CRLF-framed JSONL lines", async () => {
    const dir = await makeTempDir();
    const client = createClient(dir);

    const settledPromise = waitForSettled(client);
    const ack = await client.prompt("Test strict framing [unicode] [crlf] [tool]");
    expect(ack.disposition).toBe("started");

    const events = await settledPromise;
    const types = events.map((e) => e.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_update");
    expect(types).toContain("tool_execution_end");
    expect(types).toContain("agent_end");
    expect(types).toContain("agent_settled");

    const lastText = await client.getLastAssistantText();
    expect(lastText.text).toContain("\u2028line-sep\u2029para-sep");

    const stats = await client.getSessionStats();
    expect(stats.userMessages).toBe(1);
    expect(stats.assistantMessages).toBe(1);
    expect(stats.toolCalls).toBe(1);
    expect(stats.tokens.total).toBeGreaterThan(0);
  });

  it("completes extension_ui_request / sendExtensionUiResponse roundtrip", async () => {
    const dir = await makeTempDir();
    const client = createClient(dir);

    const off = client.onEvent((ev) => {
      if (ev.type === "extension_ui_request" && ev.method === "confirm") {
        client.sendExtensionUiResponse({ id: ev.id, confirmed: true });
      }
    });

    const settledPromise = waitForSettled(client);
    await client.prompt("Run deployment [confirm]");
    await settledPromise;
    off();

    const last = await client.getLastAssistantText();
    expect(last.text).toContain("[UI confirmed]");
  });

  it("supports aborting a slow streaming turn and forking/cloning sessions", async () => {
    const dir = await makeTempDir();
    const client = createClient(dir);

    // 1. Complete first turn so we have a forkable user entry
    const firstTurn = waitForSettled(client);
    await client.prompt("First turn message");
    await firstTurn;

    const forkCandidates = await client.getForkMessages();
    expect(forkCandidates.messages).toHaveLength(1);
    const firstEntryId = forkCandidates.messages[0]!.entryId;

    // 2. Start slow second turn and abort mid-stream
    const secondTurn = waitForSettled(client);
    await client.prompt("Second slow turn [slow]");
    await new Promise((r) => setTimeout(r, 250));
    await client.abort();
    const abortEvents = await secondTurn;

    const settledEvent = abortEvents.find((e) => e.type === "agent_settled");
    expect(settledEvent?.type === "agent_settled" && settledEvent.aborted).toBe(true);

    // 3. Clone and fork
    const cloned = await client.clone();
    expect(cloned.cancelled).toBe(false);

    const forked = await client.fork(firstEntryId);
    expect(forked.cancelled).toBe(false);
    expect(forked.text).toBe("First turn message");

    const postForkMsgs = await client.getMessages();
    expect(postForkMsgs.messages).toHaveLength(0);
  });
});
