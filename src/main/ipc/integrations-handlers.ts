// 设置 → 扩展、包与 Skill 中的 Skills 管理 IPC：读写 `~/.pi/agent/skills`、`.pi/skills`、`~/.agents/skills` 与 `.agents/skills`。
import os from "node:os";
import { dialog, shell } from "electron";
import type { HandlerGroup, ProjectId } from "../../shared/ipc.ts";
import { resolveAgentDir } from "../history/session-index.ts";
import { listPiSkills, PiSkillPicker, removePiSkillFolder, setPiSkillEnabled } from "../pi-config/resources.ts";
import { getTaskPool } from "../tasks/runtime.ts";
import { getMainWindow } from "../window/main-window.ts";
import { IpcValidationError, parseBoolean, parseOneOf, parseProjectId, parseRecord, parseString } from "./validate.ts";

const skillPicker = new PiSkillPicker();

function optionalProjectId(value: unknown): ProjectId | null {
  return value === null ? null : parseProjectId(value);
}

export const integrationsHandlers: HandlerGroup<
  | "listSshHosts"
  | "addSshHost"
  | "removeSshHost"
  | "listSkills"
  | "setSkillEnabled"
  | "removeSkill"
  | "pickSkillFolder"
  | "addSkill"
> = {
  listSshHosts: async (projectId) => {
    optionalProjectId(projectId);
    return [];
  },
  listSkills: async (projectId) => {
    const project = optionalProjectId(projectId);
    const projectDir = project === null ? null : (await getTaskPool()).projectPath(project);
    return listPiSkills(resolveAgentDir(), projectDir, os.homedir());
  },
  setSkillEnabled: (name, enabled) =>
    setPiSkillEnabled(resolveAgentDir(), parseString(name, "name", 200), parseBoolean(enabled, "enabled")),
  removeSkill: async (name, scope, projectId) => {
    const parsedScope = parseOneOf(scope, "scope", ["user", "project"] as const);
    const project = optionalProjectId(projectId);
    if (parsedScope === "project" && project === null) {
      throw new IpcValidationError("项目范围的 skill 需要 projectId");
    }
    const projectDir =
      parsedScope === "project" && project !== null ? (await getTaskPool()).projectPath(project) : null;
    await removePiSkillFolder(
      parseString(name, "name", 200),
      parsedScope,
      {
        agentDir: resolveAgentDir(),
        projectDir,
        homeDir: os.homedir(),
      },
      (folder) => shell.trashItem(folder),
    );
  },
  pickSkillFolder: async () => {
    const window = getMainWindow();
    const options = { properties: ["openDirectory" as const] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const dir = result.filePaths[0];
    if (result.canceled || dir === undefined) return null;
    return skillPicker.pick(dir);
  },
  addSkill: async (token, target, scope, projectId) => {
    const parsedScope = parseOneOf(scope, "scope", ["user", "project"] as const);
    const project = optionalProjectId(projectId);
    if (parsedScope === "project" && project === null) {
      throw new IpcValidationError("项目范围的 skill 需要 projectId");
    }
    const projectDir =
      parsedScope === "project" && project !== null ? (await getTaskPool()).projectPath(project) : null;
    const { name } = await skillPicker.add(
      parseString(token, "token", 100),
      parseOneOf(target, "target", ["shared", "omp"] as const),
      {
        agentDir: resolveAgentDir(),
        projectDir,
        homeDir: os.homedir(),
      },
    );
    return { name };
  },
  addSshHost: (input, projectId) => {
    parseRecord(input, "input");
    optionalProjectId(projectId);
    return Promise.reject(new Error("Pi 暂不内置 SSH 主机注册表"));
  },
  removeSshHost: (name, scope, projectId) => {
    parseString(name, "name", 64);
    parseOneOf(scope, "scope", ["user", "project"] as const);
    optionalProjectId(projectId);
    return Promise.reject(new Error("Pi 暂不内置 SSH 主机注册表"));
  },
};
