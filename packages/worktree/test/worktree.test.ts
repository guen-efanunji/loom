import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	dependencyDirectories,
	getWorktreeBranch,
	getWorktreePath,
	validateRepository,
	WorktreeError,
	WorktreeManager,
} from "../src";

describe("worktree paths", () => {
	test("uses the managed path and branch convention", () => {
		expect(getWorktreePath("project-1", "task-1", "/tmp/home")).toBe(
			resolve("/tmp/home/.loom/worktrees/project-1/task-1"),
		);
		expect(getWorktreeBranch("task-1")).toBe("loom/task-1");
	});

	test("rejects traversal segments", () => {
		expect(() => getWorktreePath("../project", "task", "/tmp/home")).toThrow(
			WorktreeError,
		);
	});
});

describe("temporary git repository", () => {
	let root = "";
	let home = "";

	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true });
		if (home) await rm(home, { recursive: true, force: true });
		root = "";
		home = "";
	});

	test("accepts an empty Git repository", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-empty-repository-"));
		const process = Bun.spawn(["git", "init", "-b", "main"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await process.exited).toBe(0);

		const info = await validateRepository(root);
		expect(info.path).toBe(root);
		expect(info.defaultBranch).toBe("main");
		expect(info.head).toBe("");
		expect(info.clean).toBe(true);
	});

	test("validates, creates, diffs, and discards an isolated worktree", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (
			command: string,
			args: readonly string[],
			options?: { cwd?: string },
		) => {
			const process = Bun.spawn([command, ...args], {
				cwd: options?.cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(process.stdout).text(),
				new Response(process.stderr).text(),
				process.exited,
			]);
			return { stdout, stderr, exitCode };
		};
		await run("git", ["init", "-b", "main"], { cwd: root });
		await run("git", ["config", "user.name", "Loom"], { cwd: root });
		await run("git", ["config", "user.email", "loom@example.test"], {
			cwd: root,
		});
		await writeFile(join(root, "README.md"), "initial\n");
		await run("git", ["add", "README.md"], { cwd: root });
		await run(
			"git",
			[
				"-c",
				"user.name=Loom",
				"-c",
				"user.email=loom@example.test",
				"commit",
				"-m",
				"initial",
			],
			{ cwd: root },
		);
		const info = await validateRepository(root);
		expect(info.defaultBranch).toBe("main");
		const manager = new WorktreeManager({ home });
		const workspace = await manager.create({
			projectPath: root,
			projectId: "project-1",
			taskId: "task-1",
		});
		expect(workspace.branch).toBe("loom/task-1");
		await writeFile(join(workspace.path, "change.txt"), "change\n");
		await run("git", ["add", "change.txt"], { cwd: workspace.path });
		await run(
			"git",
			[
				"-c",
				"user.name=Loom",
				"-c",
				"user.email=loom@example.test",
				"commit",
				"-m",
				"change",
			],
			{ cwd: workspace.path },
		);
		expect(await manager.diff(workspace)).toContain("change.txt");
		await manager.discard(workspace);
		expect(() => getWorktreeBranch("task-1")).not.toThrow();
	});

	test("creates two isolated worktrees for different tasks", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(join(root, "base.txt"), "base\n");
		await run(["add", "."]);
		await run(["commit", "-m", "initial"]);
		const manager = new WorktreeManager({ home });
		const first = await manager.create({
			projectPath: root,
			projectId: "project-isolation",
			taskId: "task-a",
		});
		const second = await manager.create({
			projectPath: root,
			projectId: "project-isolation",
			taskId: "task-b",
		});
		expect(first.path).not.toBe(second.path);
		expect(first.branch).not.toBe(second.branch);
		await writeFile(join(first.path, "a.txt"), "a\n");
		await writeFile(join(second.path, "b.txt"), "b\n");
		expect((await run(["status", "--porcelain"])).stdout.trim()).toBe("");
		await manager.discard(first);
		await manager.discard(second);
	});

	test("assembles exact task output SHAs into a reviewable candidate before promotion", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-integration-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-integration-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(join(root, "base.txt"), "base\n");
		await run(["add", "."]);
		await run(["commit", "-m", "base"]);
		const baseSha = (await run(["rev-parse", "HEAD"])).stdout.trim();
		const manager = new WorktreeManager({ home });
		const frontend = await manager.create({
			projectPath: root,
			projectId: "batch-project",
			taskId: "frontend",
			baseRef: baseSha,
		});
		const backend = await manager.create({
			projectPath: root,
			projectId: "batch-project",
			taskId: "backend",
			baseRef: baseSha,
		});
		for (const [workspace, file] of [
			[frontend, "frontend.txt"],
			[backend, "backend.txt"],
		] as const) {
			await writeFile(join(workspace.path, file), `${file}\n`);
			await run(["add", file], workspace.path);
			await run(
				[
					"-c",
					"user.name=Loom",
					"-c",
					"user.email=loom@example.test",
					"commit",
					"-m",
					file,
				],
				workspace.path,
			);
		}
		const frontendSha = (
			await run(["rev-parse", "HEAD"], frontend.path)
		).stdout.trim();
		const backendSha = (
			await run(["rev-parse", "HEAD"], backend.path)
		).stdout.trim();
		const candidate = await manager.createIntegrationCandidate({
			projectPath: root,
			projectId: "batch-project",
			batchId: "batch-1",
			targetBranch: "main",
			targetBaseSha: baseSha,
			members: [
				{ taskId: "frontend", outputSha: frontendSha },
				{ taskId: "backend", outputSha: backendSha },
			],
		});
		expect(candidate.memberShas).toEqual([frontendSha, backendSha]);
		expect(
			await Bun.file(join(candidate.workspace.path, "frontend.txt")).text(),
		).toBe("frontend.txt\n");
		expect(
			await Bun.file(join(candidate.workspace.path, "backend.txt")).text(),
		).toBe("backend.txt\n");
		expect((await run(["rev-parse", "main"])).stdout.trim()).toBe(baseSha);
		const reviewed = await manager.inspectHead(candidate.workspace);
		expect(reviewed.head).toBe(candidate.candidateSha);
		const cleanCheck = await manager.runIntegrationCheck(candidate.workspace, {
			name: "git diff check",
			command: "git",
			args: ["diff", "--check"],
			timeoutMs: 5_000,
		});
		expect(cleanCheck.status).toBe("passed");
		const failedCheck = await manager.runIntegrationCheck(candidate.workspace, {
			name: "invalid git option",
			command: "git",
			args: ["--not-a-git-option"],
			timeoutMs: 5_000,
		});
		expect(failedCheck.status).toBe("failed");
		await run([
			"-c",
			"user.name=Loom",
			"-c",
			"user.email=loom@example.test",
			"commit",
			"--allow-empty",
			"-m",
			"move target",
		]);
		await expect(
			manager.promoteIntegrationCandidate(candidate.workspace, {
				expectedTargetSha: baseSha,
				candidateSha: candidate.candidateSha,
			}),
		).rejects.toThrow("Target branch moved");
		await run(["reset", "--hard", baseSha]);
		await manager.promoteIntegrationCandidate(candidate.workspace, {
			expectedTargetSha: baseSha,
			candidateSha: candidate.candidateSha,
		});
		expect((await run(["rev-parse", "main"])).stdout.trim()).toBe(
			candidate.candidateSha,
		);
		await manager.discardIntegrationCandidate(candidate.workspace);
		await manager.discard(frontend);
		await manager.discard(backend);
	});

	test("uses an explicit baseline while leaving dirty checkout changes untouched", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(join(root, "base.txt"), "baseline\n");
		await run(["add", "."]);
		await run(["commit", "-m", "baseline"]);
		const baseSha = (await run(["rev-parse", "HEAD"])).stdout.trim();
		await run(["checkout", "-b", "other"]);
		await writeFile(join(root, "base.txt"), "other branch\n");
		await run(["commit", "-am", "other branch"]);
		await writeFile(join(root, "local.txt"), "uncommitted user work\n");
		const manager = new WorktreeManager({ home });
		const workspace = await manager.create({
			projectPath: root,
			projectId: "project-explicit-base",
			taskId: "task-explicit-base",
			baseRef: baseSha,
		});
		expect(workspace.baseCommit).toBe(baseSha);
		expect(await Bun.file(join(workspace.path, "base.txt")).text()).toBe(
			"baseline\n",
		);
		expect(await Bun.file(join(root, "local.txt")).text()).toBe(
			"uncommitted user work\n",
		);
		await manager.discard(workspace);
	});

	test("refuses normal removal when task output is uncheckpointed", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(join(root, "base.txt"), "baseline\n");
		await run(["add", "."]);
		await run(["commit", "-m", "baseline"]);
		const manager = new WorktreeManager({ home });
		const workspace = await manager.create({
			projectPath: root,
			projectId: "project-safe-remove",
			taskId: "task-safe-remove",
		});
		await writeFile(join(workspace.path, "output.txt"), "keep this output\n");
		await expect(manager.remove(workspace)).rejects.toThrow(
			/uncheckpointed changes/,
		);
		expect(await Bun.file(join(workspace.path, "output.txt")).exists()).toBe(
			true,
		);
		await manager.discard(workspace);
	});

	test("checkpoints visible worktree output and rejects secret files", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(join(root, "base.txt"), "baseline\n");
		await run(["add", "."]);
		await run(["commit", "-m", "baseline"]);
		const manager = new WorktreeManager({ home });
		const workspace = await manager.create({
			projectPath: root,
			projectId: "project-checkpoint",
			taskId: "task-checkpoint",
		});
		await writeFile(
			join(workspace.path, "output.ts"),
			"export const ready = true;\n",
		);
		await writeFile(join(workspace.path, ".env.local"), "TOKEN=secret\n");
		expect(await manager.diff(workspace)).toContain("output.ts");
		expect(await manager.diff(workspace)).not.toContain("TOKEN=secret");
		await expect(
			manager.checkpoint(workspace, "checkpoint output"),
		).rejects.toThrow(/secret, generated, or Loom metadata/);
		await rm(join(workspace.path, ".env.local"));
		const sha = await manager.checkpoint(workspace, "checkpoint output");
		expect(
			(await run(["rev-parse", "HEAD"], workspace.path)).stdout.trim(),
		).toBe(sha);
		expect((await run(["ls-files"], workspace.path)).stdout).toContain(
			"output.ts",
		);
		expect((await run(["ls-files"], workspace.path)).stdout).not.toContain(
			".loom-worktree.json",
		);
		expect(
			await manager.readTextAtCommit(workspace, sha, "output.ts"),
		).toContain("ready = true");
		await expect(
			manager.readTextAtCommit(workspace, sha, "../../outside"),
		).rejects.toThrow("unsafe or excluded");
		await manager.discard(workspace);
	});

	test("merges committed changes and removes only a clean worktree", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(join(root, "file.txt"), "base\n");
		await run(["add", "."]);
		await run(["commit", "-m", "initial"]);
		const manager = new WorktreeManager({ home });
		const workspace = await manager.create({
			projectPath: root,
			projectId: "project-2",
			taskId: "task-2",
		});
		await writeFile(join(workspace.path, "file.txt"), "merged\n");
		await run(["add", "."], workspace.path);
		expect(
			(
				await run(["ls-files", ".loom-worktree.json"], workspace.path)
			).stdout.trim(),
		).toBe("");
		await run(["commit", "-m", "change"], workspace.path);
		const outputSha = (
			await run(["rev-parse", "HEAD"], workspace.path)
		).stdout.trim();
		const promotedSha = await manager.merge(workspace);
		expect(await manager.isCommitIntegrated(workspace, outputSha)).toBe(true);
		expect(promotedSha).not.toBe("");
		expect((await run(["show", "HEAD:file.txt"])).stdout.trim()).toBe("merged");
	});

	test("aborts a conflicting merge and keeps main usable", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(join(root, "file.txt"), "base\n");
		await run(["add", "."]);
		await run(["commit", "-m", "initial"]);
		const manager = new WorktreeManager({ home });
		const workspace = await manager.create({
			projectPath: root,
			projectId: "project-3",
			taskId: "task-3",
		});
		await writeFile(join(workspace.path, "file.txt"), "branch\n");
		await run(["add", "."], workspace.path);
		await run(["commit", "-m", "branch"], workspace.path);
		await writeFile(join(root, "file.txt"), "main\n");
		await run(["add", "."]);
		await run(["commit", "-m", "main"]);
		await expect(manager.merge(workspace)).rejects.toThrow();
		expect((await run(["status", "--porcelain"])).stdout.trim()).toBe("");
		expect((await run(["show", "HEAD:file.txt"])).stdout.trim()).toBe("main");
		await manager.discard(workspace);
	});

	test("keeps a chat workspace after integrating its branch", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(join(root, "file.txt"), "base\n");
		await run(["add", "."]);
		await run(["commit", "-m", "initial"]);
		const manager = new WorktreeManager({ home });
		const workspace = await manager.create({
			projectPath: root,
			projectId: "project-chat",
			taskId: "chat-backend",
		});
		await writeFile(join(workspace.path, "api.ts"), "export const api = 1;\n");
		const sha = await manager.checkpoint(workspace, "feat: backend api");
		await manager.merge(workspace, undefined, { keepWorkspace: true });
		// The conversation is still live, so its checkout must survive the intake.
		expect((await stat(workspace.path)).isDirectory()).toBe(true);
		expect(await manager.isCommitIntegrated(workspace, sha)).toBe(true);
		expect((await run(["show", "HEAD:api.ts"])).stdout).toContain("api = 1");
		// Further work on the same branch integrates cleanly afterwards too.
		await writeFile(join(workspace.path, "api.ts"), "export const api = 2;\n");
		const second = await manager.checkpoint(workspace, "feat: backend api v2");
		await manager.merge(workspace, undefined, { keepWorkspace: true });
		expect((await run(["show", "HEAD:api.ts"])).stdout).toContain("api = 2");
		expect(await manager.isCommitIntegrated(workspace, second)).toBe(true);
		await manager.discard(workspace);
	});

	test("syncs a workspace with the branch another tab just merged", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(join(root, "shared.ts"), "base\n");
		await run(["add", "."]);
		await run(["commit", "-m", "initial"]);
		const manager = new WorktreeManager({ home });
		const backend = await manager.create({
			projectPath: root,
			projectId: "project-sync",
			taskId: "chat-backend",
		});
		const frontend = await manager.create({
			projectPath: root,
			projectId: "project-sync",
			taskId: "chat-frontend",
		});
		await writeFile(join(backend.path, "shared.ts"), "from backend\n");
		await manager.checkpoint(backend, "backend change");
		await manager.merge(backend, undefined, { keepWorkspace: true });
		// The frontend tab cannot see the merged change until it syncs.
		expect(
			(await readFile(join(frontend.path, "shared.ts"), "utf8")).trim(),
		).toBe("base");
		await manager.sync(frontend);
		expect(
			(await readFile(join(frontend.path, "shared.ts"), "utf8")).trim(),
		).toBe("from backend");
		// A dirty workspace must not be merged into by the sync.
		await writeFile(join(frontend.path, "draft.ts"), "uncommitted\n");
		await expect(manager.sync(frontend)).rejects.toThrow(WorktreeError);
		await manager.discard(backend);
		await manager.discard(frontend);
	});

	test("discarding a chat workspace can drop its branch too", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(join(root, "file.txt"), "base\n");
		await run(["add", "."]);
		await run(["commit", "-m", "initial"]);
		const manager = new WorktreeManager({ home });
		const kept = await manager.create({
			projectPath: root,
			projectId: "project-drop",
			taskId: "chat-kept",
		});
		const dropped = await manager.create({
			projectPath: root,
			projectId: "project-drop",
			taskId: "chat-dropped",
		});
		await manager.discard(kept);
		await manager.discard(dropped, { deleteBranch: true });
		const branches = await run(["branch", "--list", "loom/chat-*"]);
		// Kanban-style removal keeps the branch for later inspection; an abandoned
		// chat tab must not leave an unreachable branch behind.
		expect(branches.stdout).toContain("loom/chat-kept");
		expect(branches.stdout).not.toContain("loom/chat-dropped");
	});

	test("links installed dependencies into a new workspace", async () => {
		root = await mkdtemp(join(tmpdir(), "loom-repository-"));
		home = await mkdtemp(join(tmpdir(), "loom-home-"));
		const run = async (args: string[], cwd = root) => {
			const process = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				stdout: await new Response(process.stdout).text(),
				stderr: await new Response(process.stderr).text(),
				exitCode: await process.exited,
			};
		};
		await run(["init", "-b", "main"]);
		await run(["config", "user.name", "Loom"]);
		await run(["config", "user.email", "loom@example.test"]);
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
		);
		await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
		await mkdir(join(root, "apps", "web", "node_modules", "vite"), {
			recursive: true,
		});
		await mkdir(join(root, "apps", "web", "src"), { recursive: true });
		await writeFile(join(root, "apps", "web", "src", "app.ts"), "app\n");
		await run(["add", "."]);
		await run(["commit", "-m", "initial"]);
		expect(await dependencyDirectories(root)).toEqual([
			"apps/web/node_modules",
			"node_modules",
		]);
		const manager = new WorktreeManager({ home });
		const workspace = await manager.create({
			projectPath: root,
			projectId: "project-deps",
			taskId: "chat-deps",
		});
		const linked = await manager.prepareDependencies(workspace);
		expect(linked.map((entry) => entry.path)).toEqual([
			"apps/web/node_modules",
			"node_modules",
		]);
		expect(
			(await stat(join(workspace.path, "node_modules"))).isDirectory(),
		).toBe(true);
		// Linked installs stay invisible to Git so checkpoint/merge/remove still work.
		expect((await manager.inspectHead(workspace)).clean).toBe(true);
		await writeFile(join(workspace.path, "feature.ts"), "new\n");
		const sha = await manager.checkpoint(workspace, "feat: isolated work");
		expect(sha).not.toBe("");
		await manager.merge(workspace, undefined, { keepWorkspace: true });
		await manager.discard(workspace);
	});
});
