import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDb,
	customAgents,
	eq,
	projectRepository,
	tasks as taskTable,
} from "@loom/db";
import { createAgentSettingsRoutes } from "../src/agents";

const directories: string[] = [];

async function fixture(providerStatus = "connected") {
	const directory = await mkdtemp(join(tmpdir(), "loom-agents-"));
	directories.push(directory);
	const db = createDb({ DATABASE_URL: `file:${join(directory, "state.db")}` });
	const projects = projectRepository(db);
	const project = await projects.create({
		name: "agent-test",
		path: join(directory, "project"),
		defaultBranch: "main",
	});
	let resolvePrompt!: (input: {
		model?: { providerID: string; modelID: string };
	}) => void;
	const promptCaptured = new Promise<{
		model?: { providerID: string; modelID: string };
	}>((resolve) => {
		resolvePrompt = resolve;
	});
	const runtime = {
		createSession: async () => ({ id: "session-1" }),
		prompt: async (input: {
			model?: { providerID: string; modelID: string };
		}) => {
			resolvePrompt(input);
		},
		wait: async () => "completed" as const,
		readOutput: async () => ({ output: "done" }),
		abort: async () => {},
		getDiff: async () => "",
	};
	const providers = {
		get: () => ({ status: providerStatus }),
		registry: {
			require: (id: string) => ({
				definition: { id, capabilities: ["custom-model"] },
				getRuntime: () => runtime,
			}),
		},
		catalog: {
			listByProvider: () => [
				{
					name: "model-1",
					displayName: "Model 1",
					metadata: { modelId: "model-1" },
				},
			],
		},
	} as never;
	const app = createAgentSettingsRoutes({
		db,
		projects,
		tasks: { getById: async () => undefined, update: async () => [] },
		startTask: async () => {},
		enqueueAndWait: async () => {},
		retryTask: async () => {},
		cancelTask: async () => {},
		providers,
	});
	return { db, app, project, promptCaptured };
}

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

