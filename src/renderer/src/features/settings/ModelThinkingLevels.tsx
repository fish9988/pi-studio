// 一个模型（或 `modelOverrides` 覆盖项）的 `thinkingLevelMap`：Pi 七个档位各一行。
// 空 = 不声明这一档（`off`…`high` 用上游默认值，`xhigh` / `max` 不支持）；填值 = 这一档发给上游的值；勾「隐藏」= null，上游没有这一档。
// 只写用户在界面里改过的档位，不给所有模型硬塞 xhigh / max（Pi 的 `getSupportedThinkingLevels` 就是这么判的）。
import { useState } from "react";
import { limits, type CustomThinkingLevelMap } from "../../../../shared/custom-models.ts";
import { PI_THINKING_LEVEL_ORDER } from "../../../../shared/pi-model-capability.ts";
import { useT } from "../../i18n/use-t.ts";
import { Checkbox, TextField } from "../../ui/controls.tsx";

/** 改一个档位：`undefined` = 删掉这一项（回到不声明），`null` = 隐藏。 */
export function withThinkingLevel(
  map: CustomThinkingLevelMap,
  level: string,
  next: string | null | undefined,
): CustomThinkingLevelMap {
  const out = { ...map };
  if (next === undefined) delete out[level];
  else out[level] = next;
  return out;
}

interface ModelThinkingLevelsProps {
  modelId: string;
  value: CustomThinkingLevelMap;
  onChange(next: CustomThinkingLevelMap): void;
}

export function ModelThinkingLevels({ modelId, value, onChange }: ModelThinkingLevelsProps) {
  const t = useT();
  // 勾「隐藏」时把输入框里的值记下来：取消隐藏时恢复，不会白填一遍。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const textOf = (level: string): string => {
    const mapped = value[level];
    return typeof mapped === "string" ? mapped : "";
  };

  return (
    <div className="cp-levels">
      <p className="ui-help">{t("custom.form.meta.levels.help")}</p>
      <div className="cp-levels-grid">
        {PI_THINKING_LEVEL_ORDER.map((level) => {
          const hidden = value[level] === null;
          const text = hidden ? "" : textOf(level);
          return (
            <div className="cp-level" key={level}>
              <span className="cp-level-name">{level}</span>
              <TextField
                size="sm"
                mono
                width="100%"
                autoComplete="off"
                value={text}
                disabled={hidden}
                invalid={text !== "" && text !== text.trim()}
                maxLength={limits.thinkingValue}
                placeholder={
                  isExtraLevel(level) ? t("custom.form.meta.levels.unset.extra") : t("custom.form.meta.levels.unset")
                }
                aria-label={t("custom.form.meta.levels.cell", { level, model: modelId })}
                testId={`custom-model-level-${modelId}-${level}`}
                onChange={(next) => onChange(withThinkingLevel(value, level, next === "" ? undefined : next))}
              />
              <Checkbox
                checked={hidden}
                label={t("custom.form.meta.levels.hide", { level, model: modelId })}
                testId={`custom-model-hide-${modelId}-${level}`}
                onChange={(next) => {
                  if (next) {
                    if (text !== "") setDrafts((current) => ({ ...current, [level]: text }));
                    onChange(withThinkingLevel(value, level, null));
                    return;
                  }
                  const draft = drafts[level] ?? "";
                  onChange(withThinkingLevel(value, level, draft === "" ? undefined : draft));
                }}
              >
                {t("custom.form.meta.levels.hidden")}
              </Checkbox>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** `xhigh` / `max` 不写就不支持：占位文案要说清楚，不然看起来像是和 `off`…`high` 一样"留空用默认"。 */
const isExtraLevel = (level: string): boolean => level === "xhigh" || level === "max";
