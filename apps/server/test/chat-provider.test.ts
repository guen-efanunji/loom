import { describe, expect, test } from "bun:test";
import {
	type AgentRuntime,
	ProviderManager,
	ProviderRegistry,
} from "@loom/providers";
import { CliProviderAdapter } from "../../../packages/providers/src/adapters/cli";
import { createChatRoutes } from "../src/chat";
import { createAgyPermissionStore } from "../src/permissions";

type ChatState = {
	status: { type: string; message?: string };
	messages: Array<{
		info: {
			role: string;
			modelID?: string;
			time: { created: number; completed?: number };
			error: { data: { message: string } };
		};
		parts: Array<{ type?: string; text?: string; tool?: string }>;
	}>;
};
type TestRuntimeOutput = {
	output: string;
	parts?: Array<
		| { type: "text"; id: string; text: string }
		| { type: "activity"; id: string }
	>;
	activities?: Array<{ id: string; tool: string; status: "completed" }>;
};

async function setup(
	providerId = "agy",
	storedHistory = new Map<string, unknown[]>(),
	designNodes: Array<{
		id: string;
		projectId: string;
		title: string;
		brief: string;
		viewport: string;
		status: string;
		html: string;
	}> = [],
) {
	let status: Awaited<ReturnType<AgentRuntime["status"]>> = "running";
	let output = "";
	let outputParts: TestRuntimeOutput["parts"];
	let outputActivities: TestRuntimeOutput["activities"];
	let failure: string | null = null;
	let count = 0;
	const prompts: Parameters<AgentRuntime["prompt"]>[0][] = [];
	const calls: string[] = [];
	const openCodePrompts: unknown[] = [];
	const runtime: AgentRuntime = {
		createSession: async () => ({ id: `${providerId}-${++count}` }),
		prompt: async (input) => {
			prompts.push(input);
			if (failure) throw new Error(failure);
			status = "running";
			output = "";
		},
		status: async () => status,
		readOutput: async () =>
			({ output, parts: outputParts, activities: outputActivities }) as never,
		lastError: async () => "CLI authentication expired",
		abort: async () => {
			status = "cancelled";
		},
		wait: async () => "completed",
		getDiff: async () => [],
	};
	const adapter = new CliProviderAdapter({
		definition: {
			id: providerId,
			name: providerId,
			executable: providerId,
			capabilities: ["chat"],
			install: { supported: false },
			authStrategy: "none",
		},
		buildPrompt: async () => ({ command: providerId, args: [] }),
		getAuthStatus: async () => ({ authenticated: true, strategy: "none" }),
	});
	adapter.detect = async () => ({ installed: true });
	const providerManager = new ProviderManager({
		registry: new ProviderRegistry().register(adapter),
	});
	await providerManager.refresh(providerId);
	const app = createChatRoutes({
		permissions: createAgyPermissionStore(),
		agyPermissionUrl: "http://localhost/permission",
		providerHistory: {
			get: async <T>(sessionId: string) =>
				storedHistory.get(sessionId) as T | undefined,
			save: async (sessionId, messages) => {
				storedHistory.set(sessionId, structuredClone(messages));
			},
			delete: async (sessionId) => {
				storedHistory.delete(sessionId);
			},
		},
		projects: {
			list: async () => [{ id: "project", path: "/tmp" }],
			getById: async () => ({ path: "/tmp" }),
		},
		providerManager,
		designs: { listNodes: async () => designNodes },
		runtimes: new Map([[providerId, runtime]]),
		request: async <T>(path: string, options?: { body?: unknown }) => {
			calls.push(path);
			if (path.endsWith("/prompt_async")) openCodePrompts.push(options?.body);
			if (path === "/session/ses_test")
				return {
					id: "ses_test",
					directory: "/tmp",
					title: "Chat",
					time: { updated: 1 },
				} as T;
			if (path === "/session/status") return {} as T;
			return [] as T;
		},
	});
	return {
		app,
		prompts,
		calls,
		openCodePrompts,
		finish: (next = "completed" as typeof status, text = "Hello") => {
			status = next;
			output = text;
			outputParts = undefined;
			outputActivities = undefined;
		},
		finishWithParts: (parts: NonNullable<typeof outputParts>) => {
			status = "completed";
			output = parts
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n");
			outputParts = parts;
			outputActivities = parts.flatMap((part) =>
				part.type === "activity"
					? [{ id: part.id, tool: part.id, status: "completed" as const }]
					: [],
			);
		},
		failSpawn: () => {
			failure = "Binary unavailable";
		},
		send: (
			text = "Hello",
			provider = providerId,
			designNodeIds: string[] = [],
		) =>
			app.request("/sessions/ses_test/messages", {
				method: "POST",
				body: JSON.stringify({
					text,
					model: { providerID: provider, modelID: "custom-model" },
					designNodeIds,
				}),
			}),
		state: async () =>
			(await app.request("/sessions/ses_test")).json() as Promise<ChatState>,
	};
}

