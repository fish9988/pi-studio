// `thinkingLevelMap`（Pi 的思考档位映射）的序列化 / 校验 / 保存回显：
// - 界面没声明（null / 空对象）时一个档位都不写进去，不替所有模型硬塞 xhigh / max；
// - 写了的档位按 Pi 的顺序落盘，null（隐藏）原样写回；
// - 清掉配置时整项删掉，模型条目里别的键（cost、compat、samplingParams……）与根上的未知字段一律不动；
// - 文件里认不出的写法（不认识的档位、不是字符串也不是 null）原样保留，不拿界面上的空值覆盖。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasThinkingLevelMap,
  isThinkingLevelMapSavable,
  type CustomProviderInput,
  type CustomThinkingLevelMap,
} from "../src/shared/custom-models.ts";
import { piModelThinkingLevels } from "../src/shared/pi-model-capability.ts";
import {
  applyPiOverride,
  applyPiProvider,
  parsePiProviders,
  readPiModelsFile,
  savePiCustomProvider,
  savePiProviderOverride,
} from "../src/main/pi-config/auth-and-models.ts";

const noEnv = (): "missing" => "missing";

const meta = (over: Partial<{ thinkingLevelMap: CustomThinkingLevelMap | null }> = {}) => ({
  reasoning: null as boolean | null,
  images: null,
  contextWindow: null,
  maxTokens: null,
  thinkingLevelMap: null as CustomThinkingLevelMap | null,
  ...over,
});

const input = (over: Partial<CustomProviderInput> = {}): CustomProviderInput => ({
  id: "relay",
  baseUrl: "https://relay.example.com/v1",
  api: "openai-completions",
  key: { kind: "literal", value: "sk-relay" },
  models: [{ id: "gpt-6.1-sol", ...meta() }],
  ...over,
});

function applied(text: string | null, value: CustomProviderInput, mode: "add" | "edit" = "edit"): string {
  const result = applyPiProvider(text, value, mode);
  if (!result.ok) throw new Error(`unexpected ${result.code}`);
  return result.text;
}

