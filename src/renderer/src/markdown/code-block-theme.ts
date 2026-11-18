// 代码卡用深色终端卡还是浅色软卡（markdown/CodeBlock.tsx 的 data-code-dark / data-code-light）。
// 抽成纯函数：六种界面风格 × 三种代码块配色 × 主题深浅 × 是不是图，组合起来只在这里判断一次，单测直接覆盖。
import type { CodeBlockStyle, UiStyle } from "../../../shared/ipc.ts";

export interface CodeBlockTone {
  uiStyle: UiStyle;
  codeBlockStyle: CodeBlockStyle;
  /** 当前解析出的主题是不是深色（themes[resolveTheme(...)].dark）。 */
  darkTheme: boolean;
  /** 这块是不是画成了图（```svg / ```mermaid）：图不铺代码卡底色，两个属性都不挂。 */
  drawing: boolean;
}

/** 浅色主题下 auto 走浅色软卡的风格：Fluent 冷灰、云母冷灰、Claude 纯白、现代工作台中性暖灰。 */
const lightCardStyles = new Set<UiStyle>(["fluent", "mica-liquid", "claude", "zcode"]);

/** 是否用深色终端代码卡。手选优先；auto 下深色主题一律深色卡，浅色主题只有上面几套风格用浅色软卡。 */
export function codeBlockUsesDark({ uiStyle, codeBlockStyle, darkTheme, drawing }: CodeBlockTone): boolean {
  if (drawing) return false;
  if (codeBlockStyle === "dark") return true;
  if (codeBlockStyle === "light") return false;
  return darkTheme || !lightCardStyles.has(uiStyle);
}