describe("custom agent settings", () => {
	test("serves Loom's built-in role prompt presets", async () => {
		const { app } = await fixture();
		const response = await app.request("/prompt-presets");
		expect(response.status).toBe(200);
		const presets = (await response.json()) as Record<string, string>;
		expect(presets.frontend).toContain("Frontend Agent Instructions");
		expect(presets.backend).toContain("Backend Agent Instructions");
		expect(presets.fullstack).toContain("Fullstack Agent Instructions");
		expect(presets.qa).toContain("Quality Assurance Agent Instructions");
		expect(presets.pm).toContain("Project Manager Agent Instructions");
		expect(presets.uiux).toContain("UI/UX Design Assistant");
		expect(presets.custom).toContain("Coding Agent Instructions");
		expect(presets.fullstack).not.toBe(presets.frontend);
	});

	test("persists agent runtime, skill, surface, and approval settings", async () => {
		const { app, project } = await fixture();
		const response = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectId: project.id,
				label: "Backend Builder",
				role: "backend",
				provider: "claude",
				modelId: "model-1",
				allowChat: false,
				allowCanvas: false,
				allowKanban: false,
				approvalPolicy: "ask_before_write",
				executionMode: "on_demand",
				skills: [
					{
						name: "API review",
						source: "custom",
						instructions:
							"Review handlers and tests before changing public behavior.",
						enabled: true,
						allowChat: true,
						allowCanvas: false,
						allowKanban: true,
						canReadFiles: true,
						canWriteFiles: false,
						canRunTests: true,
						canUseNetwork: false,
					},
				],
			}),
		});
		expect(response.status).toBe(201);
		const created = (await response.json()) as {
			id: string;
			label: string;
			modelId: string;
			allowChat: boolean;
			allowCanvas: boolean;
			allowKanban: boolean;
			skills: Array<{ canWriteFiles: boolean }>;
		};
		expect(created.label).toBe("Backend Builder");
		expect(created.modelId).toBe("model-1");
		expect(created.allowChat).toBe(false);
		expect(created.allowCanvas).toBe(false);
		expect(created.allowKanban).toBe(false);
		expect(created.skills).toHaveLength(1);
		expect(created.skills[0]?.canWriteFiles).toBe(false);
		const updated = await app.request(`/${created.id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectId: project.id,
				label: "Backend Builder",
				role: "backend",
				provider: "claude",
				modelId: "model-1",
				allowChat: true,
				allowCanvas: true,
				allowKanban: true,
				approvalPolicy: "ask_before_write",
				executionMode: "on_demand",
				skills: [{ name: "API review", instructions: "Review safely." }],
			}),
		});
		expect(updated.status).toBe(200);
		expect(await updated.json()).toMatchObject({
			allowChat: true,
			allowCanvas: true,
			allowKanban: true,
		});
		expect((await app.request(`/?projectId=${project.id}`)).status).toBe(200);
		expect((await app.request("/runs")).status).toBe(200);
	});

	test("blocks Kanban assignment for agents without Kanban access", async () => {
		const { app, project } = await fixture();
		const response = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectId: project.id,
				label: "Chat only agent",
				role: "backend",
				provider: "claude",
				allowChat: true,
				allowCanvas: false,
				allowKanban: false,
				approvalPolicy: "read_only",
				skills: [{ name: "Review", instructions: "Review code safely." }],
			}),
		});
		const agent = (await response.json()) as { id: string };
		const assignment = await app.request("/assignments", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: agent.id,
				projectId: project.id,
				taskId: "task-not-needed-for-surface-check",
			}),
		});
		expect(assignment.status).toBe(403);
	});

	test("passes a configured custom model alias to the selected provider runtime", async () => {
		const { app, project, promptCaptured } = await fixture();
		const created = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectId: project.id,
				label: "Alias model agent",
				role: "backend",
				provider: "claude",
				modelId: "team/claude-code-alias",
				allowChat: true,
				allowCanvas: false,
				allowKanban: true,
				approvalPolicy: "read_only",
				skills: [{ name: "Review", instructions: "Review safely." }],
			}),
		});
		expect(created.status).toBe(201);
		const agent = (await created.json()) as { id: string };
		const run = await app.request("/runs/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: agent.id,
				projectId: project.id,
				message: "Run with the configured alias.",
			}),
		});
		expect(run.status).toBe(202);
		const prompt = await promptCaptured;
		expect(prompt.model).toEqual({
			providerID: "claude",
			modelID: "team/claude-code-alias",
		});
	});

	test("rejects unsafe Canvas skills, empty skills, and unavailable providers", async () => {
		const { app, project } = await fixture();
		const base = {
			projectId: project.id,
			label: "Safe Designer",
			role: "uiux",
			provider: "claude",
			allowChat: true,
			allowCanvas: true,
			allowKanban: true,
			approvalPolicy: "read_only",
			executionMode: "on_demand",
		};
		const unsafe = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...base,
				skills: [
					{
						name: "Unsafe",
						instructions: "Design safely.",
						enabled: true,
						allowCanvas: true,
						canWriteFiles: true,
					},
				],
			}),
		});
		expect(unsafe.status).toBe(400);
		const empty = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...base, skills: [] }),
		});
		expect(empty.status).toBe(400);
		const disconnected = await fixture("disconnected");
		const unavailable = await disconnected.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...base,
				projectId: disconnected.project.id,
				skills: [
					{ name: "Read", instructions: "Read relevant files.", enabled: true },
				],
			}),
		});
		expect(unavailable.status).toBe(400);
		const customRole = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...base,
				label: "Assistant specialist",
				role: "ASISTEN",
				skills: [{ name: "Review", instructions: "Review code changes." }],
			}),
		});
		expect(customRole.status).toBe(201);
		expect(((await customRole.json()) as { role: string }).role).toBe(
			"ASISTEN",
		);
	});

	test("runs only the bounded task filter and returns the same run for an idempotent retry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "loom-agent-continuous-"));
		directories.push(directory);
		const db = createDb({
			DATABASE_URL: `file:${join(directory, "continuous.db")}`,
		});
		const project = await projectRepository(db).create({
			name: "continuous",
			path: join(directory, "project"),
			defaultBranch: "main",
		});
		const taskIds = ["continuous-task-1", "continuous-task-2"];
		for (const [index, id] of taskIds.entries())
			await db.insert(taskTable).values({
				id,
				projectId: project.id,
				title: `Task ${index + 1}`,
				prompt: `Implement task ${index + 1}`,
				status: "queued",
			});
		await db.insert(customAgents).values({
			id: "continuous-agent",
			projectId: project.id,
			label: "Continuous agent",
			role: "backend",
			provider: "opencode",
			status: "active",
			executionMode: "continuous_kanban",
			allowKanban: true,
		});
		const invoked: string[] = [];
		const retried: string[] = [];
		const attempts = new Map<string, number>();
		const app = createAgentSettingsRoutes({
			db,
			projects: projectRepository(db),
			tasks: {
				getById: async (id) =>
					(await db.query.tasks.findFirst({ where: eq(taskTable.id, id) })) ??
					null,
				update: (id, input) =>
					db.update(taskTable).set(input).where(eq(taskTable.id, id)),
			},
			startTask: async () => {},
			enqueueAndWait: async (id) => {
				invoked.push(id);
				const attempt = (attempts.get(id) ?? 0) + 1;
				attempts.set(id, attempt);
				await db
					.update(taskTable)
					.set({ status: attempt === 1 ? "failed" : "ready_to_merge" })
					.where(eq(taskTable.id, id));
			},
			retryTask: async (id) => {
				retried.push(id);
				await db
					.update(taskTable)
					.set({ status: "ready_to_merge" })
					.where(eq(taskTable.id, id));
			},
			cancelTask: async () => {},
			providers: {} as never,
		});
		const headers = { "content-type": "application/json" };
		const assigned = await app.request("/assignments", {
			method: "POST",
			headers,
			body: JSON.stringify({
				agentId: "continuous-agent",
				projectId: project.id,
				taskId: taskIds[0],
				continuousEnabled: true,
			}),
		});
		expect(assigned.status).toBe(201);
		const assignmentId = ((await assigned.json()) as { id: string }).id;
		const requestBody = {
			taskIds,
			maxTasks: 2,
			concurrency: 2,
			durationMinutes: 1,
			maxRetries: 1,
			idempotencyKey: "continuous-run-key-1",
		};
		const started = await app.request(`/assignments/${assignmentId}/continue`, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});
		expect(started.status).toBe(202);
		const startedRun = (await started.json()) as { id: string };
		let run: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			const listed = await app.request(`/assignments/${assignmentId}/runs`);
			run = ((await listed.json()) as Array<Record<string, unknown>>)[0];
			if (
				run?.status === "paused" ||
				run?.status === "completed" ||
				run?.status === "failed"
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(run).toMatchObject({
			id: startedRun.id,
			status: "paused",
			completedTasks: 2,
			currentTaskIdsJson: "[]",
		});
		expect(invoked.sort()).toEqual([...taskIds].sort());
		expect(retried.sort()).toEqual([...taskIds].sort());
		const retry = await app.request(`/assignments/${assignmentId}/continue`, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});
		expect(retry.status).toBe(200);
		expect(((await retry.json()) as { id: string }).id).toBe(startedRun.id);
	});
});
