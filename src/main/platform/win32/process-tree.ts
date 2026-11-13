// Windows 上结束一个进程和它的所有后代：`taskkill /T /F`。POSIX 的对应实现见 posix/process-tree.ts。
import { execFile } from "node:child_process";
import path from "node:path";
import { log } from "../../log/log.ts";

/** `taskkill` 找不到目标进程时的退出码：进程已经自己退出，属于正常情况。 */
const TASKKILL_NOT_FOUND_EXIT_CODE = 128;

/**
 * taskkill 的失败要不要记日志。进程已经自己退出（`ERROR: The process ... not found`，退出码 128）
 * 和被超时/信号强制结束时（`error.killed === true`）都是预期内的，不记；缺 `taskkill.exe`（ENOENT）、
 * 权限拒绝、参数错误等真实失败要记，否则问题会被静默吞掉。
 */
export function shouldLogTaskkillFailure(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error !== "object") return true;
  const { killed, code } = error as { killed?: unknown; code?: unknown };
  if (killed === true) return false;
  if (code === TASKKILL_NOT_FOUND_EXIT_CODE) return false;
  return true;
}

/**
 * 结束 root 和它的所有后代，taskkill 结束（或超时）后 resolve，永不 reject。
 * taskkill 用绝对路径：不带路径时 Windows 会先在当前目录里找。进程已经自己退出时命令会失败，忽略即可。
 */
export function killWin32ProcessTree(root: number): Promise<void> {
  const taskkill = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");
  const done = Promise.withResolvers<void>();
  execFile(taskkill, ["/T", "/F", "/PID", String(root)], { windowsHide: true, timeout: 5000 }, (error) => {
    if (shouldLogTaskkillFailure(error)) {
      log.warn("taskkill failed", { pid: root, message: String(error) });
    }
    done.resolve();
  });
  return done.promise;
}
