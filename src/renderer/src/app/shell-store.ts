// 外壳界面状态：侧栏宽度、折叠、终端面板高度、历史会话排列（主进程持久化）和窄窗抽屉是否打开（只在内存）。
// 拖动侧栏 / 终端拖拽条时不经过这里：拖拽条自己直接改 DOM，松手时才 commit（一次写 store、一次持久化）。
import {
  backdropChatVeilRange,
  backdropSidebarVeilRange,
  backdropSurfaceOpacityRange,
  limits,
  type BackdropScope,
  type BrandStyle,
  type CodeBlockStyle,
  type ConversationView,
  type FontStyle,
  type HelperThinking,
  type HistoryOrder,
  type MascotCharacter,
  type PreferredShell,
  type ProcessRowsLayout,
  type ShellState,
  type UiStyle,
} from "../../../shared/ipc.ts";
import { defaultTerminalHeight } from "../../../shared/ui/terminal-model.ts";
import { createStore, useStoreValue } from "../store/create-store.ts";

export const defaultSidebarWidth = 240;
export const sidebarWidthRange = [200, 360] as const;
export const defaultChatWidth = 820;
export const chatWidthRange = limits.chatWidthRange;

interface ShellUiState extends ShellState {
  drawerOpen: boolean;
}

const shellStore = createStore<ShellUiState>({
  sidebarWidth: defaultSidebarWidth,
  sidebarCollapsed: false,
  terminalHeight: defaultTerminalHeight,
  historyOrder: "folder",
  chatWidth: 0,
  brandStyle: "pi",
  uiStyle: "expressive",
  codeBlockStyle: "auto",
  mascot: "clawd",
  processRows: "classic",
  helperModel: "smol",
  helperThinking: "off",
  autoSmartRename: false,
  preferredShell: "auto",
  conversationView: "chat",
  homeRipple: true,
  uiFontStyle: "sans",
  uiFontFamily: "",
  chatFontStyle: "sans",
  chatFontFamily: "",
  backdropScope: "chat",
  backdropChatVeil: 82,
  backdropSidebarVeil: 84,
  backdropSurfaceOpacity: 88,
  backdropSoftMask: true,
  drawerOpen: false,
});
/** 只在有字段真的变了时写入：每次 set 都会通知所有订阅者（例如每次切任务都会调 setDrawerOpen(false)）。 */
function update(patch: Partial<ShellUiState>): void {
  const current = shellStore.get();
  const keys = Object.keys(patch) as (keyof ShellUiState)[];
  if (keys.every((key) => Object.is(current[key], patch[key]))) return;
  shellStore.set({ ...current, ...patch });
}

export function startShellStore(): void {
  window.studio.getShellState().then(
    (state) => update(state),
    (error: unknown) => console.error("getShellState 失败", error),
  );
  // 设置可以开成独立窗口（或在主窗口里分屏）：别的窗口改了外壳状态就跟着改，
  // 否则主窗口会一直停在启动时读到的那份值上（「过程行」点了和没点一样就是这个）。
  window.studio.onShellState((patch) => update(patch));
}

function persist(patch: Partial<ShellState>): void {
  window.studio.setShellState(patch).catch((error: unknown) => console.error("setShellState 失败", error));
}

export function commitSidebarWidth(width: number): void {
  const sidebarWidth = clampSidebarWidth(width);
  update({ sidebarWidth });
  persist({ sidebarWidth });
}
export function commitChatWidth(width: number): void {
  const chatWidth = width <= 0 ? 0 : clampChatWidth(width);
  update({ chatWidth });
  persist({ chatWidth });
}

export function clampChatWidth(width: number): number {
  return Math.round(Math.min(chatWidthRange[1], Math.max(chatWidthRange[0], width)));
}

/** 存储里只夹到合法范围；"不超过主区 70%" 取决于当时的窗口高度，由面板渲染时再夹。 */
function clampStoredTerminalHeight(height: number): number {
  return Math.round(Math.min(limits.terminalHeightRange[1], Math.max(limits.terminalHeightRange[0], height)));
}

