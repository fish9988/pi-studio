// Pi Studio 渲染进程桥接层：在不提前改动 shared/ipc.ts 的前提下，为设置页提供完整强类型 API 与安全回退。
import type {
  CustomModelsFileInfo,
  CustomModelsOutcome,
  CustomProviderInput,
  ProviderOverrideInput,
} from "../../../../../shared/custom-models.ts";
import type {
  LoginOutcome,
  ModelOption,
  OmpConfigSnapshot,
  OmpConfigWriteResult,
  OmpStatus,
  OmpUpgradeResult,
  Project,
  ProjectId,
  ShellState,
} from "../../../../../shared/ipc.ts";

type Unsubscribe = () => void;
import type { SkillCandidate, SkillEntry, SkillScope, SkillTarget } from "../../../../../shared/omp-output/skills.ts";
import {
  PI_BUILTIN_EXTENSIONS,
  type PiBuiltinExtensionId,
  type PiConfigFileKind,
  type PiConfigScope,
  type PiMcpServerSaveInput,
  type PiProviderAuthStatus,
  type PiResourcesSnapshot,
  type PiSystemDoc,
  type PiSystemDocKind,
} from "../../../../../shared/pi-config-types.ts";
import { CURATED_PI_PLUGINS, type PiMarketplacePlugin } from "../../../../../shared/pi-plugin-catalog.ts";

export interface PiStudioApi {
  // 既有 window.studio 接口
  getOmpConfig(): Promise<OmpConfigSnapshot>;
  setOmpConfig(key: string, valueJson: string): Promise<OmpConfigWriteResult>;
  resetOmpConfig(key: string): Promise<OmpConfigWriteResult>;
  onOmpConfigChanged(listener: (payload: { key: string }) => void): Unsubscribe;
  listProjects(): Promise<Project[]>;
  listModels(refresh: boolean): Promise<ModelOption[]>;
  listCustomProviders(): Promise<CustomModelsFileInfo>;
  saveCustomProvider(mode: "add" | "edit", input: CustomProviderInput): Promise<CustomModelsOutcome>;
  deleteCustomProvider(providerId: string): Promise<CustomModelsOutcome>;
  saveProviderOverride(providerId: string, input: ProviderOverrideInput): Promise<CustomModelsOutcome>;
  openModelsFile(): Promise<void>;
  openEnvFile(): Promise<void>;
  refreshModels(): Promise<void>;
  listSkills(projectId: ProjectId | null): Promise<SkillEntry[]>;
  setSkillEnabled(name: string, enabled: boolean): Promise<void>;
  removeSkill(name: string, scope: SkillScope, projectId: ProjectId | null): Promise<void>;
  pickSkillFolder(): Promise<SkillCandidate | null>;
  addSkill(
    token: string,
    target: SkillTarget,
    scope: SkillScope,
    projectId: ProjectId | null,
  ): Promise<{ name: string }>;
  startTerminalLogin(providerId: string): Promise<LoginOutcome>;
  cancelTerminalLogin(): Promise<void>;
  saveApiKey(providerId: string, key: string): Promise<void>;
  logout(providerId: string, credentialId?: number): Promise<void>;
  getOmpStatus(): Promise<OmpStatus>;
  upgradePathOmp(): Promise<OmpUpgradeResult>;
  checkOmpUpdate(): Promise<{ installedVersion: string | null; availableVersion: string | null }>;
  getShellState(): Promise<ShellState>;
  setShellState(patch: Partial<ShellState>): Promise<void>;
  openExternal(url: string): Promise<void>;
  openLogsFolder(): Promise<void>;
  exportDiagnostics(): Promise<boolean>;

