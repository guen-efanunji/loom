import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	PROTOCOL_VERSION,
	platformKey,
	REPOSITORY,
	VERSION,
} from "../packages/distribution/src/index";
import {
	checkForUpdate,
	downloadUpdate,
	type Manifest,
} from "../packages/distribution/src/updates";

// Exercises the update check, download, and verification path against a local
// fixture manifest. The real network and daemon are never touched.
const platform = platformKey();
const suffix = platform.startsWith("windows") ? ".exe" : "";
const binary = resolve(`dist/loom-${platform}${suffix}`);
const bytes = Buffer.from(await Bun.file(binary).arrayBuffer());
if (!bytes.length)
	throw new Error(
		`Missing release artifact: ${binary}. Run scripts/build-release.ts first.`,
	);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const version = "9.9.9";
const manifest: Manifest = {
	version,
	protocolVersion: PROTOCOL_VERSION,
	releasedAt: new Date().toISOString(),
	artifacts: {
		[platform]: {
			url: `https://github.com/${REPOSITORY}/releases/download/v${version}/loom-${platform}${suffix}`,
			sha256,
			size: bytes.length,
		},
	},
};
function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
const directory = await mkdtemp(join(tmpdir(), "loom-smoke-update-"));
try {
	const newer = await checkForUpdate("stable", {
		force: true,
		directory,
		fetcher: async () => Response.json(manifest),
	});
	assert(!newer.error, `Update check failed: ${newer.error}`);
	assert(
		newer.available && newer.latest?.version === version,
		"Newer test release was not detected",
	);
	const current = await checkForUpdate("stable", {
		force: true,
		directory: await mkdtemp(join(tmpdir(), "loom-smoke-update-")),
		fetcher: async () => Response.json({ ...manifest, version: VERSION }),
	});
	assert(!current.available, "Current version was reported as an update");
	const staged = await downloadUpdate(manifest, {
		directory,
		platform,
		fetcher: async () => new Response(bytes),
	});
	const stagedBytes = await readFile(staged);
	assert(stagedBytes.length === bytes.length, "Staged artifact size changed");
	await rm(staged);
	let tampered = false;
	try {
		await downloadUpdate(manifest, {
			directory,
			platform,
			fetcher: async () => new Response(Buffer.from(`${bytes}tampered`)),
		});
	} catch {
		tampered = true;
	}
	assert(tampered, "Tampered download was accepted");
	let rejected = false;
	try {
		await downloadUpdate(
			{
				...manifest,
				artifacts: {
					[platform]: {
						...manifest.artifacts[platform]!,
						url: "https://example.com/loom.exe",
					},
				},
			},
			{ directory, platform, fetcher: async () => new Response(bytes) },
		);
	} catch {
		rejected = true;
	}
	assert(rejected, "Off-origin artifact URL was accepted");
	console.log(
		`PASS ${platform}: update check, current-version short-circuit, verified download, tamper rejection, origin pinning`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
