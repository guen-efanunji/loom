import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson, dataDirectory, platformKey, REPOSITORY, VERSION, type ReleaseChannel } from "./index";

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta)\.(0|[1-9]\d*))?$/;
export const manifestSchema = z.object({
  version: z.string().regex(semver),
  protocolVersion: z.number().int().positive(),
  releasedAt: z.iso.datetime(),
  artifacts: z.record(z.string(), z.object({ url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(300_000_000) })),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type ReleaseFetcher = (input: string, init?: RequestInit) => Promise<Response>;
export function isNewer(candidate: string, current: string) {
  const a = semver.exec(candidate), b = semver.exec(current);
  if (!a || !b) return false;
  for (const i of [1, 2, 3]) { const delta = Number(a[i]) - Number(b[i]); if (delta) return delta > 0; }
  if (!a[4] && b[4]) return true;
  if (a[4] && !b[4]) return false;
  return Number(a[5] ?? 0) > Number(b[5] ?? 0);
}
export function releaseUrl(channel: ReleaseChannel) {
  return `https://github.com/${REPOSITORY}/releases/download/channel-${channel}/manifest.json`;
}
export function assertArtifactUrl(value: string, version: string, platform: string) {
  const url = new URL(value);
  const name = `loom-${platform}${platform.startsWith("windows-") ? ".exe" : ""}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash || url.pathname !== `/${REPOSITORY}/releases/download/v${version}/${name}`)
    throw new Error("Release artifact must come from the official versioned GitHub release");
}
export type UpdateStatus = { current: string; channel: ReleaseChannel; checkedAt: string | null; latest: Manifest | null; available: boolean; error?: string };
export async function checkForUpdate(channel: ReleaseChannel, options: { force?: boolean; directory?: string; fetcher?: ReleaseFetcher; now?: number } = {}): Promise<UpdateStatus> {
  const directory = options.directory ?? dataDirectory();
  await mkdir(join(directory, "cache"), { recursive: true, mode: 0o700 });
  const path = join(directory, "cache", `update-${channel}.json`);
  const now = options.now ?? Date.now();
  let cached: { lastUpdateCheck: string; latestSeen: string | null; manifest: Manifest | null } | null = null;
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    cached = { lastUpdateCheck: z.iso.datetime().parse(value.lastUpdateCheck), latestSeen: value.latestSeen, manifest: value.manifest ? manifestSchema.parse(value.manifest) : null };
  } catch {}
  const result = (manifest: Manifest | null, checkedAt: string | null, error?: string): UpdateStatus => ({ current: VERSION, channel, checkedAt, latest: manifest, available: !!manifest && isNewer(manifest.version, VERSION), ...(error ? { error } : {}) });
  if (!options.force && cached && now - Date.parse(cached.lastUpdateCheck) >= 0 && now - Date.parse(cached.lastUpdateCheck) < 6 * 3600_000) return result(cached.manifest, cached.lastUpdateCheck);
  try {
    const response = await (options.fetcher ?? fetch)(releaseUrl(channel), { signal: AbortSignal.timeout(4000), headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Release check returned HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 32000) throw new Error("Release manifest is too large");
    const manifest = manifestSchema.parse(JSON.parse(body));
    if (channel === "stable" && manifest.version.includes("-")) throw new Error("Stable channel contains a prerelease");
    for (const [platform, artifact] of Object.entries(manifest.artifacts)) assertArtifactUrl(artifact.url, manifest.version, platform);
    const checkedAt = new Date(now).toISOString();
    await atomicJson(path, { lastUpdateCheck: checkedAt, latestSeen: manifest.version, manifest });
    return result(manifest, checkedAt);
  } catch (error) {
    const checkedAt = new Date(now).toISOString();
    await atomicJson(path, { lastUpdateCheck: checkedAt, latestSeen: cached?.latestSeen ?? null, manifest: cached?.manifest ?? null });
    return result(cached?.manifest ?? null, checkedAt, error instanceof Error ? error.message : "Unable to check releases");
  }
}
export async function downloadUpdate(manifest: Manifest, options: { directory?: string; platform?: string; fetcher?: ReleaseFetcher } = {}) {
  const platform = options.platform ?? platformKey();
  const artifact = manifest.artifacts[platform];
  if (!artifact) throw new Error(`No release artifact for ${platform}`);
  assertArtifactUrl(artifact.url, manifest.version, platform);
  const directory = join(options.directory ?? dataDirectory(), "cache");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `update-${randomUUID()}${platform.startsWith("windows") ? ".exe" : ""}`);
  const file = await open(path, "wx", 0o600);
  try {
    const response = await (options.fetcher ?? fetch)(artifact.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > artifact.size) throw new Error("Artifact exceeds its declared size");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (size !== artifact.size || hash.digest("hex") !== artifact.sha256) throw new Error("Release checksum or size mismatch; nothing was installed");
    await file.sync();
    await file.close();
    await chmod(path, 0o700);
    return path;
  } catch (error) { await file.close().catch(() => {}); await rm(path, { force: true }); throw error; }
}