function parsed(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** 一个像用户真实 models.json 的文件：根上有未知字段，模型条目里也有别的键。 */
const existing = `{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "unknownRoot": { "keep": true },
  "providers": {
    "relay": {
      "baseUrl": "https://relay.example.com/v1",
      "apiKey": "$RELAY_KEY",
      "api": "openai-completions",
      "headers": { "X-Trace": "1" },
      "models": [
        {
          "id": "gpt-6.1-sol",
          "name": "GPT 6.1 Sol",
          "reasoning": true,
          "contextWindow": 400000,
          "maxTokens": 128000,
          "cost": { "input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0 },
          "thinkingLevelMap": { "minimal": null, "xhigh": "xhigh", "max": "max" }
        },
        { "id": "plain" }
      ]
    }
  }
}
`;

describe("models.json 的 thinkingLevelMap", () => {
  it("界面没声明时一个档位都不写（不替模型声明 xhigh / max）", () => {
    const text = applied(
      existing,
      input({
        models: [
          {
            id: "gpt-6.1-sol",
            ...meta({ thinkingLevelMap: null }),
            reasoning: true,
            contextWindow: 400000,
            maxTokens: 128000,
          },
        ],
      }),
    );
    const model = (parsed(text) as { providers: { relay: { models: Record<string, unknown>[] } } }).providers.relay
      .models[0]!;
    expect(model).not.toHaveProperty("thinkingLevelMap");
    // 别的键、根上的未知字段都在
    expect(model["cost"]).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(model["name"]).toBe("GPT 6.1 Sol");
    expect(model["maxTokens"]).toBe(128000);
    expect((parsed(text) as { unknownRoot: unknown }).unknownRoot).toEqual({ keep: true });
    // 没有声明的模型按 Pi 的规则只有 off…high
    expect(piModelThinkingLevels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("写 xhigh / max 映射和 null 隐藏：按 Pi 的档位顺序落盘，隐藏的值原样写回", () => {
    const map: CustomThinkingLevelMap = { max: "max", xhigh: "xhigh", minimal: null };
    const text = applied(
      existing,
      input({
        models: [{ id: "gpt-6.1-sol", ...meta({ thinkingLevelMap: map }), reasoning: true }],
      }),
    );
    const model = (parsed(text) as { providers: { relay: { models: Record<string, unknown>[] } } }).providers.relay
      .models[0]!;
    expect(model["thinkingLevelMap"]).toEqual({ minimal: null, xhigh: "xhigh", max: "max" });
    expect(Object.keys(model["thinkingLevelMap"] as object)).toEqual(["minimal", "xhigh", "max"]);
    // 写完后 Pi 判定的档位和写进去的一致
    expect(piModelThinkingLevels({ reasoning: true, thinkingLevelMap: map })).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("清掉配置：整项删掉，条目里别的键原样", () => {
    const text = applied(
      existing,
      input({
        models: [
          {
            id: "gpt-6.1-sol",
            ...meta({ thinkingLevelMap: null }),
            reasoning: true,
            contextWindow: 400000,
            maxTokens: 128000,
          },
        ],
      }),
    );
    const model = (parsed(text) as { providers: { relay: { models: Record<string, unknown>[] } } }).providers.relay
      .models[0]!;
    expect(model).not.toHaveProperty("thinkingLevelMap");
    expect(model["maxTokens"]).toBe(128000);
    expect(model["contextWindow"]).toBe(400000);
  });

  it("空对象和没声明等价，也不再往文件里写空对象", () => {
    const text = applied(existing, input({ models: [{ id: "gpt-6.1-sol", ...meta({ thinkingLevelMap: {} }) }] }));
    const model = (parsed(text) as { providers: { relay: { models: Record<string, unknown>[] } } }).providers.relay
      .models[0]!;
    expect(model).not.toHaveProperty("thinkingLevelMap");
  });

  it("文件里写了空对象（{}）：等于没声明，界面上新写的档位照样落盘", () => {
    const emptyMap = `{
  "providers": {
    "relay": {
      "baseUrl": "https://relay.example.com/v1",
      "api": "openai-completions",
      "models": [{ "id": "m", "thinkingLevelMap": {} }]
    }
  }
}
`;
    const text = applied(emptyMap, input({ models: [{ id: "m", ...meta({ thinkingLevelMap: { high: "high" } }) }] }));
    expect(
      (parsed(text) as { providers: { relay: { models: Record<string, unknown>[] } } }).providers.relay.models[0],
    ).toEqual({ id: "m", thinkingLevelMap: { high: "high" } });
  });

  it("文件里认不出的写法原样保留（不认识的档位 / 不是字符串也不是 null）", () => {
    const weird = `{
  "providers": {
    "relay": {
      "baseUrl": "https://relay.example.com/v1",
      "api": "openai-completions",
      "models": [{ "id": "m", "thinkingLevelMap": { "turbo": "turbo" } }]
    }
  }
}
`;
    const info = parsePiProviders(weird, noEnv);
    expect(info.ok && info.providers[0]?.models[0]?.thinkingLevelMap).toBeNull();
    const text = applied(weird, input({ models: [{ id: "m", ...meta() }] }));
    expect(
      (parsed(text) as { providers: { relay: { models: Record<string, unknown>[] } } }).providers.relay.models[0],
    ).toEqual({ id: "m", thinkingLevelMap: { turbo: "turbo" } });
    // 用户在界面上新写了档位也不会把认不出的那几项抹掉（整项不动，等用户自己去改文件）。
    const withMap = applied(weird, input({ models: [{ id: "m", ...meta({ thinkingLevelMap: { high: "high" } }) }] }));
    expect(
      (parsed(withMap) as { providers: { relay: { models: Record<string, unknown>[] } } }).providers.relay.models[0],
    ).toEqual({ id: "m", thinkingLevelMap: { turbo: "turbo" } });
  });

  it("非法档位 / 空值 / 首尾空格一律 invalid-models，不落盘", () => {
    for (const thinkingLevelMap of [
      { turbo: "turbo" } as CustomThinkingLevelMap,
      { high: "" } as CustomThinkingLevelMap,
      { high: " high" } as CustomThinkingLevelMap,
      { high: 1 as unknown as string } as CustomThinkingLevelMap,
    ]) {
      expect(
        applyPiProvider(existing, input({ models: [{ id: "m", ...meta({ thinkingLevelMap }) }] }), "edit"),
      ).toEqual({
        ok: false,
        code: "invalid-models",
      });
    }
  });

  it("回显：readPiModelsFile 读出模型条目和覆盖项的 thinkingLevelMap（只含写了的档位）", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-thinking-map-"));
    try {
      await writeFile(path.join(agentDir, "models.json"), existing, "utf8");
      const info = await readPiModelsFile(agentDir);
      expect(info.providers[0]?.models[0]?.thinkingLevelMap).toEqual({ minimal: null, xhigh: "xhigh", max: "max" });
      expect(info.providers[0]?.models[1]?.thinkingLevelMap).toBeNull();

      const ov = applyPiOverride(existing, "relay", {
        key: { kind: "keep" },
        models: [
          { id: "gpt-6.1-sol", ...meta({ thinkingLevelMap: { high: "high" } }) },
          { id: "plain", ...meta() },
        ],
      });
      expect(ov.ok).toBe(true);
      if (!ov.ok) return;
      expect(parsePiProviders(ov.text, noEnv).ok).toBe(true);
      const written = parsed(ov.text) as { providers: { relay: { modelOverrides: Record<string, unknown> } } };
      expect(written.providers.relay.modelOverrides["gpt-6.1-sol"]).toEqual({ thinkingLevelMap: { high: "high" } });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("覆盖项只写了 thinkingLevelMap 也算覆盖项（界面上要能列出来）", async () => {
    const text = applyPiOverride(null, "relay", {
      key: null,
      models: [{ id: "gpt-6.1-sol", ...meta({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } }) }],
    });
    // 没有这个 provider → not-found；这里直接验证写入后的回显
    expect(text).toEqual({ ok: false, code: "not-found" });

    const ov = applyPiOverride(existing, "relay", {
      key: { kind: "keep" },
      models: [{ id: "gpt-6.1-sol", ...meta({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } }) }],
    });
    if (!ov.ok) throw new Error(ov.code);
    const info = parsePiProviders(ov.text, noEnv);
    expect(info.ok && info.providers[0]?.overrides).toEqual([
      {
        id: "gpt-6.1-sol",
        reasoning: null,
        images: null,
        contextWindow: null,
        maxTokens: null,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
    ]);
    // 清掉之后覆盖项整条删掉（没有别的键）
    const cleared = applyPiOverride(ov.text, "relay", { key: { kind: "keep" }, models: [] });
    if (!cleared.ok) throw new Error(cleared.code);
    expect(
      (parsed(cleared.text) as { providers: { relay: Record<string, unknown> } }).providers.relay,
    ).not.toHaveProperty("modelOverrides");
  });

  it("保存后再读回来（回显）与再保存一次字节不变", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-thinking-map-save-"));
    try {
      const map: CustomThinkingLevelMap = { low: "low", xhigh: "xhigh", max: null };
      const saved = await savePiCustomProvider(
        agentDir,
        input({ models: [{ id: "gpt-6.1-sol", ...meta({ thinkingLevelMap: map }) }] }),
        "add",
      );
      expect(saved.ok).toBe(true);
      const info = await readPiModelsFile(agentDir);
      expect(info.providers[0]?.models[0]?.thinkingLevelMap).toEqual(map);

      const before = await readFile(path.join(agentDir, "models.json"), "utf8");
      const again = await savePiCustomProvider(
        agentDir,
        input({ models: [{ id: "gpt-6.1-sol", ...meta({ thinkingLevelMap: map }) }] }),
        "edit",
      );
      expect(again.ok).toBe(true);
      expect(await readFile(path.join(agentDir, "models.json"), "utf8")).toBe(before);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("覆盖项清空 thinkingLevelMap 时保留条目里的 name / cost 等别的键", async () => {
    const withName = `{
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-sonnet-4-6": { "name": "Sonnet", "thinkingLevelMap": { "max": "max" } }
      }
    }
  }
}
`;
    const ov = await (async () => {
      const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-thinking-map-ov-"));
      try {
        await writeFile(path.join(agentDir, "models.json"), withName, "utf8");
        const result = await savePiProviderOverride(agentDir, "anthropic", {
          key: { kind: "keep" },
          models: [{ id: "claude-sonnet-4-6", ...meta({ thinkingLevelMap: null }) }],
        });
        expect(result.ok).toBe(true);
        return parsed(await readFile(path.join(agentDir, "models.json"), "utf8")) as {
          providers: { anthropic: { modelOverrides: Record<string, unknown> } };
        };
      } finally {
        await rm(agentDir, { recursive: true, force: true });
      }
    })();
    expect(ov.providers.anthropic.modelOverrides["claude-sonnet-4-6"]).toEqual({ name: "Sonnet" });
  });
});

// 表单侧「留空 = 不声明」用的就是这两个纯函数：保存时 null / 空对象都不写，非法值挡住保存。
describe("表单侧的 thinkingLevelMap 约定", () => {
  it("没声明 / 空对象 = 不写；只有一个档位也算声明", () => {
    expect(hasThinkingLevelMap(null)).toBe(false);
    expect(hasThinkingLevelMap(undefined)).toBe(false);
    expect(hasThinkingLevelMap({})).toBe(false);
    expect(hasThinkingLevelMap({ xhigh: "xhigh" })).toBe(true);
    expect(hasThinkingLevelMap({ high: null })).toBe(true);
  });

  it("非法值挡住保存，合法值放行", () => {
    expect(isThinkingLevelMapSavable(null)).toBe(true);
    expect(isThinkingLevelMapSavable({})).toBe(true);
    expect(isThinkingLevelMapSavable({ minimal: null, xhigh: "xhigh", max: "max" })).toBe(true);
    expect(isThinkingLevelMapSavable({ turbo: "turbo" })).toBe(false);
    expect(isThinkingLevelMapSavable({ high: "" })).toBe(false);
    expect(isThinkingLevelMapSavable({ high: " high" })).toBe(false);
  });
});
