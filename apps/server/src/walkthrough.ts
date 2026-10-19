import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type WalkthroughEvidence = {
	id: string;
	file: string;
	status: string;
	kind: "diff" | "untracked";
	patch: string;
	truncated?: boolean;
};

export type WalkthroughSnapshot = {
	scope: "uncommitted";
	fingerprint: string;
	capturedAt: string;
	files: WalkthroughEvidence[];
	coverage: {
		truncated: boolean;
		excludedFiles: number;
		omittedFiles: number;
		message?: string;
	};
};

const MAX_FILES = 100;
const MAX_FILE_BYTES = 150 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_COMMAND_BYTES = 250 * 1024;
const excludedComponents = new Set([
	".git",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"coverage",
	".svelte-kit",
	".next",
	".cache",
	".turbo",
	".vercel",
	".expo",
]);

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		const remaining = Math.max(0, limit - size);
		if (value.byteLength > remaining) truncated = true;
		if (remaining > 0) {
			const part = value.subarray(0, remaining);
			chunks.push(part);
			size += part.byteLength;
		}
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

async function runGit(root: string, args: string[], timeoutMs = 5000) {
	const child = Bun.spawn(["git", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeout = setTimeout(() => child.kill(), timeoutMs);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			readBounded(child.stdout, MAX_COMMAND_BYTES).then((result) => {
				if (result.truncated) child.kill();
				return result;
			}),
			readBounded(child.stderr, 4000),
		]);
		return {
			exitCode,
			stdout: stdout.text,
			stderr: stderr.text,
			truncated: stdout.truncated,
		};
	} finally {
		clearTimeout(timeout);
	}
}

function excluded(path: string) {
	const parts = path.split(/[\\/]/).filter(Boolean);
	const base = parts.at(-1)?.toLowerCase() ?? "";
	return (
		parts.some((part) => excludedComponents.has(part.toLowerCase())) ||
		/^\.env(?:\.|$)/i.test(base) ||
		[".npmrc", ".pypirc", ".netrc"].includes(base) ||
		/\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(base) ||
		/(?:^|\.)credentials?(?:\.|$)/i.test(base) ||
		/(?:secret|token|password|private[-_]?key|credential|api[-_]?key|service[-_]?account|^id_(?:rsa|ed25519))/i.test(
			base,
		)
	);
}