  // Pi 1.5+ 新增专属接口
  listPiProviderStatuses(): Promise<PiProviderAuthStatus[]>;
  getPiResources(projectId: ProjectId | null): Promise<PiResourcesSnapshot>;
  savePiMcpServer(input: PiMcpServerSaveInput): Promise<void>;
  deletePiMcpServer(scope: PiConfigScope, name: string, projectId: ProjectId | null): Promise<void>;
  setPiMcpServerEnabled(
    scope: PiConfigScope,
    name: string,
    enabled: boolean,
    projectId: ProjectId | null,
  ): Promise<void>;
  setPiBuiltinExtensionEnabled(id: PiBuiltinExtensionId, enabled: boolean): Promise<void>;
  setPiCustomExtensions(paths: string[]): Promise<void>;
  runPiPackageAction(
    op: "install" | "remove" | "update",
    source: string | null,
    scope: PiConfigScope,
    projectId: ProjectId | null,
  ): Promise<{ output: string }>;
  getPiSystemDoc(scope: PiConfigScope, kind: PiSystemDocKind, projectId: ProjectId | null): Promise<PiSystemDoc>;
  savePiSystemDoc(
    scope: PiConfigScope,
    kind: PiSystemDocKind,
    content: string,
    projectId: ProjectId | null,
  ): Promise<void>;
  openPiConfigFile(kind: PiConfigFileKind): Promise<void>;
  searchPiPlugins(query: string): Promise<PiMarketplacePlugin[]>;
}

const emptyResources = (): PiResourcesSnapshot => ({
  packages: [],
  builtinExtensions: PI_BUILTIN_EXTENSIONS.map((id) => ({ id, enabled: true })),
  customExtensions: [],
  mcpServers: [],
  prompts: [],
  enableSkillCommands: true,
});

function rawStudio(): Partial<PiStudioApi> {
  if (typeof window === "undefined") return {};
  return (window as unknown as { studio?: Partial<PiStudioApi> }).studio ?? {};
}

function notWired(name: string): Promise<never> {
  return Promise.reject(new Error(`IPC method "${name}" is not available yet.`));
}

