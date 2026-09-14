import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformKey, redact, VERSION } from "./index";
import { assertArtifactUrl, checkForUpdate, downloadUpdate, isNewer, type Manifest, type ReleaseFetcher } from "./updates";
const bytes = new TextEncoder().encode("verified executable fixture");
const manifest: Manifest = { version: "1.2.3", protocolVersion: 1, releasedAt: "2026-09-13T00:00:00.000Z", artifacts: { "linux-x64": { url: "https://github.com/MrPinguiiin/loom/releases/download/v1.2.3/loom-linux-x64", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } } };
test("platform and semver comparisons keep stable and beta ordered", () => {
  expect(platformKey("win32", "x64")).toBe("windows-x64");
  expect(() => platformKey("linux", "ia32")).toThrow("Unsupported");
  expect(isNewer("1.2.3", "1.2.3-beta.9")).toBe(true);
  expect(isNewer("1.2.3-beta.2", "1.2.3")).toBe(false);
  expect(isNewer("1.2.3-beta.10", "1.2.3-beta.9")).toBe(true);
  expect(isNewer("1.2.3", "2.0.0")).toBe(false);
  expect(isNewer("garbage", VERSION)).toBe(false);
});
test("release artifacts cannot escape the official repository or version", () => {
  expect(() => assertArtifactUrl(manifest.artifacts["linux-x64"]?.url || "", "1.2.3", "linux-x64")).not.toThrow();
  for (const url of ["http://github.com/MrPinguiiin/loom/releases/download/v1.2.3/loom-linux-x64", "https://evil.example/loom", "https://github.com/other/loom/releases/download/v1.2.3/loom-linux-x64", `${manifest.artifacts["linux-x64"]?.url}?redirect=evil`]) expect(() => assertArtifactUrl(url, "1.2.3", "linux-x64")).toThrow();
});
test("update checks are cached and a network failure stays nonblocking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loom-update-"));
  let calls = 0;
  const fetcher: ReleaseFetcher = async () => { calls++; return Response.json(manifest); };
  try {
    expect((await checkForUpdate("stable", { directory, fetcher, now: 100000000 })).available).toBe(true);
    await checkForUpdate("stable", { directory, fetcher, now: 100000100 });
    expect(calls).toBe(1);
    const failed = await checkForUpdate("stable", { directory, force: true, fetcher: async () => { throw new Error("offline"); }, now: 100000200 });
    expect(failed.error).toBe("offline");
    expect(failed.latest?.version).toBe("1.2.3");
    await checkForUpdate("stable", { directory, fetcher, now: 100000300 });
    expect(calls).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("downloads verify size and checksum and remove corrupt files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loom-download-"));
  try {
    const path = await downloadUpdate(manifest, { directory, platform: "linux-x64", fetcher: async () => new Response(bytes) });
    expect(await Bun.file(path).text()).toBe("verified executable fixture");
    await rm(path);
    await expect(downloadUpdate(manifest, { directory, platform: "linux-x64", fetcher: async () => new Response("tampered") })).rejects.toThrow("mismatch");
    expect(await readdir(join(directory, "cache"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("structured log redaction covers nested credentials and URL query secrets", () => {
  expect(redact({ token: "private", nested: { apiKey: "private", message: "Bearer abc.def password=private" } })).toEqual({ token: "[REDACTED]", nested: { apiKey: "[REDACTED]", message: "Bearer [REDACTED] password=[REDACTED]" } });
});
