import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, repositories } from "@loom/db";
import type { AgentRunStatus, AgentRuntime } from "@loom/opencode";
import { TaskOrchestrator } from "@loom/orchestrator";
import { WorktreeManager } from "@loom/worktree";
import type { DaemonConfig } from "./config";
import { createApp } from "./index";

const config: DaemonConfig = {
	port: 4317,
	corsOrigin: "http://localhost:5173",
	token: "test-token",
};

async function runGit(args: string[], cwd: string) {
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
}

async function createRepository() {
	const root = await mkdtemp(join(tmpdir(), "loom-server-repository-"));
	await runGit(["init", "-b", "main"], root);
	await runGit(["config", "user.name", "Loom"], root);
	await runGit(["config", "user.email", "loom@example.test"], root);
	await writeFile(join(root, "README.md"), "initial\n");
	await runGit(["add", "README.md"], root);
	await runGit(["commit", "-m", "initial"], root);
	return root;
}

class FakeAgentRuntime implements AgentRuntime {
	private readonly sessions = new Map<
		string,
		{ cwd: string; status: AgentRunStatus }
	>();
	private nextId = 0;

	async createSession(input: { cwd: string; title: string }) {
		const id = `fake-session-${++this.nextId}`;
		this.sessions.set(id, { cwd: input.cwd, status: "queued" });
		return { id };
	}

	async prompt(input: { sessionId: string; prompt: string }) {
		const session = this.sessions.get(input.sessionId);
		if (!session) throw new Error("Fake session not found");
		await writeFile(join(session.cwd, "agent.txt"), `${input.prompt}\n`);
		await runGit(["add", "agent.txt"], session.cwd);
		await runGit(["commit", "-m", "agent change"], session.cwd);
		session.status = "completed";
	}

	async status(sessionId: string) {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Fake session not found");
		return session.status;
	}

	async wait(
		sessionId: string,
	): Promise<
		Exclude<AgentRunStatus, "queued" | "running" | "waiting_permission">
	> {
		const status = await this.status(sessionId);
		if (status === "completed" || status === "failed" || status === "cancelled")
			return status;
		throw new Error("Fake agent did not finish");
	}

	async abort(sessionId: string) {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Fake session not found");
		session.status = "cancelled";
	}

	async getDiff(sessionId: string) {
		return this.sessions.get(sessionId) ? [] : [];
	}
}

async function createTestSetup() {
	const root = await createRepository();
	const home = await mkdtemp(join(tmpdir(), "loom-server-home-"));
	const databasePath = join(home, "state.db");
	const database = createDb({ DATABASE_URL: `file:${databasePath}` });
	const repos = repositories(database);
	const project = await repos.projects.create({
		id: "project-1",
		name: "repository",
		path: root,
		defaultBranch: "main",
	});
	const orchestrator = new TaskOrchestrator({
		projects: repos.projects,
		tasks: repos.tasks,
		workspaces: repos.workspaces,
		agentRuns: repos.agentRuns,
		worktree: new WorktreeManager({ home }),
		runtime: new FakeAgentRuntime(),
	});
	const daemon = await createApp({
		config,
		database,
		orchestrator,
		startOpenCode: false,
	});
	return { daemon, database, home, root, project };
}

