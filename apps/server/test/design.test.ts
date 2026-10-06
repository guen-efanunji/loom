import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, repositories } from "@loom/db";
import type {
	AgentModel,
	AgentRunStatus,
	AgentRuntime,
	RuntimeOutput,
} from "@loom/opencode";
import type {
	DesignChatResult,
	DesignMessage,
	DesignNode,
} from "@loom/protocol";
import type { DaemonConfig } from "../src/config";
import { createApp } from "../src/index";

const config: DaemonConfig = {
	port: 4317,
	corsOrigin: "http://localhost:5173",
	token: "test-token",
};

type DesignApp = Awaited<ReturnType<typeof createApp>>;
type DesignRuntime = Exclude<
	AgentRunStatus,
	"queued" | "running" | "waiting_permission"
>;

const headers = {
	Authorization: "Bearer test-token",
	"Content-Type": "application/json",
};

/**
 * Design agent double. It records every prompt and replies with a complete HTML
 * document, mirroring the contract DesignService expects from OpenCode.
 */
class FakeDesignRuntime implements AgentRuntime {
	readonly prompts: string[] = [];
	readonly models: Array<AgentModel | undefined> = [];
	failNext = false;
	/** Canned answers for the design-chat intent + assistant turns. */
	intent = "CHAT";
	chatReply = "Halo! Ada yang bisa saya bantu?";
	private readonly sessions = new Map<string, string>();
	private nextId = 0;

	async createSession(input: { cwd: string; title: string }) {
		const id = `design-session-${++this.nextId}`;
		this.sessions.set(id, input.title);
		return { id };
	}

	async prompt(input: {
		sessionId: string;
		prompt: string;
		model?: AgentModel;
	}) {
		if (!this.sessions.has(input.sessionId))
			throw new Error("Fake session not found");
		this.prompts.push(input.prompt);
		this.models.push(input.model);
	}

	async status(): Promise<AgentRunStatus> {
		return "completed";
	}

	async readOutput(sessionId: string): Promise<RuntimeOutput> {
		const prompt = this.prompts[this.prompts.length - 1] ?? "";
		if (/intent classifier/i.test(prompt)) return { output: this.intent };
		if (/UI\/UX design agent/i.test(prompt)) return { output: this.chatReply };
		return {
			output: `<!DOCTYPE html>\n<html lang="en">\n<head><title>${sessionId}</title></head>\n<body><h1>${prompt.slice(0, 40)}</h1></body>\n</html>`,
		};
	}

	async wait(): Promise<DesignRuntime> {
		if (this.failNext) {
			this.failNext = false;
			return "failed";
		}
		return "completed";
	}

	async abort(): Promise<void> {}

	async getDiff() {
		return [];
	}
}

async function createDesignSetup() {
	const root = await mkdtemp(join(tmpdir(), "loom-design-project-"));
	await writeFile(join(root, "package.json"), '{"name":"demo"}\n');
	const home = await mkdtemp(join(tmpdir(), "loom-design-home-"));
	const database = createDb({ DATABASE_URL: `file:${join(home, "state.db")}` });
	const repos = repositories(database);
	const project = await repos.projects.create({
		id: "design-project",
		name: "demo",
		path: root,
		defaultBranch: "main",
	});
	const runtime = new FakeDesignRuntime();
	const daemon = await createApp({
		config,
		database,
		designRuntime: runtime,
		startOpenCode: false,
	});
	return { daemon, home, project, root, runtime };
}

async function waitForNode(
	app: DesignApp["app"],
	id: string,
): Promise<DesignNode> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const response = await app.request(`/api/designs/${id}`, { headers });
		const node = (await response.json()) as DesignNode;
		if (node.status === "ready" || node.status === "failed") return node;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Design never finished");
}

async function readThread(app: DesignApp["app"], projectId: string) {
	const response = await app.request(`/api/projects/${projectId}/designs`, {
		headers,
	});
	return (await response.json()) as {
		nodes: DesignNode[];
		messages: DesignMessage[];
	};
}

async function withSetup(
	run: (setup: Awaited<ReturnType<typeof createDesignSetup>>) => Promise<void>,
) {
	const setup = await createDesignSetup();
	try {
		await run(setup);
	} finally {
		await setup.daemon.close();
		await rm(setup.root, { recursive: true, force: true });
		await rm(setup.home, { recursive: true, force: true });
	}
}

