// Cross-platform discovery, version inspection, and lifecycle manager for the `pi` CLI.
// Never spawns through a command interpreter (`shell` option is always omitted/false).
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { OmpStatus, OmpUpgradeResult } from "../../shared/ipc.ts";

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 15_000;
const UPGRADE_TIMEOUT_MS = 180_000;
const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const JS_SCRIPT_EXT_PATTERN = /\.(?:m?js|cjs|ts)$/i;

const KNOWN_CLI_REL_PATHS = [
  ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"],
  ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"],
  ["node_modules", "@mariozechner", "pi-coding-agent", "dist", "bundle", "cli.js"],
  ["node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"],
] as const;

export interface PiLaunch {
  command: string;
  prefixArgs: string[];
  env: Record<string, string>;
  displayPath: string;
}

export interface PiInstall {
  launch: PiLaunch;
  path: string;
  version: string;
}

export type InspectPiResult = { ok: true; version: string; launch: PiLaunch } | { ok: false; message: string };

let testPiOverride: string | null = null;

/** Test hook to override `pi` discovery without mutating global PATH. */
export function setTestPiOverride(override: string | null): void {
  testPiOverride = override;
}

export function getTestPiOverride(): string | null {
  return testPiOverride;
}

function makeNodeScriptLaunch(scriptPath: string, displayPath = scriptPath): PiLaunch {
  return {
    command: process.execPath,
    prefixArgs: [scriptPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    displayPath,
  };
}

function makeNativeLaunch(binPath: string): PiLaunch {
  return {
    command: binPath,
    prefixArgs: [],
    env: {},
    displayPath: binPath,
  };
}

function launchFromOverride(rawOverride: string): PiLaunch {
  const trimmed = rawOverride.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { command?: unknown; args?: unknown };
      if (typeof parsed.command === "string" && parsed.command.trim() !== "") {
        const rawArgs = Array.isArray(parsed.args)
          ? parsed.args.filter((arg): arg is string => typeof arg === "string")
          : [];
        const firstArg = rawArgs[0];
        if (firstArg !== undefined && firstArg.includes("fake-tsp-omp")) {
          const fakePi = path.resolve(path.dirname(firstArg), "..", "fake-pi", "fake-pi.mjs");
          return makeNodeScriptLaunch(fakePi, fakePi);
        }
        const env: Record<string, string> =
          firstArg !== undefined && JS_SCRIPT_EXT_PATTERN.test(firstArg) ? { ELECTRON_RUN_AS_NODE: "1" } : {};
        return {
          command: parsed.command,
          prefixArgs: rawArgs,
          env,
          displayPath: firstArg ?? parsed.command,
        };
      }
    } catch {
      // Fall through to plain path handling.
    }
  }
  if (JS_SCRIPT_EXT_PATTERN.test(trimmed)) {
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
    return makeNodeScriptLaunch(resolved, resolved);
  }
  return makeNativeLaunch(trimmed);
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    if (platform === "win32") return true;
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a Windows npm `.cmd` shim (e.g. `pi.cmd`) to extract the underlying `.js` entrypoint,
 * resolving `%dp0%` and `%~dp0` tokens against `path.dirname(cmdPath)`.
 */
export function parsePiCmdShim(cmdPath: string, content: string): string | null {
  const baseDir = path.win32.dirname(cmdPath);
  const tokenPattern = /"([^"\r\n]+?\.(?:m?js|cjs))"|([^\s"\r\n]+?\.(?:m?js|cjs))/gi;
  const candidates: string[] = [];
  for (const match of content.matchAll(tokenPattern)) {
    const raw = match[1] ?? match[2];
    if (raw === undefined || raw === "") continue;
    candidates.push(raw);
  }
  // Prefer candidates referencing pi-coding-agent or cli.js over helper scripts if multiple match.
  candidates.sort((a, b) => {
    const score = (s: string): number => {
      const lower = s.toLowerCase();
      if (lower.includes("pi-coding-agent")) return 0;
      if (lower.endsWith("cli.js") || lower.endsWith("cli.mjs")) return 1;
      return 2;
    };
    return score(a) - score(b);
  });

  const first = candidates[0];
  if (first === undefined) return null;

  const expanded = first.replace(/%~dp0[\\/]?/gi, `${baseDir}\\`).replace(/%dp0%[\\/]?/gi, `${baseDir}\\`);

  if (path.win32.isAbsolute(expanded)) {
    return path.win32.normalize(expanded);
  }
  return path.win32.resolve(baseDir, expanded);
}

function collectSearchDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const pathVar = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const dirs: string[] = [];

  const pushDir = (raw: string | undefined): void => {
    if (raw === undefined) return;
    const cleaned = raw
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    if (cleaned === "") return;
    const key = platform === "win32" ? cleaned.toLowerCase() : cleaned;
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push(cleaned);
  };

  for (const entry of pathVar.split(delimiter)) {
    pushDir(entry);
  }

  const home = env["HOME"] ?? env["USERPROFILE"] ?? os.homedir();
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? (home ? path.win32.join(home, "AppData", "Roaming") : undefined);
    const localAppData = env["LOCALAPPDATA"] ?? (home ? path.win32.join(home, "AppData", "Local") : undefined);
    if (appData !== undefined) pushDir(path.win32.join(appData, "npm"));
    if (localAppData !== undefined) {
      pushDir(path.win32.join(localAppData, "npm"));
      pushDir(path.win32.join(localAppData, "pnpm"));
      pushDir(path.win32.join(localAppData, "Volta", "bin"));
      pushDir(path.win32.join(localAppData, "Programs", "nodejs"));
    }
    if (home) {
      pushDir(path.win32.join(home, ".local", "bin"));
      pushDir(path.win32.join(home, ".bun", "bin"));
      pushDir(path.win32.join(home, "scoop", "shims"));
    }
  } else {
    if (env["NVM_BIN"] !== undefined) pushDir(env["NVM_BIN"]);
    if (home) {
      pushDir(path.posix.join(home, ".local", "bin"));
      pushDir(path.posix.join(home, ".npm-global", "bin"));
      pushDir(path.posix.join(home, ".volta", "bin"));
      pushDir(path.posix.join(home, ".bun", "bin"));
    }
    pushDir("/opt/homebrew/bin");
    pushDir("/usr/local/bin");
  }

  return dirs;
}

