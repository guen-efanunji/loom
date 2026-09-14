import { spawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory, PROTOCOL_VERSION, readSettings } from "@loom/distribution";

export function executableArgs(args: string[]) {
  return /(?:^|[\\/])bun(?:\.exe)?$/.test(process.execPath) ? [process.argv[1] || "", ...args] : args;
}
export async function localUrl() { return `http://127.0.0.1:${process.env.LOOM_PORT || (await readSettings()).port}`; }
export async function health() {
  try {
    const response = await fetch(`${await localUrl()}/health`, { signal: AbortSignal.timeout(1000) });
    const value = await response.json() as { product?: string; status?: string; version?: string; protocolVersion?: number };
    return response.ok && value.product === "loom" && value.status === "ok" ? value : null;
  } catch { return null; }
}
export async function control(path: string, method = "GET") {
  const settings = await readSettings();
  const response = await fetch(`${await localUrl()}${path}`, { method, headers: { Authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
export async function waitHealthy(version?: string, timeout = 20000, protocolVersion = PROTOCOL_VERSION) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await health();
    if (state && (!version || state.version === version) && state.protocolVersion === protocolVersion) return true;
    await Bun.sleep(200);
  }
  return false;
}
export async function launch(executable = process.execPath, args = executableArgs(["--daemon"])) {
  const directory = join(dataDirectory(), "logs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(join(directory, "daemon.log"), "a", 0o600);
  const child = spawn(executable, args, { detached: true, stdio: ["ignore", file.fd, file.fd], windowsHide: true, env: { ...process.env, LOOM_NO_BROWSER: "1", LOOM_DAEMON: "false" } });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  await file.close();
  child.unref();
  return child.pid;
}
export async function stop() {
  if (!await health()) return;
  await control("/api/daemon/stop", "POST");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (!await health()) return; await Bun.sleep(200); }
  throw new Error("Daemon did not stop; no executable was replaced");
}
export async function openBrowser() {
  if (process.env.LOOM_NO_BROWSER === "1") return;
  const url = await localUrl();
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const child = spawn(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], { detached: true, stdio: "ignore" });
  child.on("error", () => console.log(`Open ${url} in your browser.`));
  child.unref();
}
