// Cached background `pi --mode rpc --no-session` service process for global catalog queries:
// `listModelOptions(refresh)`, `readDefaultModel(refresh)`, and `listSlashCommands(cwd)`.
import os from "node:os";
import type { DefaultModelInfo, ModelOption } from "../../shared/ipc.ts";
import type {
  AvailableSlashCommand,
  Effort,
  SlashCommandSource,
  ThinkingLevel,
} from "../../shared/omp-wire/rpc-wire.generated.ts";
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

export function toThinkingLevelsList(rawLevels: readonly string[], reasoning = false): ThinkingLevel[] {
  const seen = new Set<ThinkingLevel>(["off"]);
  const out: ThinkingLevel[] = ["off"];
  for (const item of rawLevels) {
    const level = toThinkingLevel(item);
    if (level !== null && level !== "inherit" && !seen.has(level)) {
      seen.add(level);
      out.push(level);
    }
  }
  if (out.length === 1 && reasoning) {
    for (const fallback of ["minimal", "low", "medium", "high"] as const) {
      out.push(fallback);
    }
  }
  return out;
}

export function toModelOption(model: PiModelInfo, effortsOverride?: Effort[] | null): ModelOption {
  const reasoning = model.reasoning === true;
  const defaultEfforts: Effort[] | null =
    effortsOverride !== undefined ? effortsOverride : reasoning ? ["minimal", "low", "medium", "high"] : null;

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

  async listModelOptions(refresh = false): Promise<ModelOption[]> {
    if (!refresh && this.cachedModels !== null) {
      return this.cachedModels;
    }
    const rpc = await this.ensureClient();
    this.bumpIdleTimer();
    const { models } = await rpc.getAvailableModels();
    const mapped = models.map((m) => toModelOption(m));
    this.cachedModels = mapped;
    return mapped;
  }

  async readDefaultModel(refresh = false): Promise<DefaultModelInfo | null> {
    if (!refresh && this.cachedDefaultModel !== undefined) {
      return this.cachedDefaultModel;
    }
    const rpc = await this.ensureClient();
    this.bumpIdleTimer();
    const state = await rpc.getState();
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
      this.bumpIdleTimer();
      const { commands } = await rpc.getCommands();
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
    const existing = this.client;
    this.client = null;
    this.startingPromise = null;
    if (existing !== null) {
      await existing.close(1_500);
    }
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
    const launch = await this.getLaunch();
    const client = new PiRpcClient({
      launch,
      cwd: this.defaultCwd,
      noSession: true,
    });
    client.onExit(() => {
      if (this.client === client) {
        this.client = null;
      }
    });
    this.client = client;
    this.bumpIdleTimer();
    return client;
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
