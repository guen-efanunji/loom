import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, projectRepository } from "@loom/db";
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
	const providers = {
		get: () => ({ status: providerStatus }),
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
		tasks: { getById: async () => undefined },
		providers,
	});
	return { db, app, project };
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
		expect(presets.qa).toContain("QA Agent Instructions");
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
				allowChat: true,
				allowCanvas: false,
				allowKanban: true,
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
			label: string;
			modelId: string;
			skills: Array<{ canWriteFiles: boolean }>;
		};
		expect(created.label).toBe("Backend Builder");
		expect(created.modelId).toBe("model-1");
		expect(created.skills).toHaveLength(1);
		expect(created.skills[0]?.canWriteFiles).toBe(false);
		expect((await app.request(`/?projectId=${project.id}`)).status).toBe(200);
		expect((await app.request("/runs")).status).toBe(200);
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
});
