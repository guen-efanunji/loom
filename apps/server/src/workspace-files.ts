import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export type WorkspaceFileEntry = {
	name: string;
	path: string;
	type: "file" | "directory";
};

export class WorkspaceFileError extends Error {
	constructor(
		readonly code:
			| "NOT_FOUND"
			| "ALREADY_EXISTS"
			| "INVALID_NAME"
			| "FORBIDDEN"
			| "OUTSIDE_WORKSPACE"
			| "READ_ONLY_CONTEXT"
			| "FILE_TOO_LARGE"
			| "UNSUPPORTED_BINARY"
			| "STALE_CONTEXT"
			| "STALE_REVISION"
			| "WORKSPACE_BUSY",
		message: string,
	) {
		super(message);
		this.name = "WorkspaceFileError";
	}
}

const maxPreviewBytes = 512 * 1024;
const maxDirectoryEntries = 300;
const generatedDirectories = new Set([
	".git",
	".next",
	".svelte-kit",
	".turbo",
	".cache",
	"coverage",
	"dist",
	"build",
	"node_modules",
	"vendor",
]);
const sensitiveNames = new Set([
	".npmrc",
	".pypirc",
	"credentials",
	"credentials.json",
	"id_rsa",
	"id_ed25519",
]);

function isSensitiveName(name: string) {
	const lower = name.toLowerCase();
	return (
		sensitiveNames.has(lower) ||
		lower === ".env" ||
		lower.startsWith(".env.") ||
		lower.startsWith("id_rsa.") ||
		lower.startsWith("id_ed25519.") ||
		/\.(?:pem|key|p12|pfx|keystore|secret)$/i.test(lower)
	);
}

function pathParts(value: string, allowRoot = false) {
	if (allowRoot && value === "") return [];
	if (
		!value ||
		value.includes("\0") ||
		value.includes("\\") ||
		value.startsWith("/") ||
		/^[a-z]:/i.test(value)
	)
		throw new WorkspaceFileError(
			"OUTSIDE_WORKSPACE",
			"Invalid workspace path.",
		);
	const parts = value.split("/");
	if (parts.some((part) => !part || part === "." || part === ".."))
		throw new WorkspaceFileError(
			"OUTSIDE_WORKSPACE",
			"Invalid workspace path.",
		);
	return parts;
}

async function resolveInside(
	root: string,
	relativePath: string,
	allowMissing = false,
) {
	const base = await realpath(root);
	const parts = pathParts(relativePath, true);
	let current = base;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (!part) continue;
		current = join(current, part);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink())
				throw new WorkspaceFileError(
					"OUTSIDE_WORKSPACE",
					"Symbolic links are not available in the workspace preview.",
				);
			if (index < parts.length - 1 && !info.isDirectory())
				throw new WorkspaceFileError(
					"NOT_FOUND",
					"Parent directory not found.",
				);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				if (allowMissing && index === parts.length - 1) break;
				throw new WorkspaceFileError("NOT_FOUND", "Workspace entry not found.");
			}
			throw error;
		}
	}
	const local = relative(base, current);
	if (
		local === ".." ||
		local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
	)
		throw new WorkspaceFileError(
			"OUTSIDE_WORKSPACE",
			"Path is outside the workspace.",
		);
	return { base, path: current, parts };
}

