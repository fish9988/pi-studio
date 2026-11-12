// 右侧工作台内嵌终端页签（对齐 DSH 右侧栏终端体验，不在主对话底部弹出）。
// 支持同时保留多个已打开的终端标签页（切页仅显隐，xterm 屏幕与历史零丢失）。
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { TerminalKey } from "../../../../shared/ipc.ts";
import { cwdLabel } from "../../../../shared/ui/terminal-model.ts";
import { withShortcut } from "../../app/platform-keys.ts";
import { useT } from "../../i18n/use-t.ts";
import { Close, Restart, Terminal } from "../../icons.tsx";
import { useAppInfo } from "../../store/index.ts";
import { IconButton } from "../../ui/controls.tsx";
import { updateDshTerminalLabel } from "../workbench/dsh-workbench-store.ts";
import { useTerminalSession } from "./use-terminal-session.ts";
import "./terminal.css";

export function RightTerminalPane({
  workspaceKey,
  terminalKey,
  active,
  onCloseTab,
}: {
  workspaceKey: TerminalKey;
  terminalKey: TerminalKey;
  active: boolean;
  onCloseTab(): void;
}) {
  const t = useT();
  const platform = useAppInfo()?.platform ?? "win32";
  const host = useRef<HTMLDivElement>(null);
  const session = useTerminalSession(terminalKey, host, platform);

  useEffect(() => {
    if (session.shell) {
      updateDshTerminalLabel(workspaceKey, terminalKey, session.shell);
    }
  }, [workspaceKey, terminalKey, session.shell]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      host.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <section
      className="dsh-wb-terminal"
      hidden={!active}
      data-testid={active ? "terminal-panel" : undefined}
      aria-label={t("terminal.title")}
    >
      <header className="dsh-wb-term-head">
        <Terminal size={13} />
        <span className="terminal-shell" data-testid={active ? "terminal-shell" : undefined}>
          {session.shell ?? t("terminal.title")}
        </span>
        {session.cwd !== null && (
          <span className="terminal-cwd" title={session.cwd} data-testid={active ? "terminal-cwd" : undefined}>
            {cwdLabel(session.cwd)}
          </span>
        )}
        <span className="terminal-spacer" />
        <IconButton
          label={t("terminal.restart")}
          testId={active ? "terminal-restart" : undefined}
          onClick={session.restart}
        >
          <Restart size={13} />
        </IconButton>
        <IconButton
          label={t("terminal.hide")}
          tip={withShortcut(t("terminal.hide"), "Ctrl `")}
          testId={active ? "terminal-hide" : undefined}
          onClick={onCloseTab}
        >
          <Close size={13} />
        </IconButton>
      </header>
      <div className="terminal-body">
        <div
          ref={host}
          className="terminal-host"
          data-terminal-host={active ? "" : undefined}
          data-testid={active ? "terminal-host" : undefined}
        />
      </div>
    </section>
  );
}
