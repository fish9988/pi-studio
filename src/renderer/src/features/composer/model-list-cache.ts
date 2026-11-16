// 模型选择器上次拿到的目录：再打开时先用它把整张表画出来，骨架屏只在真的一个模型都没有时出现。
// 主进程仍然会去核对最新目录，结果到了再替换；缓存只影响"第一帧画什么"，不参与任何判断。
import type { ModelOption } from "../../../../shared/ipc.ts";
import { startupSnapshot } from "../../store/startup-snapshot.ts";

let cached: ModelOption[] | null = null;

/** 上次读到的目录；从没读过时退回启动缓存（启动快照里那份），仍然没有是 null。 */
export function cachedModelList(): ModelOption[] | null {
  if (cached !== null) return cached;
  const snapshot = startupSnapshot().models;
  return snapshot !== undefined && snapshot.length > 0 ? snapshot : null;
}

/** 记下这次读到的目录；空列表不覆盖（读出空多半是暂时性失败，别把缓存清掉）。 */
export function rememberModelList(list: readonly ModelOption[]): void {
  if (list.length > 0) cached = [...list];
}
