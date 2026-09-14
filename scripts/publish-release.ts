import { isNewer, manifestSchema } from "../packages/distribution/src/updates";
import { REPOSITORY } from "../packages/distribution/src/index";
const manifest = manifestSchema.parse(await Bun.file("dist/manifest.json").json());
const tag = `v${manifest.version}`;
if (tag !== process.env.RELEASE_TAG) throw new Error("Release tag mismatch");
const channel = manifest.version.includes("-") ? "beta" : "stable";
async function gh(args: string[], allowFailure = false) {
  const child = Bun.spawn(["gh", ...args, "--repo", REPOSITORY], { stdout: "pipe", stderr: "pipe" });
  const exit = await child.exited;
  const stdout = await new Response(child.stdout).text();
  if (exit && !allowFailure) throw new Error(await new Response(child.stderr).text());
  return { exit, stdout };
}
const exists = await gh(["release", "view", tag], true);
if (exists.exit) await gh(["release", "create", tag, "--verify-tag", "--draft", "--generate-notes", ...(channel === "beta" ? ["--prerelease"] : [])]);
const names = Object.keys(manifest.artifacts).map(platform => `dist/loom-${platform}${platform.startsWith("windows") ? ".exe" : ""}`);
await gh(["release", "upload", tag, ...names, "dist/manifest.json", "dist/SHA256SUMS", "dist/version.txt", "install.sh", "install.ps1", "--clobber"]);
await gh(["release", "edit", tag, "--draft=false", `--prerelease=${channel === "beta"}`, `--latest=${channel === "stable"}`]);
// Publish the small channel pointer only after all five immutable versioned artifacts exist.
let current: string | null = null;
try { const response = await fetch(`https://github.com/${REPOSITORY}/releases/download/channel-${channel}/manifest.json`); if (response.ok) current = manifestSchema.parse(await response.json()).version; } catch {}
if (current && current !== manifest.version && !isNewer(manifest.version, current)) throw new Error("Refusing to move a release channel backwards");
const pointer = `channel-${channel}`;
if ((await gh(["release", "view", pointer], true)).exit) await gh(["release", "create", pointer, "--target", tag, "--prerelease", "--latest=false", "--title", `${channel} release manifest`, "--notes", "Machine-readable release pointer. Download binaries from the linked versioned release."]);
await gh(["release", "upload", pointer, "dist/manifest.json", "dist/SHA256SUMS", "dist/version.txt", "--clobber"]);