function redactSecrets(value: string) {
	return value
		.replace(
			/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\b\s*[:=]\s*["']?)[^\s"'`,;]+/gi,
			"$1[redacted]",
		)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
		.replace(
			/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
			"[redacted]",
		);
}

function parseStatus(value: string) {
	const fields = value.split("\0");
	const files: Array<{ path: string; status: string }> = [];
	for (let index = 0; index < fields.length; index += 1) {
		const entry = fields[index];
		if (!entry) continue;
		const status = entry.slice(0, 2).trim() || "?";
		let path = entry.slice(3);
		const renamePath = fields[index + 1];
		if (/[RC]/.test(entry.slice(0, 2)) && renamePath !== undefined) {
			path = renamePath;
			index += 1;
		}
		files.push({ path, status });
	}
	return files;
}

function withinRoot(root: string, path: string) {
	const rel = relative(root, path);
	return (
		rel === "" ||
		(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
	);
}

async function readUntracked(root: string, path: string) {
	const absolutePath = resolve(root, path);
	if (!withinRoot(root, absolutePath)) throw new Error("Unsafe untracked path");
	const details = await lstat(absolutePath);
	if (!details.isFile() || details.isSymbolicLink())
		return {
			patch: "[Not included: path is not a regular file.]",
			truncated: false,
		};
	if (details.size > MAX_FILE_BYTES)
		return {
			patch: "[Not included: file exceeds the 150 KiB limit.]",
			truncated: true,
		};
	const canonical = await realpath(absolutePath);
	if (!withinRoot(root, canonical)) throw new Error("Unsafe untracked path");
	const body = await readFile(canonical);
	if (body.includes(0))
		return {
			patch: "[Not included: binary file contents are not inspected.]",
			truncated: false,
		};
	return { patch: body.toString("utf8"), truncated: false };
}

async function stableStats(root: string, files: Array<{ path: string }>) {
	return Promise.all(
		files.map(async ({ path }) => {
			try {
				const value = await lstat(resolve(root, path));
				return `${path}\0${value.size}\0${value.mtimeMs}\0${value.mode}`;
			} catch {
				return `${path}\0missing`;
			}
		}),
	);
}

async function captureOnce(
	rootPath: string,
): Promise<WalkthroughSnapshot & { stable: boolean }> {
	const root = await realpath(rootPath);
	const before = await runGit(root, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
	]);
	if (before.truncated)
		throw new Error(
			"INPUT_TOO_LARGE: The working tree has too many changed paths to capture safely.",
		);
	if (before.exitCode !== 0)
		throw new Error(before.stderr.trim() || "Unable to read Git working tree");
	const rawFiles = parseStatus(before.stdout);
	const excludedFiles = rawFiles.filter((file) => excluded(file.path)).length;
	const eligible = rawFiles.filter((file) => !excluded(file.path));
	const limited = eligible.slice(0, MAX_FILES);
	const omittedFiles = Math.max(0, eligible.length - limited.length);
	const beforeStats = await stableStats(root, limited);
	const head = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
	const hasHead = head.exitCode === 0 && !!head.stdout.trim();
	let cursor = 0;
	let totalBytes = 0;
	let truncated = omittedFiles > 0 || before.truncated;
	const collected: WalkthroughEvidence[] = [];
	const workers = Array.from(
		{ length: Math.min(4, limited.length) },
		async () => {
			while (cursor < limited.length) {
				const index = cursor++;
				const item = limited[index];
				if (!item) continue;
				let patch: string;
				let fileTruncated = false;
				let kind: WalkthroughEvidence["kind"] = "diff";
				if (item.status.startsWith("?") || !hasHead) {
					kind = "untracked";
					try {
						const content = await readUntracked(root, item.path);
						patch = content.patch;
						fileTruncated = content.truncated;
					} catch {
						patch =
							"[Not included: file changed or failed the workspace boundary check during capture.]";
					}
				} else {
					const diff = await runGit(root, [
						"--no-pager",
						"diff",
						"--no-ext-diff",
						"--no-textconv",
						"--no-color",
						"--unified=4",
						"HEAD",
						"--",
						item.path,
					]);
					patch =
						diff.stdout ||
						`[No text diff available for status ${item.status}.]`;
					fileTruncated = diff.truncated;
				}
				patch = redactSecrets(patch);
				const remaining = Math.max(0, MAX_TOTAL_BYTES - totalBytes);
				const bytes = Buffer.byteLength(patch);
				if (bytes > remaining) {
					patch = Buffer.from(patch).subarray(0, remaining).toString("utf8");
					fileTruncated = true;
				}
				totalBytes += Buffer.byteLength(patch);
				if (fileTruncated) truncated = true;
				collected[index] = {
					id: `ev-${String(index + 1).padStart(4, "0")}`,
					file: item.path,
					status: item.status,
					kind,
					patch,
					...(fileTruncated ? { truncated: true } : {}),
				};
			}
		},
	);
	await Promise.all(workers);
	const after = await runGit(root, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
	]);
	const afterStats = await stableStats(root, limited);
	const evidence = collected.filter(Boolean);
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ status: before.stdout, evidence }))
		.digest("hex");
	return {
		scope: "uncommitted",
		fingerprint,
		capturedAt: new Date().toISOString(),
		files: evidence,
		coverage: {
			truncated,
			excludedFiles,
			omittedFiles,
			...(!hasHead
				? {
						message:
							"This repository has no HEAD commit; eligible working files are shown as added content.",
					}
				: {}),
		},
		stable:
			before.stdout === after.stdout &&
			JSON.stringify(beforeStats) === JSON.stringify(afterStats),
	};
}

export async function collectWalkthroughSnapshot(root: string) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const snapshot = await captureOnce(root);
		if (snapshot.stable) {
			const { stable: _stable, ...result } = snapshot;
			return result;
		}
	}
	throw new Error(
		"SNAPSHOT_UNSTABLE: Files changed while capturing this walkthrough. Retry after the working tree settles.",
	);
}
