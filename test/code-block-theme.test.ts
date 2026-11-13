// 代码卡底色：手选（深色 / 浅色）优先；auto 下深色主题一律深色终端卡，浅色主题只有 fluent / mica-liquid 用冷灰浅色卡，
// expressive / liquid 保留深色终端卡；图（svg / mermaid）不挂代码卡底色。
import { describe, expect, it } from "vitest";
import { codeBlockUsesDark } from "../src/renderer/src/markdown/code-block-theme.ts";

const cases = [
  { uiStyle: "fluent", codeBlockStyle: "auto", darkTheme: false, drawing: false, expected: false },
  { uiStyle: "mica-liquid", codeBlockStyle: "auto", darkTheme: false, drawing: false, expected: false },
  { uiStyle: "expressive", codeBlockStyle: "auto", darkTheme: false, drawing: false, expected: true },
  { uiStyle: "liquid", codeBlockStyle: "auto", darkTheme: false, drawing: false, expected: true },
  { uiStyle: "fluent", codeBlockStyle: "auto", darkTheme: true, drawing: false, expected: true },
  { uiStyle: "mica-liquid", codeBlockStyle: "auto", darkTheme: true, drawing: false, expected: true },
  { uiStyle: "expressive", codeBlockStyle: "auto", darkTheme: true, drawing: false, expected: true },
  { uiStyle: "liquid", codeBlockStyle: "auto", darkTheme: true, drawing: false, expected: true },
  { uiStyle: "fluent", codeBlockStyle: "dark", darkTheme: false, drawing: false, expected: true },
  { uiStyle: "mica-liquid", codeBlockStyle: "dark", darkTheme: false, drawing: false, expected: true },
  { uiStyle: "mica-liquid", codeBlockStyle: "light", darkTheme: true, drawing: false, expected: false },
  { uiStyle: "liquid", codeBlockStyle: "light", darkTheme: true, drawing: false, expected: false },
  { uiStyle: "expressive", codeBlockStyle: "light", darkTheme: false, drawing: false, expected: false },
  { uiStyle: "fluent", codeBlockStyle: "auto", darkTheme: false, drawing: true, expected: false },
  { uiStyle: "liquid", codeBlockStyle: "dark", darkTheme: true, drawing: true, expected: false },
] as const;

describe("代码卡配色", () => {
  it.each(cases)("$uiStyle · $codeBlockStyle · dark=$darkTheme · figure=$drawing → $expected", (item) => {
    expect(codeBlockUsesDark(item)).toBe(item.expected);
  });
});
