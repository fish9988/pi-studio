// 代码卡用深色终端卡还是冷灰浅色卡（markdown/CodeBlock.tsx 的 data-code-dark / data-code-light）。
// 抽成纯函数：四种界面风格 × 三种代码块配色 × 主题深浅 × 是不是图，组合起来只在这里判断一次，单测直接覆盖。
import type { CodeBlockStyle, UiStyle } from "../../../shared/ipc.ts";

export interface CodeBlockTone {
  uiStyle: UiStyle;
  codeBlockStyle: CodeBlockStyle;
  /** 当前解析出的主题是不是深色（themes[resolveTheme(...)].dark）。 */
  darkTheme: boolean;
  /** 这块是不是画成了图（```svg / ```mermaid）：图不铺代码卡底色，两个属性都不挂。 */
  drawing: boolean;
}

/** 是否用深色终端代码卡。手选优先；auto 下深色主题一律深色卡，浅色主题只有 fluent / mica-liquid 用冷灰浅色卡。 */
export function codeBlockUsesDark({ uiStyle, codeBlockStyle, darkTheme, drawing }: CodeBlockTone): boolean {
  if (drawing) return false;
  if (codeBlockStyle === "dark") return true;
  if (codeBlockStyle === "light") return false;
  return darkTheme || (uiStyle !== "fluent" && uiStyle !== "mica-liquid");
}
