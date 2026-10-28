import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	access,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
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
	targetBranch?: string;
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
	/** Explicit Git ref or commit used as the worktree baseline. */
	baseRef?: string;
};

export type IntegrationMember = {
	taskId: string;
	outputSha: string;
};

export type IntegrationCandidateInput = {
	projectPath: string;
	projectId: string;
	batchId: string;
	targetBranch: string;
	targetBaseSha: string;
	members: IntegrationMember[];
};

export type IntegrationCheck = {
	name: string;
	command: string;
	args: string[];
	timeoutMs?: number;
};

export type OrphanWorkspace = {
	path: string;
	branch: string | null;
	reason: "missing_metadata" | "invalid_metadata" | "missing_task";
};

/** Relative path of a dependency directory mirrored into a new worktree. */
export type LinkedDependency = { path: string; target: string };

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
	readonly integrationWorkspace?: Workspace;

	constructor(
		files: string[],
		message = "Merge conflict detected",
		integrationWorkspace?: Workspace,
	) {
		super("COMMAND_FAILED", message, { files: files.join("\n") });
		this.name = "MergeConflictError";
		this.files = files;
		this.integrationWorkspace = integrationWorkspace;
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
	const result = await runGitRaw(runner, args, cwd);
	return result.trim();
}

/**
 * NUL-delimited output must not be trimmed: `git status --porcelain -z` writes
 * `XY path`, and a worktree-only change starts with a space (` M api.ts`) that
 * trimming would swallow, corrupting every path parsed from the first entry.
 */
async function runGitRaw(
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
	return result.stdout;
}

/**
 * Paths from `git status --porcelain -z`. Each entry is `XY path`, so only the
 * path is kept; a rename/copy entry is followed by its source path as a bare
 * NUL field, which is consumed rather than treated as another changed file.
 */
function porcelainPaths(output: string): string[] {
	const entries = output.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!entry) continue;
		let path = entry.length > 3 ? entry.slice(3) : "";
		const arrow = path.indexOf(" -> ");
		if (arrow >= 0) path = path.slice(arrow + 4);
		if (/[RC]/.test(entry[0] ?? "")) index += 1;
		if (path) paths.push(path);
	}
	return paths;
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

