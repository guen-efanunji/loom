import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "@loom/providers";
import { CliProviderAdapter } from "../../../packages/providers/src/adapters/cli";
import { createChatRoutes } from "../src/chat";
import { createAgyPermissionStore } from "../src/permissions";

// Drives the Agy chat permission flow end to end against the routes: a run mints
// a per-run secret, the PreToolUse hook store surfaces pending tool requests on
// the session poll, and the existing reply endpoint resolves allow/deny. The
// runtime is faked so only the permission wiring is under test.
async function setup(
	options: { autoAccept?: boolean; providerId?: string } = {},
) {
	const providerId = options.providerId ?? "agy";
	let status: Awaited<ReturnType<AgentRuntime["status"]>> = "running";
	let output = "";
	const deletedSessions: string[] = [];
	const prompts: Parameters<AgentRuntime["prompt"]>[0][] = [];
	const runtime: AgentRuntime = {
		createSession: async () => ({ id: `${providerId}-session` }),
		prompt: async (input) => {
			prompts.push(input);
			status = "running";
			output = "";
		},
		status: async () => status,
		readOutput: async () => ({ output }),
		lastError: async () => null,
		abort: async () => {
			status = "cancelled";
		},
		wait: async () => "completed",
		getDiff: async () => [],
		deleteSession: async (sessionId) => {
			deletedSessions.push(sessionId);
		},
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
	const providerManager = providerManagerWith(adapter, providerId);
	const permissions = createAgyPermissionStore();
	const app = createChatRoutes({
		projects: {
			list: async () => [{ id: "project", path: "/tmp" }],
			getById: async () => ({
				path: "/tmp",
				autoAccept: options.autoAccept ?? false,
			}),
		},
		providerManager,
		permissions,
		agyPermissionUrl: "http://127.0.0.1:0/api/agy/permission",
		sessionScope: async () => ({ directory: "/tmp", projectId: "project" }),
		runtimes: new Map([[providerId, runtime]]),
		request: async <T>(path: string) => {
			if (path === "/session/ses_test")
				return {
					id: "ses_test",
					directory: "/tmp",
					title: "Chat",
					time: { updated: 1 },
				} as T;
			return [] as T;
		},
	});
	const send = () =>
		app.request("/sessions/ses_test/messages", {
			method: "POST",
			body: JSON.stringify({
				text: "Run a command",
				model: { providerID: providerId, modelID: "gpt" },
			}),
		});
	return {
		app,
		permissions,
		prompts,
		deletedSessions,
		setCompleted: (text: string) => {
			output = text;
			status = "completed";
		},
		send,
		state: async () =>
			(await app.request("/sessions/ses_test")).json() as Promise<{
				permissions: Array<{
					id: string;
					permission: string;
					patterns: string[];
				}>;
				status: { type: string; message?: string };
			}>,
	};
}

function providerManagerWith(adapter: CliProviderAdapter, providerId = "agy") {
	// Minimal ProviderManager substitute exposing only what chat.ts reads.
	const registry = {
		get: (id: string) => (id === providerId ? adapter : undefined),
	};
	return {
		registry,
		get: () => ({ status: "connected" }),
		refreshAll: async () => {},
		catalog: { listAvailable: () => [] },
	} as never;
}

describe("agy chat permissions", () => {
	test("ask mode threads the run token and gates a pending tool request", async () => {
		const fixture = await setup();
		expect((await fixture.send()).status).toBe(204);
		const permission = fixture.prompts[0]?.permission;
		expect(permission?.mode).toBe("ask");
		const token = permission?.env?.LOOM_PERMISSION_TOKEN;
		expect(token).toBeTruthy();

		const submitted = fixture.permissions.submit(
			{
				token: token ?? "",
				conversationId: "conv",
				toolName: "run_command",
				args: { command: "rm -rf /tmp/x" },
				stepIdx: 0,
			},
			5000,
		);
		expect(submitted.status).toBe("pending");
		if (submitted.status !== "pending") return;

		const running = await fixture.state();
		expect(running.permissions).toHaveLength(1);
		expect(running.permissions[0]?.permission).toBe("run_command");
		expect(running.permissions[0]?.patterns).toEqual(["rm -rf /tmp/x"]);
		expect(running.status.message).toBe("Waiting for permission");

		const reply = await fixture.app.request(
			`/sessions/ses_test/permission/${submitted.request.id}`,
			{ method: "POST", body: JSON.stringify({ reply: "once" }) },
		);
		expect(reply.status).toBe(200);
		expect(await submitted.decision).toBe("allow");
		// Once resolved, the request no longer appears in the pending list.
		expect((await fixture.state()).permissions).toHaveLength(0);
	});

	test("shows Agy command and file targets in permission cards", async () => {
		const fixture = await setup();
		await fixture.send();
		const token =
			fixture.prompts[0]?.permission?.env?.LOOM_PERMISSION_TOKEN ?? "";
		const command = fixture.permissions.submit(
			{
				token,
				conversationId: "conv",
				toolName: "run_command",
				args: { CommandLine: "bun run build", Cwd: "/tmp" },
				stepIdx: 0,
			},
			5000,
		);
		const edit = fixture.permissions.submit(
			{
				token,
				conversationId: "conv",
				toolName: "write_to_file",
				args: {
					TargetFile: "/tmp/src/login.ts",
					Description: "Create login page",
				},
				stepIdx: 1,
			},
			5000,
		);
		const state = await fixture.state();
		expect(state.permissions.map((item) => item.patterns)).toEqual([
			["bun run build"],
			["/tmp/src/login.ts", "Create login page"],
		]);
		if (command.status === "pending")
			fixture.permissions.decide(command.request.id, "deny");
		if (edit.status === "pending")
			fixture.permissions.decide(edit.request.id, "deny");
	});

	test("reject denies the tool while keeping the run alive", async () => {
		const fixture = await setup();
		await fixture.send();
		const token = fixture.prompts[0]?.permission?.env?.LOOM_PERMISSION_TOKEN;
		const submitted = fixture.permissions.submit(
			{
				token: token ?? "",
				conversationId: "conv",
				toolName: "write_to_file",
				args: { file_path: "a.txt" },
				stepIdx: 1,
			},
			5000,
		);
		if (submitted.status !== "pending") throw new Error("expected pending");
		const reply = await fixture.app.request(
			`/sessions/ses_test/permission/${submitted.request.id}`,
			{ method: "POST", body: JSON.stringify({ reply: "reject" }) },
		);
		expect(reply.status).toBe(200);
		expect(await submitted.decision).toBe("deny");
	});

	test("auto-accept runs skip the flag path and never surface pending requests", async () => {
		const fixture = await setup({ autoAccept: true });
		await fixture.send();
		expect(fixture.prompts[0]?.permission?.mode).toBe("auto");
		const token = fixture.prompts[0]?.permission?.env?.LOOM_PERMISSION_TOKEN;
		const submitted = fixture.permissions.submit(
			{
				token: token ?? "",
				conversationId: "conv",
				toolName: "run_command",
				args: { command: "ls" },
				stepIdx: 0,
			},
			5000,
		);
		expect(submitted.status).toBe("auto");
		expect((await fixture.state()).permissions).toHaveLength(0);
	});
});

describe("codex chat permissions and cleanup", () => {
	test("ask mode wires authorizeTool, surfaces Codex command/file patterns, and cleans up session on completion", async () => {
		const fixture = await setup({ providerId: "codex" });
		expect((await fixture.send()).status).toBe(204);
		const prompt = fixture.prompts[0];
		expect(prompt?.permission?.mode).toBe("ask");
		expect(typeof prompt?.authorizeTool).toBe("function");

		const cmdAuth = prompt!.authorizeTool!({
			toolName: "command_execution",
			args: { command: "bun test", cwd: "/tmp" },
			reason: "Run tests",
		});
		const fileAuth = prompt!.authorizeTool!({
			toolName: "file_change",
			args: { grantRoot: "/tmp/src" },
			reason: "Write file",
		});

		const running = await fixture.state();
		expect(running.status.message).toBe("Waiting for permission");
		expect(running.permissions).toHaveLength(2);
		expect(running.permissions[0]?.patterns).toEqual(["bun test", "Run tests"]);
		expect(running.permissions[1]?.patterns).toEqual([
			"/tmp/src",
			"Write file",
		]);

		await fixture.app.request(
			`/sessions/ses_test/permission/${running.permissions[0]!.id}`,
			{ method: "POST", body: JSON.stringify({ reply: "once" }) },
		);
		await fixture.app.request(
			`/sessions/ses_test/permission/${running.permissions[1]!.id}`,
			{ method: "POST", body: JSON.stringify({ reply: "reject" }) },
		);
		expect(await cmdAuth).toBe(true);
		expect(await fileAuth).toBe(false);

		fixture.setCompleted("All done");
		await fixture.state();
		expect(fixture.deletedSessions).toEqual(["codex-session"]);
	});

	test("autoAccept passes auto mode for codex", async () => {
		const fixture = await setup({ providerId: "codex", autoAccept: true });
		expect((await fixture.send()).status).toBe(204);
		expect(fixture.prompts[0]?.permission?.mode).toBe("auto");
		expect(
			await fixture.prompts[0]!.authorizeTool!({
				toolName: "command_execution",
				args: { command: "ls" },
				reason: "Inspect files",
			}),
		).toBe(true);
		expect((await fixture.state()).permissions).toHaveLength(0);
	});
});