describe("design canvas API", () => {
	test("generates a design node from a brief", async () => {
		await withSetup(async (setup) => {
			const created = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Landing page for a coffee roaster",
					viewport: "desktop",
					model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
				}),
			});
			expect(created.status).toBe(202);
			const { nodeId } = (await created.json()) as { nodeId: string };
			const node = await waitForNode(setup.daemon.app, nodeId);
			expect(node.status).toBe("ready");
			expect(node.html).toContain("<!DOCTYPE html>");
			expect(node.title).toBe("Landing page for a coffee roaster");
			expect(node.sessionId?.startsWith("design-session-")).toBe(true);
			expect(setup.runtime.prompts[0]).toContain(
				"Landing page for a coffee roaster",
			);
			expect(setup.runtime.prompts[0]).toContain("1440x900");
			expect(setup.runtime.models[0]).toEqual({
				providerID: "anthropic",
				modelID: "claude-sonnet-4-5",
			});
			const thread = await readThread(setup.daemon.app, setup.project.id);
			expect(thread.nodes.map((item) => item.id)).toContain(nodeId);
			const user = thread.messages.find((message) => message.role === "user");
			expect(user?.text).toBe("Landing page for a coffee roaster");
			expect(user?.model).toBe("anthropic/claude-sonnet-4-5");
			expect(
				thread.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.text.includes("ready"),
				),
			).toBe(true);
		});
	});

	test("refines a design in place and records the change request", async () => {
		await withSetup(async (setup) => {
			const created = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Checkout flow",
				}),
			});
			const { nodeId } = (await created.json()) as { nodeId: string };
			expect((await waitForNode(setup.daemon.app, nodeId)).status).toBe(
				"ready",
			);
			const refined = await setup.daemon.app.request(
				`/api/designs/${nodeId}/refine`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ message: "Add a promo code field" }),
				},
			);
			expect(refined.status).toBe(202);
			// Refining in place returns the same node and adds no duplicate card.
			const refinedBody = (await refined.json()) as { nodeId: string };
			expect(refinedBody.nodeId).toBe(nodeId);
			const node = await waitForNode(setup.daemon.app, nodeId);
			expect(node.status).toBe("ready");
			expect(node.html).toContain("<!DOCTYPE html>");
			const refinePrompt = setup.runtime.prompts.at(-1) ?? "";
			expect(refinePrompt).toContain("Add a promo code field");
			expect(refinePrompt).toContain("<!DOCTYPE html>");
			const thread = await readThread(setup.daemon.app, setup.project.id);
			expect(thread.nodes.length).toBe(1);
			expect(
				thread.messages.some(
					(message) =>
						message.role === "user" &&
						message.text === "Add a promo code field",
				),
			).toBe(true);
		});
	});

	test("retrying a refined design keeps its model and re-applies the change", async () => {
		await withSetup(async (setup) => {
			const created = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Checkout flow",
					model: { providerID: "google", modelID: "gemini-pro" },
				}),
			});
			const { nodeId } = (await created.json()) as { nodeId: string };
			expect((await waitForNode(setup.daemon.app, nodeId)).status).toBe(
				"ready",
			);
			const refined = await setup.daemon.app.request(
				`/api/designs/${nodeId}/refine`,
				{
					method: "POST",
					headers,
					// No model picked: the refinement inherits the node's choice.
					body: JSON.stringify({ message: "Add a promo code field" }),
				},
			);
			const refinedId = ((await refined.json()) as { nodeId: string }).nodeId;
			expect(refinedId).toBe(nodeId);
			expect((await waitForNode(setup.daemon.app, nodeId)).status).toBe(
				"ready",
			);
			expect(setup.runtime.models.at(-1)).toEqual({
				providerID: "google",
				modelID: "gemini-pro",
			});

			setup.runtime.failNext = true;
			const failedRetry = await setup.daemon.app.request(
				`/api/designs/${nodeId}/retry`,
				{ method: "POST", headers },
			);
			expect(failedRetry.status).toBe(202);
			expect((await waitForNode(setup.daemon.app, nodeId)).status).toBe(
				"failed",
			);

			const retry = await setup.daemon.app.request(
				`/api/designs/${nodeId}/retry`,
				{ method: "POST", headers },
			);
			expect(retry.status).toBe(202);
			const recovered = await waitForNode(setup.daemon.app, nodeId);
			expect(recovered.status).toBe("ready");
			const prompt = setup.runtime.prompts.at(-1) ?? "";
			expect(prompt).toContain("Checkout flow");
			expect(prompt).toContain("Add a promo code field");
			expect(prompt).toContain("<!DOCTYPE html>");
			expect(setup.runtime.models.at(-1)).toEqual({
				providerID: "google",
				modelID: "gemini-pro",
			});
		});
	});

	test("marks generation failures as retryable and recovers on retry", async () => {
		await withSetup(async (setup) => {
			setup.runtime.failNext = true;
			const created = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Dashboard",
				}),
			});
			const { nodeId } = (await created.json()) as { nodeId: string };
			const failed = await waitForNode(setup.daemon.app, nodeId);
			expect(failed.status).toBe("failed");
			expect(failed.errorMessage).toContain("failed");
			const retried = await setup.daemon.app.request(
				`/api/designs/${nodeId}/retry`,
				{ method: "POST", headers },
			);
			expect(retried.status).toBe(202);
			expect((await waitForNode(setup.daemon.app, nodeId)).status).toBe(
				"ready",
			);
		});
	});

	test("stores canvas edits and publishes the HTML into the project", async () => {
		await withSetup(async (setup) => {
			const created = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Sign up screen",
					viewport: "mobile",
				}),
			});
			const { nodeId } = (await created.json()) as { nodeId: string };
			expect((await waitForNode(setup.daemon.app, nodeId)).status).toBe(
				"ready",
			);
			const patched = await setup.daemon.app.request(`/api/designs/${nodeId}`, {
				method: "PATCH",
				headers,
				body: JSON.stringify({ title: "Sign up v2", x: 320, y: 140 }),
			});
			expect(patched.status).toBe(200);
			const node = (await patched.json()) as DesignNode;
			expect(node.title).toBe("Sign up v2");
			expect([node.x, node.y]).toEqual([320, 140]);
			expect([node.width, node.height]).toEqual([220, 476]);
			const invalidPatch = await setup.daemon.app.request(
				`/api/designs/${nodeId}`,
				{ method: "PATCH", headers, body: JSON.stringify({}) },
			);
			expect(invalidPatch.status).toBe(400);
			const published = await setup.daemon.app.request(
				`/api/designs/${nodeId}/publish`,
				{ method: "POST", headers, body: JSON.stringify({}) },
			);
			expect(published.status).toBe(200);
			const { path } = (await published.json()) as { path: string };
			expect(path).toMatch(/^designs\/.*\.html$/);
			const written = await readFile(join(setup.root, path), "utf8");
			expect(written).toContain("<!DOCTYPE html>");
			const escaping = await setup.daemon.app.request(
				`/api/designs/${nodeId}/publish`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ path: "../outside.html" }),
				},
			);
			expect(escaping.status).toBe(500);
		});
	});

	test("deletes a node and clears the project canvas", async () => {
		await withSetup(async (setup) => {
			const first = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "First screen",
				}),
			});
			const { nodeId: firstId } = (await first.json()) as { nodeId: string };
			await waitForNode(setup.daemon.app, firstId);
			const removed = await setup.daemon.app.request(
				`/api/designs/${firstId}`,
				{
					method: "DELETE",
					headers,
				},
			);
			expect(removed.status).toBe(204);
			expect(
				(await setup.daemon.app.request(`/api/designs/${firstId}`, { headers }))
					.status,
			).toBe(404);
			const second = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Second screen",
				}),
			});
			await waitForNode(
				setup.daemon.app,
				((await second.json()) as { nodeId: string }).nodeId,
			);
			const cleared = await setup.daemon.app.request(
				`/api/projects/${setup.project.id}/designs`,
				{ method: "DELETE", headers },
			);
			expect(cleared.status).toBe(204);
			expect(
				(await readThread(setup.daemon.app, setup.project.id)).nodes,
			).toEqual([]);
		});
	});

	test("validates input and rejects unknown designs", async () => {
		await withSetup(async (setup) => {
			const emptyBrief = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({ projectId: setup.project.id, brief: "   " }),
			});
			expect(emptyBrief.status).toBe(400);
			const unknownProject = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({ projectId: "nope", brief: "Screen" }),
			});
			expect(unknownProject.status).toBe(404);
			const missingThread = await setup.daemon.app.request(
				"/api/projects/nope/designs",
				{ headers },
			);
			expect(missingThread.status).toBe(404);
			const missingNode = await setup.daemon.app.request("/api/designs/nope", {
				headers,
			});
			expect(missingNode.status).toBe(404);
			const unauthenticated = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				body: JSON.stringify({ projectId: setup.project.id, brief: "Screen" }),
			});
			expect(unauthenticated.status).toBe(401);
		});
	});
});

