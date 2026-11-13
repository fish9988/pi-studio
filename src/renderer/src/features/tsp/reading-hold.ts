// 阅读保护（参考 vastsa/PI-Desktop disclosure.tsx）：
// 当模型刚刚思考结束或过程组刚刚完成（settled）时，如果用户的键盘焦点或鼠标划词正停留在过程/思考正文内部，
// 暂缓自动收起，等用户移出焦点或取消选区后再收起，绝不在用户阅读/复制文本的瞬间把内容折走。
export function ownsReadingPosition(container: HTMLElement | null): boolean {
  if (container === null) return false;
  const active = document.activeElement;
  if (active !== null && container.contains(active)) return true;
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed) return false;
  return container.contains(selection.anchorNode) || container.contains(selection.focusNode);
}

const listeners = new Set<() => void>();
let hubInstalled = false;

function installReadingHub(): void {
  if (hubInstalled || typeof document === "undefined") return;
  hubInstalled = true;
  const notify = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  document.addEventListener("focusin", notify);
  document.addEventListener("selectionchange", notify);
  window.addEventListener("pointerup", notify);
}

export function subscribeReadingChanges(listener: () => void): () => void {
  installReadingHub();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
