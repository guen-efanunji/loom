import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, designRepository, repositories } from "@loom/db";
import type {
	AgentModel,
	AgentRunStatus,
	AgentRuntime,
	RuntimeOutput,
} from "@loom/opencode";
import { DesignService } from "@loom/orchestrator";
import type {
	DesignChatResult,
	DesignMessage,
	DesignNode,
} from "@loom/protocol";
import type { RuntimePermission } from "@loom/providers/core";
import type { DaemonConfig } from "../src/config";
import { createApp } from "../src/index";
import { createAgyPermissionStore } from "../src/permissions";

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
	readonly images: Array<Array<{ mime: string; data: string }>> = [];
	readonly models: Array<AgentModel | undefined> = [];
	readonly permissions: Array<RuntimePermission | undefined> = [];
	traceOutput?: RuntimeOutput;
	designOutputs: string[] = [];
	failNext = false;
	/** Canned answers for the design-chat intent + assistant turns. */
	intent = "CHAT";
	chatReply = "Halo! Ada yang bisa saya bantu?";
	holdWait = false;
	private releaseWait?: () => void;
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
		permission?: RuntimePermission;
		images?: Array<{ mime: string; data: string }>;
	}) {
		if (!this.sessions.has(input.sessionId))
			throw new Error("Fake session not found");
		this.prompts.push(input.prompt);
		this.images.push(input.images ?? []);
		this.models.push(input.model);
		this.permissions.push(input.permission);
	}

	async status(): Promise<AgentRunStatus> {
		return "completed";
	}

	async readOutput(sessionId: string): Promise<RuntimeOutput> {
		if (this.traceOutput) return this.traceOutput;
		const prompt = this.prompts[this.prompts.length - 1] ?? "";
		if (/intent classifier/i.test(prompt)) return { output: this.intent };
		if (/UI\/UX design agent/i.test(prompt)) return { output: this.chatReply };
		if (this.designOutputs.length)
			return { output: this.designOutputs.shift() ?? "" };
		return {
			output: `<!DOCTYPE html>\n<html lang="en">\n<head><title>${sessionId}</title></head>\n<body><h1>${prompt.slice(0, 40)}</h1></body>\n</html>`,
		};
	}

	async wait(_sessionId?: string): Promise<DesignRuntime> {
		if (this.holdWait)
			await new Promise<void>((resolve) => {
				this.releaseWait = resolve;
			});
		if (this.failNext) {
			this.failNext = false;
			return "failed";
		}
		return "completed";
	}

	finishWait() {
		this.releaseWait?.();
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
	return { daemon, database, repos, home, project, root, runtime };
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
	test("runs Canvas generation through the selected provider runtime", async () => {
		await withSetup(async (setup) => {
			const defaultRuntime = new FakeDesignRuntime();
			const codexRuntime = new FakeDesignRuntime();
			const service = new DesignService(
				designRepository(setup.database),
				setup.repos,
				defaultRuntime,
				new Map([["codex", codexRuntime]]),
			);
			const result = await service.create({
				projectId: setup.project.id,
				brief: "A login screen",
				model: { providerID: "codex", modelID: "gpt-6-sol" },
			});
			await service.idle(result.nodeId);
			expect(codexRuntime.models).toEqual([
				{ providerID: "codex", modelID: "gpt-6-sol" },
			]);
			expect(defaultRuntime.prompts).toHaveLength(0);
			expect(codexRuntime.permissions[0]?.mode).toBe("read-only");
		});
	});

	test("custom provider canvas generation does not offer tools or approvals", async () => {
		await withSetup(async (setup) => {
			const customRuntime = new FakeDesignRuntime();
			const service = new DesignService(
				designRepository(setup.database),
				setup.repos,
				setup.runtime,
				new Map([["loom_custom_test", customRuntime]]),
				{
					store: createAgyPermissionStore(),
					url: "http://127.0.0.1:4317/api/agy/permission",
				},
			);
			const result = await service.create({
				projectId: setup.project.id,
				brief: "A login screen",
				model: { providerID: "loom_custom_test", modelID: "visual" },
			});
			await service.idle(result.nodeId);
			expect((await service.detail(result.nodeId)).status).toBe("ready");
			expect(customRuntime.permissions[0]?.mode).toBe("read-only");
			expect(setup.runtime.prompts).toHaveLength(0);
		});
	});

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
			expect(setup.runtime.prompts[0]).toContain("Project name: demo");
			expect(setup.runtime.prompts[0]).toContain(
				`Project folder: ${setup.root}`,
			);
			expect(setup.runtime.prompts[0]).toContain(
				"isolated scratch working directory",
			);
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
						message.role === "assistant" && message.text.includes("ready"),
				),
			).toBe(true);
		});
	});

	test("persists scoped tool trace without exposing secrets or HTML", async () => {
		await withSetup(async (setup) => {
			setup.runtime.traceOutput = {
				output: "<!DOCTYPE html><html><body>OK</body></html>",
				activities: [
					{
						id: "tool-1",
						tool: "inspect",
						status: "completed",
						output: "checked layout token=super-secret-value",
					},
				],
				parts: [
					{ type: "activity", id: "tool-1" },
					{
						type: "text",
						id: "answer",
						text: "<!DOCTYPE html><html>OK</html>",
					},
				],
			} as RuntimeOutput;
			const response = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Landing page",
				}),
			});
			const { nodeId } = (await response.json()) as { nodeId: string };
			await waitForNode(setup.daemon.app, nodeId);
			const traceResponse = await setup.daemon.app.request(
				`/api/designs/${nodeId}/trace`,
				{ headers },
			);
			const trace = (await traceResponse.json()) as {
				projectId: string;
				nodeId: string;
				runs: Array<{ sessionId: string; events: unknown[] }>;
			};
			expect(trace.projectId).toBe(setup.project.id);
			expect(trace.nodeId).toBe(nodeId);
			expect(trace.runs[0]?.sessionId).toStartWith("design-session-");
			expect(trace.runs[0]?.events).toEqual([
				{
					type: "tool",
					tool: "inspect",
					status: "completed",
					output: "checked layout token=[redacted]",
				},
			]);
			expect(
				(await readThread(setup.daemon.app, setup.project.id)).messages.some(
					(m) => m.text.includes("loom-design-trace"),
				),
			).toBe(false);
		});
	});

	test("does not read unrelated project files for an unreferenced design", async () => {
		await withSetup(async (setup) => {
			await writeFile(join(setup.root, "package.json"), '{"private":true}');
			await writeFile(join(setup.root, "README.md"), "Unrelated project notes");
			await writeFile(
				join(setup.root, "app.css"),
				":root { --secret-brand: orange; }",
			);
			const result = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Design a clean login screen",
				}),
			});
			const { nodeId } = (await result.json()) as { nodeId: string };
			await waitForNode(setup.daemon.app, nodeId);
			expect(setup.runtime.prompts[0]).not.toContain("Unrelated project notes");
			expect(setup.runtime.prompts[0]).not.toContain("--secret-brand");
			expect(setup.runtime.prompts[0]).not.toContain(
				"Match these existing theme tokens",
			);
		});
	});

	test("supplies mentioned files, text attachments, and images to Canvas generation", async () => {
		await withSetup(async (setup) => {
			await mkdir(join(setup.root, "src"), { recursive: true });
			await writeFile(
				join(setup.root, "src", "flow.html"),
				'<main class="checkout-flow">Step 1: account details</main>',
			);
			const projectImage = Buffer.from("project-image-bytes");
			await writeFile(join(setup.root, "src", "reference.png"), projectImage);
			const response = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Design a signup screen that follows the attached flow",
					files: ["src/flow.html", "src/reference.png"],
					attachments: [
						{
							filename: "brand-notes.md",
							mime: "text/markdown",
							data: Buffer.from("Use the teal brand color #087f8c.").toString(
								"base64",
							),
						},
						{
							filename: "reference-screen.png",
							mime: "image/png",
							data: "aW1hZ2UtYnl0ZXM=",
						},
					],
				}),
			});
			const { nodeId } = (await response.json()) as { nodeId: string };
			const node = await waitForNode(setup.daemon.app, nodeId);
			expect(node.status).toBe("ready");
			expect(setup.runtime.prompts[0]).toContain(
				'<main class="checkout-flow">Step 1: account details</main>',
			);
			expect(setup.runtime.prompts[0]).toContain(
				"Use the teal brand color #087f8c.",
			);
			expect(setup.runtime.prompts[0]).toContain("reference-screen.png");
			expect(setup.runtime.prompts[0]).toContain("src/reference.png");
			expect(setup.runtime.images[0]).toEqual([
				{ mime: "image/png", data: projectImage.toString("base64") },
				{ mime: "image/png", data: "aW1hZ2UtYnl0ZXM=" },
			]);
		});
	});

	test("repairs a non-HTML provider reply and preserves references on retry", async () => {
		await withSetup(async (setup) => {
			await writeFile(join(setup.root, "login.html"), "<form>Sign in</form>");
			setup.runtime.designOutputs = [
				"I understand the request and will create a design.",
				"I still forgot to include the HTML.",
			];
			const created = await setup.daemon.app.request("/api/designs", {
				method: "POST",
				headers,
				body: JSON.stringify({
					projectId: setup.project.id,
					brief: "Create a login screen",
					files: ["login.html"],
					attachments: [
						{
							filename: "reference.png",
							mime: "image/png",
							data: "cG5n",
						},
					],
				}),
			});
			const { nodeId } = (await created.json()) as { nodeId: string };
			const failed = await waitForNode(setup.daemon.app, nodeId);
			expect(failed.status).toBe("failed");
			expect(setup.runtime.prompts).toHaveLength(2);
			expect(setup.runtime.prompts[1]).toContain("Previous answer to correct");

			const retried = await setup.daemon.app.request(
				`/api/designs/${nodeId}/retry`,
				{ method: "POST", headers, body: JSON.stringify({}) },
			);
			expect(retried.status).toBe(202);
			const ready = await waitForNode(setup.daemon.app, nodeId);
			expect(ready.status).toBe("ready");
			expect(setup.runtime.prompts[2]).toContain("<form>Sign in</form>");
			expect(setup.runtime.prompts[2]).toContain("reference.png");
			expect(setup.runtime.images[2]).toEqual([
				{ mime: "image/png", data: "cG5n" },
			]);
		});
	});

	test("Agy canvas generation runs tool-free instead of waiting for an approval", async () => {
		await withSetup(async (setup) => {
			const runtime = new FakeDesignRuntime();
			const permissions = createAgyPermissionStore();
			const service = new DesignService(
				designRepository(setup.database),
				setup.repos,
				new FakeDesignRuntime(),
				new Map([["agy", runtime]]),
				{ store: permissions, url: "http://127.0.0.1:4317/api/agy/permission" },
			);
			const created = await service.create({
				projectId: setup.project.id,
				brief: "Roasting schedule dashboard",
				model: { providerID: "agy", modelID: "gemini-3.8-flash-high" },
			});
			await service.idle(created.nodeId);
			const node = await service.detail(created.nodeId);

			expect(node.status).toBe("ready");
			// A canvas design needs no tools, so none are offered. Leaving them
			// available made headless Agy hold a RunCommand for an approval nobody
			// was watching for and fail the run with a denied action.
			expect(runtime.permissions[0]?.mode).toBe("read-only");
			expect(runtime.permissions[0]?.env).toBeUndefined();
			// The gate is configured but never engaged, and no run is registered.
			expect(
				permissions.submit(
					{
						token: "unused",
						conversationId: "agy-conversation",
						toolName: "RunCommand",
						args: { CommandLine: "pwd" },
						stepIdx: 1,
					},
					1_000,
				).status,
			).not.toBe("pending");
			expect(runtime.prompts[0]).not.toContain("Coding Agent Instructions");
			expect(runtime.prompts[0]).toContain(
				"Do not call tools, run shell commands, read or write files",
			);
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
			expect(refinePrompt).toContain("Project name: demo");
			expect(refinePrompt).toContain(`Project folder: ${setup.root}`);
			expect(refinePrompt).toContain("isolated scratch working directory");
			expect(refinePrompt).toContain("read or write files");
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

	test("answers questions from mentioned file contents and visual attachments", async () => {
		await withSetup(async (setup) => {
			await writeFile(
				join(setup.root, "flow.html"),
				'<form><input name="email"><button>Continue</button></form>',
			);
			const projectImage = Buffer.from("mentioned-screen-bytes");
			await writeFile(join(setup.root, "screen-reference.png"), projectImage);
			setup.runtime.intent = "CHAT";
			setup.runtime.chatReply = "The flow collects an email before continuing.";
			const result = await chat(setup.daemon.app, setup.project.id, {
				message: "Explain this flow",
				files: ["flow.html", "screen-reference.png"],
				attachments: [
					{
						filename: "screen.png",
						mime: "image/png",
						data: "c2NyZWVu",
					},
				],
			});
			expect(result.kind).toBe("chat");
			// A plain question with attachments is clearly conversational, so the
			// service skips the model-based intent pass and runs one assistant turn.
			expect(setup.runtime.prompts).toHaveLength(1);
			expect(setup.runtime.prompts[0]).toContain(
				'<form><input name="email"><button>Continue</button></form>',
			);
			expect(setup.runtime.prompts[0]).toContain("screen.png");
			expect(setup.runtime.prompts[0]).toContain("screen-reference.png");
			expect(setup.runtime.images[0]).toEqual([
				{ mime: "image/png", data: "c2NyZWVu" },
				{ mime: "image/png", data: projectImage.toString("base64") },
			]);
		});
	});

	test("serializes concurrent turns on one cached chat session", async () => {
		await withSetup(async (setup) => {
			class BlockingRuntime extends FakeDesignRuntime {
				chatSessions: string[] = [];
				active = new Set<string>();
				started?: () => void;
				release?: () => void;

				override async createSession(input: { cwd: string; title: string }) {
					const session = await super.createSession(input);
					if (input.title.startsWith("Loom design chat"))
						this.chatSessions.push(session.id);
					return session;
				}

				override async prompt(
					input: Parameters<FakeDesignRuntime["prompt"]>[0],
				) {
					if (this.active.has(input.sessionId))
						throw new Error("Session is already running");
					await super.prompt(input);
					if (this.chatSessions.includes(input.sessionId))
						this.active.add(input.sessionId);
				}

				override async readOutput(sessionId: string): Promise<RuntimeOutput> {
					if (this.chatSessions.includes(sessionId))
						return { output: this.chatReply };
					return super.readOutput(sessionId);
				}

				override async wait(sessionId?: string): Promise<DesignRuntime> {
					if (sessionId && this.chatSessions.includes(sessionId)) {
						if (this.started) {
							this.started();
							this.started = undefined;
							await new Promise<void>((resolve) => {
								this.release = resolve;
							});
						}
						this.active.delete(sessionId);
					}
					return super.wait(sessionId);
				}
			}
			const runtime = new BlockingRuntime();
			const service = new DesignService(
				designRepository(setup.database),
				setup.repos,
				runtime,
			);
			let started!: () => void;
			const firstStarted = new Promise<void>((resolve) => {
				started = resolve;
			});
			runtime.started = started;
			const first = service.chat({
				projectId: setup.project.id,
				message: "hello one",
			});
			await firstStarted;
			const second = service.chat({
				projectId: setup.project.id,
				message: "hello two",
			});
			for (let attempt = 0; attempt < 100; attempt++) {
				if (
					(await service.list(setup.project.id)).messages.filter(
						(m) => m.role === "user",
					).length === 2
				)
					break;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(
				(await service.list(setup.project.id)).messages
					.filter((m) => m.role === "user")
					.map((m) => m.text),
			).toEqual(["hello one", "hello two"]);
			expect(runtime.chatSessions).toHaveLength(1);
			expect(
				runtime.prompts.filter((p) => /UI\/UX design agent/.test(p)),
			).toHaveLength(1);
			runtime.release?.();
			const results = await Promise.all([first, second]);
			expect(results.map((result) => result.kind)).toEqual(["chat", "chat"]);
			expect(runtime.chatSessions).toHaveLength(1);
			const thread = await service.list(setup.project.id);
			expect(thread.messages.filter((m) => m.role === "user")).toHaveLength(2);
			expect(
				thread.messages.filter((m) => m.role === "assistant"),
			).toHaveLength(2);
		});
	});

	test("persists a failed chat turn and creates a fresh session for the next turn", async () => {
		await withSetup(async (setup) => {
			class FailingRuntime extends FakeDesignRuntime {
				chatSessions: string[] = [];
				override async createSession(input: { cwd: string; title: string }) {
					const session = await super.createSession(input);
					if (input.title.startsWith("Loom design chat"))
						this.chatSessions.push(session.id);
					return session;
				}
				override async wait(sessionId?: string): Promise<DesignRuntime> {
					if (
						sessionId &&
						this.chatSessions.includes(sessionId) &&
						this.chatSessions.length === 1
					)
						return "failed";
					return super.wait(sessionId);
				}
			}
			const runtime = new FailingRuntime();
			const service = new DesignService(
				designRepository(setup.database),
				setup.repos,
				runtime,
			);
			await expect(
				service.chat({
					projectId: setup.project.id,
					message: "first question",
				}),
			).rejects.toThrow("failed");
			const failed = await service.list(setup.project.id);
			expect(failed.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(failed.messages[1]?.errorMessage).toContain("failed");
			expect(
				(
					await service.chat({
						projectId: setup.project.id,
						message: "second question",
					})
				).kind,
			).toBe("chat");
			expect(runtime.chatSessions).toHaveLength(2);
			expect(
				(await service.list(setup.project.id)).messages
					.filter((m) => m.role === "user")
					.map((m) => m.text),
			).toEqual(["first question", "second question"]);
		});
	});

	test("answers a greeting as chat without drawing a node", async () => {
		await withSetup(async (setup) => {
			setup.runtime.intent = "CHAT";
			setup.runtime.chatReply = "Halo! Saya siap membantu mendesain.";
			const result = await chat(setup.daemon.app, setup.project.id, {
				message: "halo",
			});
			expect(result.kind).toBe("chat");
			if (result.kind === "chat") expect(result.text).toContain("Halo");
			const thread = await readThread(setup.daemon.app, setup.project.id);
			expect(thread.nodes).toEqual([]);
			expect(
				thread.messages.some((m) => m.role === "user" && m.text === "halo"),
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
			expect(
				setup.runtime.prompts.some((prompt) =>
					/intent classifier/i.test(prompt),
				),
			).toBe(false);
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
						options: [{ label: "Landing", description: "Halaman utama" }],
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
					(m) =>
						m.role === "user" && m.text === "pada keduanya tambahkan animasi",
				),
			).toHaveLength(1);
		});
	});
});