describe("server API", () => {
	test("rejects invalid and accepts valid daemon auth", async () => {
		const setup = await createTestSetup();
		try {
			expect((await setup.daemon.app.request("/api/projects")).status).toBe(
				401,
			);
			const response = await setup.daemon.app.request("/api/projects", {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(response.status).toBe(200);
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
			await rm(setup.home, { recursive: true, force: true });
		}
	});

	test("validates project CRUD and task input", async () => {
		const setup = await createTestSetup();
		const headers = {
			Authorization: "Bearer test-token",
			"Content-Type": "application/json",
		};
		try {
			const invalid = await setup.daemon.app.request("/api/projects", {
				method: "POST",
				headers,
				body: JSON.stringify({ path: "/missing" }),
			});
			expect(invalid.status).toBe(400);
			const projects = await setup.daemon.app.request("/api/projects", {
				headers,
			});
			const projectList = (await projects.json()) as unknown[];
			expect(projectList.length).toBe(1);
			const invalidTask = await setup.daemon.app.request("/api/tasks", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					title: "",
					prompt: "x",
				}),
			});
			expect(invalidTask.status).toBe(400);
			const missing = await setup.daemon.app.request("/api/projects/missing", {
				headers,
			});
			expect(missing.status).toBe(404);
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
			await rm(setup.home, { recursive: true, force: true });
		}
	});

	test("renames, reorders, and deletes tasks", async () => {
		const setup = await createTestSetup();
		const headers = {
			Authorization: "Bearer test-token",
			"Content-Type": "application/json",
		};
		const create = async (title: string) => {
			const response = await setup.daemon.app.request("/api/tasks", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					title,
					prompt: title,
				}),
			});
			expect(response.status).toBe(201);
			return (await response.json()) as { id: string; position: number | null };
		};
		try {
			const first = await create("First");
			const second = await create("Second");
			expect(second.position).toBe((first.position ?? -1) + 1);
			const renamed = await setup.daemon.app.request(`/api/tasks/${first.id}`, {
				method: "PATCH",
				headers,
				body: JSON.stringify({ title: "Renamed" }),
			});
			expect(renamed.status).toBe(200);
			expect(((await renamed.json()) as { title: string }).title).toBe(
				"Renamed",
			);
			const empty = await setup.daemon.app.request(`/api/tasks/${first.id}`, {
				method: "PATCH",
				headers,
				body: JSON.stringify({}),
			});
			expect(empty.status).toBe(500);
			const reordered = await setup.daemon.app.request(
				`/api/projects/${setup.project.id}/tasks/reorder`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ orderedIds: [second.id, first.id] }),
				},
			);
			expect(reordered.status).toBe(200);
			const mismatch = await setup.daemon.app.request(
				`/api/projects/${setup.project.id}/tasks/reorder`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ orderedIds: [first.id] }),
				},
			);
			expect(mismatch.status).toBe(500);
			const deleted = await setup.daemon.app.request(`/api/tasks/${first.id}`, {
				method: "DELETE",
				headers,
			});
			expect(deleted.status).toBe(204);
			expect(
				(
					await setup.daemon.app.request(`/api/tasks/${first.id}`, {
						headers,
					})
				).status,
			).toBe(404);
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
			await rm(setup.home, { recursive: true, force: true });
		}
	});

	test("creates and cancels a queued task", async () => {
		const setup = await createTestSetup();
		const headers = {
			Authorization: "Bearer test-token",
			"Content-Type": "application/json",
		};
		try {
			const created = await setup.daemon.app.request("/api/tasks", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					title: "Cancel",
					prompt: "stop",
				}),
			});
			const task = (await created.json()) as { id: string };
			const cancelled = await setup.daemon.app.request(
				`/api/tasks/${task.id}/cancel`,
				{ method: "POST", headers },
			);
			expect(cancelled.status).toBe(200);
			const result = await setup.daemon.app.request(`/api/tasks/${task.id}`, {
				headers,
			});
			const cancelledTask = (await result.json()) as { status: string };
			expect(cancelledTask.status).toBe("cancelled");
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
			await rm(setup.home, { recursive: true, force: true });
		}
	});

	test("runs register to mutation, diff, merge, and verifies main", async () => {
		const setup = await createTestSetup();
		const headers = {
			Authorization: "Bearer test-token",
			"Content-Type": "application/json",
		};
		try {
			const created = await setup.daemon.app.request("/api/tasks", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					title: "Change",
					prompt: "hello",
				}),
			});
			expect(created.status).toBe(201);
			const task = (await created.json()) as { id: string };
			expect(
				(
					await setup.daemon.app.request(`/api/tasks/${task.id}/start`, {
						method: "POST",
						headers,
					})
				).status,
			).toBe(200);
			// Start acknowledges enqueueing; completion is asynchronous.
			let completedTask: { status: string } = { status: "queued" };
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const response = await setup.daemon.app.request(
					`/api/tasks/${task.id}`,
					{ headers },
				);
				completedTask = (await response.json()) as { status: string };
				if (["completed", "failed", "cancelled"].includes(completedTask.status))
					break;
				await Bun.sleep(20);
			}
			expect(completedTask.status).toBe("completed");
			const diff = await setup.daemon.app.request(
				`/api/tasks/${task.id}/diff`,
				{ headers },
			);
			const diffBody = (await diff.json()) as { diff: string };
			expect(diffBody.diff).toContain("agent.txt");
			expect(
				(
					await setup.daemon.app.request(`/api/tasks/${task.id}/merge`, {
						method: "POST",
						headers,
					})
				).status,
			).toBe(200);
			expect(await readFile(join(setup.root, "agent.txt"), "utf8")).toBe(
				"hello\n",
			);
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
			await rm(setup.home, { recursive: true, force: true });
		}
	});

	test("maps missing task errors and protects bootstrap origin", async () => {
		const setup = await createTestSetup();
		try {
			const headers = { Authorization: "Bearer test-token" };
			expect(
				(await setup.daemon.app.request("/api/tasks/missing", { headers }))
					.status,
			).toBe(404);
			expect((await setup.daemon.app.request("/api/bootstrap")).status).toBe(
				401,
			);
			expect(
				(
					await setup.daemon.app.request("/api/bootstrap", {
						headers: { Origin: config.corsOrigin },
					})
				).status,
			).toBe(200);
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
			await rm(setup.home, { recursive: true, force: true });
		}
	});

	test("maps epic validation and missing-epic errors to JSON responses", async () => {
		const setup = await createTestSetup();
		const headers = {
			Authorization: "Bearer test-token",
			"Content-Type": "application/json",
		};
		try {
			const invalid = await setup.daemon.app.request("/api/epics", {
				method: "POST",
				headers,
				body: JSON.stringify({ title: "Missing fields" }),
			});
			expect(invalid.status).toBe(400);
			const invalidBody = (await invalid.json()) as {
				error: { code: string };
			};
			expect(invalidBody.error.code).toBe("VALIDATION_ERROR");
			const missing = await setup.daemon.app.request("/api/epics/missing", {
				headers,
			});
			expect(missing.status).toBe(404);
			const missingBody = (await missing.json()) as {
				error: { code: string };
			};
			expect(missingBody.error.code).toBe("NOT_FOUND");
			const start = await setup.daemon.app.request("/api/epics/missing/start", {
				method: "POST",
				headers,
			});
			expect(start.status).toBe(404);
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
			await rm(setup.home, { recursive: true, force: true });
		}
	});

	test("broadcasts events only after websocket token validation when supported", async () => {
		const setup = await createTestSetup();
		try {
			expect((await setup.daemon.app.request("/api/events")).status).toBe(401);
			expect(
				(await setup.daemon.app.request("/api/events?token=test-token")).status,
			).not.toBe(401);
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
			await rm(setup.home, { recursive: true, force: true });
		}
	});
});
