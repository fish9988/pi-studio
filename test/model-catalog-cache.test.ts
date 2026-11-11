// 模型目录和 Pi 自选默认模型的缓存优先（service/default-model.ts）：数服务进程被用了几次。
// 启动缓存里有、Pi 的输入（版本、settings.json、models.json、auth.json、.env、系统环境里的 key 变量）没变时：
// 预读、任务启动、草稿挂载都不碰服务进程；打开模型选择器（refresh）、登录后、settings.json / models.json 变了、Pi 升级后要现读。
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DefaultModelInfo, ModelOption } from "../src/shared/ipc.ts";
import { StartupCache } from "../src/main/service/startup-cache.ts";

const hoisted = vi.hoisted(() => ({
  uses: 0,
  piVersion: "1.5.2",
  cache: null as unknown,
}));

vi.mock("electron", () => ({ app: { getVersion: () => "0.1.0-test" } }));
vi.mock("../src/main/ipc/events.ts", () => ({ emitEvent: () => {} }));
vi.mock("../src/main/service/startup-cache-instance.ts", () => ({ startupCache: () => hoisted.cache }));
vi.mock("../src/main/pi/runtime-singleton.ts", () => ({
  readyPiVersion: async () => hoisted.piVersion,
  piService: () => ({
    readDefaultModel: async (): Promise<DefaultModelInfo> => {
      hoisted.uses++;
      return {
        key: { provider: "anthropic", modelId: "claude-opus-5-5" },
        name: "Claude Opus 5.5",
        thinkingLevel: "high",
      };
    },
    listModelOptions: async (): Promise<ModelOption[]> => {
      hoisted.uses++;
      return [
        {
          key: { provider: "anthropic", modelId: "claude-opus-5-5" },
          name: "Claude Opus 5.5",
          contextWindow: 1_000_000,
          reasoning: true,
          acceptsImages: false,
          maxTokens: 64_000,
          thinkingEfforts: ["minimal", "low", "medium", "high"],
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          intelligence: null,
          catalogTps: null,
        },
      ];
    },
    invalidate: async () => {},
  }),
}));

// vi.mock 提升到导入之前，被测模块必须在 mock 之后才加载：这里只能动态导入。
const { listModelOptions, prewarmToolbarData, readDefaultModel, reloadServiceModels } =
  await import("../src/main/service/default-model.ts");

/** 记下缓存被查过哪几样：预读不返回 promise，查过之后起不起服务进程是同步决定的。 */
class WatchedCache extends StartupCache {
  readonly checked: string[] = [];

  override freshModels(stamp: string): ModelOption[] | null {
    this.checked.push("models");
    return super.freshModels(stamp);
  }

  override freshDefaultModel(stamp: string): DefaultModelInfo | null | undefined {
    this.checked.push("defaultModel");
    return super.freshDefaultModel(stamp);
  }
}

let scratch: string;
let agentDir: string;
let cache: WatchedCache;
let run = 0;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "omp-studio 模型缓存-"));
  agentDir = path.join(scratch, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  run++;
  await rm(agentDir, { recursive: true, force: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "settings.json"), "{}\n");
  cache = new WatchedCache({
    file: path.join(scratch, `startup-cache-${run}.json`),
    write: async () => {},
    warn: () => {},
  });
  hoisted.cache = cache;
  hoisted.uses = 0;
  hoisted.piVersion = "1.5.2";
});

describe("模型目录、默认模型缓存优先", () => {
  it("缓存里两样都有、输入没变：启动预读、任务启动（refresh=false）、草稿读默认模型都不碰服务进程", async () => {
    await listModelOptions(false);
    await readDefaultModel(false);
    expect(hoisted.uses).toBe(2);

    cache.checked.length = 0;
    prewarmToolbarData();
    await vi.waitFor(() => expect(cache.checked).toEqual(expect.arrayContaining(["models", "defaultModel"])));
    expect(await listModelOptions(false)).toHaveLength(1);
    expect(await readDefaultModel(false)).toMatchObject({ name: "Claude Opus 5.5" });
    expect(hoisted.uses).toBe(2);
  });

  it("打开模型选择器（refresh=true）一定现读目录和默认模型（终端里登录过），读到的记进缓存", async () => {
    await listModelOptions(false);
    await readDefaultModel(false);
    await listModelOptions(true);
    await vi.waitFor(() => expect(hoisted.uses).toBe(4));
    await listModelOptions(false);
    await readDefaultModel(false);
    expect(hoisted.uses).toBe(4);
  });

  it("登录前开始的读晚到：不当成现成的，登录后的下一次读照样现读", async () => {
    const stale = listModelOptions(false);
    await reloadServiceModels();
    await stale;
    await listModelOptions(false);
    expect(hoisted.uses).toBe(2);
  });

  it("系统环境里 provider 的 key 变量变了：下一次读要现读", async () => {
    await listModelOptions(false);
    vi.stubEnv("OPENAI_API_KEY", `sk-test-${run}`);
    await listModelOptions(false);
    await listModelOptions(false);
    expect(hoisted.uses).toBe(2);
  });

  it("登录、改 key、改 provider 之后（reloadServiceModels）下一次读要现读", async () => {
    await listModelOptions(false);
    await readDefaultModel(false);
    await reloadServiceModels();
    await listModelOptions(false);
    await readDefaultModel(false);
    expect(hoisted.uses).toBe(4);
    await listModelOptions(false);
    await readDefaultModel(false);
    expect(hoisted.uses).toBe(4);
  });

  it("agent 目录的 settings.json、models.json 变了或 Pi 升级了：下一次读要现读", async () => {
    await listModelOptions(false);
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(agentDir, "settings.json"), later, later);
    await listModelOptions(false);
    expect(hoisted.uses).toBe(2);

    await writeFile(path.join(agentDir, "models.json"), '{"providers":{}}\n');
    await listModelOptions(false);
    expect(hoisted.uses).toBe(3);

    hoisted.piVersion = "1.6.0";
    await listModelOptions(false);
    expect(hoisted.uses).toBe(4);
    await listModelOptions(false);
    expect(hoisted.uses).toBe(4);
  });
});