async function findKnownCliJs(baseDir: string, platform: NodeJS.Platform): Promise<string | null> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const roots = [baseDir];
  if (platform !== "win32") {
    roots.push(pathApi.resolve(baseDir, "..", "lib"));
  }
  for (const root of roots) {
    for (const rel of KNOWN_CLI_REL_PATHS) {
      const candidate = pathApi.join(root, ...rel);
      if (await isRegularFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Discover the `pi` CLI across Windows, macOS, and Linux without invoking a shell.
 */
export async function discoverPi(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<PiLaunch | null> {
  const override = testPiOverride ?? env["STUDIO_TEST_PI"] ?? env["STUDIO_TEST_OMP"];
  if (override !== undefined && override.trim() !== "") {
    return launchFromOverride(override);
  }

  const dirs = collectSearchDirs(env, platform);
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  for (const dir of dirs) {
    if (platform === "win32") {
      const exePath = pathApi.join(dir, "pi.exe");
      if (await isExecutableFile(exePath, platform)) {
        return makeNativeLaunch(exePath);
      }

      const cmdPath = pathApi.join(dir, "pi.cmd");
      if (await isRegularFile(cmdPath)) {
        try {
          const content = await readFile(cmdPath, "utf8");
          const parsedJs = parsePiCmdShim(cmdPath, content);
          if (parsedJs !== null && (await isRegularFile(parsedJs))) {
            return makeNodeScriptLaunch(parsedJs, parsedJs);
          }
        } catch {
          // Fall through to well-known node_modules locations in the same directory.
        }
      }

      const knownJs = await findKnownCliJs(dir, platform);
      if (knownJs !== null) {
        return makeNodeScriptLaunch(knownJs, knownJs);
      }
    } else {
      const binPath = pathApi.join(dir, "pi");
      if (await isExecutableFile(binPath, platform)) {
        return makeNativeLaunch(binPath);
      }

      const knownJs = await findKnownCliJs(dir, platform);
      if (knownJs !== null) {
        return makeNodeScriptLaunch(knownJs, knownJs);
      }
    }
  }

  return null;
}

function buildChildEnv(baseEnv: NodeJS.ProcessEnv, extraEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...baseEnv, ...extraEnv };
}

/**
 * Discover `pi` and run `--version` directly via `execFile` (no shell, 15s timeout).
 */
export async function inspectPi(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<InspectPiResult> {
  const launch = await discoverPi(env, platform);
  if (launch === null) {
    return {
      ok: false,
      message: "pi CLI not found in PATH. Install @earendil-works/pi-coding-agent globally via npm.",
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(launch.command, [...launch.prefixArgs, "--version"], {
      env: buildChildEnv(env, launch.env),
      windowsHide: true,
      timeout: VERSION_TIMEOUT_MS,
    });
    const combined = `${stdout}\n${stderr}`.trim();
    const match = VERSION_PATTERN.exec(combined);
    if (match?.[1] === undefined) {
      return {
        ok: false,
        message: `Could not parse pi version from output: ${combined.slice(0, 200)}`,
      };
    }
    return {
      ok: true,
      version: match[1],
      launch,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Failed to execute pi (${launch.displayPath}): ${formatError(error)}`,
    };
  }
}

async function discoverNpmCliLaunch(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<{ command: string; prefixArgs: string[]; env: Record<string, string> } | null> {
  const dirs = collectSearchDirs(env, platform);
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  for (const dir of dirs) {
    if (platform === "win32") {
      const npmCliCandidates = [
        pathApi.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
        pathApi.resolve(dir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
      ];
      for (const cliJs of npmCliCandidates) {
        if (await isRegularFile(cliJs)) {
          return {
            command: process.execPath,
            prefixArgs: [cliJs],
            env: { ELECTRON_RUN_AS_NODE: "1" },
          };
        }
      }
      const npmCmd = pathApi.join(dir, "npm.cmd");
      if (await isRegularFile(npmCmd)) {
        try {
          const content = await readFile(npmCmd, "utf8");
          const parsed = parsePiCmdShim(npmCmd, content);
          if (parsed !== null && (await isRegularFile(parsed))) {
            return {
              command: process.execPath,
              prefixArgs: [parsed],
              env: { ELECTRON_RUN_AS_NODE: "1" },
            };
          }
        } catch {
          // Continue searching.
        }
      }
    } else {
      const npmBin = pathApi.join(dir, "npm");
      if (await isExecutableFile(npmBin, platform)) {
        return { command: npmBin, prefixArgs: [], env: {} };
      }
    }
  }
  return null;
}

/**
 * Lightweight status & upgrade manager for `pi`, structurally compatible with `OmpManager` / `OmpStatus`.
 */
export class PiManager {
  private current: OmpStatus = { state: "discovering" };
  private currentLaunch: PiLaunch | null = null;
  private lastMissingMessage: string | null = null;
  private inflight: Promise<void> | null = null;
  private readonly onStatus: (status: OmpStatus) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;

  constructor(
    onStatus: (status: OmpStatus) => void = () => {},
    options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
  ) {
    this.onStatus = onStatus;
    this.env = options?.env ?? process.env;
    this.platform = options?.platform ?? process.platform;
  }

  get status(): OmpStatus {
    return this.current;
  }

  get launch(): PiLaunch | null {
    return this.currentLaunch;
  }

  get missingMessage(): string | null {
    return this.lastMissingMessage;
  }

  start(): Promise<void> {
    this.inflight ??= this.probe().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  startOnce(): Promise<void> {
    if (this.current.state !== "discovering" || this.inflight !== null) {
      return this.inflight ?? Promise.resolve();
    }
    return this.start();
  }

  async ensureReady(): Promise<PiInstall> {
    if (this.inflight !== null) await this.inflight;
    if (this.current.state === "discovering") await this.start();
    if (this.current.state === "ready" && this.currentLaunch !== null) {
      return {
        launch: this.currentLaunch,
        path: this.current.path,
        version: this.current.version,
      };
    }
    const reason =
      this.current.state === "error"
        ? this.current.message
        : this.current.state === "missing"
          ? (this.lastMissingMessage ?? "pi CLI is not installed")
          : "pi is still starting";
    throw new Error(reason);
  }

  async retry(): Promise<OmpStatus> {
    await this.start();
    return this.current;
  }

  async upgradePi(): Promise<OmpUpgradeResult> {
    if (this.inflight !== null) await this.inflight;

    const hasTestOverride =
      (testPiOverride ?? this.env["STUDIO_TEST_PI"] ?? this.env["STUDIO_TEST_OMP"] ?? "").trim() !== "";
    const existingLaunch = this.currentLaunch ?? (await discoverPi(this.env, this.platform));

    if (existingLaunch !== null) {
      try {
        const { stdout, stderr } = await execFileAsync(
          existingLaunch.command,
          [...existingLaunch.prefixArgs, "update"],
          {
            env: buildChildEnv(this.env, existingLaunch.env),
            windowsHide: true,
            timeout: UPGRADE_TIMEOUT_MS,
          },
        );
        await this.start();
        return { exitCode: 0, output: `${stdout}\n${stderr}`.trim() };
      } catch (error) {
        if (hasTestOverride) {
          return { exitCode: 1, output: `pi update failed: ${formatError(error)}` };
        }
        // Otherwise fall back to `npm install -g` below.
      }
    }

    if (!hasTestOverride) {
      const npmLaunch = await discoverNpmCliLaunch(this.env, this.platform);
      if (npmLaunch !== null) {
        const packageName =
          existingLaunch?.displayPath.includes("@mariozechner") === true
            ? "@mariozechner/pi-coding-agent@latest"
            : "@earendil-works/pi-coding-agent@latest";
        try {
          const { stdout, stderr } = await execFileAsync(
            npmLaunch.command,
            [...npmLaunch.prefixArgs, "install", "-g", packageName],
            {
              env: buildChildEnv(this.env, npmLaunch.env),
              windowsHide: true,
              timeout: UPGRADE_TIMEOUT_MS,
            },
          );
          await this.start();
          return { exitCode: 0, output: `${stdout}\n${stderr}`.trim() };
        } catch (error) {
          return { exitCode: 1, output: `npm global update failed: ${formatError(error)}` };
        }
      }
    }

    return { exitCode: 1, output: "Neither pi CLI nor npm was found to perform an upgrade." };
  }

  /** Alias matching `OmpManager` naming so callers swapping managers compile cleanly. */
  upgradePathOmp(): Promise<OmpUpgradeResult> {
    return this.upgradePi();
  }

  private async probe(): Promise<void> {
    this.emit({ state: "discovering" });
    const result = await inspectPi(this.env, this.platform);
    if (result.ok) {
      this.currentLaunch = result.launch;
      this.lastMissingMessage = null;
      this.emit({
        state: "ready",
        source: { kind: "user_installed" },
        version: result.version,
        path: result.launch.displayPath,
        belowMinimum: false,
        stagedUpdate: null,
      });
    } else {
      const launch = await discoverPi(this.env, this.platform);
      this.currentLaunch = null;
      if (launch === null) {
        this.lastMissingMessage = result.message;
        this.emit({
          state: "missing",
          version: null,
          sizeBytes: null,
          source: "@earendil-works/pi-coding-agent",
        });
      } else {
        this.lastMissingMessage = null;
        this.emit({
          state: "error",
          stage: "discover",
          message: result.message,
        });
      }
    }
  }

  private emit(next: OmpStatus): void {
    this.current = next;
    this.onStatus(next);
  }
}
