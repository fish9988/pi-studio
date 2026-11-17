// 更新服务的 Electron 接线：electron-updater 的 autoUpdater、更新源解析、把状态推给界面、安装前跑退出流程。
// 更新源：STUDIO_UPDATE_URL（本地测试 / 临时切换，http(s) 地址或本机目录）优先，否则用打包时写入的
// resources/app-update.yml（electron-builder.yml 的 publish：本仓库的 GitHub Releases），两个都没有就不检查。
// 本机目录由 local-feed.ts 在 127.0.0.1 上提供，目录不存在时按未配置处理。开发版（没打包）一律不检查。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import type { AppUpdater } from "electron-updater";
import type { UpdateState } from "../../shared/ipc.ts";
import { emitEvent } from "../ipc/events.ts";
import { log } from "../log/log.ts";
import { writeFileAtomic } from "../tasks/atomic-write.ts";
import { finishShutdown } from "../window/shutdown.ts";
import { localFeedDir, serveFeedDir } from "./local-feed.ts";
import { UpdateService, type Updater } from "./service.ts";

const execFileAsync = promisify(execFile);
const GITHUB_REPO = "fish9988/pi-studio";

// electron-updater 是 CJS，主进程打出来是 ESM；Node 的具名导出探测认不出 autoUpdater
// （实测 import { autoUpdater } 会让应用启动即崩），所以用 require 拿。
const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as { autoUpdater: AppUpdater };

let service: UpdateService | undefined;
let latest: UpdateState = {
  currentVersion: app.getVersion(),
  latestVersion: null,
  phase: "idle",
  percent: 0,
  lastCheckedAt: null,
  error: null,
  disabledReason: null,
};

/** 设置页随时可能读到；服务启动前返回初始状态。 */
export function getUpdateState(): UpdateState {
  return latest;
}

/**
 * 准备更新源，返回是否可以检查更新。
 * STUDIO_UPDATE_URL 写成 userData/app-update.yml（generic）再指过去：本机目录要换成回环地址；
 * electron-updater 还要从配置里读 updaterCacheDirName（下载缓存目录），只给地址时检查能过、开始下载时 ENOENT。
 * 没有覆盖时 electron-updater 自己读 resources/app-update.yml（electron-builder 写的，带 updaterCacheDirName）。
 */
let ghFeedDir: string | null = null;

/** 安装包文件名：`pi-studio-<版本>-setup.exe(.blockmap)`。 */
const FEED_ASSET_RE = /^pi-studio-(.+?)-setup\.exe(\.blockmap)?$/i;

/** 文件的 sha512（base64）是否等于 `latest.yml` 里写的那个；读不了也算不等。 */
async function fileSha512Matches(file: string, expected: string): Promise<boolean> {
  try {
    const hash = createHash("sha512");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file);
      stream.on("error", reject);
      hash.on("error", reject);
      hash.on("finish", () => resolve());
      stream.pipe(hash);
    });
    return hash.digest("base64") === expected;
  } catch {
    return false;
  }
}

/**
 * 针对私有或公开 GitHub 仓库（fish9988/pi-studio）：
 * 若本机已登录 `gh` CLI，通过 `gh release view` / `gh release download` 将最新 Release 的 `latest.yml`
 * （以及存在新版本时的安装包）同步到本地 `gh-release-feed` 目录，使私有仓库无需暴露硬编码 Token 即可完成自动检查与更新下载。
 */
