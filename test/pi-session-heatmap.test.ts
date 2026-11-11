import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatLocalDate,
  PI_HEATMAP_DAYS,
  readPiSessionTrace,
  readPiUsageHeatmap,
} from "../src/main/usage/pi-session-heatmap.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeAssistantLine(opts: {
  id: string;
  ts: number;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost: number;
  stopReason?: string;
  durationMs?: number;
  ttftMs?: number;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
}): string {
  const content: Record<string, unknown>[] = [{ type: "text", text: "Done." }];
  for (const tc of opts.toolCalls ?? []) {
    content.push({
      type: "toolCall",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    });
  }
  return JSON.stringify({
    type: "message",
    id: opts.id,
    timestamp: new Date(opts.ts).toISOString(),
    message: {
      role: "assistant",
      provider: opts.provider,
      model: opts.model,
      timestamp: opts.ts,
      stopReason: opts.stopReason ?? "stop",
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      ...(opts.ttftMs !== undefined ? { ttftMs: opts.ttftMs } : {}),
      content,
      usage: {
        input: opts.input,
        output: opts.output,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        ...(opts.totalTokens !== undefined ? { totalTokens: opts.totalTokens } : {}),
        cost: { total: opts.cost },
      },
    },
  });
}

describe("pi-session-heatmap & trace", () => {
  let rootDir = "";
  let agentDir = "";
  let cacheFile = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "pi-heatmap-test-"));
    agentDir = path.join(rootDir, "agent");
    cacheFile = path.join(rootDir, "heatmap-cache.json");
  });

  afterEach(async () => {
    if (rootDir !== "") {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("returns hasDatabase: true and empty days when sessions directory does not exist", async () => {
    const fixedNow = new Date(2026, 10, 11, 12, 0, 0).getTime();
    const heatmap = await readPiUsageHeatmap(agentDir, { cacheFile, now: fixedNow });
    expect(heatmap.hasDatabase).toBe(true);
    expect(heatmap.days).toEqual([]);
    expect(heatmap.models).toEqual([]);
    expect(heatmap.to).toBe(formatLocalDate(fixedNow));
  });

  it("aggregates 365-day usage across nested session JSONLs and incrementally caches by mtime+size", async () => {
    const fixedNow = new Date(2026, 10, 11, 15, 0, 0).getTime();
    const todayDate = formatLocalDate(fixedNow);

    const firstDayObj = new Date(fixedNow);
    firstDayObj.setDate(firstDayObj.getDate() - (PI_HEATMAP_DAYS - 1));
    firstDayObj.setHours(10, 0, 0, 0);
    const boundaryInTs = firstDayObj.getTime();
    const boundaryInDate = formatLocalDate(boundaryInTs);

    const tooOldTs = boundaryInTs - 2 * DAY_MS;

    const projA = path.join(agentDir, "sessions", "--project-alpha--");
    const projB = path.join(agentDir, "sessions", "--project-beta--");
    await Promise.all([mkdir(projA, { recursive: true }), mkdir(projB, { recursive: true })]);

    const fileA = path.join(projA, "session-a.jsonl");
    await writeFile(
      fileA,
      [
        JSON.stringify({ type: "session", version: 3, id: "s-a", cwd: "/workspace/alpha" }),
        JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hi" } }),
        makeAssistantLine({
          id: "a-old",
          ts: tooOldTs,
          provider: "anthropic",
          model: "claude-3-5-sonnet",
          input: 9999,
          output: 9999,
          totalTokens: 19998,
          cost: 9.99,
        }),
        makeAssistantLine({
          id: "a-boundary",
          ts: boundaryInTs,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input: 1000,
          output: 500,
          cacheRead: 200,
          cacheWrite: 100,
          totalTokens: 1800,
          cost: 0.05,
        }),
        makeAssistantLine({
          id: "a-today-1",
          ts: fixedNow - 60_000,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input: 2000,
          output: 1000,
          // omit totalTokens to verify input+output+cacheRead+cacheWrite fallback
          cacheRead: 500,
          cacheWrite: 0,
          cost: 0.12,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    // Create 30 additional session files to verify warm cache speed (<20ms)
    for (let i = 0; i < 30; i++) {
      await writeFile(
        path.join(projB, `session-${i}.jsonl`),
        makeAssistantLine({
          id: `b-${i}`,
          ts: fixedNow - 10_000,
          provider: "openai",
          model: "gpt-5",
          input: 100,
          output: 50,
          totalTokens: 150,
          cost: 0.01,
        }) + "\n",
        "utf8",
      );
    }

    const firstRead = await readPiUsageHeatmap(agentDir, { cacheFile, now: fixedNow });
    expect(firstRead.hasDatabase).toBe(true);
    expect((await stat(cacheFile)).isFile()).toBe(true);

    expect(firstRead.days).toHaveLength(2);
    expect(firstRead.days[0]).toEqual({
      date: boundaryInDate,
      requests: 1,
      tokens: 1800,
      costUsd: 0.05,
    });
    expect(firstRead.days[1]?.date).toBe(todayDate);
    expect(firstRead.days[1]?.requests).toBe(31);
    expect(firstRead.days[1]?.tokens).toBe(3500 + 30 * 150);
    expect(firstRead.days[1]?.costUsd).toBeCloseTo(0.12 + 30 * 0.01, 6);

    const todayModels = (firstRead.models ?? []).filter((m) => m.date === todayDate);
    expect(todayModels).toHaveLength(2);
    expect(todayModels[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      requests: 30,
      tokens: 4500,
    });
    expect(todayModels[1]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      requests: 1,
      tokens: 3500,
    });

    // Warm read should hit cache and finish very fast
    const t0 = performance.now();
    const warmRead = await readPiUsageHeatmap(agentDir, { cacheFile, now: fixedNow });
    const elapsedMs = performance.now() - t0;
    expect(warmRead).toEqual(firstRead);
    expect(elapsedMs).toBeLessThan(100);

    // Append new assistant turn to fileA and bump mtime -> cache invalidates only fileA
    await appendFile(
      fileA,
      makeAssistantLine({
        id: "a-today-2",
        ts: fixedNow - 1_000,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input: 400,
        output: 600,
        totalTokens: 1000,
        cost: 0.04,
      }) + "\n",
      "utf8",
    );
    const futureDate = new Date(Date.now() + 5000);
    await utimes(fileA, futureDate, futureDate);

    const updatedRead = await readPiUsageHeatmap(agentDir, { cacheFile, now: fixedNow });
    const updatedToday = updatedRead.days.find((d) => d.date === todayDate);
    expect(updatedToday?.requests).toBe(32);
    expect(updatedToday?.tokens).toBe(3500 + 4500 + 1000);

    // Delete fileA -> pruned from aggregation
    await rm(fileA);
    const afterDelete = await readPiUsageHeatmap(agentDir, { cacheFile, now: fixedNow });
    expect(afterDelete.days).toHaveLength(1);
    expect(afterDelete.days[0]?.requests).toBe(30);
  });

  it("parses session trace requests newest-first, correlates toolCall/toolResult, and truncates", async () => {
    expect(await readPiSessionTrace(null)).toEqual({
      hasDatabase: true,
      requests: [],
      truncated: false,
    });

    const sessionFile = path.join(rootDir, "trace-session.jsonl");
    const baseTs = 1_760_000_000_000;
    const argsObj = { path: "src/index.ts" };

    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "trace-1", cwd: "/workspace/demo" }),
      makeAssistantLine({
        id: "req-1",
        ts: baseTs,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input: 500,
        output: 120,
        cacheRead: 1000,
        cacheWrite: 200,
        totalTokens: 1820,
        cost: 0.015,
        stopReason: "toolUse",
        durationMs: 1450,
        ttftMs: 320,
        toolCalls: [{ id: "call-1", name: "read", arguments: argsObj }],
      }),
      JSON.stringify({
        type: "message",
        id: "tr-1",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "export const ok = true;\n" }],
        },
      }),
      makeAssistantLine({
        id: "req-2",
        ts: baseTs + 2000,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input: 700,
        output: 80,
        totalTokens: 780,
        cost: 0.008,
        stopReason: "stop",
      }),
      makeAssistantLine({
        id: "req-3",
        ts: baseTs + 4000,
        provider: "openai",
        model: "gpt-5",
        input: 300,
        output: 90,
        totalTokens: 390,
        cost: 0.004,
        stopReason: "stop",
      }),
    ];

    await writeFile(sessionFile, lines.join("\n") + "\n", "utf8");

    const fullTrace = await readPiSessionTrace(sessionFile);
    expect(fullTrace.hasDatabase).toBe(true);
    expect(fullTrace.truncated).toBe(false);
    expect(fullTrace.requests.map((r) => r.entryId)).toEqual(["req-3", "req-2", "req-1"]);

    const req1 = fullTrace.requests[2]!;
    expect(req1).toMatchObject({
      entryId: "req-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      stopReason: "toolUse",
      input: 500,
      output: 120,
      cacheRead: 1000,
      cacheWrite: 200,
      total: 1820,
      costUsd: 0.015,
      durationMs: 1450,
      ttftMs: 320,
    });
    expect(req1.tools).toEqual([
      {
        name: "read",
        isError: false,
        argsChars: JSON.stringify(argsObj).length,
        resultChars: "export const ok = true;\n".length,
      },
    ]);

    const truncatedTrace = await readPiSessionTrace(sessionFile, 2);
    expect(truncatedTrace.truncated).toBe(true);
    expect(truncatedTrace.requests.map((r) => r.entryId)).toEqual(["req-3", "req-2"]);
  });
});
