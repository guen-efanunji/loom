import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
	artifactInputSchema,
	type ProjectContext,
	type TaskArtifact,
} from "@loom/protocol";
import { git } from "./commands";

export async function readProjectFile(
	root: string,
	path: string,
	limit = 8000,
): Promise<string> {
	const base = await realpath(root);
	const file = await realpath(join(base, path));
	const rel = relative(base, file);
	if (!rel || rel.startsWith("..") || isAbsolute(rel))
		throw new Error("Invalid file path outside project");
	const handle = await open(file, "r");
	try {
		if (!(await handle.stat()).isFile())
			throw new Error("Artifact must be a regular file");
		const buffer = Buffer.alloc(limit + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, Math.min(bytesRead, limit)).toString("utf8");
	} finally {
		await handle.close();
	}
}
async function optional(root: string, path: string, limit = 8000) {
	try {
		return await readProjectFile(root, path, limit);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
export async function buildProjectContext(
	project: { id: string; path: string },
	cacheRoot = join(homedir(), ".loom", "projects"),
): Promise<ProjectContext> {
	const tree = (await git(project.path, "ls-files"))
		.split("\n")
		.slice(0, 200)
		.join("\n")
		.slice(0, 9000);
	const branch = await git(project.path, "branch", "--show-current");
	const raw = await optional(project.path, "package.json", 32000);
	const pkg = raw
		? (JSON.parse(raw) as {
				packageManager?: string;
				scripts?: Record<string, string>;
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			})
		: undefined;
	const pm =
		pkg?.packageManager?.split("@")[0] ||
		((await optional(project.path, "bun.lock", 20)) ||
		(await optional(project.path, "bun.lockb", 20))
			? "bun"
			: (await optional(project.path, "pnpm-lock.yaml", 20))
				? "pnpm"
				: (await optional(project.path, "yarn.lock", 20))
					? "yarn"
					: "npm");
	const commands: ProjectContext["commands"] = {};
	if (pkg) {
		commands.install =
			pm === "npm"
				? (await optional(project.path, "package-lock.json", 20))
					? "npm ci"
					: "npm install"
				: `${["bun", "pnpm", "yarn"].includes(pm) ? pm : "npm"} install`;
		for (const name of ["lint", "test", "build"] as const)
			if (pkg.scripts?.[name])
				commands[name] =
					`${["bun", "pnpm", "yarn"].includes(pm) ? pm : "npm"} run ${name}`;
	}
	const context: ProjectContext = {
		summary: [
			`Branch: ${branch}`,
			`Package manager: ${pkg ? pm : "not detected"}`,
			`Dependencies: ${Object.keys({
				...pkg?.dependencies,
				...pkg?.devDependencies,
			})
				.slice(0, 60)
				.join(", ")}`,
			`Tracked files (bounded):\n${tree}`,
			(await optional(project.path, ".loom/context.md", 4000)) ?? "",
		]
			.join("\n")
			.slice(0, 16000),
		architecture: await optional(project.path, ".loom/architecture.md"),
		conventions: await optional(project.path, ".loom/conventions.md"),
		commands,
	};
	const path = join(cacheRoot, project.id);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "context.json"), JSON.stringify(context, null, 2));
	return context;
}
export class ContextBuilder {
	build(input: {
		prompt: string;
		context: ProjectContext;
		dependencies: Array<{ title: string; status: string }>;
		artifacts: TaskArtifact[];
	}): string {
		const handoff = input.artifacts
			.slice(0, 30)
			.map((a) => `[${a.type}] ${a.path}: ${a.summary.slice(0, 1000)}`)
			.join("\n")
			.slice(0, 10000);
		return [
			input.prompt,
			"\nProject context:",
			input.context.summary.slice(0, 6000),
			input.context.architecture?.slice(0, 3000),
			input.context.conventions?.slice(0, 4000),
			`Commands: ${JSON.stringify(input.context.commands)}`,
			`Dependencies completed: ${input.dependencies.map((t) => t.title).join(", ")}`,
			`Handoff artifacts (read these files in this workspace as needed):\n${handoff}`,
			'Work only in this workspace. Do not merge into the project branch. Produce a compact handoff in .loom/artifacts.json: an array of {type:"api-contract"|"schema"|"decision"|"documentation"|"custom",path:"relative/file",summary:"contract or decision"}. Paths must exist. Preserve existing artifacts. Run relevant checks.',
		]
			.filter(Boolean)
			.join("\n\n");
	}
}

export async function collectTaskArtifacts(
	taskId: string,
	workspacePath: string,
): Promise<TaskArtifact[]> {
	let value: unknown;
	try {
		value = JSON.parse(
			await readProjectFile(workspacePath, ".loom/artifacts.json", 64_000),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(
			`Invalid .loom/artifacts.json: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!Array.isArray(value))
		throw new Error(".loom/artifacts.json must contain an array");
	const artifacts: TaskArtifact[] = [];
	for (const [index, item] of value.entries()) {
		const parsed = artifactInputSchema.parse(item);
		await readProjectFile(workspacePath, parsed.path, 1);
		artifacts.push({ id: `${taskId}-${index}`, taskId, ...parsed });
	}
	return artifacts;
}