export function piBridge(): PiStudioApi {
  const raw = rawStudio();
  return {
    getOmpConfig: () =>
      raw.getOmpConfig ? raw.getOmpConfig() : Promise.resolve({ ompVersion: "", tabs: [], items: [] }),
    setOmpConfig: (key, valueJson) => (raw.setOmpConfig ? raw.setOmpConfig(key, valueJson) : notWired("setOmpConfig")),
    resetOmpConfig: (key) => (raw.resetOmpConfig ? raw.resetOmpConfig(key) : notWired("resetOmpConfig")),
    onOmpConfigChanged: (listener) => (raw.onOmpConfigChanged ? raw.onOmpConfigChanged(listener) : () => undefined),
    listProjects: () => (raw.listProjects ? raw.listProjects() : Promise.resolve([])),
    listModels: (refresh) => (raw.listModels ? raw.listModels(refresh) : Promise.resolve([])),
    listCustomProviders: () =>
      raw.listCustomProviders ? raw.listCustomProviders() : Promise.resolve({ path: "", exists: false, providers: [] }),
    saveCustomProvider: (mode, input) =>
      raw.saveCustomProvider ? raw.saveCustomProvider(mode, input) : notWired("saveCustomProvider"),
    deleteCustomProvider: (providerId) =>
      raw.deleteCustomProvider ? raw.deleteCustomProvider(providerId) : notWired("deleteCustomProvider"),
    saveProviderOverride: (providerId, input) =>
      raw.saveProviderOverride ? raw.saveProviderOverride(providerId, input) : notWired("saveProviderOverride"),
    openModelsFile: () => (raw.openModelsFile ? raw.openModelsFile() : Promise.resolve()),
    openEnvFile: () => (raw.openEnvFile ? raw.openEnvFile() : Promise.resolve()),
    refreshModels: () => (raw.refreshModels ? raw.refreshModels() : Promise.resolve()),
    listSkills: (projectId) => (raw.listSkills ? raw.listSkills(projectId) : Promise.resolve([])),
    setSkillEnabled: (name, enabled) =>
      raw.setSkillEnabled ? raw.setSkillEnabled(name, enabled) : notWired("setSkillEnabled"),
    removeSkill: (name, scope, projectId) =>
      raw.removeSkill ? raw.removeSkill(name, scope, projectId) : notWired("removeSkill"),
    pickSkillFolder: () => (raw.pickSkillFolder ? raw.pickSkillFolder() : Promise.resolve(null)),
    addSkill: (token, target, scope, projectId) =>
      raw.addSkill ? raw.addSkill(token, target, scope, projectId) : notWired("addSkill"),
    startTerminalLogin: (providerId) =>
      raw.startTerminalLogin ? raw.startTerminalLogin(providerId) : notWired("startTerminalLogin"),
    cancelTerminalLogin: () => (raw.cancelTerminalLogin ? raw.cancelTerminalLogin() : Promise.resolve()),
    saveApiKey: (providerId, key) => (raw.saveApiKey ? raw.saveApiKey(providerId, key) : notWired("saveApiKey")),
    logout: (providerId, credentialId = 0) => (raw.logout ? raw.logout(providerId, credentialId) : notWired("logout")),
    getOmpStatus: () => (raw.getOmpStatus ? raw.getOmpStatus() : Promise.resolve({ state: "discovering" })),
    upgradePathOmp: () => (raw.upgradePathOmp ? raw.upgradePathOmp() : notWired("upgradePathOmp")),
    checkOmpUpdate: () =>
      raw.checkOmpUpdate ? raw.checkOmpUpdate() : Promise.resolve({ installedVersion: null, availableVersion: null }),
    getShellState: () => (raw.getShellState ? raw.getShellState() : notWired("getShellState")),
    setShellState: (patch) => (raw.setShellState ? raw.setShellState(patch) : Promise.resolve()),
    openExternal: (url) => (raw.openExternal ? raw.openExternal(url) : Promise.resolve()),
    openLogsFolder: () => (raw.openLogsFolder ? raw.openLogsFolder() : Promise.resolve()),
    exportDiagnostics: () => (raw.exportDiagnostics ? raw.exportDiagnostics() : Promise.resolve(false)),

    // Pi 专属方法（在主进程尚未接线时提供安全降级）
    listPiProviderStatuses: () => (raw.listPiProviderStatuses ? raw.listPiProviderStatuses() : Promise.resolve([])),
    getPiResources: (projectId) =>
      raw.getPiResources ? raw.getPiResources(projectId) : Promise.resolve(emptyResources()),
    savePiMcpServer: (input) => (raw.savePiMcpServer ? raw.savePiMcpServer(input) : notWired("savePiMcpServer")),
    deletePiMcpServer: (scope, name, projectId) =>
      raw.deletePiMcpServer ? raw.deletePiMcpServer(scope, name, projectId) : notWired("deletePiMcpServer"),
    setPiMcpServerEnabled: (scope, name, enabled, projectId) =>
      raw.setPiMcpServerEnabled
        ? raw.setPiMcpServerEnabled(scope, name, enabled, projectId)
        : notWired("setPiMcpServerEnabled"),
    setPiBuiltinExtensionEnabled: (id, enabled) =>
      raw.setPiBuiltinExtensionEnabled
        ? raw.setPiBuiltinExtensionEnabled(id, enabled)
        : notWired("setPiBuiltinExtensionEnabled"),
    setPiCustomExtensions: (paths) =>
      raw.setPiCustomExtensions ? raw.setPiCustomExtensions(paths) : notWired("setPiCustomExtensions"),
    runPiPackageAction: (op, source, scope, projectId) =>
      raw.runPiPackageAction ? raw.runPiPackageAction(op, source, scope, projectId) : notWired("runPiPackageAction"),
    getPiSystemDoc: (scope, kind, projectId) =>
      raw.getPiSystemDoc
        ? raw.getPiSystemDoc(scope, kind, projectId)
        : Promise.resolve({ kind, scope, exists: false, content: "" }),
    savePiSystemDoc: (scope, kind, content, projectId) =>
      raw.savePiSystemDoc ? raw.savePiSystemDoc(scope, kind, content, projectId) : notWired("savePiSystemDoc"),
    openPiConfigFile: (kind) => {
      if (raw.openPiConfigFile) return raw.openPiConfigFile(kind);
      if (kind === "models.json" && raw.openModelsFile) return raw.openModelsFile();
      return notWired("openPiConfigFile");
    },
    searchPiPlugins: (query) =>
      raw.searchPiPlugins ? raw.searchPiPlugins(query) : Promise.resolve([...CURATED_PI_PLUGINS]),
  };
}
