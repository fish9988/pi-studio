// Pi 关于页 CLI 状态卡（about）：展示 @earendil-works/pi-coding-agent 版本、解析路径、就绪状态点与检查/更新动作。
import { useState } from "react";
import { Restart } from "../../../icons.tsx";
import { useOmpStatus } from "../../../store/index.ts";
import { Badge, Button } from "../../../ui/controls.tsx";
import { reportError } from "../../../ui/errors.ts";
import { pushToast } from "../../dialogs/toast-store.ts";
import { piBridge } from "./pi-bridge.ts";
import { usePiText } from "./pi-shared.tsx";

export function PiCliCard() {
  const { tr, t } = usePiText();
  const status = useOmpStatus();
  const [busy, setBusy] = useState(false);
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [output, setOutput] = useState("");

  const ready = status?.state === "ready" ? status : null;
  const isError = status?.state === "missing" || status?.state === "error" || status?.state === "unusable";
  const latestNewVersion = availableVersion ?? ready?.availableVersion ?? null;

  const checkOrUpgrade = async () => {
    setBusy(true);
    try {
      if (latestNewVersion !== null) {
        const res = await piBridge().upgradePathOmp();
        setOutput(res.output.trim());
        if (res.exitCode === 0) {
          setAvailableVersion(null);
          pushToast({ level: "info", message: tr("Pi CLI 已完成更新", "Pi CLI updated") });
        }
        return;
      }
      const checked = await piBridge().checkOmpUpdate();
      if (checked.availableVersion) {
        setAvailableVersion(checked.availableVersion);
        pushToast({
          level: "info",
          message: tr(`发现新版本 ${checked.availableVersion}`, `Update available: ${checked.availableVersion}`),
        });
      } else {
        pushToast({
          level: "info",
          message: tr("当前已是最新版本", "Pi CLI is up to date"),
        });
      }
    } catch (error) {
      reportError(t, error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pis-cli-card" data-testid="pi-cli-card">
      <div className="pis-cli-head">
        <div className="pis-cli-title">
          <span
            className="pis-cli-dot"
            data-ready={ready !== null || undefined}
            data-error={isError || undefined}
            aria-hidden="true"
          />
          <span className="pis-mono">@earendil-works/pi-coding-agent</span>
          {ready !== null ? (
            <Badge tone="success" testId="pi-cli-version">
              v{ready.version}
            </Badge>
          ) : (
            <Badge tone={isError ? "error" : "neutral"}>
              {isError ? tr("未找到 CLI", "CLI missing") : tr("检测中…", "Detecting…")}
            </Badge>
          )}
          {latestNewVersion !== null && (
            <Badge tone="accent" testId="pi-cli-available">
              {tr(`可升级至 v${latestNewVersion}`, `v${latestNewVersion} available`)}
            </Badge>
          )}
        </div>

        <Button
          size="sm"
          icon={<Restart size={14} />}
          loading={busy}
          disabled={ready === null}
          onClick={() => void checkOrUpgrade()}
          testId="pi-cli-action"
        >
          {latestNewVersion !== null ? tr("立即更新 Pi", "Update Pi") : tr("检查 / 更新 Pi", "Check / Update Pi")}
        </Button>
      </div>

      {ready !== null && (
        <div className="pis-cli-path" title={ready.path} data-testid="pi-cli-path">
          {ready.path}
        </div>
      )}

      {output !== "" && (
        <pre className="pis-cli-output" data-testid="pi-cli-output">
          {output}
        </pre>
      )}
    </div>
  );
}
