import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformKey, redact, VERSION } from "../src/index";
import {
	assertArtifactUrl,
	checkForUpdate,
	downloadUpdate,
	isNewer,
	type Manifest,
	type ReleaseFetcher,
} from "../src/updates";

const bytes = new TextEncoder().encode("verified executable fixture");
const manifest: Manifest = {
	version: "1.2.3",
	protocolVersion: 1,
	releasedAt: "2026-09-13T00:00:00.000Z",
	artifacts: {
		"linux-x64": {
			url: "https://github.com/guen-efanunji/loom/releases/download/v1.2.3/loom-linux-x64",
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.length,
		},
	},
};
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
	expect(() =>
		assertArtifactUrl(
			manifest.artifacts["linux-x64"]?.url || "",
			"1.2.3",
			"linux-x64",
		),
	).not.toThrow();
	for (const url of [
		"http://github.com/guen-efanunji/loom/releases/download/v1.2.3/loom-linux-x64",
		"https://evil.example/loom",
		"https://github.com/other/loom/releases/download/v1.2.3/loom-linux-x64",
		`${manifest.artifacts["linux-x64"]?.url}?redirect=evil`,
	])
		expect(() => assertArtifactUrl(url, "1.2.3", "linux-x64")).toThrow();
});
test("update checks are cached and a network failure stays nonblocking", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-update-"));
	let calls = 0;
	const fetcher: ReleaseFetcher = async () => {
		calls++;
		return Response.json(manifest);
	};
	try {
		expect(
			(await checkForUpdate("stable", { directory, fetcher, now: 100000000 }))
				.available,
		).toBe(true);
		await checkForUpdate("stable", { directory, fetcher, now: 100000100 });
		expect(calls).toBe(1);
		const failed = await checkForUpdate("stable", {
			directory,
			force: true,
			fetcher: async () => {
				throw new Error("offline");
			},
			now: 100000200,
		});
		expect(failed.error).toBe("offline");
		expect(failed.latest?.version).toBe("1.2.3");
		await checkForUpdate("stable", { directory, fetcher, now: 100000300 });
		expect(calls).toBe(1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("downloads verify size and checksum and remove corrupt files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-download-"));
	try {
		const progress: Array<[number, number]> = [];
		const path = await downloadUpdate(manifest, {
			directory,
			platform: "linux-x64",
			fetcher: async () => new Response(bytes),
			onProgress: (downloaded, total) => progress.push([downloaded, total]),
		});
		expect(await Bun.file(path).text()).toBe("verified executable fixture");
		expect(progress.at(-1)).toEqual([bytes.length, bytes.length]);
		await rm(path);
		await expect(
			downloadUpdate(manifest, {
				directory,
				platform: "linux-x64",
				fetcher: async () => new Response("tampered"),
			}),
		).rejects.toThrow("mismatch");
		expect(await readdir(join(directory, "cache"))).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("a slow link completes and a stalled connection is cancelled", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-download-slow-"));
	const pieces = [
		bytes.slice(0, 7),
		bytes.slice(7, 14),
		bytes.slice(14, 20),
		bytes.slice(20),
	];
	const trickle = async (gapMs: number) =>
		new Response(
			new ReadableStream<Uint8Array>({
				async start(output) {
					for (const piece of pieces) {
						await new Promise((resolve) => setTimeout(resolve, gapMs));
						output.enqueue(piece);
					}
					output.close();
				},
			}),
		);
	try {
		// Four chunks of 120ms take 480ms in total, longer than the 300ms window,
		// yet every chunk lands inside it: progress must reset the watchdog.
		const path = await downloadUpdate(manifest, {
			directory,
			platform: "linux-x64",
			fetcher: async () => trickle(120),
			stallTimeoutMs: 300,
		});
		expect(await Bun.file(path).text()).toBe("verified executable fixture");
		await rm(path);
		await expect(
			downloadUpdate(manifest, {
				directory,
				platform: "linux-x64",
				// One chunk arrives and then the connection goes quiet. A real fetch
				// errors the body when its signal aborts, so the stub does too.
				fetcher: async (_url, init) =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(output) {
								for (const piece of pieces.slice(0, 1)) output.enqueue(piece);
								init?.signal?.addEventListener("abort", () =>
									output.error(new Error("aborted")),
								);
							},
						}),
					),
				stallTimeoutMs: 150,
			}),
		).rejects.toThrow("stalled");
		expect(await readdir(join(directory, "cache"))).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 8_000);
test("structured log redaction covers nested credentials and URL query secrets", () => {
	expect(
		redact({
			token: "private",
			nested: { apiKey: "private", message: "Bearer abc.def password=private" },
		}),
	).toEqual({
		token: "[REDACTED]",
		nested: {
			apiKey: "[REDACTED]",
			message: "Bearer [REDACTED] password=[REDACTED]",
		},
	});
});
