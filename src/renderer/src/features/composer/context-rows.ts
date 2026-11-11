// 上下文构成的行（ContextBreakdown 用）。
// 新任务草稿还没有运行轮次，按 DSH 风格列出系统提示词、Skills、工具定义、消息、工具调用与输出、剩余空间与自动压缩预留。
import type { ContextReportRow } from "../../../../shared/ipc.ts";

/** 草稿的行：按 Pi 的真实上下文结构分列展示（预留默认按 Pi 的 16384 token，而非旧 15%）。 */
export function draftContextRows(window: number, trigger: number | null): ContextReportRow[] {
  const defaultReserve = Math.min(window, 16_384);
  const rawBuffer = trigger === null ? defaultReserve : Math.max(0, window - trigger);
  const buffer = rawBuffer > 100_000 && window >= 500_000 ? defaultReserve : rawBuffer;
  const rows: ContextReportRow[] = [
    { key: "piSystemPrompt", label: "系统提示词与指令", tokens: 0 },
    { key: "piSkills", label: "Skills 索引", tokens: 0 },
    { key: "builtInTools", label: "内置工具定义", tokens: 0 },
    { key: "userMessages", label: "用户消息", tokens: 0 },
    { key: "assistantMessages", label: "助手回复", tokens: 0 },
    { key: "toolCalls", label: "工具调用", tokens: 0 },
    { key: "toolOutput", label: "工具返回结果", tokens: 0 },
    { key: "free", label: "Free space", tokens: Math.max(0, window - buffer) },
  ];
  if (buffer > 0) rows.push({ key: "buffer", label: "Autocompact buffer", tokens: buffer });
  return rows;
}
