import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/themes.css";
import "./app/app.css";
import "./ui/controls.css";
import "./ui/motion.css";
import "./ui/scrollbars.css";
import { App } from "./app/App.tsx";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import { installInputModality } from "./ui/input-modality.ts";
import { installScrollActivity } from "./ui/scroll-activity.ts";
import { startShellStore } from "./app/shell-store.ts";
import { startStores } from "./store/index.ts";
import { loadStartupSnapshot } from "./store/startup-snapshot.ts";

installScrollActivity();
installInputModality();
startStores();
startShellStore();

const container = document.getElementById("root");
if (!container) throw new Error("index.html 里没有 #root");

function safeFontLoad(sizePx: number, varName: string): Promise<unknown> {
  try {
    const family = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (!family) return Promise.resolve();
    return document.fonts.load(`${sizePx}px ${family}`).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

// 启动预热（快照 + 首帧字体）加上限超时与异常兜底：开发态异步样式注入或字体异常时绝不卡死在空白 #root。
const bootReady = Promise.race([
  Promise.allSettled([
    loadStartupSnapshot(),
    safeFontLoad(13, "--font-sans"),
    safeFontLoad(15, "--font-display"),
    safeFontLoad(13, "--font-mono"),
  ]),
  new Promise<void>((resolve) => {
    setTimeout(resolve, 600);
  }),
]);

void bootReady.finally(() => {
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary fullScreen>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
});
