// Main-process singletons for `PiManager` (CLI discovery & status events) and `PiService`
// (background `pi --mode rpc --no-session` catalog/default-model/slash-command queries).
import { emitEvent } from "../ipc/events.ts";
import { registerShutdownHook } from "../window/shutdown.ts";
import { PiManager, type PiInstall, type PiLaunch } from "./discover.ts";
import { PiService } from "./pi-service.ts";

let managerInstance: PiManager | null = null;
let serviceInstance: PiService | null = null;

export function piManager(): PiManager {
  managerInstance ??= new PiManager((status) => emitEvent("ompStatus", status));
  return managerInstance;
}

export function readyPi(): Promise<PiInstall> {
  return piManager().ensureReady();
}

export async function readyPiLaunch(): Promise<PiLaunch> {
  return (await piManager().ensureReady()).launch;
}

export async function readyPiVersion(): Promise<string> {
  return (await piManager().ensureReady()).version;
}

export function piService(): PiService {
  serviceInstance ??= new PiService(readyPiLaunch);
  return serviceInstance;
}

registerShutdownHook(async () => {
  if (serviceInstance !== null) {
    await serviceInstance.close();
  }
});
