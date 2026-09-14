import { createHash } from "node:crypto";
import { REPOSITORY, PROTOCOL_VERSION } from "../packages/distribution/src/index";
import { manifestSchema } from "../packages/distribution/src/updates";
const version = process.env.LOOM_VERSION || (await Bun.file("version.json").json()).version;
const artifacts: Record<string, { url: string; sha256: string; size: number }> = {};
const sums: string[] = [];
for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"]) {
  const name = `loom-${platform}${platform.startsWith("windows") ? ".exe" : ""}`;
  const bytes = await Bun.file(`dist/${name}`).arrayBuffer();
  const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  artifacts[platform] = { url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`, sha256, size: bytes.byteLength };
  sums.push(`${sha256}  ${name}`);
}
const manifest = manifestSchema.parse({ version, protocolVersion: PROTOCOL_VERSION, releasedAt: new Date().toISOString(), artifacts });
await Bun.write("dist/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
await Bun.write("dist/SHA256SUMS", `${sums.join("\n")}\n`);
await Bun.write("dist/version.txt", `${version}\n`);
