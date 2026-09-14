import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platformKey } from "../packages/distribution/src/index";
const platform = platformKey();
const binary = resolve(`dist/loom-${platform}${platform.startsWith("windows") ? ".exe" : ""}`);
const directory = await mkdtemp(join(tmpdir(), "loom-smoke-"));
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = portProbe.port;
portProbe.stop(true);
let runtime: ReturnType<typeof Bun.serve> | undefined;
// CI has no provider credentials. This tests daemon packaging against only the runtime health contract.
try { runtime = Bun.serve({ hostname: "127.0.0.1", port: 4096, fetch: () => Response.json({ healthy: true, version: "smoke" }) }); } catch { /* Reuse an existing developer OpenCode server. */ }
const child = Bun.spawn([binary, "--daemon"], { cwd: directory, env: { ...process.env, PATH: "", LOOM_HOME: directory, LOOM_PORT: String(port), LOOM_NO_BROWSER: "1", LOOM_DAEMON: "false", CORS_ORIGIN: `http://127.0.0.1:${port}` }, stdout: "pipe", stderr: "pipe" });
const url = `http://127.0.0.1:${port}`;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
try {
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(`${url}/health`); const data = await response.json() as { product: string }; if (response.ok && data.product === "loom") { healthy = true; break; } } catch {}
    await Bun.sleep(100);
  }
  assert(healthy, "Standalone daemon did not start");
  const response = await fetch(url, { headers: { Accept: "text/html" } });
  const html = await response.text();
  assert(response.ok && html.includes("_app/immutable"), "Static UI was not embedded");
  assert((await fetch(`${url}/api/projects`)).status === 401, "Unauthenticated API is accessible");
  assert((await fetch(`${url}/api/bootstrap`, { method: "POST", headers: { Origin: "https://untrusted.example" } })).status === 403, "Foreign Origin accepted");
  assert((await fetch(`${url}/health`, { headers: { Host: "untrusted.example" } })).status === 403, "Foreign Host accepted");
  const tokenResponse = await fetch(`${url}/api/bootstrap`, { method: "POST", headers: { Origin: url } });
  const { token } = await tokenResponse.json() as { token: string };
  assert(token?.length >= 32, "Same-origin browser cannot bootstrap");
  const headers = { Authorization: `Bearer ${token}` };
  assert((await fetch(`${url}/api/projects`, { headers })).ok, "Authenticated API failed");
  assert((await fetch(`${url}/epic/example?session=example`, { headers: { Accept: "text/html" } })).ok, "Deep-link fallback missing");
  await fetch(`${url}/api/daemon/stop`, { method: "POST", headers });
  assert(await child.exited === 0, "Daemon did not stop cleanly");
  console.log(`PASS ${platform}: standalone startup without PATH/runtime, embedded UI, deep links, auth, origin, host, and shutdown`);
} catch (error) {
  child.kill();
  console.error(await new Response(child.stderr).text());
  throw error;
} finally { child.kill(); runtime?.stop(true); await rm(directory, { recursive: true, force: true }); }