async function ignoredPaths(root: string, paths: string[]) {
	if (!paths.length) return new Set<string>();
	const child = Bun.spawn(["git", "check-ignore", "-z", "--stdin"], {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	child.stdin.write(`${paths.join("\0")}\0`);
	child.stdin.end();
	const output = await new Response(child.stdout).text();
	const exitCode = await child.exited;
	if (exitCode !== 0 && exitCode !== 1)
		throw new WorkspaceFileError(
			"FORBIDDEN",
			"Unable to apply the repository ignore rules.",
		);
	return new Set(output.split("\0").filter(Boolean));
}

export async function listWorkspaceDirectory(root: string, directory: string) {
	const resolved = await resolveInside(root, directory);
	const info = await lstat(resolved.path);
	if (!info.isDirectory())
		throw new WorkspaceFileError("NOT_FOUND", "Directory not found.");
	const items = await readdir(resolved.path, { withFileTypes: true });
	const candidates = items
		.filter((item) => !item.isSymbolicLink())
		.filter((item) => !generatedDirectories.has(item.name))
		.filter((item) => !isSensitiveName(item.name))
		.filter((item) => item.isDirectory() || item.isFile())
		.map((item) => ({
			name: item.name,
			path: directory ? `${directory}/${item.name}` : item.name,
			type: item.isDirectory() ? ("directory" as const) : ("file" as const),
		}));
	const ignored = await ignoredPaths(
		resolved.base,
		candidates.map((item) => item.path),
	);
	const visible = candidates
		.filter((item) => !ignored.has(item.path))
		.sort(
			(a, b) =>
				Number(b.type === "directory") - Number(a.type === "directory") ||
				a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
	return {
		directory,
		entries: visible.slice(0, maxDirectoryEntries),
		truncated: visible.length > maxDirectoryEntries,
	};
}

/** Search visible workspace entries without following symlinks or entering ignored paths. */
export async function searchWorkspaceEntries(root: string, query: string) {
	const needle = query.trim().toLocaleLowerCase();
	const pending = [""];
	const matches: WorkspaceFileEntry[] = [];
	let visited = 0;
	while (pending.length && visited < 500 && matches.length < 100) {
		const directory = pending.shift();
		if (directory === undefined) break;
		visited += 1;
		const result = await listWorkspaceDirectory(root, directory);
		for (const entry of result.entries) {
			if (entry.type === "directory" && pending.length < 500)
				pending.push(entry.path);
			if (!needle || entry.path.toLocaleLowerCase().includes(needle))
				matches.push(entry);
			if (matches.length >= 100) break;
		}
	}
	return matches.map((entry) => ({
		...entry,
		path: entry.type === "directory" ? `${entry.path}/` : entry.path,
	}));
}

export async function readWorkspaceFile(root: string, relativePath: string) {
	const { path, parts } = await resolveInside(root, relativePath);
	if (
		parts.some(
			(part) => isSensitiveName(part) || generatedDirectories.has(part),
		)
	)
		throw new WorkspaceFileError(
			"FORBIDDEN",
			"This file is hidden for safety.",
		);
	const ignored = await ignoredPaths(root, [relativePath]);
	if (ignored.has(relativePath))
		throw new WorkspaceFileError("NOT_FOUND", "Workspace entry not found.");
	const noFollow = constants.O_NOFOLLOW ?? 0;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | noFollow);
		const info = await handle.stat();
		if (!info.isFile())
			throw new WorkspaceFileError("NOT_FOUND", "File not found.");
		if (info.size > maxPreviewBytes)
			throw new WorkspaceFileError(
				"FILE_TOO_LARGE",
				`File exceeds the ${maxPreviewBytes / 1024} KiB preview limit.`,
			);
		const data = await handle.readFile();
		if (data.includes(0))
			return {
				path: relativePath,
				content: null,
				binary: true,
				complete: false,
				byteSize: data.byteLength,
				revision: createHash("sha256").update(data).digest("hex"),
			};
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(data);
		} catch {
			return {
				path: relativePath,
				content: null,
				binary: true,
				complete: false,
				byteSize: data.byteLength,
				revision: createHash("sha256").update(data).digest("hex"),
			};
		}
		return {
			path: relativePath,
			content,
			binary: false,
			complete: true,
			byteSize: data.byteLength,
			revision: createHash("sha256").update(data).digest("hex"),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP")
			throw new WorkspaceFileError(
				"OUTSIDE_WORKSPACE",
				"Symbolic links are not previewed.",
			);
		throw error;
	} finally {
		await handle?.close();
	}
}

export async function writeWorkspaceFile(
	root: string,
	relativePath: string,
	content: string,
	expectedRevision: string,
) {
	const data = Buffer.from(content, "utf8");
	if (data.byteLength > maxPreviewBytes)
		throw new WorkspaceFileError(
			"FILE_TOO_LARGE",
			`File exceeds the ${maxPreviewBytes / 1024} KiB edit limit.`,
		);
	if (!/^[a-f0-9]{64}$/i.test(expectedRevision))
		throw new WorkspaceFileError(
			"STALE_REVISION",
			"The file revision is missing. Refresh the file before saving.",
		);
	const { path, parts } = await resolveInside(root, relativePath);
	if (
		parts.some(
			(part) => isSensitiveName(part) || generatedDirectories.has(part),
		)
	)
		throw new WorkspaceFileError(
			"FORBIDDEN",
			"This file is hidden for safety.",
		);
	const ignored = await ignoredPaths(root, [relativePath]);
	if (ignored.has(relativePath))
		throw new WorkspaceFileError("NOT_FOUND", "Workspace entry not found.");
	let tempPath: string | undefined;
	let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const current = await readWorkspaceFile(root, relativePath);
		if (current.binary || current.content === null)
			throw new WorkspaceFileError(
				"UNSUPPORTED_BINARY",
				"Binary files cannot be edited in the preview.",
			);
		if (current.revision !== expectedRevision)
			throw new WorkspaceFileError(
				"STALE_REVISION",
				"This file changed on disk. Reload it before saving your edits.",
			);
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink())
			throw new WorkspaceFileError("NOT_FOUND", "File not found.");
		if ((info.mode & 0o222) === 0)
			throw new WorkspaceFileError("FORBIDDEN", "This file is read-only.");
		tempPath = join(dirname(path), `.loom-preview-${randomUUID()}.tmp`);
		tempHandle = await open(
			tempPath,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				(constants.O_NOFOLLOW ?? 0),
			info.mode & 0o777,
		);
		let offset = 0;
		while (offset < data.byteLength) {
			const { bytesWritten } = await tempHandle.write(
				data,
				offset,
				data.byteLength - offset,
			);
			if (!bytesWritten)
				throw new WorkspaceFileError(
					"FORBIDDEN",
					"The file could not be fully written.",
				);
			offset += bytesWritten;
		}
		await tempHandle.sync();
		await tempHandle.close();
		tempHandle = undefined;
		const latest = await readWorkspaceFile(root, relativePath);
		if (latest.revision !== expectedRevision)
			throw new WorkspaceFileError(
				"STALE_REVISION",
				"This file changed while it was being saved. Reload it before saving again.",
			);
		await rename(tempPath, path);
		tempPath = undefined;
		return {
			path: relativePath,
			byteSize: data.byteLength,
			revision: createHash("sha256").update(data).digest("hex"),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP")
			throw new WorkspaceFileError(
				"OUTSIDE_WORKSPACE",
				"Symbolic links are not edited in the workspace preview.",
			);
		throw error;
	} finally {
		await tempHandle?.close();
		if (tempPath) await unlink(tempPath).catch(() => {});
	}
}

