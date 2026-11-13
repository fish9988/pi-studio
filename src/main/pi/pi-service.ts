// Cached background `pi --mode rpc --no-session` service process for global catalog queries:
// `listModelOptions(refresh, inputsStamp)`, `readDefaultModel(refresh, inputsStamp)`, and `listSlashCommands(cwd)`.
import os from "node:os";
import type { DefaultModelInfo, ModelOption } from "../../shared/ipc.ts";
import type {
  AvailableSlashCommand,
  Effort,
  SlashCommandSource,
  ThinkingLevel,
} from "../../shared/omp-wire/rpc-wire.generated.ts";
import {
  piModelThinkingEfforts,
  piModelThinkingLevels,
  type PiThinkingCapability,
} from "../../shared/pi-model-capability.ts";
import type { PiLaunch } from "./discover.ts";
import { PiRpcClient, type PiCommandInfo, type PiModelInfo } from "./pi-rpc-client.ts";

const DEFAULT_IDLE_MS = 5 * 60_000;
const COMMAND_CACHE_TTL_MS = 15_000;

const VALID_EFFORTS: ReadonlySet<Effort> = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const VALID_THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set([
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function toThinkingLevel(raw: string | null | undefined): ThinkingLevel | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim() as ThinkingLevel;
  return VALID_THINKING_LEVELS.has(trimmed) ? trimmed : null;
}

/**
 * Pi 报告的档位（`get_available_thinking_levels`，原样用）；Pi 没报（老版本、查询失败）时按模型自己的
 * `thinkingLevelMap` 推出来，和 Pi 的 `getSupportedThinkingLevels` 一致（见 shared/pi-model-capability.ts）。
 */
export function toThinkingLevelsList(
  rawLevels: readonly string[],
  model?: PiThinkingCapability | null,
): ThinkingLevel[] {
  const out: ThinkingLevel[] = [];
  for (const item of rawLevels) {
    const level = toThinkingLevel(item);
    if (level !== null && level !== "inherit" && !out.includes(level)) out.push(level);
  }
  return out.length > 0 ? out : piModelThinkingLevels(model);
}

export function toModelOption(model: PiModelInfo, effortsOverride?: Effort[] | null): ModelOption {
  const reasoning = model.reasoning === true;
  // 档位来自模型自己的显式能力（thinkingLevelMap），不按“reasoning 就给 minimal…high”硬编码。
  const defaultEfforts: Effort[] | null =
    effortsOverride !== undefined ? effortsOverride : reasoning ? piModelThinkingEfforts(model) : null;

  return {
    key: {
      provider: model.provider,
      modelId: model.id,
    },
    name: model.name !== "" ? model.name : model.id,
    contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : null,
    reasoning,
    acceptsImages: Array.isArray(model.input) ? model.input.includes("image") : false,
    maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : null,
    thinkingEfforts: defaultEfforts,
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
    intelligence: null,
    catalogTps: null,
  };
}

export function toAvailableSlashCommand(cmd: PiCommandInfo): AvailableSlashCommand {
  let source: SlashCommandSource;
  switch (cmd.source) {
    case "skill":
      source = "skill";
      break;
    case "extension":
      source = "extension";
      break;
    case "prompt":
      source = "file";
      break;
    default:
      source = "custom";
      break;
  }

  return {
    name: cmd.name,
    source,
    ...(cmd.description !== undefined && cmd.description !== "" ? { description: cmd.description } : {}),
  };
}

export function extractEfforts(levels: readonly string[]): Effort[] | null {
  const efforts = levels.filter((lvl): lvl is Effort => VALID_EFFORTS.has(lvl as Effort));
  return efforts.length > 0 ? efforts : null;
}

export class PiService {
  private readonly getLaunch: () => Promise<PiLaunch>;
  private readonly idleMs: number;
  private readonly defaultCwd: string;

  private client: PiRpcClient | null = null;
  private startingPromise: Promise<PiRpcClient> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private cachedModels: ModelOption[] | null = null;
  private cachedDefaultModel: DefaultModelInfo | null | undefined = undefined;
  private readonly slashCache = new Map<string, { expiresAt: number; commands: AvailableSlashCommand[] }>();
  /** 现在这个服务进程启动时的模型表输入指纹（models.json / auth.json / .env / 版本 / key 环境变量）；null = 还没记。 */
  private inputsStamp: string | null = null;
  /** 关过几次：启动中的进程醒来时发现代数变了，说明这份输入已经过期，按新的重来（不留旧快照的进程）。 */
  private generation = 0;
  /** 正在跑 RPC 的查询数：close 前等它们收尾，别把正在读的请求打断（客户端关了在途请求一律 reject）。 */
  private inFlight = 0;
  private readonly quietWaiters: (() => void)[] = [];
  /** 模型目录 / 默认模型查询排队跑：重起服务进程的 close 不能落在别的查询的 get_available_models 中间。 */
  private catalogChain: Promise<unknown> = Promise.resolve();

  constructor(
    getLaunch: () => Promise<PiLaunch>,
    options?: {
      idleMs?: number | undefined;
      cwd?: string | undefined;
    },
  ) {
    this.getLaunch = getLaunch;
    this.idleMs = options?.idleMs ?? DEFAULT_IDLE_MS;
    this.defaultCwd = options?.cwd ?? os.tmpdir();
  }

  /**
   * 模型目录。`inputsStamp`（default-model.ts 的 catalogStamp）变了就重启服务进程：Pi 的模型表是进程启动时读的
   * （`ModelRuntime.create` → `ModelConfig.load`），不重起的话 `get_available_models` 永远回旧快照——
   * 在终端里改了 `models.json` / 登录了新 provider 时新加的模型就在这里丢。
   */
  async listModelOptions(refresh = false, inputsStamp?: string): Promise<ModelOption[]> {
    return this.#serializeCatalog(async () => {
      if (inputsStamp !== undefined) await this.syncInputs(inputsStamp);
      if (!refresh && this.cachedModels !== null) {
        return this.cachedModels;
      }
      const rpc = await this.ensureClient();
      const models = await this.#runQuery(rpc, () => rpc.getAvailableModels());
      const mapped = models.models.map((m) => toModelOption(m));
      this.cachedModels = mapped;
      return mapped;
    });
  }

  async readDefaultModel(refresh = false, inputsStamp?: string): Promise<DefaultModelInfo | null> {
    return this.#serializeCatalog(async () => {
      if (inputsStamp !== undefined) await this.syncInputs(inputsStamp);
      if (!refresh && this.cachedDefaultModel !== undefined) {
        return this.cachedDefaultModel;
      }
      const rpc = await this.ensureClient();
      const state = await this.#runQuery(rpc, () => rpc.getState());
      if (state.model === undefined) {
        this.cachedDefaultModel = null;
        return null;
      }
      const info: DefaultModelInfo = {
        key: {
          provider: state.model.provider,
          modelId: state.model.id,
        },
        name: state.model.name !== "" ? state.model.name : state.model.id,
        thinkingLevel: toThinkingLevel(state.thinkingLevel),
      };
      this.cachedDefaultModel = info;
      return info;
    });
  }

  async listSlashCommands(cwd?: string): Promise<AvailableSlashCommand[]> {
    const targetCwd = cwd ?? this.defaultCwd;
    const now = Date.now();
    const hit = this.slashCache.get(targetCwd);
    if (hit !== undefined && hit.expiresAt > now) {
      return hit.commands;
    }

    if (targetCwd === this.defaultCwd) {
      const rpc = await this.ensureClient();
      const { commands } = await this.#runQuery(rpc, () => rpc.getCommands());
      const mapped = commands.map(toAvailableSlashCommand);
      this.slashCache.set(targetCwd, { expiresAt: now + COMMAND_CACHE_TTL_MS, commands: mapped });
      return mapped;
    }

    const launch = await this.getLaunch();
    const projectClient = new PiRpcClient({
      launch,
      cwd: targetCwd,
      noSession: true,
    });
    try {
      const { commands } = await projectClient.getCommands();
      const mapped = commands.map(toAvailableSlashCommand);
      this.slashCache.set(targetCwd, { expiresAt: Date.now() + COMMAND_CACHE_TTL_MS, commands: mapped });
      return mapped;
    } finally {
      await projectClient.close(1_500);
    }
  }

  async invalidate(): Promise<void> {
    this.cachedModels = null;
    this.cachedDefaultModel = undefined;
    this.slashCache.clear();
    await this.close();
  }

  async close(): Promise<void> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.generation++;
    const existing = this.client;
    this.client = null;
    this.startingPromise = null;
    if (existing === null) return;
    // 正在读的请求（斜杠命令等）先让它收尾，再关：中途关掉客户端，在途请求会一律 reject。
    await this.#waitQuiet(2_000);
    await existing.close(1_500);
  }

  /** 模型表的输入变了：关掉服务进程，下一次查询会重新起一个（重新读 models.json / 凭据）。 */
  private async syncInputs(inputsStamp: string): Promise<void> {
    const previous = this.inputsStamp;
    if (previous === inputsStamp) return;
    this.inputsStamp = inputsStamp;
    // 第一次记（还没有按目录起过进程）：不关，正在用（或刚起）的那个进程本来就是按这份输入起的。
    if (previous === null) return;
    // 输入变了：旧进程读到的目录和默认模型都不算数了，不能按旧指纹留在缓存里。
    this.cachedModels = null;
    this.cachedDefaultModel = undefined;
    await this.close();
  }

  /** 目录类查询排队跑（一个跑完再起下一个）：重起进程的 close 不会落在别人在途的请求上。 */
  #serializeCatalog<T>(task: () => Promise<T>): Promise<T> {
    const run = this.catalogChain.then(task, task);
    this.catalogChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 跑一次 RPC 查询：登记在途数（close 会等它），跑完再重置空闲计时器。 */
  async #runQuery<T>(client: PiRpcClient, run: () => Promise<T>): Promise<T> {
    this.inFlight++;
    // 查询在跑的时候不让空闲计时器把客户端关掉（跑完的 finally 里重新计时）。
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      return await run();
    } finally {
      this.inFlight--;
      this.bumpIdleTimer();
      if (this.inFlight === 0 && this.quietWaiters.length > 0) {
        for (const resolve of this.quietWaiters.splice(0)) resolve();
      }
    }
  }

  /** 等在途查询收尾；最多等 `timeoutMs`（请求卡住时也不能把 close 拖死）。 */
  #waitQuiet(timeoutMs: number): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (): void => {
        if (timer !== null) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.quietWaiters.push(done);
    });
  }

  private ensureClient(): Promise<PiRpcClient> {
    if (this.client !== null && this.client.alive) {
      return Promise.resolve(this.client);
    }
    this.startingPromise ??= this.spawnClient().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  private async spawnClient(): Promise<PiRpcClient> {
    for (let attempt = 0; ; attempt++) {
      const generation = this.generation;
      const launch = await this.getLaunch();
      // getLaunch 期间被 close 过（刚改了 models.json / 登录了新 provider）：这份输入已经过期，按新的重来。
      if (generation !== this.generation) {
        if (attempt < 4) continue;
        throw new Error("pi service process was invalidated while starting");
      }
      const client = new PiRpcClient({
        launch,
        cwd: this.defaultCwd,
        noSession: true,
      });
      // 同一代里别人抢先把进程登记上了（两个启动分支撞在一起）：这个多余的关掉，用活着那个。
      if (this.client !== null && this.client.alive) {
        await client.close(500);
        return this.client;
      }
      client.onExit(() => {
        if (this.client === client) {
          this.client = null;
        }
      });
      this.client = client;
      this.bumpIdleTimer();
      return client;
    }
  }

  private bumpIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.close();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }
}
