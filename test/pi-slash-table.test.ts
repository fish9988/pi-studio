// Pi Studio 斜杠命令表测试：校验 Pi 1.5.2 命令查找、参数解析与派发，并确保彻底移除所有 OMP 专属命令。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createT } from "../src/shared/i18n/index.ts";
import type { TaskId } from "../src/shared/ipc.ts";
import {
  buildPiSlashCommands,
  resolvePiThinkingCommand,
  type PiSlashDeps,
} from "../src/renderer/src/features/composer/pi-slash-spec.ts";
import {
  findStudioSlash,
  handledCommands,
  withStudioSlash,
} from "../src/renderer/src/features/composer/studio-slash.ts";

const t = createT("zh-CN");
const TASK_ID = "task_pi_1" as TaskId;

function createMockDeps() {
  const deps: PiSlashDeps = {
    openSettings: vi.fn(),
    openSection: vi.fn(),
    openModelPicker: vi.fn(),
    openUsageDialog: vi.fn(),
    openSessionPicker: vi.fn(),
    startDraftForTask: vi.fn(),
    openRenameInline: vi.fn(),
    renameTask: vi.fn(() => Promise.resolve()),
    listTaskModels: vi.fn(() => Promise.resolve([])),
    setTaskModel: vi.fn(() => Promise.resolve()),
    setTaskThinkingLevel: vi.fn(() => Promise.resolve()),
    openSessionInfo: vi.fn(),
    openSessionTree: vi.fn(),
    forkTask: vi.fn(() => Promise.resolve()),
    cloneTask: vi.fn(() =>
      Promise.resolve({
        task: { id: "task_cloned" as TaskId } as never,
        sessionFile: "/tmp/cloned.jsonl",
      }),
    ),
    selectTask: vi.fn(() => Promise.resolve()),
    compactTask: vi.fn(() => Promise.resolve()),
    copyLastAnswer: vi.fn(() => Promise.resolve()),
    exportConversation: vi.fn(() => Promise.resolve()),
    reloadResources: vi.fn(() => Promise.resolve()),
    btwCommand: {
      name: "btw",
      descKey: "btw.slashDesc",
      run: vi.fn(),
    },
    openGitChanges: vi.fn(),
    archiveWithUndo: vi.fn(() => Promise.resolve()),
  };
  return deps;
}

