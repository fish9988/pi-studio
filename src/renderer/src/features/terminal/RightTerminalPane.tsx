// 右侧工作台内嵌终端页签（对齐 DSH 右侧栏终端体验，不在主对话底部弹出）。
// 支持同时保留多个已打开的终端标签页（切页仅显隐，xterm 屏幕与历史零丢失）。
// 选区联动：头部的「引用到输入框」和 .terminal-body 的右键菜单（复制 / 引用 / 清屏 / 重启），不做悬浮工具栏挡视线。
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { TerminalKey } from "../../../../shared/ipc.ts";
import { cwdLabel } from "../../../../shared/ui/terminal-model.ts";
import { withShortcut } from "../../app/platform-keys.ts";
import { useT } from "../../i18n/use-t.ts";
import { Close, Comment, CopyIcon, Restart, Terminal } from "../../icons.tsx";
import { currentLocale } from "../../store/settings-store.ts";
import { useAppInfo } from "../../store/index.ts";
import { IconButton } from "../../ui/controls.tsx";
import { Menu, type MenuAnchor, type MenuEntry } from "../../ui/Menu.tsx";
import { composerKeyForTerminal, quoteToComposer } from "../composer/quote.ts";
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
  const zh = currentLocale() === "zh-CN";
  const platform = useAppInfo()?.platform ?? "win32";
  const host = useRef<HTMLDivElement>(null);
  const session = useTerminalSession(terminalKey, host, platform);
  const selection = session.selection.trim();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

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

  const copySelection = () => {
    if (selection === "") return;
    void navigator.clipboard.writeText(selection).catch(() => undefined);
    session.clearSelection();
  };
  // 引用进草稿：终端键可能带多标签后缀（`key#t2`），草稿挂在打开它的那个任务 / 草稿上。
  const quoteSelection = () => {
    if (selection === "") return;
    quoteToComposer(composerKeyForTerminal(workspaceKey), selection);
    session.clearSelection();
  };

  const items: MenuEntry[] = [
    {
      id: "copy",
      label: zh ? "复制选区" : "Copy selection",
      icon: <CopyIcon size={14} />,
      shortcut: "Ctrl Shift C",
      disabled: selection === "",
      testId: "terminal-menu-copy",
      onSelect: copySelection,
    },
    {
      id: "quote",
      label: zh ? "引用到输入框" : "Quote to composer",
      icon: <Comment size={14} />,
      disabled: selection === "",
      testId: "terminal-menu-quote",
      onSelect: quoteSelection,
    },
    { kind: "separator", id: "sep" },
    { id: "clear", label: zh ? "清屏" : "Clear screen", testId: "terminal-menu-clear", onSelect: session.clear },
    {
      id: "restart",
      label: t("terminal.restart"),
      icon: <Restart size={13} />,
      testId: "terminal-menu-restart",
      onSelect: session.restart,
    },
  ];

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
          label={zh ? "引用选区到输入框" : "Quote selection to composer"}
          testId={active ? "terminal-quote-selection" : undefined}
          disabled={selection === ""}
          onClick={quoteSelection}
        >
          <Comment size={13} />
        </IconButton>
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
      <div
        className="terminal-body"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({
            x: event.clientX,
            y: event.clientY,
            returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
          });
        }}
      >
        <div
          ref={host}
          className="terminal-host"
          data-terminal-host={active ? "" : undefined}
          data-testid={active ? "terminal-host" : undefined}
        />
      </div>
      {menu !== null && (
        <Menu
          anchor={menu}
          items={items}
          label={zh ? "终端菜单" : "Terminal menu"}
          testId="terminal-context-menu"
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
