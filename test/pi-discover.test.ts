import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { OmpStatus } from "../src/shared/ipc.ts";
import {
  discoverPi,
  getTestPiOverride,
  inspectPi,
  parsePiCmdShim,
  PiManager,
  setTestPiOverride,
} from "../src/main/pi/discover.ts";

const FAKE_PI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fake-pi", "fake-pi.mjs");

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-discover-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  setTestPiOverride(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("parsePiCmdShim", () => {
  it("resolves %dp0% npm shim for @earendil-works/pi-coding-agent", () => {
    const cmdPath = "C:\\Temp\\npm\\pi.cmd";
    const shim = [
      "@ECHO off",
      "SETLOCAL",
      'SET "dp0=%~dp0"',
      '"%dp0%\\node.exe"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
    ].join("\r\n");

    expect(parsePiCmdShim(cmdPath, shim)).toBe(
      "C:\\Temp\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js",
    );
  });

  it("resolves %~dp0 npm shim for @mariozechner/pi-coding-agent", () => {
    const cmdPath = "D:\\Tools\\nodejs\\pi.cmd";
    const shim = '@node "%~dp0\\node_modules\\@mariozechner\\pi-coding-agent\\dist\\cli.js" %*\r\n';
    expect(parsePiCmdShim(cmdPath, shim)).toBe(
      "D:\\Tools\\nodejs\\node_modules\\@mariozechner\\pi-coding-agent\\dist\\cli.js",
    );
  });
});

describe("discoverPi", () => {
  it("supports setTestPiOverride and STUDIO_TEST_PI for .mjs scripts with ELECTRON_RUN_AS_NODE", async () => {
    setTestPiOverride(FAKE_PI_PATH);
    expect(getTestPiOverride()).toBe(FAKE_PI_PATH);

    const launch = await discoverPi({}, "win32");
    expect(launch).toEqual({
      command: process.execPath,
      prefixArgs: [FAKE_PI_PATH],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      displayPath: FAKE_PI_PATH,
    });

    setTestPiOverride(null);
    const fromEnv = await discoverPi({ STUDIO_TEST_PI: FAKE_PI_PATH }, "linux");
    expect(fromEnv).toEqual({
      command: process.execPath,
      prefixArgs: [FAKE_PI_PATH],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      displayPath: FAKE_PI_PATH,
    });
  });

  it("discovers Windows pi.cmd shim and extracts cli.js without shell", async () => {
    const root = await makeTempDir();
    const npmDir = path.win32.join(root, "Roaming", "npm");
    const cliJs = path.win32.join(
      npmDir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );
    await mkdir(path.win32.dirname(cliJs), { recursive: true });
    await writeFile(cliJs, "// fake cli.js\n", "utf8");
    await writeFile(
      path.win32.join(npmDir, "pi.cmd"),
      `"%dp0%\\node.exe" "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n`,
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      PATH: "",
      APPDATA: path.win32.join(root, "Roaming"),
      LOCALAPPDATA: path.win32.join(root, "Local"),
      USERPROFILE: root,
      HOME: root,
    };

    const launch = await discoverPi(env, "win32");
    expect(launch).toEqual({
      command: process.execPath,
      prefixArgs: [cliJs],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      displayPath: cliJs,
    });
  });

  it("discovers native executable on Windows and POSIX", async () => {
    const root = await makeTempDir();
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });

    const winExe = path.win32.join(binDir, "pi.exe");
    await writeFile(winExe, "MZ", "utf8");
    const winLaunch = await discoverPi(
      {
        PATH: binDir,
        APPDATA: path.join(root, "none1"),
        LOCALAPPDATA: path.join(root, "none2"),
        USERPROFILE: path.join(root, "none3"),
        HOME: path.join(root, "none3"),
      },
      "win32",
    );
    expect(winLaunch).toEqual({
      command: winExe,
      prefixArgs: [],
      env: {},
      displayPath: winExe,
    });

    if (process.platform !== "win32") {
      const posixBin = path.posix.join(binDir, "pi");
      await writeFile(posixBin, "#!/bin/sh\necho 1.5.2\n", "utf8");
      await chmod(posixBin, 0o755);
      const posixLaunch = await discoverPi({ PATH: binDir, HOME: root }, "linux");
      expect(posixLaunch?.command).toBe(posixBin);
    }
  });
});

describe("inspectPi & PiManager", () => {
  it("inspects fake-pi version and manages ready + upgradePi lifecycle", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      STUDIO_TEST_PI: FAKE_PI_PATH,
    };

    const inspected = await inspectPi(env);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.version).toBe("1.5.2");
      expect(inspected.launch.displayPath).toBe(FAKE_PI_PATH);
    }

    const statuses: OmpStatus[] = [];
    const manager = new PiManager((st) => statuses.push(st), { env });
    await manager.start();

    expect(manager.status).toEqual({
      state: "ready",
      source: { kind: "user_installed" },
      version: "1.5.2",
      path: FAKE_PI_PATH,
      belowMinimum: false,
      stagedUpdate: null,
    });

    const install = await manager.ensureReady();
    expect(install.version).toBe("1.5.2");

    const upgrade = await manager.upgradePi();
    expect(upgrade.exitCode).toBe(0);
    expect(upgrade.output).toContain("Updated @earendil-works/pi-coding-agent to 1.5.2");
    expect(statuses.some((s) => s.state === "ready")).toBe(true);
  });

  it("reports missing state when pi is absent from isolated environment", async () => {
    const root = await makeTempDir();
    const isolatedEnv: NodeJS.ProcessEnv = {
      PATH: path.join(root, "empty-bin"),
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "localappdata"),
      USERPROFILE: root,
      HOME: root,
    };

    const inspected = await inspectPi(isolatedEnv, "win32");
    expect(inspected.ok).toBe(false);

    const manager = new PiManager(() => {}, { env: isolatedEnv, platform: "win32" });
    await manager.start();
    expect(manager.status.state).toBe("missing");
    expect(manager.missingMessage).toContain("pi CLI not found");
  });
});