export function commitTerminalHeight(height: number): void {
  const terminalHeight = clampStoredTerminalHeight(height);
  update({ terminalHeight });
  persist({ terminalHeight });
}

export function setSidebarCollapsed(sidebarCollapsed: boolean): void {
  update({ sidebarCollapsed });
  persist({ sidebarCollapsed });
}

export function setHistoryOrder(historyOrder: HistoryOrder): void {
  update({ historyOrder });
  persist({ historyOrder });
}

export function setBrandStyle(brandStyle: BrandStyle): void {
  update({ brandStyle });
  persist({ brandStyle });
}

export function setUiStyle(uiStyle: UiStyle): void {
  update({ uiStyle });
  persist({ uiStyle });
}

export function setCodeBlockStyle(codeBlockStyle: CodeBlockStyle): void {
  update({ codeBlockStyle });
  persist({ codeBlockStyle });
}

export function setMascotCharacter(mascot: MascotCharacter): void {
  update({ mascot });
  persist({ mascot });
}

export function setProcessRowsLayout(processRows: ProcessRowsLayout): void {
  update({ processRows });
  persist({ processRows });
}

export function setHelperModel(helperModel: string): void {
  update({ helperModel });
  persist({ helperModel });
}

export function setHelperThinking(helperThinking: HelperThinking): void {
  update({ helperThinking });
  persist({ helperThinking });
}

export function setAutoSmartRename(autoSmartRename: boolean): void {
  update({ autoSmartRename });
  persist({ autoSmartRename });
}

export function setPreferredShell(preferredShell: PreferredShell): void {
  update({ preferredShell });
  persist({ preferredShell });
}

export function setConversationView(conversationView: ConversationView): void {
  update({ conversationView });
  persist({ conversationView });
}

export function setHomeRipple(homeRipple: boolean): void {
  update({ homeRipple });
  persist({ homeRipple });
}

export function setUiFontStyle(uiFontStyle: FontStyle): void {
  update({ uiFontStyle });
  persist({ uiFontStyle });
}

export function setUiFontFamily(uiFontFamily: string): void {
  update({ uiFontFamily });
  persist({ uiFontFamily });
}

export function setChatFontStyle(chatFontStyle: FontStyle): void {
  update({ chatFontStyle });
  persist({ chatFontStyle });
}

export function setChatFontFamily(chatFontFamily: string): void {
  update({ chatFontFamily });
  persist({ chatFontFamily });
}

export function setBackdropScope(backdropScope: BackdropScope): void {
  update({ backdropScope });
  persist({ backdropScope });
}

export function setBackdropChatVeil(backdropChatVeil: number): void {
  const value = clampRange(backdropChatVeil, backdropChatVeilRange);
  update({ backdropChatVeil: value });
  persist({ backdropChatVeil: value });
}

export function setBackdropSidebarVeil(backdropSidebarVeil: number): void {
  const value = clampRange(backdropSidebarVeil, backdropSidebarVeilRange);
  update({ backdropSidebarVeil: value });
  persist({ backdropSidebarVeil: value });
}

export function setBackdropSurfaceOpacity(backdropSurfaceOpacity: number): void {
  const value = clampRange(backdropSurfaceOpacity, backdropSurfaceOpacityRange);
  update({ backdropSurfaceOpacity: value });
  persist({ backdropSurfaceOpacity: value });
}

export function setBackdropSoftMask(backdropSoftMask: boolean): void {
  update({ backdropSoftMask });
  persist({ backdropSoftMask });
}

function clampRange(value: number, [min, max]: readonly [number, number]): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function setDrawerOpen(drawerOpen: boolean): void {
  update({ drawerOpen });
}

/** 订阅外壳状态的一个字段：只在这个字段变了时重渲染。 */
export function useShellValue<K extends keyof ShellUiState>(key: K): ShellUiState[K] {
  return useStoreValue(shellStore, (state) => state[key]);
}

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(sidebarWidthRange[1], Math.max(sidebarWidthRange[0], width)));
}
