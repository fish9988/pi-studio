// 模型思考档位来自模型自己的显式能力（models.json 的 thinkingLevelMap），判定和 Pi 的
// getSupportedThinkingLevels 一致：不能对所有 reasoning 模型一律给到 high，也不能一律补 xhigh/max。
// 实测（pi 1.5.2，临时 agent 目录 + 假 key）：同一份 models.json 里
// - reasoning 且没有 thinkingLevelMap 的模型：get_available_thinking_levels = off…high；
// - 显式映射了 xhigh / max 的模型：off…max。
// 用户报的 GPT-6.1 Sol「最高只到 HIGH」就是前者：Pi 没被告诉它支持 xhigh/max。
import { describe, expect, it } from "vitest";
import type { PiModelInfo } from "../src/main/pi/pi-rpc-client.ts";
import { toModelOption, toThinkingLevelsList } from "../src/main/pi/pi-service.ts";
import { piModelThinkingEfforts, piModelThinkingLevels } from "../src/shared/pi-model-capability.ts";

const SOL: PiModelInfo = {
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  provider: "yunxiang",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_050_000,
  maxTokens: 128_000,
};

const SOL_EXPLICIT: PiModelInfo = {
  ...SOL,
  thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
};

describe("piModelThinkingLevels（和 Pi 的 getSupportedThinkingLevels 一致）", () => {
  it("reasoning 且没有 thinkingLevelMap：off…high，xhigh / max 不算支持", () => {
    expect(piModelThinkingLevels(SOL)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(piModelThinkingLevels({ reasoning: true, thinkingLevelMap: {} })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("显式映射了 xhigh / max：两档都算支持", () => {
    expect(piModelThinkingLevels(SOL_EXPLICIT)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    // 只映射一档：只有那一档算。
    expect(piModelThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("映射成 null 的档明确不支持（不能思考的模型照样关掉思考）", () => {
    expect(piModelThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: null, max: null } })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    // 强制思考的模型（off: null）没有「关」。
    expect(piModelThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null } })).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(piModelThinkingLevels({ reasoning: false, thinkingLevelMap: { off: null, high: "high" } })).toEqual(["off"]);
  });

  it("非 reasoning 模型：只有 off", () => {
    expect(piModelThinkingLevels({ reasoning: false })).toEqual(["off"]);
    expect(piModelThinkingLevels(null)).toEqual(["off"]);
  });

  it("thinkingEfforts 是去掉 off 的那部分", () => {
    expect(piModelThinkingEfforts(SOL)).toEqual(["minimal", "low", "medium", "high"]);
    expect(piModelThinkingEfforts(SOL_EXPLICIT)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(piModelThinkingEfforts({ reasoning: false })).toEqual([]);
  });
});

describe("toModelOption 用模型自己的档位", () => {
  it("GPT-6.1 Sol（没写 thinkingLevelMap）：thinkingEfforts 到 high 为止，不再硬编码", () => {
    expect(toModelOption(SOL).thinkingEfforts).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("显式写了两档：模型选择器能选到 xhigh / max", () => {
    expect(toModelOption(SOL_EXPLICIT).thinkingEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("Pi 报告的活档位（effortsOverride）优先；不支持思考的模型没有档位", () => {
    expect(toModelOption(SOL, ["low", "high"]).thinkingEfforts).toEqual(["low", "high"]);
    expect(toModelOption({ ...SOL, reasoning: false }).thinkingEfforts).toBeNull();
  });
});

describe("toThinkingLevelsList", () => {
  it("Pi 报告的档位原样用（含 off、去重、丢掉 inherit）", () => {
    expect(toThinkingLevelsList(["off", "minimal", "high", "high", "inherit"], SOL)).toEqual([
      "off",
      "minimal",
      "high",
    ]);
  });

  it("Pi 没报时按模型自己的 thinkingLevelMap 推，而不是退回硬编码的 off…high", () => {
    expect(toThinkingLevelsList([], SOL)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(toThinkingLevelsList([], SOL_EXPLICIT)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(toThinkingLevelsList([], { reasoning: false })).toEqual(["off"]);
  });
});