export function validateWorkspaceEntryName(name: string) {
	if (
		!name.trim() ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		/[. ]$/.test(name) ||
		/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
	)
		throw new WorkspaceFileError(
			"INVALID_NAME",
			"Enter one valid file or folder name.",
		);
	if (isSensitiveName(name) || generatedDirectories.has(name))
		throw new WorkspaceFileError(
			"FORBIDDEN",
			"This name is reserved or hidden for safety.",
		);
	return name;
}

export async function createWorkspaceFile(
	root: string,
	parent: string,
	name: string,
) {
	const safeName = validateWorkspaceEntryName(name);
	const parentPath = await resolveInside(root, parent);
	const parentInfo = await lstat(parentPath.path);
	if (!parentInfo.isDirectory())
		throw new WorkspaceFileError("NOT_FOUND", "Parent directory not found.");
	const path = join(parentPath.path, safeName);
	try {
		const handle = await open(
			path,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				(constants.O_NOFOLLOW ?? 0),
			0o666,
		);
		await handle.close();
	} catch (error) {
		if (
			["EEXIST", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
		)
			throw new WorkspaceFileError(
				"ALREADY_EXISTS",
				"An entry with this name already exists.",
			);
		throw error;
	}
	return {
		path: parent ? `${parent}/${safeName}` : safeName,
		type: "file" as const,
	};
}

export async function createWorkspaceDirectory(
	root: string,
	parent: string,
	name: string,
) {
	const safeName = validateWorkspaceEntryName(name);
	const parentPath = await resolveInside(root, parent);
	const parentInfo = await lstat(parentPath.path);
	if (!parentInfo.isDirectory())
		throw new WorkspaceFileError("NOT_FOUND", "Parent directory not found.");
	const path = join(parentPath.path, safeName);
	try {
		await mkdir(path, { recursive: false });
	} catch (error) {
		if (
			["EEXIST", "ENOTEMPTY"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)
		)
			throw new WorkspaceFileError(
				"ALREADY_EXISTS",
				"An entry with this name already exists.",
			);
		throw error;
	}
	return {
		path: parent ? `${parent}/${safeName}` : safeName,
		type: "directory" as const,
	};
}
