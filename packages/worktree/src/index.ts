import { spawn } from "node:child_process";
import {
	access,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export type CommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type CommandRunner = (
	command: string,
	args: readonly string[],
	options?: { cwd?: string },
) => Promise<CommandResult>;

export type RepositoryInfo = {
	path: string;
	defaultBranch: string;
	head: string;
	clean: boolean;
};

export type MergePreflight = RepositoryInfo & { branchExists: boolean };

export type Workspace = {
	id: string;
	taskId: string;
	projectId: string;
	projectPath: string;
	path: string;
	branch: string;
	baseCommit: string;
	createdAt: string;
	runId?: string;
	owner?: "loom";
};

export type WorktreeInput = {
	projectPath: string;
	projectId: string;
	taskId: string;
	runId?: string;
};

export type OrphanWorkspace = {
	path: string;
	branch: string | null;
	reason: "missing_metadata" | "invalid_metadata" | "missing_task";
};

export class WorktreeError extends Error {
	readonly code:
		| "INVALID_PROJECT"
		| "GIT_UNAVAILABLE"
		| "COMMAND_FAILED"
		| "SAFETY_ERROR"
		| "NOT_FOUND";
	readonly details: Record<string, string>;

	constructor(
		code: WorktreeError["code"],
		message: string,
		details: Record<string, string> = {},
	) {
		super(message);
		this.name = "WorktreeError";
		this.code = code;
		this.details = details;
	}
}

export class MergeConflictError extends WorktreeError {
	readonly files: string[];

	constructor(files: string[], message = "Merge conflict detected") {
		super("COMMAND_FAILED", message, { files: files.join("\n") });
		this.name = "MergeConflictError";
		this.files = files;
	}
}

export function createCommandRunner(): CommandRunner {
	return (command, args, options = {}) =>
		new Promise((resolvePromise, reject) => {
			const child = spawn(command, [...args], {
				cwd: options.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", (exitCode) =>
				resolvePromise({ stdout, stderr, exitCode: exitCode ?? 1 }),
			);
		});
}

async function runGit(
	runner: CommandRunner,
	args: readonly string[],
	cwd: string,
): Promise<string> {
	let result: CommandResult;
	try {
		result = await runner("git", args, { cwd });
	} catch (error) {
		throw new WorktreeError(
			"GIT_UNAVAILABLE",
			"Git executable is unavailable",
			{
				reason: error instanceof Error ? error.message : String(error),
			},
		);
	}
	if (result.exitCode !== 0) {
		throw new WorktreeError(
			"COMMAND_FAILED",
			`Git command failed: git ${args.join(" ")}`,
			{
				stderr: result.stderr.trim(),
			},
		);
	}
	return result.stdout.trim();
}

function validateSegment(value: string, label: string): void {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
		value === "." ||
		value === ".."
	) {
		throw new WorktreeError(
			"SAFETY_ERROR",
			`${label} contains unsafe path characters`,
		);
	}
}

export function getWorktreePath(
	projectId: string,
	taskId: string,
	home = homedir(),
	runId?: string,
): string {
	validateSegment(projectId, "Project ID");
	validateSegment(taskId, "Task ID");
	if (runId) validateSegment(runId, "Run ID");
	return resolve(
		home,
		".loom",
		"worktrees",
		projectId,
		taskId,
		...(runId ? [runId] : []),
	);
}

export function getWorktreeBranch(taskId: string, runId?: string): string {
	validateSegment(taskId, "Task ID");
	if (runId) validateSegment(runId, "Run ID");
	return `loom/${taskId}${runId ? `/${runId}` : ""}`;
}

async function readdirSafe(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch {
		return [];
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		await access(path);
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function validateRepository(
	projectPath: string,
	runner: CommandRunner = createCommandRunner(),
): Promise<RepositoryInfo> {
	const path = resolve(projectPath);
	if (!isAbsolute(projectPath) || !(await isDirectory(path))) {
		throw new WorktreeError(
			"INVALID_PROJECT",
			"Project path must be an existing absolute directory",
			{ path },
		);
	}
	const root = await runGit(runner, ["rev-parse", "--show-toplevel"], path);
	const canonical = await realpath(path);
	if ((await realpath(root)) !== canonical) {
		throw new WorktreeError(
			"INVALID_PROJECT",
			"Project path must be the Git repository root",
			{ path },
		);
	}
	let head = "";
	try {
		head = await runGit(runner, ["rev-parse", "HEAD"], path);
	} catch (error) {
		if (
			!(error instanceof WorktreeError) ||
			error.code !== "COMMAND_FAILED" ||
			!(error.details.stderr ?? "").includes("ambiguous argument 'HEAD'")
		)
			throw error;
	}
	const status = await runGit(runner, ["status", "--porcelain"], path);
	let defaultBranch = "";
	try {
		defaultBranch = await runGit(
			runner,
			["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
			path,
		);
		defaultBranch = defaultBranch.replace(/^origin\//, "");
	} catch {
		defaultBranch = await runGit(runner, ["branch", "--show-current"], path);
	}
	if (!defaultBranch) {
		defaultBranch = "main";
	}
	return { path: canonical, defaultBranch, head, clean: status.length === 0 };
}

export class WorktreeManager {
	private readonly runner: CommandRunner;
	private readonly home: string;

	constructor(options: { runner?: CommandRunner; home?: string } = {}) {
		this.runner = options.runner ?? createCommandRunner();
		this.home = options.home ?? homedir();
	}

	async create(input: WorktreeInput): Promise<Workspace> {
		const repository = await validateRepository(input.projectPath, this.runner);
		if (
			resolve(input.projectPath) === resolve(this.home, ".loom", "worktrees")
		) {
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Main workspace cannot be a managed worktree",
			);
		}
		const path = getWorktreePath(
			input.projectId,
			input.taskId,
			this.home,
			input.runId,
		);
		const branch = getWorktreeBranch(input.taskId, input.runId);
		if (
			resolve(path) !== path ||
			!resolve(path).startsWith(resolve(this.home, ".loom", "worktrees") + sep)
		) {
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Worktree path is outside the managed directory",
			);
		}
		try {
			await stat(path);
			throw new WorktreeError("SAFETY_ERROR", "Worktree path already exists", {
				path,
			});
		} catch (error) {
			if (error instanceof WorktreeError) throw error;
		}
		try {
			await runGit(
				this.runner,
				["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
				repository.path,
			);
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Worktree branch already exists",
				{
					branch,
				},
			);
		} catch (error) {
			if (error instanceof WorktreeError && error.code === "SAFETY_ERROR")
				throw error;
		}
		await mkdir(dirname(path), { recursive: true });
		await runGit(
			this.runner,
			repository.head
				? ["worktree", "add", "-b", branch, path, repository.head]
				: ["worktree", "add", "--orphan", "-b", branch, path],
			repository.path,
		);
		await writeFile(
			join(path, ".loom-worktree.json"),
			JSON.stringify({
				owner: "loom",
				projectId: input.projectId,
				taskId: input.taskId,
				runId: input.runId ?? null,
				branch,
			}),
			"utf8",
		);
		return {
			id: input.taskId,
			taskId: input.taskId,
			projectId: input.projectId,
			projectPath: repository.path,
			path,
			branch,
			baseCommit: repository.head,
			createdAt: new Date().toISOString(),
			runId: input.runId,
			owner: "loom",
		};
	}

	async diff(workspace: Workspace): Promise<string> {
		await this.assertWorkspacePath(workspace);
		return runGit(
			this.runner,
			[
				"diff",
				"--no-ext-diff",
				`${workspace.baseCommit}...${workspace.branch}`,
			],
			workspace.path,
		);
	}

	async remove(workspace: Workspace): Promise<void> {
		await this.assertWorkspacePath(workspace);
		await rm(join(workspace.path, ".loom-worktree.json"), { force: true });
		await runGit(
			this.runner,
			["worktree", "remove", "--force", workspace.path],
			workspace.projectPath,
		);
	}

	async discard(workspace: Workspace): Promise<void> {
		await this.assertWorkspacePath(workspace);
		await rm(join(workspace.path, ".loom-worktree.json"), { force: true });
		await runGit(
			this.runner,
			["worktree", "remove", "--force", workspace.path],
			workspace.projectPath,
		);
	}

	async preflightMerge(workspace: Workspace): Promise<MergePreflight> {
		await this.assertWorkspacePath(workspace);
		const repository = await validateRepository(
			workspace.projectPath,
			this.runner,
		);
		let branchExists = true;
		try {
			await runGit(
				this.runner,
				["show-ref", "--verify", "--quiet", `refs/heads/${workspace.branch}`],
				repository.path,
			);
		} catch {
			branchExists = false;
		}
		return { ...repository, branchExists };
	}

	async merge(workspace: Workspace, expectedHead?: string): Promise<void> {
		const repository = await this.preflightMerge(workspace);
		if (!repository.clean)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Main workspace must be clean before merge",
				{ path: repository.path },
			);
		if (!repository.branchExists)
			throw new WorktreeError("NOT_FOUND", "Workspace branch is missing", {
				branch: workspace.branch,
			});
		if (expectedHead && repository.head !== expectedHead)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Target HEAD changed before merge",
				{ expectedHead, actualHead: repository.head },
			);
		try {
			await runGit(
				this.runner,
				["merge", "--no-ff", "--", workspace.branch],
				repository.path,
			);
		} catch (error) {
			const files = await this.conflictFiles(repository.path);
			try {
				await runGit(this.runner, ["merge", "--abort"], repository.path);
			} catch {}
			if (files.length > 0) throw new MergeConflictError(files);
			throw error;
		}
		await this.remove(workspace);
	}

	private async conflictFiles(repositoryPath: string): Promise<string[]> {
		try {
			const output = await runGit(
				this.runner,
				["diff", "--name-only", "--diff-filter=U"],
				repositoryPath,
			);
			return [
				...new Set(
					output
						.split("\n")
						.map((file) => file.trim())
						.filter(Boolean),
				),
			].sort();
		} catch {
			return [];
		}
	}

	async findOrphans(
		projectId: string,
		taskIds: readonly string[] = [],
	): Promise<OrphanWorkspace[]> {
		validateSegment(projectId, "Project ID");
		const projectRoot = resolve(this.home, ".loom", "worktrees", projectId);
		const entries = await readdirSafe(projectRoot);
		const expectedTasks = new Set(taskIds);
		const orphans: OrphanWorkspace[] = [];
		for (const entry of entries) {
			const candidate = resolve(projectRoot, entry);
			if (!(await isDirectory(candidate))) continue;
			try {
				const metadata = JSON.parse(
					await readFile(join(candidate, ".loom-worktree.json"), "utf8"),
				) as { owner?: string; taskId?: string; branch?: string };
				if (
					metadata.owner !== "loom" ||
					!metadata.taskId ||
					(taskIds.length > 0 && !expectedTasks.has(metadata.taskId))
				) {
					orphans.push({
						path: candidate,
						branch: metadata.branch ?? null,
						reason: "invalid_metadata",
					});
				}
			} catch {
				orphans.push({
					path: candidate,
					branch: null,
					reason: "missing_metadata",
				});
			}
		}
		return orphans;
	}

	private async assertWorkspacePath(workspace: Workspace): Promise<void> {
		const expected = getWorktreePath(
			workspace.projectId,
			workspace.taskId,
			this.home,
			workspace.runId,
		);
		let actual: string;
		try {
			actual = await realpath(workspace.path);
		} catch {
			throw new WorktreeError(
				"NOT_FOUND",
				"Workspace path is missing or invalid",
				{ path: workspace.path },
			);
		}
		if (resolve(workspace.path) !== expected || actual !== expected) {
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Workspace path is outside its owned directory",
				{ path: workspace.path },
			);
		}
		try {
			const metadata = JSON.parse(
				await readFile(join(expected, ".loom-worktree.json"), "utf8"),
			) as {
				owner?: string;
				projectId?: string;
				taskId?: string;
				branch?: string;
			};
			if (
				metadata.owner !== "loom" ||
				metadata.projectId !== workspace.projectId ||
				metadata.taskId !== workspace.taskId ||
				metadata.branch !== workspace.branch
			) {
				throw new WorktreeError(
					"SAFETY_ERROR",
					"Workspace ownership metadata does not match",
					{ path: expected },
				);
			}
		} catch (error) {
			if (error instanceof WorktreeError) throw error;
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Workspace ownership metadata is missing or invalid",
				{ path: expected },
			);
		}
		const repository = await validateRepository(
			workspace.projectPath,
			this.runner,
		);
		const worktree = await runGit(
			this.runner,
			["worktree", "list", "--porcelain"],
			repository.path,
		);
		if (!worktree.split("\n").includes(`worktree ${expected}`)) {
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Workspace is not owned by the project repository",
				{ path: workspace.path },
			);
		}
	}
}

export async function removeManagedDirectory(
	path: string,
	home = homedir(),
): Promise<void> {
	const root = resolve(home, ".loom", "worktrees");
	const candidate = resolve(path);
	if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
		throw new WorktreeError(
			"SAFETY_ERROR",
			"Refusing to remove a path outside managed worktrees",
		);
	}
	await rm(candidate, { recursive: true, force: true });
}
