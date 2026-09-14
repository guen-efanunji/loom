import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicJson, dataDirectory, log, platformKey, readSettings, releaseChannelSchema, saveSettings } from "@loom/distribution";
import { checkForUpdate, downloadUpdate, manifestSchema } from "@loom/distribution/updates";
import { control, health, launch, stop, waitHealthy } from "./process";

export async function prepareUpdate(channelValue?: string) {
  const directory = dataDirectory();
  const settings = await readSettings();
  const channel = releaseChannelSchema.parse(channelValue ?? settings.releaseChannel);
  const target = join(directory, "bin", process.platform === "win32" ? "loom.exe" : "loom");
  if (await realpath(process.execPath) !== await realpath(target).catch(() => "")) throw new Error("Updates require the installed standalone Loom executable. Use the installer first.");
  const status = await checkForUpdate(channel, { force: true });
  if (status.error) throw new Error(status.error);
  if (!status.available || !status.latest) return { updating: false, version: status.current };
  const lock = join(directory, "cache", "update.lock");
  await mkdir(lock).catch(() => { throw new Error("Another update is in progress. See loom doctor if a previous update was interrupted."); });
  let staged: string | undefined;
  try {
    if (await health()) await control("/api/updates/ready");
    staged = await downloadUpdate(status.latest);
    const helper = join(lock, process.platform === "win32" ? "helper.exe" : "helper");
    await copyFile(process.execPath, helper);
    await chmod(helper, 0o700);
    await atomicJson(join(lock, "job.json"), { staged, target, manifest: status.latest, channel });
    await launch(helper, ["--apply-update"]);
    return { updating: true, version: status.latest.version };
  } catch (error) {
    if (staged) await rm(staged, { force: true });
    await rm(lock, { recursive: true, force: true });
    throw error;
  }
}

/** Runs the trusted current executable from a separate path; no release scripts. */
export async function applyUpdate() {
  const directory = dataDirectory();
  const lock = join(directory, "cache", "update.lock");
  const job = JSON.parse(await readFile(join(lock, "job.json"), "utf8"));
  const manifest = manifestSchema.parse(job.manifest);
  const channel = releaseChannelSchema.parse(job.channel);
  const target = join(directory, "bin", process.platform === "win32" ? "loom.exe" : "loom");
  if (resolve(job.target) !== resolve(target) || !/^update-[a-f0-9-]+(?:\.exe)?$/.test(String(job.staged).split(/[\\/]/).at(-1) || "") || resolve(job.staged, "..") !== resolve(directory, "cache")) throw new Error("Invalid update job paths");
  const artifact = manifest.artifacts[platformKey()];
  const bytes = await readFile(job.staged);
  if (!artifact || bytes.length !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Staged update changed after verification");
  const backup = `${target}.previous`;
  const next = `${target}.next`;
  let preserved = false;
  let replaced = false;
  let launched: number | undefined;
  let databaseBackedUp = false;
  const database = join(directory, "state.db");
  try {
    if (await health()) await control("/api/updates/ready");
    let previousPid: number | undefined;
    try { previousPid = JSON.parse(await readFile(join(directory, "daemon.json"), "utf8")).pid; } catch {}
    await stop();
    if (previousPid) {
      const deadline = Date.now() + 30000;
      let alive = true;
      while (alive && Date.now() < deadline) { try { process.kill(previousPid, 0); await Bun.sleep(200); } catch { alive = false; } }
      if (alive) throw new Error("Previous daemon still owns its executable");
    }
    await copyFile(database, join(lock, "state.db.backup")).then(() => { databaseBackedUp = true; }).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await copyFile(job.staged, next);
    await chmod(next, 0o700);
    await rm(backup, { force: true });
    await rename(target, backup);
    preserved = true;
    await rename(next, target);
    replaced = true;
    launched = await launch(target, ["--daemon"]);
    if (!await waitHealthy(manifest.version, 30000, manifest.protocolVersion)) throw new Error("New daemon failed its health check");
    await saveSettings({ ...await readSettings(), releaseChannel: channel });
    await atomicJson(join(directory, "cache", "update-result.json"), { status: "completed", version: manifest.version, at: new Date().toISOString() });
    log("updater", "completed", { version: manifest.version });
  } catch (error) {
    if (preserved) {
      if (launched) {
        try { process.kill(launched, "SIGTERM"); } catch {}
        for (let i = 0; i < 100; i++) { try { process.kill(launched, 0); } catch { break; } await Bun.sleep(100); }
      }
      if (replaced) await rm(target, { force: true });
      await rename(backup, target);
      if (databaseBackedUp) {
        await rm(`${database}-wal`, { force: true });
        await rm(`${database}-shm`, { force: true });
        await copyFile(join(lock, "state.db.backup"), database);
      }
      await launch(target, ["--daemon"]);
      log("updater", "rolled_back", { recovered: await waitHealthy() }, "error");
    }
    await atomicJson(join(directory, "cache", "update-result.json"), { status: "failed", error: error instanceof Error ? error.message : "Update failed", rolledBack: preserved, at: new Date().toISOString() });
    throw error;
  } finally {
    await rm(job.staged, { force: true });
    await rm(next, { force: true });
    if (process.platform === "win32") await rename(lock, `${lock}.finished-${Date.now()}`);
    else await rm(lock, { recursive: true, force: true });
  }
}
