// 分层渲染错误边界（防白屏）：
//  - RootErrorBoundary 包裹根应用：任何未捕获渲染异常都不会导致整窗卸载白屏或卡在 opacity:0，而是给出可一键重载/恢复外观的兜底面板；
//  - PanelErrorBoundary 包裹对话流、右侧工作台与设置面板：单区域渲染异常只隔离在该面板内，侧栏切换会话（key 变化）自动自愈。
import { Component, type ErrorInfo, type ReactNode } from "react";

interface InnerProps {
  children: ReactNode;
  fullScreen?: boolean | undefined;
}

interface InnerState {
  error: Error | null;
}

class ErrorBoundaryInner extends Component<InnerProps, InnerState> {
  override state: InnerState = { error: null };

  static getDerivedStateFromError(error: unknown): InnerState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[pi-studio] UI ErrorBoundary caught:", error, info.componentStack);
    if (this.props.fullScreen) {
      void window.studio?.windowReady?.().catch(() => {});
    }
  }

  #retry = (): void => {
    this.setState({ error: null });
  };

  #reload = (): void => {
    window.location.reload();
  };

  #resetAppearanceAndReload = (): void => {
    void Promise.allSettled([window.studio?.setTheme?.("default"), window.studio?.setColorMode?.("system")]).finally(
      () => {
        window.location.reload();
      },
    );
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    if (this.props.fullScreen) {
      return (
        <div className="ui-crash-screen" role="alert" data-testid="root-error-boundary">
          <div className="ui-crash-card">
            <h2 className="ui-crash-title">界面渲染出现异常，已拦截白屏</h2>
            <p className="ui-crash-desc">{error.message || "未知渲染错误"}</p>
            <div className="ui-crash-actions">
              <button type="button" className="ui-crash-btn" onClick={this.#retry}>
                重试渲染
              </button>
              <button type="button" className="ui-crash-btn" onClick={this.#resetAppearanceAndReload}>
                重置外观并刷新
              </button>
              <button type="button" className="ui-crash-btn ui-crash-btn-primary" onClick={this.#reload}>
                重新加载界面
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="ui-crash-inline" role="alert" data-testid="panel-error-boundary">
        <span className="ui-crash-inline-text">该面板渲染异常：{error.message || "未知错误"}</span>
        <button type="button" className="ui-crash-btn" onClick={this.#retry}>
          重试
        </button>
      </div>
    );
  }
}

export function ErrorBoundary({
  children,
  resetKey,
  fullScreen,
}: {
  children: ReactNode;
  resetKey?: string | null | undefined;
  fullScreen?: boolean | undefined;
}) {
  return (
    <ErrorBoundaryInner key={resetKey ?? "root"} fullScreen={fullScreen}>
      {children}
    </ErrorBoundaryInner>
  );
}