describe("PI_STUDIO_SLASH_COMMANDS", () => {
  let deps = createMockDeps();
  let commands = buildPiSlashCommands(deps);

  beforeEach(() => {
    deps = createMockDeps();
    commands = buildPiSlashCommands(deps);
  });

  it("registers all 24 Pi 1.5.2 Studio slash commands and aliases", () => {
    const names = commands.map((cmd) => cmd.name);
    expect(names).toEqual([
      "settings",
      "model",
      "thinking",
      "scoped-models",
      "mcp",
      "login",
      "logout",
      "new",
      "resume",
      "name",
      "session",
      "usage",
      "tree",
      "fork",
      "clone",
      "compact",
      "copy",
      "export",
      "reload",
      "btw",
      "git",
      "hotkeys",
      "changelog",
      "delete",
    ]);

    expect(findStudioSlash("/effort high", commands)?.command.name).toBe("thinking");
    expect(findStudioSlash("/rename Demo", commands)?.command.name).toBe("name");

    const menu = withStudioSlash([], commands, t, "task");
    expect(menu).toHaveLength(24);
    expect(menu.every((entry) => (entry.description ?? "").length > 0)).toBe(true);

    const draftNames = handledCommands(commands, "draft").map((cmd) => cmd.name);
    expect(draftNames).toEqual(
      expect.arrayContaining(["settings", "model", "thinking", "scoped-models", "mcp", "login", "logout", "resume"]),
    );
  });

  it("excludes all OMP-only slash commands", () => {
    const ompOnlyCommands = [
      "/goal",
      "/plan",
      "/vibe",
      "/loop",
      "/fast",
      "/slow",
      "/skillful",
      "/advisor",
      "/prewalk",
      "/hub",
      "/ssh",
      "/memory",
      "/forget-approvals",
      "/plugins",
      "/marketplace",
      "/reload-plugins",
      "/todo",
      "/jobs",
      "/trace",
    ];

    for (const cmd of ompOnlyCommands) {
      expect(findStudioSlash(cmd, commands), `${cmd} should not be in Pi table`).toBeNull();
    }
  });

  it("parses and dispatches /thinking (and /effort) across all 7 Pi thinking levels", async () => {
    expect(resolvePiThinkingCommand("")).toEqual({ kind: "picker" });
    expect(resolvePiThinkingCommand("xhigh")).toEqual({ kind: "set", level: "xhigh" });
    expect(resolvePiThinkingCommand("MAX")).toEqual({ kind: "set", level: "max" });
    expect(resolvePiThinkingCommand("off")).toEqual({ kind: "set", level: "off" });
    expect(resolvePiThinkingCommand("turbo")).toEqual({ kind: "omp" });

    const xhighHit = findStudioSlash("/thinking xhigh", commands);
    expect(xhighHit).not.toBeNull();
    await xhighHit!.command.run(TASK_ID, xhighHit!.args, t);
    expect(deps.setTaskThinkingLevel).toHaveBeenCalledWith(TASK_ID, "xhigh");

    const maxHit = findStudioSlash("/thinking max", commands);
    expect(maxHit).not.toBeNull();
    await maxHit!.command.run(TASK_ID, maxHit!.args, t);
    expect(deps.setTaskThinkingLevel).toHaveBeenCalledWith(TASK_ID, "max");

    const effortHit = findStudioSlash("/effort minimal", commands);
    expect(effortHit).not.toBeNull();
    await effortHit!.command.run(TASK_ID, effortHit!.args, t);
    expect(deps.setTaskThinkingLevel).toHaveBeenCalledWith(TASK_ID, "minimal");

    const unknownHit = findStudioSlash("/thinking bogus", commands);
    expect(await unknownHit!.command.run(TASK_ID, unknownHit!.args, t)).toBe("omp");
  });

  it("parses and dispatches /name <title> and /rename <title>", async () => {
    const hit = findStudioSlash("/name My Session", commands);
    expect(hit).not.toBeNull();
    expect(hit!.args).toBe("My Session");
    await hit!.command.run(TASK_ID, hit!.args, t);
    expect(deps.renameTask).toHaveBeenCalledWith(TASK_ID, "My Session");

    const aliasHit = findStudioSlash("/rename Refactored UI", commands);
    expect(aliasHit).not.toBeNull();
    await aliasHit!.command.run(TASK_ID, aliasHit!.args, t);
    expect(deps.renameTask).toHaveBeenCalledWith(TASK_ID, "Refactored UI");
  });

  it("parses and dispatches /compact with and without custom instructions", async () => {
    const withInstructions = findStudioSlash("/compact focus on API changes", commands);
    expect(withInstructions).not.toBeNull();
    expect(withInstructions!.args).toBe("focus on API changes");
    await withInstructions!.command.run(TASK_ID, withInstructions!.args, t);
    expect(deps.compactTask).toHaveBeenCalledWith(TASK_ID, "focus on API changes");

    vi.mocked(deps.compactTask).mockClear();
    const noArgs = findStudioSlash("/compact", commands);
    expect(noArgs).not.toBeNull();
    expect(noArgs!.args).toBe("");
    await noArgs!.command.run(TASK_ID, noArgs!.args, t);
    expect(deps.compactTask).toHaveBeenCalledWith(TASK_ID);
  });

  it("dispatches /clone, /reload, /scoped-models, /mcp, and /git cleanly", async () => {
    const cloneHit = findStudioSlash("/clone", commands);
    await cloneHit!.command.run(TASK_ID, cloneHit!.args, t);
    expect(deps.cloneTask).toHaveBeenCalledWith(TASK_ID);
    expect(deps.selectTask).toHaveBeenCalledWith("task_cloned");

    const reloadHit = findStudioSlash("/reload", commands);
    await reloadHit!.command.run(TASK_ID, reloadHit!.args, t);
    expect(deps.reloadResources).toHaveBeenCalledWith(TASK_ID, t);

    const scopedHit = findStudioSlash("/scoped-models", commands);
    await scopedHit!.command.run(TASK_ID, scopedHit!.args, t);
    expect(deps.openSection).toHaveBeenCalledWith("models");

    const mcpHit = findStudioSlash("/mcp", commands);
    await mcpHit!.command.run(TASK_ID, mcpHit!.args, t);
    expect(deps.openSection).toHaveBeenCalledWith("extensions");

    const gitHit = findStudioSlash("/git", commands);
    await gitHit!.command.run(TASK_ID, gitHit!.args, t);
    expect(deps.openGitChanges).toHaveBeenCalledWith(TASK_ID);
  });
});
