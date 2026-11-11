// Pi 网络与高级页（advanced）：传输协议与代理、指数退避重试策略、配置文件直达栏。
import type { PiConfigFileKind } from "../../../../../shared/pi-config-types.ts";
import { External } from "../../../icons.tsx";
import { Button, Row, SectionHead, Segmented, Switch, type Option } from "../../../ui/controls.tsx";
import { reportError } from "../../../ui/errors.ts";
import { piBridge } from "./pi-bridge.ts";
import {
  asBoolean,
  asNumber,
  asString,
  PiNumberCommitField,
  PiTextCommitField,
  usePiSetting,
  usePiText,
} from "./pi-shared.tsx";

type TransportMode = "auto" | "sse" | "websocket" | "websocket-cached";

const asTransport = (raw: unknown, fallback: TransportMode): TransportMode =>
  raw === "auto" || raw === "sse" || raw === "websocket" || raw === "websocket-cached" ? raw : fallback;

const CONFIG_FILES: readonly PiConfigFileKind[] = [
  "settings.json",
  "models.json",
  "mcp.json",
  "keybindings.json",
  "auth.json",
];

export function PiNetworkAdvancedSection() {
  const { tr, t } = usePiText();

  // 1. 传输协议与代理
  const transport = usePiSetting<TransportMode>("transport", "auto", asTransport);
  const httpProxy = usePiSetting("httpProxy", "", asString);
  const httpIdleTimeout = usePiSetting("httpIdleTimeoutMs", 60000, asNumber);
  const wsConnectTimeout = usePiSetting("websocketConnectTimeoutMs", 10000, asNumber);

  // 2. 自动重试策略 (retry.*)
  const retryEnabled = usePiSetting("retry.enabled", true, asBoolean);
  const maxRetries = usePiSetting("retry.maxRetries", 3, asNumber);
  const baseDelayMs = usePiSetting("retry.baseDelayMs", 2000, asNumber);
  const maxAgentDelayMs = usePiSetting("retry.maxAgentDelayMs", 60000, asNumber);
  const providerTimeoutMs = usePiSetting("retry.provider.timeoutMs", 300000, asNumber);

  const transportOptions: readonly Option<TransportMode>[] = [
    { value: "auto", label: "auto" },
    { value: "sse", label: "sse" },
    { value: "websocket", label: "websocket" },
    { value: "websocket-cached", label: "ws-cached" },
  ];

  const openFile = (kind: PiConfigFileKind) => {
    void piBridge()
      .openPiConfigFile(kind)
      .catch((error: unknown) => reportError(t, error));
  };

  return (
    <div className="pis-stack" data-testid="pi-advanced-section">
      {/* 1. 传输协议与代理 */}
      <section className="pis-group">
        <SectionHead title={tr("传输协议与代理", "Transport & HTTP proxy")} />
        <div className="pis-card pis-card-rows">
          <Row
            label={tr("流式传输协议", "Streaming transport")}
            modified={transport.modified}
            reset={{ tip: "auto", onReset: () => void transport.reset() }}
            testId="pi-transport-row"
          >
            {(labelId) => (
              <Segmented
                size="sm"
                mono
                value={transport.value}
                options={transportOptions}
                labelledBy={labelId}
                onChange={(next) => void transport.save(next)}
                testId="pi-transport"
              />
            )}
          </Row>

          <Row
            label={tr("HTTP 代理地址", "HTTP proxy URL")}
            modified={httpProxy.modified}
            reset={{ tip: tr("空（读取环境变量）", "Empty (use ENV)"), onReset: () => void httpProxy.reset() }}
            testId="pi-http-proxy-row"
          >
            {(labelId) => (
              <PiTextCommitField
                mono
                width={260}
                value={httpProxy.value}
                placeholder="http://127.0.0.1:7890"
                labelledBy={labelId}
                onCommit={(next) => void httpProxy.save(next)}
                testId="pi-http-proxy"
              />
            )}
          </Row>

          <Row
            label={tr("HTTP 空闲超时", "HTTP idle timeout")}
            modified={httpIdleTimeout.modified}
            reset={{ tip: "60000 ms", onReset: () => void httpIdleTimeout.reset() }}
            testId="pi-http-idle-row"
          >
            {(labelId) => (
              <PiNumberCommitField
                value={httpIdleTimeout.value}
                min={1000}
                max={3600000}
                unit="ms"
                labelledBy={labelId}
                onCommit={(next) => void httpIdleTimeout.save(next)}
                testId="pi-http-idle"
              />
            )}
          </Row>

          <Row
            label={tr("WebSocket 握手超时", "WebSocket connect timeout")}
            modified={wsConnectTimeout.modified}
            reset={{ tip: "10000 ms", onReset: () => void wsConnectTimeout.reset() }}
            testId="pi-ws-timeout-row"
          >
            {(labelId) => (
              <PiNumberCommitField
                value={wsConnectTimeout.value}
                min={1000}
                max={300000}
                unit="ms"
                labelledBy={labelId}
                onCommit={(next) => void wsConnectTimeout.save(next)}
                testId="pi-ws-timeout"
              />
            )}
          </Row>
        </div>
      </section>

      {/* 2. 自动重试策略 */}
      <section className="pis-group">
        <SectionHead title={tr("自动重试策略", "Retry & backoff policy")} />
        <div className="pis-card pis-card-rows">
          <Row
            label={tr("启用请求失败自动重试", "Enable automatic retry")}
            modified={retryEnabled.modified}
            reset={{ tip: "true", onReset: () => void retryEnabled.reset() }}
            testId="pi-retry-enabled-row"
          >
            {(labelId) => (
              <Switch
                checked={retryEnabled.value}
                labelledBy={labelId}
                onChange={(next) => void retryEnabled.save(next)}
                testId="pi-retry-enabled"
              />
            )}
          </Row>

          <Row
            label={tr("最大重试次数", "Max retries")}
            modified={maxRetries.modified}
            reset={{ tip: "3", onReset: () => void maxRetries.reset() }}
            testId="pi-retry-max-row"
          >
            {(labelId) => (
              <PiNumberCommitField
                value={maxRetries.value}
                min={0}
                max={20}
                width={96}
                labelledBy={labelId}
                onCommit={(next) => void maxRetries.save(next)}
                testId="pi-retry-max"
              />
            )}
          </Row>

          <Row
            label={tr("初始退避延迟", "Base backoff delay")}
            modified={baseDelayMs.modified}
            reset={{ tip: "2000 ms", onReset: () => void baseDelayMs.reset() }}
            testId="pi-retry-base-row"
          >
            {(labelId) => (
              <PiNumberCommitField
                value={baseDelayMs.value}
                min={100}
                max={120000}
                unit="ms"
                labelledBy={labelId}
                onCommit={(next) => void baseDelayMs.save(next)}
                testId="pi-retry-base"
              />
            )}
          </Row>

          <Row
            label={tr("单次退避上限", "Max backoff delay")}
            modified={maxAgentDelayMs.modified}
            reset={{ tip: "60000 ms", onReset: () => void maxAgentDelayMs.reset() }}
            testId="pi-retry-max-delay-row"
          >
            {(labelId) => (
              <PiNumberCommitField
                value={maxAgentDelayMs.value}
                min={1000}
                max={600000}
                unit="ms"
                labelledBy={labelId}
                onCommit={(next) => void maxAgentDelayMs.save(next)}
                testId="pi-retry-max-delay"
              />
            )}
          </Row>

          <Row
            label={tr("Provider 总请求超时", "Provider request timeout")}
            modified={providerTimeoutMs.modified}
            reset={{ tip: "300000 ms", onReset: () => void providerTimeoutMs.reset() }}
            testId="pi-retry-provider-timeout-row"
          >
            {(labelId) => (
              <PiNumberCommitField
                value={providerTimeoutMs.value}
                min={5000}
                max={3600000}
                unit="ms"
                labelledBy={labelId}
                onCommit={(next) => void providerTimeoutMs.save(next)}
                testId="pi-retry-provider-timeout"
              />
            )}
          </Row>
        </div>
      </section>

      {/* 3. 配置文件直达栏 */}
      <section className="pis-group">
        <SectionHead title={tr("配置文件直达 (~/.pi/agent/)", "Quick open config files (~/.pi/agent/)")} />
        <div className="pis-card-padded">
          <div className="pis-file-bar" data-testid="pi-config-file-bar">
            {CONFIG_FILES.map((file) => (
              <Button
                key={file}
                size="sm"
                icon={<External size={14} />}
                onClick={() => openFile(file)}
                testId={`pi-open-file-${file}`}
              >
                {file}
              </Button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
