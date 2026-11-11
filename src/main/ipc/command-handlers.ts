// 斜杠命令 IPC：会话级（`runTaskCommand`）在任务的 Pi RPC 会话里执行；旧版全局 `runBuiltin` 返回友好说明。
import type { HandlerGroup } from "../../shared/ipc.ts";
import { getTaskPool } from "../tasks/runtime.ts";
import { parseBuiltinCommandArg, parseBuiltinScope, parseTaskCommandArg, parseTaskId } from "./validate.ts";

export const commandHandlers: HandlerGroup<"runTaskCommand" | "runBuiltin"> = {
  runTaskCommand: async (taskId, cmd) => {
    const id = parseTaskId(taskId);
    const command = parseTaskCommandArg(cmd);
    return (await getTaskPool()).runTaskCommand(id, command);
  },
  runBuiltin: (cmd, scope) => {
    parseBuiltinCommandArg(cmd);
    parseBuiltinScope(scope);
    return Promise.resolve({ text: "" });
  },
};
