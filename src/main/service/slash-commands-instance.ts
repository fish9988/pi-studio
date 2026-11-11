// 斜杠命令列表缓存的单例（slash-commands.ts）：通过 `piService().listSlashCommands` 获取项目级或全局命令，
// 并按 `settings.json` / skills / prompts / extensions 指纹缓存。
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { AvailableSlashCommand } from "../../shared/omp-wire/rpc-wire.generated.ts";
import { resolveAgentDir } from "../history/session-index.ts";
import { piService, readyPiVersion } from "../pi/runtime-singleton.ts";
import { pathKey } from "../tasks/task-registry.ts";
import { inputStamp } from "./input-stamp.ts";
import { serviceCwd } from "./service-omp.ts";
import { SlashCommandCache, slashCommandInputs } from "./slash-commands.ts";
import { startupCache } from "./startup-cache-instance.ts";

let instance: SlashCommandCache | null = null;

function cache(): SlashCommandCache {
  instance ??= new SlashCommandCache({
    stamp: async (dir) => {
      const home = os.homedir();
      const configRoot = path.resolve(home, process.env["PI_CONFIG_DIR"] || ".pi");
      return inputStamp(
        `${app.getVersion()}+${await readyPiVersion()}`,
        await slashCommandInputs(dir, resolveAgentDir(), configRoot, home),
      );
    },
    key: pathKey,
    cache: startupCache(),
  });
  return instance;
}

/** `cwd` 是任务目录（含 `.pi/skills`、`.pi/prompts`、`.pi/extensions`）；null = 草稿页（中性目录）。 */
export async function listSlashCommands(cwd: string | null): Promise<AvailableSlashCommand[]> {
  if (cwd !== null) return cache().list(cwd, () => piService().listSlashCommands(cwd));
  const neutral = await serviceCwd();
  return cache().list(neutral, () => piService().listSlashCommands());
}

export function rememberSlashCommands(dir: string, commands: AvailableSlashCommand[]): Promise<void> {
  return cache().remember(dir, commands);
}
