import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	getWorktreeBranch,
	getWorktreePath,
	validateRepository,
	WorktreeError,
	WorktreeManager,
} from "../src";

describe("worktree paths", () => {
	test("uses the managed path and branch convention", () => {
		expect(getWorktreePath("project-1", "task-1", "/tmp/home")).toBe(
			"/tmp/home/.loom/worktrees/project-1/task-1",
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
		await run(["commit", "-m", "change"], workspace.path);
		await manager.merge(workspace);
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
});