async function syncGithubReleaseFeedIfAvailable(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["release", "view", "--repo", GITHUB_REPO, "--json", "tagName,assets"],
      { timeout: 10_000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout) as {
      tagName?: string;
      assets?: { name?: string }[];
    };
    const tag = typeof parsed.tagName === "string" ? parsed.tagName.trim() : "";
    if (!tag) return null;
    const latestVer = tag.replace(/^v/i, "");
    const feedDir = path.join(app.getPath("userData"), "gh-release-feed");
    await mkdir(feedDir, { recursive: true });

    const assetNames = (parsed.assets ?? []).map((a) => (typeof a?.name === "string" ? a.name : "")).filter(Boolean);
    const hasLatestYml = assetNames.includes("latest.yml");
    if (!hasLatestYml) return null;

    await execFileAsync(
      "gh",
      ["release", "download", tag, "--repo", GITHUB_REPO, "--pattern", "latest.yml", "--dir", feedDir, "--clobber"],
      { timeout: 15_000, windowsHide: true },
    );

    // `gh release download` 可能只落了半个包（网络中断）：这种文件进了 feed 目录就会永远校验失败——
    // 因为下面的循环只补“文件不存在”的，不重新下已有文件。所以按 latest.yml 的 size/sha512 校验，对不上就重下。
    const latestText = await readFile(path.join(feedDir, "latest.yml"), "utf8").catch(() => "");
    const expectedPath = /^\s*path:\s*(\S+)\s*$/m.exec(latestText)?.[1] ?? null;
    const expectedSha = /^\s*sha512:\s*(\S+)\s*$/m.exec(latestText)?.[1] ?? null;
    const expectedSize = (() => {
      const match = /^\s*size:\s*(\d+)\s*$/m.exec(latestText);
      return match === null ? null : Number(match[1]);
    })();

    if (latestVer !== app.getVersion()) {
      for (const assetName of assetNames) {
        if (FEED_ASSET_RE.test(assetName) === false) continue;
        const targetFile = path.join(feedDir, assetName);
        const checkSha = expectedPath !== null && assetName === expectedPath && expectedSha !== null;
        const checkSize = checkSha && expectedSize !== null;
        const intact = async (): Promise<boolean> => {
          if (!existsSync(targetFile)) return false;
          if (checkSize && statSync(targetFile).size !== expectedSize) return false;
          return checkSha && expectedSha !== null ? fileSha512Matches(targetFile, expectedSha) : true;
        };
        if (await intact()) continue;

        // --clobber 会重下整份文件；先清掉半包的残留，失败时也不会把它当“已下载”留下来。
        await rm(targetFile, { force: true });
        await execFileAsync(
          "gh",
          ["release", "download", tag, "--repo", GITHUB_REPO, "--pattern", assetName, "--dir", feedDir, "--clobber"],
          { timeout: 180_000, windowsHide: true },
        );
        if (await intact()) continue;
        await rm(targetFile, { force: true });
        log.warn(`update feed: ${assetName} from ${tag} does not match latest.yml; updates stay off`);
        return null;
      }
    }

    // 旧版本的安装包留着只会占盘（每个 ~120MB），顺手清掉。
    for (const name of await readdir(feedDir)) {
      const version = FEED_ASSET_RE.exec(name)?.[1];
      if (version !== undefined && version !== latestVer) await rm(path.join(feedDir, name), { force: true });
    }
    return feedDir;
  } catch {
    return null;
  }
}

async function configureFeed(): Promise<boolean> {
  const override = process.env["STUDIO_UPDATE_URL"];
  if (override === undefined || override === "") {
    const syncedDir = await syncGithubReleaseFeedIfAvailable();
    if (syncedDir !== null) {
      ghFeedDir = syncedDir;
      const feedUrl = (await serveFeedDir(syncedDir)).url;
      autoUpdater.disableDifferentialDownload = true;
      const written = path.join(app.getPath("userData"), "app-update.yml");
      await writeFileAtomic(
        written,
        `provider: generic\nurl: ${JSON.stringify(feedUrl)}\nupdaterCacheDirName: pi-studio-updater\n`,
        String(process.pid),
      );
      autoUpdater.updateConfigPath = written;
      log.info(`update feed: synced GitHub release via gh CLI at ${feedUrl}`);
      return true;
    }
    return existsSync(path.join(process.resourcesPath, "app-update.yml"));
  }
  let feedUrl = override;
  const dir = localFeedDir(override);
  if (dir !== null) {
    if (!existsSync(dir)) {
      log.info(`update feed: local directory ${dir} does not exist; updates off`);
      return false;
    }
    feedUrl = (await serveFeedDir(dir)).url;
    autoUpdater.disableDifferentialDownload = true;
    log.info(`update feed: local directory ${dir} served at ${feedUrl}`);
  }
  const written = path.join(app.getPath("userData"), "app-update.yml");
  await writeFileAtomic(
    written,
    `provider: generic\nurl: ${JSON.stringify(feedUrl)}\nupdaterCacheDirName: omp-studio-updater\n`,
    String(process.pid),
  );
  autoUpdater.updateConfigPath = written;
  return true;
}

export async function startUpdates(): Promise<void> {
  // mac：不签名（ad-hoc）的应用 Squirrel.Mac 装不了更新，所以不给 autoUpdater 任何更新源，服务处于 disabled（未在 mac 上实测）。
  const macManual = process.platform === "darwin";
  const enabled = app.isPackaged && !macManual && (await configureFeed());

  // electron-updater 的 AppUpdater 是 EventEmitter 子类；Updater 只描述服务用到的部分，测试用假实现。
  const updater = autoUpdater as unknown as Updater;
  service = new UpdateService({
    currentVersion: app.getVersion(),
    enabled,
    disabledReason: macManual ? "manual-only" : app.isPackaged ? "no-feed" : "not-packaged",
    updater,
    emit: (state) => {
      latest = state;
      emitEvent("updateState", state);
    },
    prepareInstall: () => finishShutdown(),
    log: (message) => log.info(message),
  });
  latest = service.state();
  service.start();
}

/** 手动检查（设置页的"检查更新"）。没启用时什么也不做，界面按 getUpdateState 显示原因。 */
export async function checkForUpdate(): Promise<void> {
  if (ghFeedDir !== null && !process.env["STUDIO_UPDATE_URL"]) {
    await syncGithubReleaseFeedIfAvailable();
  }
  await service?.check(true);
}

/** 安装已下载的更新；没有已下载的更新时抛错，界面显示失败原因。 */
export async function installUpdate(): Promise<void> {
  if (service === undefined) throw new Error("update service is not running");
  await service.install();
}
