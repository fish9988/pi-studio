// 旧会话的模型目录同步（PiTaskRunner.listModels / setModel）与模型思考档位来自模型自己的显式能力。
// Pi 只在进程启动时读一次 models.json（ModelRuntime.create → ModelConfig.load），`get_available_models` 是那一刻的快照：
// 新增 provider / 模型之后，还跑着的旧会话靠重开进程（同一个会话文件）才看得见；给模型补了 thinkingLevelMap 也一样。
// 用 test/fake-pi/catalog-rpc.mjs 复现这两个行为（启动时读 catalog.json、set_model 只认快照里的模型）。
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelOption, Project, ProjectId, TaskId, TaskState } from "../src/shared/ipc.ts";
import type { PiLaunch } from "../src/main/pi/discover.ts";
import { PiTaskRunner } from "../src/main/pi/pi-task-runner.ts";
import { PiService, toModelOption } from "../src/main/pi/pi-service.ts";
import type { TaskRecord } from "../src/main/tasks/task-registry.ts";

const MOCK_PI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fake-pi", "catalog-rpc.mjs");

interface CatalogModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
  /** 服务目录有、任务进程看不到（模拟按需加载 / 网络发现的模型）。 */
  hidden?: boolean;
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-model-catalog-refresh-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function optionOf(model: CatalogModel): ModelOption {
  return toModelOption({
    id: model.id,
    name: model.name ?? model.id,
    provider: "probe",
    api: "openai-completions",
    reasoning: model.reasoning === true,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: ["text"],
    contextWindow: model.contextWindow ?? 100_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
}

/** 测试里的"服务进程目录"：和 default-model.ts 一样按输入指纹缓存，文件变了（mtime/size）就现读。 */
class FakeServiceCatalog {
  readonly file: string;
  #stamp: string | null = null;
  #cached: ModelOption[] | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, "catalog.json");
  }

  async write(models: CatalogModel[]): Promise<void> {
    await writeFile(this.file, `${JSON.stringify({ models }, null, 2)}\n`, "utf8");
  }

  async listModels(refresh: boolean): Promise<ModelOption[]> {
    const info = await stat(this.file);
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (!refresh && this.#cached !== null && this.#stamp === stamp) return this.#cached;
    const parsed = JSON.parse(await readFile(this.file, "utf8")) as { models: CatalogModel[] };
    this.#cached = parsed.models.map(optionOf);
    this.#stamp = stamp;
    return this.#cached;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function spawnCount(dir: string): Promise<number> {
  try {
    const text = await readFile(path.join(dir, "spawns.log"), "utf8");
    return text.split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}

interface Harness {
  runner: PiTaskRunner;
  record: () => TaskRecord;
  states: TaskState[];
  spawns: () => Promise<number>;
}

function makeHarness(dir: string, service: FakeServiceCatalog, model: TaskRecord["model"]): Harness {
  const launch: PiLaunch = {
    command: process.execPath,
    prefixArgs: [MOCK_PI_PATH],
    env: { ELECTRON_RUN_AS_NODE: "1", CATALOG_DIR: dir },
    displayPath: MOCK_PI_PATH,
  };
  let record: TaskRecord = {
    id: "task_catalog" as TaskId,
    projectId: "proj_catalog" as ProjectId,
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
    model,
    thinkingLevel: null,
  };
  const project: Project = { id: record.projectId, name: "Catalog", path: dir };
  const states: TaskState[] = [];
  // 旧会话构造时能拿到的只有启动缓存里那份（改目录之前读到的）模型。
  const known: ModelOption[] = [optionOf({ id: "sol-xhigh", name: "Sol XHigh", reasoning: true })];
  const runner = new PiTaskRunner(record, project, {
    buildPiLaunch: () => Promise.resolve(launch),
    acquireSlot: () => Promise.resolve(),
    persist: (_id, patch) => {
      record = { ...record, ...patch };
      return Promise.resolve(record);
    },
    isForeground: () => true,
    onState: (state) => states.push(state),
    onTspBatch: () => {},
    knownModels: () => known,
    listModels: (refresh) => service.listModels(refresh),
  });
  return { runner, record: () => record, states, spawns: () => spawnCount(dir) };
}

const SOL_PLAIN: CatalogModel = { id: "sol-xhigh", name: "Sol XHigh", reasoning: true };
const LEGACY_PLAIN: CatalogModel = { id: "legacy", name: "Legacy", reasoning: false };
const SOL_EXPLICIT: CatalogModel = {
  id: "sol-xhigh",
  name: "Sol XHigh",
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
};

describe("服务进程（草稿与设置页读的目录）在模型表输入变了之后重建", () => {
  it("输入指纹变了：listModelOptions 重起服务进程，新加的模型可见", async () => {
    const dir = await makeTempDir();
    const service = new FakeServiceCatalog(dir);
    await service.write([SOL_PLAIN]);
    const pi = new PiService(
      () =>
        Promise.resolve({
          command: process.execPath,
          prefixArgs: [MOCK_PI_PATH],
          env: { ELECTRON_RUN_AS_NODE: "1", CATALOG_DIR: dir },
          displayPath: MOCK_PI_PATH,
        }),
      { cwd: dir },
    );

    try {
      expect((await pi.listModelOptions(true, "stamp-1")).map((m) => m.key.modelId)).toEqual(["sol-xhigh"]);
      await service.write([SOL_PLAIN, LEGACY_PLAIN]);
      expect((await pi.listModelOptions(true, "stamp-2")).map((m) => m.key.modelId)).toEqual(["sol-xhigh", "legacy"]);
    } finally {
      await pi.close();
    }
  });

  it("目录查询与默认模型查询并发、指纹又变了：重起不打断在途查询，缓存按新输入作废", async () => {
    const dir = await makeTempDir();
    const service = new FakeServiceCatalog(dir);
    await service.write([SOL_PLAIN]);
    const pi = new PiService(
      () =>
        Promise.resolve({
          command: process.execPath,
          prefixArgs: [MOCK_PI_PATH],
          env: { ELECTRON_RUN_AS_NODE: "1", CATALOG_DIR: dir, CATALOG_DELAY_MS: "600" },
          displayPath: MOCK_PI_PATH,
        }),
      { cwd: dir },
    );

    try {
      // 打开模型选择器时，default-model.ts 也是 listModelOptions(true) 加一个并发的 readDefaultModel(true)。
      const listed = pi.listModelOptions(true, "stamp-1");
      // 等旧进程起来、get_available_models 已经在路上（CATALOG_DELAY_MS 回话）再改目录与指纹。
      for (let i = 0; i < 50 && (await spawnCount(dir)) === 0; i++) await sleep(20);
      await sleep(150);
      await service.write([SOL_PLAIN, LEGACY_PLAIN]);
      const defaulted = pi.readDefaultModel(true, "stamp-2");

      // 旧进程正在回 get_available_models（CATALOG_DELAY_MS）时被 close 掉的话，这里会以
      // "pi RPC process exited" reject。
      expect((await listed).map((m) => m.key.modelId)).toEqual(["sol-xhigh"]);
      await expect(defaulted).resolves.not.toBeNull();

      // 指纹变了：旧进程读到的目录不能按新指纹留在缓存里。
      const cached = await pi.listModelOptions(false, "stamp-2");
      expect(cached.map((m) => m.key.modelId)).toEqual(["sol-xhigh", "legacy"]);
    } finally {
      await pi.close();
    }
  });
});

describe("旧会话看得到新加的 provider / 模型", () => {
  it("列表比活进程的模型快照新：空闲时重开进程（同一个会话文件）再列，新模型可见", async () => {
    const dir = await makeTempDir();
    const service = new FakeServiceCatalog(dir);
    await service.write([SOL_PLAIN]);
    const h = makeHarness(dir, service, null);

    try {
      await h.runner.start();
      expect((await h.runner.listModels()).map((m) => m.key.modelId)).toEqual(["sol-xhigh"]);
      expect(await h.spawns()).toBe(1);

      await service.write([SOL_PLAIN, LEGACY_PLAIN]);

      const models = await h.runner.listModels();
      expect(models.map((m) => m.key.modelId)).toEqual(["sol-xhigh", "legacy"]);
      // 新模型来自重开后的进程：列表就是 Pi 会给的那份，不是服务进程拼出来的。
      expect(await h.spawns()).toBe(2);
    } finally {
      await h.runner.dispose();
    }
  });

  it("旧会话选新模型：set_model 说 Model not found 时空闲重开一次再设，模型生效", async () => {
    const dir = await makeTempDir();
    const service = new FakeServiceCatalog(dir);
    await service.write([SOL_PLAIN]);
    const h = makeHarness(dir, service, null);

    try {
      await h.runner.start();
      await h.runner.listModels();
      await service.write([SOL_PLAIN, LEGACY_PLAIN]);

      await h.runner.setModel({ provider: "probe", modelId: "legacy" });
      expect(h.runner.state.model?.key.modelId).toBe("legacy");
      expect(h.record().model).toEqual({ provider: "probe", modelId: "legacy" });
      expect(await h.spawns()).toBe(2);
    } finally {
      await h.runner.dispose();
    }
  });

  it("同一个会话重开一次之后还差（按需发现的模型）：不再反复重开", async () => {
    const dir = await makeTempDir();
    const service = new FakeServiceCatalog(dir);
    await service.write([SOL_PLAIN]);
    const h = makeHarness(dir, service, null);

    try {
      await h.runner.start();
      await h.runner.listModels();
      // 服务目录里多一个进程永远看不到的模型（模拟按需加载 / 网络发现）。
      await service.write([SOL_PLAIN, { ...LEGACY_PLAIN, hidden: true }]);

      expect((await h.runner.listModels()).map((m) => m.key.modelId)).toEqual(["sol-xhigh", "legacy"]);
      expect(await h.spawns()).toBe(2);
      expect((await h.runner.listModels()).map((m) => m.key.modelId)).toEqual(["sol-xhigh", "legacy"]);
      expect(await h.spawns()).toBe(2);
    } finally {
      await h.runner.dispose();
    }
  });
});

describe("旧会话（没有进程）的思考档位跟模型目录", () => {
  it("目录里给模型补了 xhigh / max 的 thinkingLevelMap：胶囊按新目录显示这些档", async () => {
    const dir = await makeTempDir();
    const service = new FakeServiceCatalog(dir);
    await service.write([SOL_EXPLICIT]);
    const h = makeHarness(dir, service, { provider: "probe", modelId: "sol-xhigh" });

    // 构造时只有启动缓存里的旧能力（off…high）。
    expect(h.runner.state.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);

    try {
      await h.runner.listModels();
      expect(h.runner.state.thinkingLevels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
      expect(h.runner.state.model?.thinkingEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    } finally {
      await h.runner.dispose();
    }
  });
});