function worktreeRoot(home: string) {
	return resolve(
		home === homedir() && process.env.LOOM_HOME
			? process.env.LOOM_HOME
			: join(home, ".loom"),
		"worktrees",
	);
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
		worktreeRoot(home),
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

async function symlinkSafe(target: string, path: string): Promise<boolean> {
	try {
		await symlink(resolve(target), path, "junction");
		return true;
	} catch {
		return false;
	}
}

async function readJsonSafe(
	path: string,
): Promise<Record<string, unknown> | null> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Workspace globs from a root manifest, in both the array form and the
 * `{ packages: [...] }` object form, so monorepo installs are discovered too.
 */
function workspaceGlobs(manifest: Record<string, unknown> | null): string[] {
	const workspaces = manifest?.workspaces;
	const entries = Array.isArray(workspaces)
		? workspaces
		: workspaces &&
				typeof workspaces === "object" &&
				Array.isArray((workspaces as { packages?: unknown }).packages)
			? (workspaces as { packages: unknown[] }).packages
			: [];
	return entries.filter((item): item is string => typeof item === "string");
}

/**
 * Dependency directories a checkout needs in order to run builds and tests.
 * Workspace globs are read from the root manifest so monorepos (the common
 * fullstack layout) keep their per-package installs too.
 */
export async function dependencyDirectories(
	projectPath: string,
): Promise<string[]> {
	const found = new Set<string>();
	const globs = workspaceGlobs(
		await readJsonSafe(join(projectPath, "package.json")),
	);
	if (await isDirectory(join(projectPath, "node_modules")))
		found.add("node_modules");
	for (const glob of globs) {
		const segments = glob.split("/");
		let current = "";
		let wildcard = false;
		for (const segment of segments) {
			if (segment === "**" || segment === "*") {
				wildcard = true;
				break;
			}
			current = current ? join(current, segment) : segment;
		}
		// Only literal prefixes are walkable; `packages/*` yields `packages`.
		const prefix = wildcard ? current : segments.join("/");
		if (!prefix || prefix === ".") continue;
		const base = join(projectPath, prefix);
		if (!(await isDirectory(base))) continue;
		if (await isDirectory(join(base, "node_modules"))) {
			found.add(`${prefix}/node_modules`);
			continue;
		}
		for (const entry of await readdirSafe(base)) {
			if (entry.startsWith(".")) continue;
			const candidate = join(base, entry, "node_modules");
			if (await isDirectory(candidate))
				found.add(`${prefix}/${entry}/node_modules`);
		}
	}
	return [...found].sort();
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
		if (!(error instanceof WorktreeError) || error.code !== "COMMAND_FAILED")
			throw error;
		// Git versions report an unborn branch as either "ambiguous argument"
		// or "invalid reference". Accept it only when HEAD is still a valid
		// symbolic branch; other rev-parse failures indicate a broken repository.
		const symbolicHead = await runner(
			"git",
			["symbolic-ref", "--quiet", "HEAD"],
			{ cwd: path },
		);
		if (symbolicHead.exitCode !== 0) throw error;
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
		let repository: RepositoryInfo;
		try {
			repository = await validateRepository(input.projectPath, this.runner);
		} catch (error) {
			if (
				error instanceof WorktreeError &&
				error.code === "COMMAND_FAILED" &&
				/ not a git repository/i.test(error.details.stderr ?? "")
			)
				throw new WorktreeError(
					"INVALID_PROJECT",
					"This project has no Git repository. Kanban tasks can be planned, but running them requires Git and an initial commit.",
					{ path: resolve(input.projectPath) },
				);
			throw error;
		}
		if (!repository.head)
			throw new WorktreeError(
				"INVALID_PROJECT",
				"This Git repository has no commits yet. Create an initial commit before running Kanban tasks.",
				{ path: repository.path },
			);
		if (resolve(input.projectPath) === worktreeRoot(this.home)) {
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
		let baseCommit = repository.head;
		if (input.baseRef) {
			try {
				baseCommit = await runGit(
					this.runner,
					["rev-parse", "--verify", `${input.baseRef}^{commit}`],
					repository.path,
				);
			} catch (error) {
				if (error instanceof WorktreeError && error.code !== "COMMAND_FAILED")
					throw error;
				// The configured base branch no longer exists (e.g. a stale
				// default branch); fall back to the repository HEAD instead of
				// failing the task before it even starts.
				baseCommit = repository.head;
			}
		}
		if (
			resolve(path) !== path ||
			!resolve(path).startsWith(worktreeRoot(this.home) + sep)
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
			baseCommit
				? ["worktree", "add", "-b", branch, path, baseCommit]
				: ["worktree", "add", "--orphan", "-b", branch, path],
			repository.path,
		);
		await this.ensureExcluded(path, ["/.loom-worktree.json"]);
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
			baseCommit,
			createdAt: new Date().toISOString(),
			runId: input.runId,
			owner: "loom",
		};
	}

	/** Append ignore patterns to the repository-local exclude file. */
	private async ensureExcluded(
		worktreePath: string,
		patterns: readonly string[],
	): Promise<void> {
		const excludePath = await runGit(
			this.runner,
			["rev-parse", "--git-path", "info/exclude"],
			worktreePath,
		);
		const absoluteExcludePath = resolve(worktreePath, excludePath);
		await mkdir(dirname(absoluteExcludePath), { recursive: true });
		let existingExcludes = "";
		try {
			existingExcludes = await readFile(absoluteExcludePath, "utf8");
		} catch {}
		const lines = existingExcludes.split(/\r?\n/);
		const missing = patterns.filter((pattern) => !lines.includes(pattern));
		if (!missing.length) return;
		await writeFile(
			absoluteExcludePath,
			`${existingExcludes}${existingExcludes.endsWith("\n") || !existingExcludes ? "" : "\n"}${missing.join("\n")}\n`,
			"utf8",
		);
	}

	/**
	 * Mirror the repository's installed dependencies into a managed worktree so
	 * an agent can build, test, and start dev servers there immediately. Every
	 * link is also added to the exclude file, keeping Git state clean enough to
	 * checkpoint, merge, and remove the workspace.
	 */
	async prepareDependencies(workspace: Workspace): Promise<LinkedDependency[]> {
		await this.assertWorkspacePath(workspace);
		const linked: LinkedDependency[] = [];
		for (const relativePath of await dependencyDirectories(
			workspace.projectPath,
		)) {
			const target = join(workspace.projectPath, relativePath);
			const linkPath = join(workspace.path, relativePath);
			if (!(await isDirectory(target))) continue;
			if (await isDirectory(linkPath)) continue;
			// The package folder must exist in this checkout before its install can
			// be linked; the branch may not contain it yet.
			if (!(await isDirectory(dirname(linkPath)))) continue;
			if (await symlinkSafe(target, linkPath))
				linked.push({ path: relativePath, target });
		}
		if (linked.length)
			await this.ensureExcluded(
				workspace.path,
				linked.map((entry) => `/${entry.path}`),
			);
		return linked;
	}

	async diff(workspace: Workspace): Promise<string> {
		await this.assertWorkspacePath(workspace);
		const tracked = await runGit(
			this.runner,
			["diff", "--no-ext-diff", "--binary", workspace.baseCommit],
			workspace.path,
		);
		const untracked = await runGitRaw(
			this.runner,
			["ls-files", "--others", "--exclude-standard", "-z"],
			workspace.path,
		);
		const additions: string[] = [];
		for (const path of untracked.split("\0").filter(Boolean)) {
			if (isExcludedCheckpointPath(path)) continue;
			try {
				const content = await readFile(join(workspace.path, path), "utf8");
				additions.push(
					`diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n${content
						.split("\n")
						.map((line) => `+${line}`)
						.join("\n")}`,
				);
			} catch {
				additions.push(`New binary file: ${path}`);
			}
		}
		return [tracked, ...additions].filter(Boolean).join("\n");
	}

	/**
	 * Create a user-authorized checkpoint commit from the managed workspace.
	 * Secret-like files and Loom runtime metadata are never staged.
	 */
	async checkpoint(workspace: Workspace, message: string): Promise<string> {
		await this.assertWorkspacePath(workspace);
		const status = await runGitRaw(
			this.runner,
			["status", "--porcelain", "-z", "--untracked-files=all"],
			workspace.path,
		);
		const changed = porcelainPaths(status);
		const ignored = await runGitRaw(
			this.runner,
			["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
			workspace.path,
		);
		const ignoredSecrets = ignored
			.split("\0")
			.filter(Boolean)
			.filter(isSensitiveCheckpointPath);
		if (ignoredSecrets.length)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Workspace contains ignored secret-like files; remove them before checkpointing",
				{ paths: ignoredSecrets.join("\n") },
			);
		const paths = changed.filter(
			(path) => path && !isExcludedCheckpointPath(path),
		);
		if (!paths.length) {
			const head = await runGit(
				this.runner,
				["rev-parse", "HEAD"],
				workspace.path,
			);
			if (head === workspace.baseCommit)
				throw new WorktreeError("NOT_FOUND", "No checkpointable changes found");
			const ancestry = await this.runner(
				"git",
				["merge-base", "--is-ancestor", workspace.baseCommit, head],
				{ cwd: workspace.path },
			);
			if (ancestry.exitCode !== 0)
				throw new WorktreeError(
					"SAFETY_ERROR",
					"Checkpoint HEAD is not based on the recorded task baseline",
				);
			const committedPaths = (
				await runGitRaw(
					this.runner,
					["diff", "--name-only", "-z", `${workspace.baseCommit}..${head}`],
					workspace.path,
				)
			)
				.split("\0")
				.filter(Boolean);
			const excludedCommitted = committedPaths.filter(isExcludedCheckpointPath);
			if (excludedCommitted.length)
				throw new WorktreeError(
					"SAFETY_ERROR",
					"Committed output contains secret, generated, or Loom metadata paths",
					{ paths: excludedCommitted.join("\n") },
				);
			if (!committedPaths.length)
				throw new WorktreeError("NOT_FOUND", "No checkpointable changes found");
			return head;
		}
		const excluded = changed.filter(
			(path) => path && isExcludedCheckpointPath(path),
		);
		if (excluded.length)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Checkpoint contains secret, generated, or Loom metadata paths; remove them before checkpointing",
				{ paths: excluded.join("\n") },
			);
		await runGit(this.runner, ["add", "--", ...paths], workspace.path);
		const staged = await runGitRaw(
			this.runner,
			["diff", "--cached", "--name-only", "-z"],
			workspace.path,
		);
		const stagedPaths = staged.split("\0").filter(Boolean);
		if (!stagedPaths.length)
			throw new WorktreeError("NOT_FOUND", "No staged changes to checkpoint");
		const unsafeStaged = stagedPaths.filter(isExcludedCheckpointPath);
		if (unsafeStaged.length)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Staged output contains secret, generated, or Loom metadata paths",
				{ paths: unsafeStaged.join("\n") },
			);
		await runGit(
			this.runner,
			[
				"-c",
				"user.name=Loom Checkpoint",
				"-c",
				"user.email=loom-checkpoint@localhost",
				"commit",
				"-m",
				message.trim() || `Checkpoint ${workspace.taskId}`,
			],
			workspace.path,
		);
		return runGit(this.runner, ["rev-parse", "HEAD"], workspace.path);
	}

	async inspectHead(
		workspace: Workspace,
	): Promise<{ head: string; clean: boolean }> {
		await this.assertWorkspacePath(workspace);
		const [head, status] = await Promise.all([
			runGit(this.runner, ["rev-parse", "HEAD"], workspace.path),
			runGit(
				this.runner,
				["status", "--porcelain", "--untracked-files=all"],
				workspace.path,
			),
		]);
		return {
			head,
			clean:
				status
					.split("\n")
					.filter(
						(line) => line.trim() && !line.endsWith(".loom-worktree.json"),
					).length === 0,
		};
	}

	async readTextAtCommit(
		workspace: Workspace,
		commitSha: string,
		relativePath: string,
	): Promise<string> {
		await this.assertWorkspacePath(workspace);
		const normalized = relativePath.replaceAll("\\", "/");
		if (
			!normalized ||
			isAbsolute(relativePath) ||
			normalized
				.split("/")
				.some((segment) => !segment || segment === "." || segment === "..") ||
			isExcludedCheckpointPath(normalized) ||
			normalized.length > 500
		)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Artifact path is unsafe or excluded",
				{ path: normalized },
			);
		const size = Number(
			await runGit(
				this.runner,
				["cat-file", "-s", `${commitSha}:${normalized}`],
				workspace.path,
			),
		);
		if (!Number.isSafeInteger(size) || size > 2_000_000)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Artifact must be a text file smaller than 2 MB",
				{ path: normalized, size: String(size) },
			);
		return runGit(
			this.runner,
			["show", `${commitSha}:${normalized}`],
			workspace.path,
		);
	}

	async remove(workspace: Workspace): Promise<void> {
		await this.assertWorkspacePath(workspace);
		const status = await runGit(
			this.runner,
			["status", "--porcelain", "--untracked-files=all"],
			workspace.path,
		);
		const uncheckpointed = status
			.split("\n")
			.filter((line) => line.trim() && !line.endsWith(".loom-worktree.json"));
		if (uncheckpointed.length) {
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Workspace has uncheckpointed changes; preserve or checkpoint them before removal",
				{ path: workspace.path },
			);
		}
		const metadataPath = join(workspace.path, ".loom-worktree.json");
		let metadata: string | undefined;
		try {
			metadata = await readFile(metadataPath, "utf8");
		} catch {}
		await rm(metadataPath, { force: true });
		try {
			const remaining = await runGit(
				this.runner,
				["status", "--porcelain", "--untracked-files=all"],
				workspace.path,
			);
			if (remaining.trim()) {
				if (metadata !== undefined)
					await writeFile(metadataPath, metadata, "utf8");
				throw new WorktreeError(
					"SAFETY_ERROR",
					"Workspace changed during removal; preserve or checkpoint the new output",
					{ path: workspace.path, status: remaining },
				);
			}
			await runGit(
				this.runner,
				["worktree", "remove", "--force", workspace.path],
				workspace.projectPath,
			);
		} catch (error) {
			if (metadata !== undefined && (await isDirectory(workspace.path)))
				await writeFile(metadataPath, metadata, "utf8");
			throw error;
		}
	}

	/**
	 * Force-remove a workspace, keeping or deleting its branch. Discarding a chat
	 * tab also drops its branch so abandoned sessions do not leave unreachable
	 * commits behind; Kanban removal keeps the branch for later inspection.
	 */
	async discard(
		workspace: Workspace,
		options: { deleteBranch?: boolean } = {},
	): Promise<void> {
		await this.assertWorkspacePath(workspace);
		await rm(join(workspace.path, ".loom-worktree.json"), { force: true });
		await runGit(
			this.runner,
			["worktree", "remove", "--force", workspace.path],
			workspace.projectPath,
		);
		if (options.deleteBranch)
			await runGit(
				this.runner,
				["branch", "-D", workspace.branch],
				workspace.projectPath,
			).catch(() => undefined);
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
		const targetBranch = workspace.targetBranch || repository.defaultBranch;
		let head = "";
		try {
			head = await runGit(
				this.runner,
				["rev-parse", "--verify", `${targetBranch}^{commit}`],
				repository.path,
			);
		} catch {
			throw new WorktreeError("NOT_FOUND", "Target branch does not exist", {
				targetBranch,
			});
		}
		return { ...repository, head, branchExists };
	}

	async isCommitIntegrated(
		workspace: Workspace,
		commitSha: string,
	): Promise<boolean> {
		const repository = await validateRepository(
			workspace.projectPath,
			this.runner,
		);
		const targetBranch = workspace.targetBranch || repository.defaultBranch;
		const result = await this.runner(
			"git",
			["merge-base", "--is-ancestor", commitSha, targetBranch],
			{ cwd: repository.path },
		);
		return result.exitCode === 0;
	}

	async createIntegrationCandidate(input: IntegrationCandidateInput): Promise<{
		workspace: Workspace;
		targetBaseSha: string;
		memberShas: string[];
		candidateSha: string;
	}> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.batchId))
			throw new WorktreeError("SAFETY_ERROR", "Invalid integration batch ID");
		if (!input.members.length)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Integration batch has no members",
			);
		const repository = await validateRepository(input.projectPath, this.runner);
		await runGit(
			this.runner,
			["check-ref-format", "--branch", input.targetBranch],
			repository.path,
		);
		const targetBaseSha = await runGit(
			this.runner,
			["rev-parse", "--verify", `${input.targetBaseSha}^{commit}`],
			repository.path,
		);
		const targetBranchSha = await runGit(
			this.runner,
			["rev-parse", "--verify", `${input.targetBranch}^{commit}`],
			repository.path,
		);
		if (targetBranchSha !== targetBaseSha)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Target branch moved before integration assembly",
				{
					expectedHead: targetBaseSha,
					actualHead: targetBranchSha,
				},
			);
		const memberShas: string[] = [];
		for (const member of input.members) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(member.taskId))
				throw new WorktreeError(
					"SAFETY_ERROR",
					"Invalid task ID in integration batch",
				);
			const outputSha = await runGit(
				this.runner,
				["rev-parse", "--verify", `${member.outputSha}^{commit}`],
				repository.path,
			);
			if (memberShas.includes(outputSha))
				throw new WorktreeError(
					"SAFETY_ERROR",
					"Integration batch contains a duplicate output SHA",
				);
			memberShas.push(outputSha);
		}
		const taskId = `integration-${input.batchId}`;
		const path = getWorktreePath(input.projectId, taskId, this.home);
		const branch = `loom/integration/${input.batchId}`;
		if (
			resolve(path) !== path ||
			!path.startsWith(worktreeRoot(this.home) + sep)
		)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Integration worktree path is outside the managed directory",
			);
		try {
			await stat(path);
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Integration worktree path already exists",
				{ path },
			);
		} catch (error) {
			if (error instanceof WorktreeError) throw error;
		}
		await mkdir(dirname(path), { recursive: true });
		await runGit(
			this.runner,
			["worktree", "add", "-b", branch, path, targetBaseSha],
			repository.path,
		);
		const workspace: Workspace = {
			id: taskId,
			taskId,
			projectId: input.projectId,
			projectPath: repository.path,
			path,
			branch,
			targetBranch: input.targetBranch,
			baseCommit: targetBaseSha,
			createdAt: new Date().toISOString(),
			owner: "loom",
		};
		try {
			await this.writeWorkspaceMetadata(workspace);
			for (let index = 0; index < input.members.length; index++) {
				const member = input.members[index]!;
				const sha = memberShas[index]!;
				try {
					await runGit(
						this.runner,
						[
							"merge",
							"--no-ff",
							"-m",
							`Integrate task ${member.taskId} (${sha.slice(0, 12)})`,
							"--",
							sha,
						],
						path,
					);
				} catch (error) {
					const files = await this.conflictFiles(path);
					if (files.length)
						throw new MergeConflictError(
							files,
							"Integration batch has merge conflicts",
							workspace,
						);
					throw error;
				}
			}
			await runGit(
				this.runner,
				["diff", "--check", `${targetBaseSha}..HEAD`],
				path,
			);
			const candidateSha = await runGit(
				this.runner,
				["rev-parse", "HEAD"],
				path,
			);
			return { workspace, targetBaseSha, memberShas, candidateSha };
		} catch (error) {
			if (error instanceof MergeConflictError)
				throw new MergeConflictError(error.files, error.message, workspace);
			// Keep the integration worktree and any conflict state so it can be inspected.
			throw error;
		}
	}

	async promoteIntegrationCandidate(
		workspace: Workspace,
		input: { expectedTargetSha: string; candidateSha: string },
	): Promise<string> {
		await this.assertWorkspacePath(workspace);
		const repository = await validateRepository(
			workspace.projectPath,
			this.runner,
		);
		const targetBranch = workspace.targetBranch || repository.defaultBranch;
		const targetRef = `refs/heads/${targetBranch}`;
		const currentTargetSha = await runGit(
			this.runner,
			["rev-parse", "--verify", `${targetRef}^{commit}`],
			repository.path,
		);
		if (currentTargetSha !== input.expectedTargetSha)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Target branch moved after candidate review",
				{
					expectedHead: input.expectedTargetSha,
					actualHead: currentTargetSha,
				},
			);
		const candidateSha = await runGit(
			this.runner,
			["rev-parse", "--verify", `${input.candidateSha}^{commit}`],
			workspace.path,
		);
		const inspected = await this.inspectHead(workspace);
		if (!inspected.clean || inspected.head !== candidateSha)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Integration candidate changed after review",
				{
					expectedHead: candidateSha,
					actualHead: inspected.head,
				},
			);
		const currentBranch = await runGit(
			this.runner,
			["branch", "--show-current"],
			repository.path,
		);
		const worktreeList = await runGit(
			this.runner,
			["worktree", "list", "--porcelain"],
			repository.path,
		);
		const targetRefLine = `branch ${targetRef}`;
		const targetWorktree = worktreeList
			.split("\n\n")
			.find((item) => item.split("\n").includes(targetRefLine));
		if (targetWorktree) {
			const checkedOutAt = targetWorktree
				.split("\n")[0]
				?.replace(/^worktree /, "");
			if (resolve(checkedOutAt ?? "") !== repository.path)
				throw new WorktreeError(
					"SAFETY_ERROR",
					"Target branch is checked out in another worktree",
					{
						targetBranch,
						checkedOutAt: checkedOutAt ?? "unknown",
					},
				);
		}
		if (currentBranch === targetBranch) {
			const status = await runGit(
				this.runner,
				["status", "--porcelain", "--untracked-files=all"],
				repository.path,
			);
			if (status.trim())
				throw new WorktreeError(
					"SAFETY_ERROR",
					"Target checkout is dirty; refusing promotion",
					{ path: repository.path },
				);
			await runGit(
				this.runner,
				["merge", "--ff-only", candidateSha],
				repository.path,
			);
		} else {
			await runGit(
				this.runner,
				["update-ref", targetRef, candidateSha, currentTargetSha],
				repository.path,
			);
		}
		return candidateSha;
	}

	async runIntegrationCheck(workspace: Workspace, check: IntegrationCheck) {
		await this.assertWorkspacePath(workspace);
		const timeoutMs = Math.max(
			1_000,
			Math.min(check.timeoutMs ?? 10 * 60_000, 30 * 60_000),
		);
		const startedAt = new Date();
		const outputHash = createHash("sha256");
		const maxCapturedBytes = 8_000;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const child = spawn(check.command, check.args, {
			cwd: workspace.path,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
			outputHash.update(stream).update(chunk);
			if (stream === "stdout")
				stdout = appendBounded(stdout, chunk.toString(), maxCapturedBytes);
			else stderr = appendBounded(stderr, chunk.toString(), maxCapturedBytes);
		};
		child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
		const killTree = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				if (process.platform !== "win32") process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree("SIGTERM");
			setTimeout(() => killTree("SIGKILL"), 1_500).unref();
		}, timeoutMs);
		const result = await new Promise<{
			exitCode: number | null;
			spawnError?: Error;
		}>((resolvePromise) => {
			child.once("error", (error) =>
				resolvePromise({ exitCode: null, spawnError: error }),
			);
			child.once("close", (exitCode) => {
				if (timedOut) killTree("SIGKILL");
				resolvePromise({ exitCode });
			});
		});
		clearTimeout(timer);
		if (result.spawnError)
			stderr = appendBounded(
				stderr,
				result.spawnError.message,
				maxCapturedBytes,
			);
		return {
			name: check.name,
			status: timedOut
				? ("timed_out" as const)
				: result.exitCode === 0
					? ("passed" as const)
					: ("failed" as const),
			exitCode: result.exitCode,
			stdout,
			stderr,
			evidenceHash: outputHash.digest("hex"),
			startedAt,
			finishedAt: new Date(),
		};
	}

	async discardIntegrationCandidate(workspace: Workspace): Promise<void> {
		await this.remove(workspace);
		try {
			await runGit(
				this.runner,
				["branch", "-D", workspace.branch],
				workspace.projectPath,
			);
		} catch {}
	}

	private async writeWorkspaceMetadata(workspace: Workspace): Promise<void> {
		const excludePath = await runGit(
			this.runner,
			["rev-parse", "--git-path", "info/exclude"],
			workspace.path,
		);
		const absoluteExcludePath = resolve(workspace.path, excludePath);
		await mkdir(dirname(absoluteExcludePath), { recursive: true });
		let existingExcludes = "";
		try {
			existingExcludes = await readFile(absoluteExcludePath, "utf8");
		} catch {}
		if (!existingExcludes.split(/\r?\n/).includes("/.loom-worktree.json")) {
			await writeFile(
				absoluteExcludePath,
				`${existingExcludes}${existingExcludes.endsWith("\n") || !existingExcludes ? "" : "\n"}/.loom-worktree.json\n`,
				"utf8",
			);
		}
		await writeFile(
			join(workspace.path, ".loom-worktree.json"),
			JSON.stringify({
				owner: "loom",
				projectId: workspace.projectId,
				taskId: workspace.taskId,
				runId: workspace.runId ?? null,
				branch: workspace.branch,
			}),
			"utf8",
		);
	}

	async merge(
		workspace: Workspace,
		expectedHead?: string,
		options: { keepWorkspace?: boolean } = {},
	): Promise<string> {
		const repository = await this.preflightMerge(workspace);
		const expectedTargetHead = expectedHead ?? repository.head;
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
		const targetBranch = workspace.targetBranch || repository.defaultBranch;
		const integrationPath = getWorktreePath(
			workspace.projectId,
			`integration-${workspace.taskId}-${randomUUID()}`,
			this.home,
		);
		await mkdir(dirname(integrationPath), { recursive: true });
		await runGit(
			this.runner,
			["worktree", "add", "--detach", integrationPath, repository.head],
			repository.path,
		);
		let candidateHead = "";
		try {
			try {
				await runGit(
					this.runner,
					[
						"merge",
						"--no-ff",
						"-m",
						`Integrate task ${workspace.taskId}`,
						"--",
						workspace.branch,
					],
					integrationPath,
				);
			} catch (error) {
				const files = await this.conflictFiles(integrationPath);
				try {
					await runGit(this.runner, ["merge", "--abort"], integrationPath);
				} catch {}
				if (files.length > 0) throw new MergeConflictError(files);
				throw error;
			}
			await runGit(
				this.runner,
				["diff", "--check", `${repository.head}..HEAD`],
				integrationPath,
			);
			candidateHead = await runGit(
				this.runner,
				["rev-parse", "HEAD"],
				integrationPath,
			);
			const currentBranch = await runGit(
				this.runner,
				["branch", "--show-current"],
				repository.path,
			);
			const worktreeList = await runGit(
				this.runner,
				["worktree", "list", "--porcelain"],
				repository.path,
			);
			const targetRef = `refs/heads/${targetBranch}`;
			const targetWorktree = worktreeList
				.split("\n\n")
				.find((item) => item.split("\n").includes(`branch ${targetRef}`));
			if (targetWorktree && currentBranch !== targetBranch) {
				const checkedOutAt = targetWorktree
					.split("\n")[0]
					?.replace(/^worktree /, "");
				if (resolve(checkedOutAt ?? "") !== repository.path)
					throw new WorktreeError(
						"SAFETY_ERROR",
						"Target branch is checked out in another worktree",
						{ targetBranch, checkedOutAt: checkedOutAt ?? "unknown" },
					);
			}
			if (repository.head !== expectedTargetHead)
				throw new WorktreeError(
					"SAFETY_ERROR",
					"Target branch changed before promotion",
					{
						expectedHead: expectedTargetHead ?? repository.head,
						actualHead: repository.head,
					},
				);
			if (currentBranch === targetBranch) {
				await runGit(
					this.runner,
					["merge", "--ff-only", candidateHead],
					repository.path,
				);
			} else {
				await runGit(
					this.runner,
					["update-ref", targetRef, candidateHead, repository.head],
					repository.path,
				);
			}
		} finally {
			if (await isDirectory(integrationPath)) {
				try {
					await runGit(
						this.runner,
						["worktree", "remove", integrationPath],
						repository.path,
					);
				} catch {}
			}
		}
		// A chat session keeps talking to the worktree it was created in, so the
		// caller can choose to retain it after its output is integrated.
		if (!options.keepWorkspace) await this.remove(workspace);
		return candidateHead;
	}

	/**
	 * Bring a managed workspace up to date with its target branch. Used by an
	 * isolated chat tab that needs another tab's freshly integrated work; Git
	 * surfaces any real overlap as a conflict instead of silently mixing edits.
	 */
	async sync(
		workspace: Workspace,
		sourceRef?: string,
	): Promise<{ head: string; conflicts: string[] }> {
		await this.assertWorkspacePath(workspace);
		const repository = await validateRepository(
			workspace.projectPath,
			this.runner,
		);
		const target =
			sourceRef ?? workspace.targetBranch ?? repository.defaultBranch;
		let sourceSha = "";
		try {
			sourceSha = await runGit(
				this.runner,
				["rev-parse", "--verify", `${target}^{commit}`],
				repository.path,
			);
		} catch {
			throw new WorktreeError("NOT_FOUND", "Sync source does not exist", {
				target,
			});
		}
		const status = await runGit(
			this.runner,
			["status", "--porcelain", "--untracked-files=all"],
			workspace.path,
		);
		const dirty = status
			.split("\n")
			.filter((line) => line.trim() && !line.endsWith(".loom-worktree.json"));
		if (dirty.length)
			throw new WorktreeError(
				"SAFETY_ERROR",
				"Workspace has uncheckpointed changes; checkpoint them before syncing",
				{ path: workspace.path },
			);
		try {
			await runGit(
				this.runner,
				[
					"merge",
					"--no-ff",
					"-m",
					`Sync ${workspace.branch} with ${target}`,
					sourceSha,
				],
				workspace.path,
			);
		} catch {
			const conflicts = await this.conflictFiles(workspace.path);
			if (conflicts.length)
				throw new MergeConflictError(
					conflicts,
					`Syncing ${target} into this workspace conflicts on ${conflicts.length} file(s)`,
					workspace,
				);
			throw new WorktreeError(
				"COMMAND_FAILED",
				"Workspace sync failed before it could merge",
				{ target },
			);
		}
		return {
			head: await runGit(this.runner, ["rev-parse", "HEAD"], workspace.path),
			conflicts: [],
		};
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
		const projectRoot = resolve(worktreeRoot(this.home), projectId);
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

function appendBounded(
	existing: string,
	addition: string,
	maxBytes: number,
): string {
	if (Buffer.byteLength(existing) >= maxBytes) return existing;
	const remaining = maxBytes - Buffer.byteLength(existing);
	return existing + Buffer.from(addition).subarray(0, remaining).toString();
}

function isExcludedCheckpointPath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	if (
		normalized === ".loom-worktree.json" ||
		/(^|\/)(\.git|\.loom|node_modules|dist|build|coverage)(\/|$)/i.test(
			normalized,
		)
	)
		return true;
	return isSensitiveCheckpointPath(path);
}

function isSensitiveCheckpointPath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	const basename = normalized
		.slice(normalized.lastIndexOf("/") + 1)
		.toLowerCase();
	if (
		basename === ".env" ||
		(basename.startsWith(".env.") &&
			!/\.(example|sample|template)$/.test(basename))
	)
		return true;
	return (
		/(^|[-_.])(secret|secrets|credential|credentials|private[-_]?key)([-_.]|$)/i.test(
			basename,
		) || /\.(pem|key|p12|pfx)$/i.test(basename)
	);
}

export async function removeManagedDirectory(
	path: string,
	home = homedir(),
): Promise<void> {
	const root = worktreeRoot(home);
	const candidate = resolve(path);
	if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
		throw new WorktreeError(
			"SAFETY_ERROR",
			"Refusing to remove a path outside managed worktrees",
		);
	}
	await rm(candidate, { recursive: true, force: true });
}