describe("provider chat", () => {
	test("renders assistant text and tools in the order emitted by the provider", async () => {
		const fixture = await setup("codex");
		await fixture.send();
		fixture.finishWithParts([
			{
				type: "text",
				id: "explain-1",
				text: "Saya mulai dengan memeriksa file.",
			},
			{ type: "activity", id: "read-1" },
			{ type: "text", id: "explain-2", text: "Strukturnya sudah jelas." },
			{ type: "activity", id: "edit-1" },
			{ type: "text", id: "explain-3", text: "Perubahan selesai." },
		]);
		const state = await fixture.state();
		expect(state.messages[1]?.parts.map((part) => part.type)).toEqual([
			"text",
			"tool",
			"text",
			"tool",
			"text",
		]);
		expect(
			state.messages[1]?.parts.map((part) => part.text ?? part.tool),
		).toEqual([
			"Saya mulai dengan memeriksa file.",
			"read-1",
			"Strukturnya sudah jelas.",
			"edit-1",
			"Perubahan selesai.",
		]);
	});

	test("embeds selected Canvas design HTML in the provider prompt", async () => {
		const { app, prompts, send } = await setup("agy", new Map(), [
			{
				id: "design-1",
				projectId: "project",
				title: "Login desktop",
				brief: "Warm coffee shop login page",
				viewport: "desktop",
				status: "ready",
				html: '<main class="login">Sign in</main>',
			},
		]);
		const response = await send("Implement this design", "agy", ["design-1"]);
		expect(response.status).toBe(204);
		expect(prompts[0]?.prompt).toContain("Implement this design");
		expect(prompts[0]?.prompt).toContain("Warm coffee shop login page");
		expect(prompts[0]?.prompt).toContain('<main class="login">Sign in</main>');
		expect(prompts[0]?.prompt).toContain("authoritative visual specification");
		const state = (await app.request("/sessions/ses_test")).json();
		expect(JSON.stringify(await state)).toContain("Login desktop");
	});

	test("sends Canvas HTML as a named attachment to OpenCode", async () => {
		const { openCodePrompts, send } = await setup("agy", new Map(), [
			{
				id: "design-open-code",
				projectId: "project",
				title: "Checkout",
				brief: "Minimal checkout flow",
				viewport: "desktop",
				status: "ready",
				html: "<main>Checkout</main>",
			},
		]);
		const response = await send("Slice this screen", "opencode", [
			"design-open-code",
		]);
		expect(response.status).toBe(204);
		const payload = openCodePrompts[0] as {
			parts: Array<{
				type: string;
				text?: string;
				filename?: string;
				url?: string;
			}>;
		};
		expect(payload.parts[0]?.text).toContain(
			"authoritative visual specification",
		);
		const attachment = payload.parts.find((part) =>
			part.filename?.startsWith("canvas-design:"),
		);
		expect(attachment?.filename).toBe("canvas-design:design-open-code.html");
		expect(attachment?.url).toContain("PG1haW4+");
	});

	test("rejects Canvas designs outside the active project", async () => {
		const { send } = await setup("agy", new Map(), [
			{
				id: "design-foreign",
				projectId: "another-project",
				title: "Other project design",
				brief: "",
				viewport: "desktop",
				status: "ready",
				html: "<main />",
			},
		]);
		const response = await send("Implement", "agy", ["design-foreign"]);
		expect(response.status).toBe(400);
	});

	for (const provider of ["agy", "claude", "codex"]) {
		test(`${provider}: acknowledges user messages, retains replies and allows follow-ups`, async () => {
			const fixture = await setup(provider);
			const before = Date.now();
			expect((await fixture.send()).status).toBe(204);
			const running = await fixture.state();
			expect(running.messages[0]?.info.role).toBe("user");
			expect(running.messages[0]?.info.time.created).toBeGreaterThanOrEqual(
				before,
			);
			expect(running.messages[0]?.parts[0]?.text).toBe("Hello");
			expect(running.status.type).toBe("busy");
			expect(running.messages[1]?.info.time.completed).toBeUndefined();
			expect(fixture.prompts[0]?.model).toEqual({
				providerID: provider,
				modelID: "custom-model",
			});
			expect((await fixture.send("Duplicate")).status).toBe(409);
			fixture.finish();
			const completed = await fixture.state();
			expect(completed.status.type).toBe("idle");
			expect(completed.messages[1]?.parts[0]?.text).toBe("Hello");
			expect(completed.messages[1]?.info.modelID).toBe("custom-model");
			expect(await fixture.state()).toEqual(completed);
			expect((await fixture.send("Follow up")).status).toBe(204);
			expect(fixture.prompts[1]?.prompt).toContain("Previous conversation:");
			expect((await fixture.state()).messages).toHaveLength(4);
			expect(fixture.calls.some((path) => path.endsWith("/prompt_async"))).toBe(
				false,
			);
		});
	}
	test("exposes CLI failures and releases the busy state", async () => {
		const fixture = await setup();
		await fixture.send();
		fixture.finish("failed", "");
		const state = await fixture.state();
		expect(state.status).toEqual({
			type: "error",
			message: "CLI authentication expired",
		});
		expect(state.messages[1]?.info.error.data.message).toBe(
			"CLI authentication expired",
		);
		expect(await fixture.state()).toEqual(state);
		expect((await fixture.send("Retry")).status).toBe(204);
	});
	test("a completed run without text is shown as an error instead of a blank answer", async () => {
		const fixture = await setup();
		await fixture.send();
		fixture.finish("completed", "");
		const state = await fixture.state();
		expect(state.status.type).toBe("error");
		expect(state.messages[1]?.info.error.data.message).toBeTruthy();
		expect((await fixture.send("Retry")).status).toBe(204);
	});
	test("spawn errors do not leave a queued session blocking retry", async () => {
		const fixture = await setup();
		fixture.failSpawn();
		expect((await fixture.send()).status).toBe(502);
		expect((await fixture.state()).status.type).toBe("error");
		expect((await fixture.send()).status).toBe(502);
	});
	test("provider conversation history survives a server restart", async () => {
		const storedHistory = new Map<string, unknown[]>();
		const firstServer = await setup("codex", storedHistory);
		expect((await firstServer.send("Persist this conversation")).status).toBe(
			204,
		);
		firstServer.finish("completed", "Saved reply");
		await firstServer.state();

		const restartedServer = await setup("codex", storedHistory);
		const restored = await restartedServer.state();
		expect(restored.messages.map((message) => message.parts[0]?.text)).toEqual([
			"Persist this conversation",
			"Saved reply",
		]);
		expect((await restartedServer.send("Continue after restart")).status).toBe(
			204,
		);
		expect(restartedServer.prompts[0]?.prompt).toContain(
			"user: Persist this conversation",
		);
		expect(restartedServer.prompts[0]?.prompt).toContain(
			"assistant: Saved reply",
		);
	});
	test("cancellation permits another turn", async () => {
		const fixture = await setup();
		await fixture.send();
		await fixture.app.request("/sessions/ses_test/abort", { method: "POST" });
		expect((await fixture.state()).status.type).toBe("idle");
		expect((await fixture.send()).status).toBe(204);
	});
	test("switching back to OpenCode resumes gateway polling and retains CLI messages", async () => {
		const fixture = await setup();
		await fixture.send();
		fixture.finish();
		expect((await fixture.send("Use OpenCode", "openai")).status).toBe(204);
		expect(fixture.calls).toContain("/session/ses_test/prompt_async");
		expect((await fixture.state()).messages).toHaveLength(2);
	});
});
