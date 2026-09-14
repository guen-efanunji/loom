import { mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { platformKey } from "../packages/distribution/src/index";

const platform = process.argv[2] || platformKey();
if (!["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"].includes(platform)) throw new Error("Unsupported release platform");
const version = process.env.LOOM_VERSION || (await Bun.file("version.json").json()).version;
if (!/^\d+\.\d+\.\d+(-beta\.\d+)?$/.test(version)) throw new Error("Invalid release version");
const assets: Record<string, { body: string; type: string }> = {};
const root = resolve("apps/web/build");
async function collect(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) {
      const file = Bun.file(path);
      assets[`/${relative(root, path).replaceAll("\\", "/")}`] = { body: Buffer.from(await file.arrayBuffer()).toString("base64"), type: file.type || "application/octet-stream" };
    }
  }
}
await collect(root);
if (!assets["/index.html"]) throw new Error("Build the static web application first: bun run --cwd apps/web build");
await mkdir("dist", { recursive: true });
const outfile = `dist/loom-${platform}${platform.startsWith("windows") ? ".exe" : ""}`;
const result = await Bun.build({
  entrypoints: ["apps/cli/src/index.ts"],
  compile: { target: `bun-${platform}` as "bun-linux-x64", outfile, autoloadDotenv: false, autoloadBunfig: false },
  minify: true,
  define: { LOOM_BUILD_VERSION: JSON.stringify(version), LOOM_STATIC_ASSETS: JSON.stringify(assets) },
});
if (!result.success) throw new AggregateError(result.logs, "Compilation failed");
console.log(`Built ${outfile} (v${version}), embedding ${Object.keys(assets).length} assets`);
