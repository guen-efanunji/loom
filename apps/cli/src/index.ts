import { spawn } from "node:child_process";
import { access, open, readFile, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { discoverExecutable } from "@loom/opencode";
import { atomicJson, dataDirectory, log, platformKey, readSettings, VERSION } from "@loom/distribution";
import { checkForUpdate } from "@loom/distribution/updates";
import { health, launch, localUrl, openBrowser, stop, waitHealthy } from "./process";
import { staticAssets } from "./assets";
import { applyUpdate, prepareUpdate } from "./update";
export { VERSION };

async function doctor() {
  const settings = await readSettings();
  const directory = dataDirectory();
  let failures = 0;
  const check = async (name: string, fn: () => Promise<string>) => {
    try { console.log(`✓ ${name}: ${await fn()}`); } catch (error) { failures++; console.log(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  await check("Platform", async () => platformKey());
  await check("Git", async () => { const command = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" }); if (await command.exited !== 0) throw new Error("Install Git and add it to PATH"); return (await new Response(command.stdout).text()).trim(); });
  await check("OpenCode", async () => { const path = await discoverExecutable(); if (!path) throw new Error("Install OpenCode and configure a provider, or set OPENCODE_BIN"); return path; });
  await check("Filesystem", async () => { await access(directory, constants.W_OK); const file = await open(join(directory, ".doctor-write"), "w", 0o600); await file.close(); await rm(join(directory, ".doctor-write")); if (process.platform !== "win32" && ((await stat(directory)).mode & 0o077)) throw new Error(`Run chmod 700 ${directory}`); return directory; });
  await check("Database", async () => { const path = join(directory, "state.db"); try { await access(path); } catch { return "Created on first start"; } const database = new Database(path, { readonly: true }); try { const result = database.query("PRAGMA quick_check").get() as { quick_check: string }; if (result.quick_check !== "ok") throw new Error(result.quick_check); return "healthy"; } finally { database.close(); } });
  await check("Daemon port", async () => { if (await health()) return `${await localUrl()} is healthy`; const server = Bun.serve({ port: Number(process.env.LOOM_PORT || settings.port), hostname: "127.0.0.1", fetch: () => new Response() }); server.stop(true); return "free; run loom to start"; });
  await check("Worktrees", async () => { const path = join(directory, "state.db"); try { await access(path); } catch { return "No workspaces yet"; } const database = new Database(path, { readonly: true }); try { const rows = database.query("SELECT path FROM workspaces").all() as { path: string }[]; let missing = 0; for (const row of rows) await access(row.path).catch(() => { missing++; }); if (missing) throw new Error(`${missing} registered workspaces are missing; inspect the affected tasks before cleanup`); return `${rows.length} registered workspaces accessible`; } finally { database.close(); } });
  await check("Updater", async () => { try { await access(join(directory, "cache", "update.lock")); throw new Error("Update lock exists; check logs before removing a stale lock"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } if (!settings.updateChecks) return `v${VERSION}; automatic checks disabled`; const status = await checkForUpdate(settings.releaseChannel); return `v${VERSION} (${settings.releaseChannel}); ${status.error || (status.available ? `${status.latest?.version} available` : "up to date")}`; });
  return failures ? 1 : 0;
}

async function serve() {
  const { createApp, bunWebSocket } = await import("../../server/src/index");
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log("daemon", "stopping");
    server.stop(true);
    await daemon.close();
    await rm(join(dataDirectory(), "daemon.json"), { force: true });
    process.exit(0);
  };
  const daemon = await createApp({ staticAssets, onShutdown: () => { void shutdown(); }, update: prepareUpdate });
  const server = Bun.serve({ hostname: "127.0.0.1", port: daemon.config.port, fetch: daemon.app.fetch, websocket: bunWebSocket });
  await atomicJson(join(dataDirectory(), "daemon.json"), { pid: process.pid, version: VERSION, port: daemon.config.port });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  log("daemon", "started", { version: VERSION, port: daemon.config.port });
  const settings = await readSettings();
  if (settings.updateChecks) void checkForUpdate(settings.releaseChannel);
  setInterval(() => { void readSettings().then(async s => { if (s.updateChecks) await checkForUpdate(s.releaseChannel); }).catch(() => {}); }, 6 * 3600_000).unref();
}
async function start() {
  console.log(`Loom v${VERSION}`);
  platformKey();
  await readSettings();
  if (!await health()) {
    if (!Bun.which("git")) throw new Error("Git is missing. Install Git, then run loom doctor.");
    console.log("✓ Git");
    if (!await discoverExecutable()) throw new Error("OpenCode is missing. Install OpenCode, configure your provider, then run loom doctor.");
    console.log("✓ OpenCode");
    await launch();
    if (!await waitHealthy()) throw new Error("Daemon did not start. Run loom logs and loom doctor.");
  }
  console.log(`✓ Local database\n✓ Agent daemon\nOpening ${await localUrl()}`);
  await openBrowser();
}
async function uninstall(args: string[]) {
  const directory = dataDirectory();
  if (!args.includes("--yes")) {
    console.log(`Remove ${join(directory, "bin")} with: loom uninstall --yes\nApp state, logs, branches, and worktrees are retained in ${directory}.\nAdd --logs to remove logs. Review and discard worktrees in Loom before manually removing app state.`);
    return;
  }
  await stop();
  const binary = join(directory, "bin", process.platform === "win32" ? "loom.exe" : "loom");
  if (process.platform === "win32") {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 2; Remove-Item -LiteralPath $env:LOOM_UNINSTALL_BINARY -Force -ErrorAction SilentlyContinue"], { detached: true, stdio: "ignore", env: { ...process.env, LOOM_UNINSTALL_BINARY: binary } });
    child.unref();
  } else await rm(binary, { force: true });
  await rm(`${binary}.previous`, { force: true });
  if (args.includes("--logs")) await rm(join(directory, "logs"), { recursive: true, force: true });
  console.log(`Loom uninstalled. Your state and worktrees remain in ${directory}. Remove the Loom PATH entry from your shell profile if desired.`);
}
const help = `Loom — local workspace for OpenCode\n\nUsage: loom [command]\n  start             Start daemon and open UI (default)\n  stop              Stop daemon\n  restart           Stop and start daemon\n  open              Open local UI\n  update [--channel stable|beta]  Verify, update and restart\n  doctor            Check requirements, data and daemon health\n  logs              Show last 100 daemon log lines\n  config            Show configuration without secrets\n  uninstall [--yes] [--logs]     Remove binary; keep state/worktrees\n  --version         Print version\n  help              Show help`;
export async function main(args = process.argv.slice(2)) {
  switch (args[0]) {
    case "--version": case "-v": console.log(`loom ${VERSION}`); return 0;
    case "help": case "--help": case "-h": console.log(help); return 0;
    case "doctor": return doctor();
    case "--daemon": await serve(); return 0;
    case "--apply-update": await applyUpdate(); return 0;
    case "stop": await stop(); console.log("Loom stopped."); return 0;
    case "restart": await stop(); await start(); return 0;
    case "open": await openBrowser(); return 0;
    case "update": { const i = args.indexOf("--channel"); if (i >= 0 && !args[i + 1]) throw new Error("--channel requires stable or beta"); const result = await prepareUpdate(i >= 0 ? args[i + 1] : undefined); console.log(result.updating ? `Installing ${result.version}; Loom will restart. Run loom logs to follow progress.` : `Loom ${result.version} is up to date.`); return 0; }
    case "logs": { try { const text = await readFile(join(dataDirectory(), "logs", "daemon.log"), "utf8"); console.log(text.trimEnd().split("\n").slice(-100).join("\n")); } catch { console.log("No daemon logs yet."); } return 0; }
    case "config": { const { token: _, ...settings } = await readSettings(); console.log(JSON.stringify({ ...settings, directory: dataDirectory() }, null, 2)); return 0; }
    case "uninstall": await uninstall(args); return 0;
    case undefined: case "start": await start(); return 0;
    default: console.error(help); return 1;
  }
}
if (import.meta.main) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
