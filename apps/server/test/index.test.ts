import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, customAgents, repositories } from "@loom/db";
import type { AgentRunStatus, AgentRuntime } from "@loom/opencode";
import { TaskOrchestrator } from "@loom/orchestrator";
import { WorktreeManager } from "@loom/worktree";
import type { DaemonConfig } from "../src/config";
import { createApp } from "../src/index";

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
	readonly sessionCwds: string[] = [];
	activePrompts = 0;
	maxConcurrentPrompts = 0;
	private readonly sessions = new Map<
		string,
		{ cwd: string; status: AgentRunStatus; title: string; output?: string }
	>();
	private nextId = 0;

	async createSession(input: { cwd: string; title: string }) {
		const id = `fake-session-${++this.nextId}`;
		this.sessionCwds.push(input.cwd);
		this.sessions.set(id, {
			cwd: input.cwd,
			status: "queued",
			title: input.title,
		});
		return { id };
	}

	async prompt(input: { sessionId: string; prompt: string }) {
		const session = this.sessions.get(input.sessionId);
		if (!session) throw new Error("Fake session not found");
		this.activePrompts++;
		this.maxConcurrentPrompts = Math.max(
			this.maxConcurrentPrompts,
			this.activePrompts,
		);
		await Bun.sleep(30);
		if (session.title.startsWith("Review:")) {
			// Decide from the checkpoint diff: the task brief re-embeds the
			// previous findings after every repair round, so the review must look
			// at the fixed output, not the finding text.
			const checkpointDiff =
				input.prompt.split("Checkpoint diff:").at(-1) ?? "";
			const hasRaceBug = checkpointDiff.includes("BUG_RACE");
			session.output = JSON.stringify({
				decision: hasRaceBug ? "request_changes" : "approve",
				summary: hasRaceBug ? "Race condition found" : "All checks passed",
				findings: hasRaceBug
					? [
							{
								severity: "high",
								file: "backend-race.txt",
								message: "BUG_RACE: protect shared update with a lock",
								suggestedAction: "Add a lock around the update",
							},
						]
					: [],
			});
			session.status = "completed";
			this.activePrompts--;
			return;
		}
		const content = input.prompt.includes("Repair round")
			? "FIXED_RACE\n"
			: session.title.toLowerCase().includes("race")
				? "BUG_RACE\n"
				: `${input.prompt}\n`;
		const titleSlug = session.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
		const fileName = session.title.toLowerCase().includes("race")
			? "backend-race.txt"
			: /^(backend|frontend)-/.test(titleSlug)
				? `${titleSlug}.txt`
				: "agent.txt";
		await writeFile(join(session.cwd, fileName), content);
		await runGit(["add", "agent.txt"], session.cwd);
		if (fileName !== "agent.txt") await runGit(["add", fileName], session.cwd);
		await runGit(
			[
				"commit",
				"-m",
				session.title.startsWith("Review:") ? "review" : "agent change",
			],
			session.cwd,
		);
		session.status = "completed";
		this.activePrompts--;
	}

	async readOutput(sessionId: string) {
		return { output: this.sessions.get(sessionId)?.output ?? "" };
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

async function createTestSetup(options: { allowAutoMerge?: boolean } = {}) {
	const root = await createRepository();
	// The home keeps the WAL database. A daemon that is shutting down can still
	// write to it, and deleting a live WAL file breaks those writes on macOS, so
	// the temporary home is left for the operating system to reclaim.
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
	const runtime = new FakeAgentRuntime();
	const reviewerRuntime = new FakeAgentRuntime();
	await database.insert(customAgents).values({
		id: "kanban-test-agent",
		projectId: project.id,
		label: "Test agent",
		role: "backend",
		provider: "opencode",
		status: "active",
		allowKanban: true,
	});
	await database.insert(customAgents).values({
		id: "kanban-test-frontend-agent",
		projectId: project.id,
		label: "Test frontend agent",
		role: "frontend",
		provider: "opencode",
		status: "active",
		allowKanban: true,
	});
	const orchestrator = new TaskOrchestrator({
		...repos,
		reviews: repos.taskReviews,
		artifacts: repos.taskArtifacts,
		integrationLeases: repos.integrationLeases,
		worktree: new WorktreeManager({ home }),
		runtime,
		reviewPolicies: repos.reviewPolicies,
		allowAutoMerge: options.allowAutoMerge,
		resolveReviewerExecutor: async () => ({
			runtime: reviewerRuntime,
			providerId: "fake-reviewer",
			modelId: null,
			snapshot: { kind: "direct", providerId: "fake-reviewer" },
		}),
	});
	const daemon = await createApp({
		config,
		database,
		orchestrator,
		plannerRuntime: new FakeAgentRuntime(),
		startOpenCode: false,
		initializeProviders: false,
	});
	return {
		daemon,
		database,
		home,
		root,
		project,
		repos,
		runtime,
		reviewerRuntime,
	};
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
		}
	});

	test("normalizes provider and local connection IDs in provider routes", async () => {
		const setup = await createTestSetup();
		try {
			const headers = { Authorization: "Bearer test-token" };
			const refresh = await setup.daemon.app.request(
				"/api/providers/opencode:local/refresh",
				{ method: "POST", headers },
			);
			expect(refresh.status).toBe(200);
			const refreshed = (await refresh.json()) as {
				providerId: string;
				id: string;
			};
			expect(refreshed.providerId).toBe("opencode");
			expect(refreshed.id).toBe("opencode:local");

			const models = await setup.daemon.app.request(
				"/api/providers/opencode:local/models",
				{ headers },
			);
			expect(models.status).toBe(200);
			const modelList = (await models.json()) as Array<{
				providerId: string;
				connectionId: string;
			}>;
			expect(
				modelList.every(
					(model) =>
						model.providerId === "opencode" &&
						model.connectionId === "opencode:local",
				),
			).toBe(true);

			const disconnected = await setup.daemon.app.request(
				"/api/providers/opencode:local/disconnect",
				{ method: "POST", headers },
			);
			expect(disconnected.status).toBe(200);
			expect(
				(await disconnected.json()) as {
					connection: { providerId: string; id: string; status: string };
				},
			).toMatchObject({
				connection: {
					providerId: "opencode",
					id: "opencode:local",
					status: "disconnected",
				},
			});
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
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
			const batches = await setup.daemon.app.request(
				`/api/integration-batches?projectId=${setup.project.id}`,
				{ headers },
			);
			expect(batches.status).toBe(200);
			expect(await batches.json()).toEqual({ batches: [] });
			const policyUrl = `/api/projects/${setup.project.id}/review-policy`;
			const initialPolicy = await setup.daemon.app.request(policyUrl, {
				headers,
			});
			expect(
				((await initialPolicy.json()) as { policy: { mode: string } }).policy
					.mode,
			).toBe("manual");
			const updatedPolicy = await setup.daemon.app.request(policyUrl, {
				method: "PUT",
				headers,
				body: JSON.stringify({
					mode: "manual",
					reviewerExecutorJson: null,
					autoMerge: false,
					requiredChecksJson: "[]",
					maxRevisionRounds: 2,
				}),
			});
			expect(updatedPolicy.status).toBe(200);
			expect(
				((await updatedPolicy.json()) as { policy: { version: number } }).policy
					.version,
			).toBe(1);
			const unsafePolicy = await setup.daemon.app.request(policyUrl, {
				method: "PUT",
				headers,
				body: JSON.stringify({
					mode: "manual",
					reviewerExecutorJson: null,
					autoMerge: true,
					requiredChecksJson: "[]",
					maxRevisionRounds: 2,
				}),
			});
			expect(unsafePolicy.status).toBe(400);
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
		}
	});

	test("returns pinned executor and target branch without exposing raw config", async () => {
		const setup = await createTestSetup();
		const headers = { Authorization: "Bearer test-token" };
		try {
			await setup.repos.tasks.create({
				id: "task-config",
				projectId: setup.project.id,
				title: "Pinned task",
				prompt: "Implement",
				status: "queued",
				description: "",
				priority: "medium",
				acceptanceCriteria: "[]",
				suggestedFiles: "[]",
				source: "manual",
				executorConfig: JSON.stringify({
					kind: "direct",
					providerId: "agy",
					modelId: "model-x",
				}),
				targetBranch: "main",
				workspaceId: null,
				sessionId: null,
				startedAt: null,
				completedAt: null,
			});
			const response = await setup.daemon.app.request(
				"/api/tasks/task-config",
				{ headers },
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				id: "task-config",
				executor: { kind: "direct", providerId: "agy", modelId: "model-x" },
				targetBranch: "main",
				acceptanceCriteria: [],
				suggestedFiles: [],
			});
			expect(
				await (
					await setup.daemon.app.request("/api/tasks/task-config", { headers })
				).text(),
			).not.toContain("executorConfig");
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
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
					acceptanceCriteria: [`${title} works`],
					executor: { kind: "agent", agentId: "kanban-test-agent" },
					targetBranch: "main",
				}),
			});
			expect(response.status).toBe(201);
			return (await response.json()) as {
				id: string;
				position: number | null;
				targetBranch: string | null;
			};
		};
		try {
			const first = await create("First");
			const second = await create("Second");
			expect(first.targetBranch).toBe("main");
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
					acceptanceCriteria: ["Task is queued"],
					executor: { kind: "agent", agentId: "kanban-test-agent" },
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
					acceptanceCriteria: ["agent.txt contains the prompt"],
					executor: { kind: "agent", agentId: "kanban-test-agent" },
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
					await setup.daemon.app.request(`/api/tasks/${task.id}/checkpoint`, {
						method: "POST",
						headers,
					})
				).status,
			).toBe(200);
			const reviewResponse = await setup.daemon.app.request(
				`/api/tasks/${task.id}/review/approve`,
				{ method: "POST", headers },
			);
			expect(reviewResponse.status).toBe(201);
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
		}
	});

	test("runs four independent Kanban tasks in isolated worktrees and repairs a reviewed race bug", async () => {
		const setup = await createTestSetup({ allowAutoMerge: true });
		const headers = {
			Authorization: "Bearer test-token",
			"Content-Type": "application/json",
		};
		try {
			const previousAutoMergeFlag = process.env.LOOM_ENABLE_KANBAN_AUTO_MERGE;
			process.env.LOOM_ENABLE_KANBAN_AUTO_MERGE = "true";
			const policy = await setup.daemon.app.request(
				`/api/projects/${setup.project.id}/review-policy`,
				{
					method: "PUT",
					headers,
					body: JSON.stringify({
						mode: "automatic",
						reviewerExecutorJson: JSON.stringify({
							kind: "direct",
							providerId: "fake-reviewer",
							modelId: null,
						}),
						autoMerge: true,
						requiredChecksJson: "[]",
						maxRevisionRounds: 2,
					}),
				},
			);
			if (previousAutoMergeFlag === undefined)
				delete process.env.LOOM_ENABLE_KANBAN_AUTO_MERGE;
			else process.env.LOOM_ENABLE_KANBAN_AUTO_MERGE = previousAutoMergeFlag;
			expect(policy.status).toBe(200);
			const taskIds: string[] = [];
			for (const [title, agentId] of [
				["Backend race condition", "kanban-test-agent"],
				["Backend API endpoint", "kanban-test-agent"],
				["Frontend form validation", "kanban-test-frontend-agent"],
				["Frontend loading state", "kanban-test-frontend-agent"],
			] as const) {
				const created = await setup.daemon.app.request("/api/tasks", {
					method: "POST",
					headers,
					body: JSON.stringify({
						projectId: setup.project.id,
						title,
						prompt: `Implement ${title}`,
						acceptanceCriteria: [`${title} is implemented`],
						executor: { kind: "agent", agentId },
					}),
				});
				expect(created.status).toBe(201);
				taskIds.push(((await created.json()) as { id: string }).id);
			}
			await Promise.all(
				taskIds.map((id) =>
					setup.daemon.app.request(`/api/tasks/${id}/start`, {
						method: "POST",
						headers,
					}),
				),
			);
			for (const id of taskIds) {
				let status = "queued";
				const terminalForCheckpoint = new Set(["completed", "ready_to_merge"]);
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline && !terminalForCheckpoint.has(status)) {
					const response = await setup.daemon.app.request(`/api/tasks/${id}`, {
						headers,
					});
					status = ((await response.json()) as { status: string }).status;
					if (!terminalForCheckpoint.has(status)) await Bun.sleep(20);
				}
				expect([...terminalForCheckpoint]).toContain(status);
				const checkpoint = await setup.daemon.app.request(
					`/api/tasks/${id}/checkpoint`,
					{
						method: "POST",
						headers,
					},
				);
				expect(checkpoint.status).toBe(200);
				expect(
					((await checkpoint.json()) as { review?: { status: string } }).review
						?.status,
				).toBe("approved");
			}

			for (const id of taskIds) {
				const reviewedTask = await setup.daemon.app.request(
					`/api/tasks/${id}`,
					{ headers },
				);
				expect(((await reviewedTask.json()) as { status: string }).status).toBe(
					"completed",
				);
			}
			const reviewedTask = await setup.daemon.app.request(
				`/api/tasks/${taskIds[0]}`,
				{ headers },
			);
			expect(((await reviewedTask.json()) as { status: string }).status).toBe(
				"completed",
			);
			expect(await readFile(join(setup.root, "backend-race.txt"), "utf8")).toBe(
				"FIXED_RACE\n",
			);

			const distinctWorktrees = new Set(setup.runtime.sessionCwds);
			expect(taskIds).toHaveLength(4);
			expect(setup.runtime.sessionCwds).toHaveLength(5);
			expect(setup.reviewerRuntime.sessionCwds).toHaveLength(5);
			expect(distinctWorktrees.size).toBe(4);
			expect(setup.runtime.maxConcurrentPrompts).toBeGreaterThan(1);
			expect([...distinctWorktrees].every((path) => path !== setup.root)).toBe(
				true,
			);
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
		}
		// Four real worktrees plus two review merges need more than the default budget.
	}, 20_000);

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
			const bootstrap = await setup.daemon.app.request("/api/bootstrap", {
				headers: { Origin: config.corsOrigin },
			});
			expect(bootstrap.status).toBe(200);
			const { token } = (await bootstrap.json()) as { token?: string };
			expect(token).toBe("test-token");
			const sameOriginPost = await setup.daemon.app.request("/api/bootstrap", {
				method: "POST",
				headers: {
					Origin: config.corsOrigin,
					"Content-Type": "application/json",
				},
				body: "{}",
			});
			expect(sameOriginPost.status).toBe(200);
			expect(await sameOriginPost.json()).toEqual({ token: "test-token" });
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
		}
	});

	test("plans flow from draft to started tasks", async () => {
		const setup = await createTestSetup();
		const headers = {
			Authorization: "Bearer test-token",
			"Content-Type": "application/json",
		};
		const call = (path: string, init?: { method?: string; body?: unknown }) =>
			setup.daemon.app.request(path, {
				headers,
				method: init?.method ?? "GET",
				body: init?.body === undefined ? undefined : JSON.stringify(init.body),
			});
		try {
			const invalid = await call("/api/plans", {
				method: "POST",
				body: { projectId: setup.project.id },
			});
			expect(invalid.status).toBe(400);
			const created = await call("/api/plans", {
				method: "POST",
				body: {
					projectId: setup.project.id,
					sourceMessageId: "msg-1",
					message: "Build the widget",
				},
			});
			expect(created.status).toBe(202);
			const { planId } = (await created.json()) as { planId: string };
			let status = "draft";
			const deadline = Date.now() + 10000;
			while (status === "draft" && Date.now() < deadline) {
				await Bun.sleep(50);
				const detail = (await (await call(`/api/plans/${planId}`)).json()) as {
					plan: { status: string };
				};
				status = detail.plan.status;
			}
			expect(status).toBe("failed");
			const badEdit = await call(`/api/plans/${planId}`, {
				method: "PATCH",
				body: {
					tasks: [
						{
							key: "a",
							title: "A",
							description: "Do A.",
							priority: "high",
							dependencies: [],
							acceptanceCriteria: [],
							suggestedFiles: [],
						},
					],
				},
			});
			expect(badEdit.status).toBe(400);
			expect(
				((await badEdit.json()) as { error: { code: string } }).error.code,
			).toBe("BAD_REQUEST");
			const saved = await call(`/api/plans/${planId}`, {
				method: "PATCH",
				body: {
					title: "Widget",
					summary: "Build the widget.",
					tasks: [
						{
							key: "a",
							title: "A",
							description: "Do A.",
							priority: "high",
							dependencies: [],
							acceptanceCriteria: ["A done"],
							suggestedFiles: [],
						},
					],
				},
			});
			expect(saved.status).toBe(200);
			const validated = (await (
				await call(`/api/plans/${planId}/validate`, { method: "POST" })
			).json()) as { ok: boolean };
			expect(validated.ok).toBe(true);
			const early = await call(`/api/plans/${planId}/tasks`, {
				method: "POST",
			});
			expect(early.status).toBe(500);
			expect(
				(await call(`/api/plans/${planId}/approve`, { method: "POST" })).status,
			).toBe(200);
			const converted = await call(`/api/plans/${planId}/tasks`, {
				method: "POST",
			});
			expect(converted.status).toBe(201);
			const first = (await converted.json()) as {
				taskIds: string[];
				converted: boolean;
			};
			expect(first.converted).toBe(true);
			expect(first.taskIds).toHaveLength(1);
			const repeated = (await (
				await call(`/api/plans/${planId}/tasks`, { method: "POST" })
			).json()) as { taskIds: string[]; converted: boolean };
			expect(repeated.converted).toBe(false);
			expect(repeated.taskIds).toEqual(first.taskIds);
			const started = await call(`/api/plans/${planId}/start`, {
				method: "POST",
			});
			expect(started.status).toBe(202);
			const detail = (await (await call(`/api/plans/${planId}`)).json()) as {
				tasks: Array<{ status: string }>;
				progress: { total: number };
			};
			expect(detail.progress.total).toBe(1);
			expect(
				(await call(`/api/projects/${setup.project.id}/plans`)).status,
			).toBe(200);
			const cancellable = await call("/api/plans", {
				method: "POST",
				body: {
					projectId: setup.project.id,
					sourceMessageId: "msg-2",
					message: "Another",
				},
			});
			const other = (await cancellable.json()) as { planId: string };
			expect(
				(await call(`/api/plans/${other.planId}/cancel`, { method: "POST" }))
					.status,
			).toBe(200);
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
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
		}
	});

	test("persists daemon events and replays them by durable cursor", async () => {
		const setup = await createTestSetup();
		const headers = {
			Authorization: "Bearer test-token",
			"Content-Type": "application/json",
		};
		try {
			expect(
				(await setup.daemon.app.request("/api/events/replay")).status,
			).toBe(401);
			const created = await setup.daemon.app.request("/api/tasks", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					title: "Replay cursor task",
					prompt: "Verify event replay",
					acceptanceCriteria: ["event is recoverable"],
					executor: { kind: "agent", agentId: "kanban-test-agent" },
					targetBranch: "main",
				}),
			});
			expect(created.status).toBe(201);
			const latest = await setup.daemon.app.request(
				"/api/events/replay?latest=1",
				{ headers },
			);
			const cursor = ((await latest.json()) as { cursor: number }).cursor;
			expect(cursor).toBeGreaterThan(0);
			const replay = await setup.daemon.app.request(
				"/api/events/replay?after=0&limit=500",
				{ headers },
			);
			const body = (await replay.json()) as {
				events: Array<{
					cursor: number;
					event: { type: string; task?: { title?: string } };
				}>;
				cursor: number;
			};
			expect(body.cursor).toBe(cursor);
			expect(
				body.events.some(
					(item) =>
						item.event.type === "task.created" &&
						item.event.task?.title === "Replay cursor task",
				),
			).toBe(true);
		} finally {
			await setup.daemon.close();
			await rm(setup.root, { recursive: true, force: true });
		}
	});
});