describe("design agent chat", () => {
	async function chat(
		app: DesignApp["app"],
		projectId: string,
		body: Record<string, unknown>,
	) {
		const response = await app.request(
			`/api/projects/${projectId}/design/chat`,
			{ method: "POST", headers, body: JSON.stringify(body) },
		);
		return (await response.json()) as DesignChatResult;
	}

	test("answers a greeting as chat without drawing a node", async () => {
		await withSetup(async (setup) => {
			setup.runtime.intent = "CHAT";
			setup.runtime.chatReply = "Halo! Saya siap membantu mendesain.";
			const result = await chat(setup.daemon.app, setup.project.id, {
				message: "halo",
			});
			expect(result.kind).toBe("chat");
			if (result.kind === "chat")
				expect(result.text).toContain("Halo");
			const thread = await readThread(setup.daemon.app, setup.project.id);
			expect(thread.nodes).toEqual([]);
			expect(
				thread.messages.some(
					(m) => m.role === "user" && m.text === "halo",
				),
			).toBe(true);
			expect(
				thread.messages.some(
					(m) => m.role === "assistant" && m.nodeId === null,
				),
			).toBe(true);
		});
	});

	test("routes an explicit build request to a canvas node", async () => {
		await withSetup(async (setup) => {
			setup.runtime.intent = "DESIGN";
			const result = await chat(setup.daemon.app, setup.project.id, {
				message: "buatkan landing page untuk kedai kopi",
			});
			expect(result.kind).toBe("design");
			if (result.kind !== "design") return;
			expect(result.status).toBe("queued");
			const node = await waitForNode(setup.daemon.app, result.nodeId);
			expect(node.status).toBe("ready");
			expect(node.html).toContain("<!DOCTYPE html>");
		});
	});

	test("returns a questionnaire when the agent needs to clarify", async () => {
		await withSetup(async (setup) => {
			setup.runtime.intent = "CHAT";
			const questionnaire = {
				id: "q1",
				questions: [
					{
						header: "Screen",
						question: "Layar mana yang mau dibuat?",
						options: [
							{ label: "Landing", description: "Halaman utama" },
						],
					},
				],
			};
			setup.runtime.chatReply =
				"Aku butuh detail dulu.\n```loom-questions\n" +
				JSON.stringify(questionnaire) +
				"\n```";
			const result = await chat(setup.daemon.app, setup.project.id, {
				message: "buatkan sesuatu",
			});
			expect(result.kind).toBe("question");
			if (result.kind === "question")
				expect(result.question.questions[0]?.header).toBe("Screen");
			const thread = await readThread(setup.daemon.app, setup.project.id);
			expect(thread.nodes).toEqual([]);
		});
	});

	test("reports live design activity for a node", async () => {
		await withSetup(async (setup) => {
			const missing = await setup.daemon.app.request(
				"/api/designs/nope/steps",
				{ headers },
			);
			expect(missing.status).toBe(404);
			const created = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Pricing table",
				}),
			});
			const { nodeId } = (await created.json()) as { nodeId: string };
			expect((await waitForNode(setup.daemon.app, nodeId)).status).toBe(
				"ready",
			);
			// Idle once ready: no in-flight activity to report.
			const steps = await setup.daemon.app.request(
				`/api/designs/${nodeId}/steps`,
				{ headers },
			);
			expect(steps.status).toBe(200);
			expect(await steps.json()).toBeNull();
		});
	});

	test("fans a change request out to every canvas at once", async () => {
		await withSetup(async (setup) => {
			const ids: string[] = [];
			for (const brief of ["Login page", "Register page"]) {
				const created = await setup.daemon.app.request("/api/designs", {
					method: "POST",
					headers,
					body: JSON.stringify({ projectId: setup.project.id, brief }),
				});
				const { nodeId } = (await created.json()) as { nodeId: string };
				expect((await waitForNode(setup.daemon.app, nodeId)).status).toBe(
					"ready",
				);
				ids.push(nodeId);
			}
			setup.runtime.intent = "DESIGN";
			const result = await chat(setup.daemon.app, setup.project.id, {
				message: "pada keduanya tambahkan animasi",
				nodeId: ids[1],
			});
			expect(result.kind).toBe("design");
			// Every ready node is refined, not just the selected one.
			for (const id of ids)
				expect((await waitForNode(setup.daemon.app, id)).status).toBe("ready");
			const refinePrompts = setup.runtime.prompts.filter(
				(prompt) =>
					prompt.includes("tambahkan animasi") &&
					prompt.includes("<!DOCTYPE html>"),
			);
			expect(refinePrompts.length).toBe(2);
			const thread = await readThread(setup.daemon.app, setup.project.id);
			// One shared user turn, not a duplicate per node.
			expect(
				thread.messages.filter(
					(m) => m.role === "user" && m.text === "pada keduanya tambahkan animasi",
				),
			).toHaveLength(1);
		});
	});
});
