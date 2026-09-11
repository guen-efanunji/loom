import { spawn } from "node:child_process";
import { access, mkdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";

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

export type Workspace = {
	id: string;
	taskId: string;
	projectId: string;
	projectPath: string;
	path: string;
	branch: string;
	baseCommit: string;
	createdAt: string;
};

export type WorktreeInput = {
	projectPath: string;
	projectId: string;
	taskId: string;
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
): string {
	validateSegment(projectId, "Project ID");
	validateSegment(taskId, "Task ID");
	return resolve(home, ".loom", "worktrees", projectId, taskId);
}

export function getWorktreeBranch(taskId: string): string {
	validateSegment(taskId, "Task ID");
	return `loom/${taskId}`;
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
	const head = await runGit(runner, ["rev-parse", "HEAD"], path);
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
		const path = getWorktreePath(input.projectId, input.taskId, this.home);
		const branch = getWorktreeBranch(input.taskId);
		if (
			resolve(path) !== path ||
			!resolve(path).startsWith(resolve(this.home, ".loom", "worktrees") + sep)
		) {
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Worktree path is outside the managed directory",
			);
		}
		if (await isDirectory(path)) {
			throw new WorktreeError("SAFETY_ERROR", "Worktree path already exists", {
				path,
			});
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
			["worktree", "add", "-b", branch, path, repository.defaultBranch],
			repository.path,
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
		await runGit(
			this.runner,
			["worktree", "remove", workspace.path],
			workspace.projectPath,
		);
	}

	async discard(workspace: Workspace): Promise<void> {
		await this.assertWorkspacePath(workspace);
		await runGit(
			this.runner,
			["worktree", "remove", "--force", workspace.path],
			workspace.projectPath,
		);
	}

	async merge(workspace: Workspace): Promise<void> {
		await this.assertWorkspacePath(workspace);
		const repository = await validateRepository(
			workspace.projectPath,
			this.runner,
		);
		if (!repository.clean) {
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Main workspace must be clean before merge",
				{ path: repository.path },
			);
		}
		try {
			await runGit(
				this.runner,
				["merge", "--no-ff", "--", workspace.branch],
				repository.path,
			);
		} catch (error) {
			try {
				await runGit(this.runner, ["merge", "--abort"], repository.path);
			} catch {}
			throw error;
		}
		await this.remove(workspace);
	}

	private async assertWorkspacePath(workspace: Workspace): Promise<void> {
		const expected = getWorktreePath(
			workspace.projectId,
			workspace.taskId,
			this.home,
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
