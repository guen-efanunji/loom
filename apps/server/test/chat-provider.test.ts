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
		parts: Array<{ text: string }>;
	}>;
};

async function setup(
	providerId = "agy",
	storedHistory = new Map<string, unknown[]>(),
) {
	let status: Awaited<ReturnType<AgentRuntime["status"]>> = "running";
	let output = "";
	let failure: string | null = null;
	let count = 0;
	const prompts: Parameters<AgentRuntime["prompt"]>[0][] = [];
	const calls: string[] = [];
	const runtime: AgentRuntime = {
		createSession: async () => ({ id: `${providerId}-${++count}` }),
		prompt: async (input) => {
			prompts.push(input);
			if (failure) throw new Error(failure);
			status = "running";
			output = "";
		},
		status: async () => status,
		readOutput: async () => ({ output }),
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
		runtimes: new Map([[providerId, runtime]]),
		request: async <T>(path: string) => {
			calls.push(path);
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
		finish: (next = "completed" as typeof status, text = "Hello") => {
			status = next;
			output = text;
		},
		failSpawn: () => {
			failure = "Binary unavailable";
		},
		send: (text = "Hello", provider = providerId) =>
			app.request("/sessions/ses_test/messages", {
				method: "POST",
				body: JSON.stringify({
					text,
					model: { providerID: provider, modelID: "custom-model" },
				}),
			}),
		state: async () =>
			(await app.request("/sessions/ses_test")).json() as Promise<ChatState>,
	};
}

describe("provider chat", () => {
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
