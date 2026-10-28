import { createHash } from "node:crypto";
import {
	PROTOCOL_VERSION,
	REPOSITORY,
} from "../packages/distribution/src/index";
import { manifestSchema } from "../packages/distribution/src/updates";

const version =
	process.env.LOOM_VERSION || (await Bun.file("version.json").json()).version;
const artifacts: Record<string, { url: string; sha256: string; size: number }> =
	{};
const sums: string[] = [];
for (const platform of [
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
	"windows-x64",
]) {
	const name = `loom-${platform}${platform.startsWith("windows") ? ".exe" : ""}`;
	const file = Bun.file(`dist/${name}`);
	// A release publishes whatever the build matrix produced, so a target that
	// is still being prepared is reported instead of breaking the manifest.
	if (!(await file.exists())) {
		console.log(`skip ${platform}: no artifact in this release`);
		continue;
	}
	const bytes = await file.arrayBuffer();
	const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
	artifacts[platform] = {
		url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`,
		sha256,
		size: bytes.byteLength,
	};
	sums.push(`${sha256}  ${name}`);
}
if (!Object.keys(artifacts).length)
	throw new Error("No release artifacts were built for this tag");
const manifest = manifestSchema.parse({
	version,
	protocolVersion: PROTOCOL_VERSION,
	releasedAt: new Date().toISOString(),
	artifacts,
});
await Bun.write("dist/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
await Bun.write("dist/SHA256SUMS", `${sums.join("\n")}\n`);
await Bun.write("dist/version.txt", `${version}\n`);
console.log(
	`Published manifest for v${version}: ${Object.keys(artifacts).join(", ")}`,
);
