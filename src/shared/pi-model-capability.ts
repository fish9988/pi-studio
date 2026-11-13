// 「这个模型支持哪些思考强度」的判定，和 Pi 自己完全一致
// （`@earendil-works/pi-ai` 的 `getSupportedThinkingLevels`，`dist/models.js`）：
// - `reasoning` 不为 true：只有 `off`（不思考的模型没有强度可选）。
// - `off` … `high` 默认支持，除非 `thinkingLevelMap` 把它映射成 null（上游没有这一档）。
// - `xhigh` / `max` 只在 `thinkingLevelMap` 里显式给了非 null 的值时才算支持：Pi 不替模型猜这两档
//   （models.json 文档原文："xhigh and max are unsupported" 当模型没映射它们）。
// 所以这里不能对所有 reasoning 模型一律给 `minimal`…`high`，也不能一律补上 `xhigh`/`max`：
// 档位来自模型自己的显式能力声明，选到的档 Pi 才会真的发给上游（否则会被 clamp 回更低的档）。
import type { Effort, ThinkingLevel } from "./omp-wire/rpc-wire.generated.ts";

/** `models.json` 里某个模型的 `thinkingLevelMap`：Pi 档位 → 发给上游的值；null = 明确不支持。 */
export type PiThinkingLevelMap = Readonly<Record<string, string | null | undefined>>;

/** 判定能力需要的模型字段（`get_available_models` 回的模型对象里的两项）。 */
export interface PiThinkingCapability {
  reasoning?: boolean | undefined;
  thinkingLevelMap?: PiThinkingLevelMap | undefined;
}

/** Pi 的全部档位，从弱到强（`off` 在最前）。 */
export const PI_THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** 这个模型能选的思考强度（含 `off`，不含 `inherit`），按 Pi 的顺序。 */
export function piModelThinkingLevels(model: PiThinkingCapability | null | undefined): ThinkingLevel[] {
  if (model?.reasoning !== true) return ["off"];
  const map = model.thinkingLevelMap;
  return PI_THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** 这个模型能选的思考强度里除 `off` 的部分（`ModelOption.thinkingEfforts` 用）。 */
export function piModelThinkingEfforts(model: PiThinkingCapability | null | undefined): Effort[] {
  return piModelThinkingLevels(model).filter((level): level is Effort => level !== "off");
}
