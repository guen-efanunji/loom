import { expect, test } from "bun:test";
import { CliProviderAdapter, parseCliOutput } from "../src/adapters/cli";
import { agyPermissionArgs } from "../src/adapters/agy";

// Captured from Agy: a denied command exits 0 and reports SUCCESS with no response.
const deniedResult = JSON.stringify({
	event: "result",
	result: {
		status: "SUCCESS",
		response: "",
		denied_actions: [{ action: "command", display_name: "RunCommand" }],
	},
});

function runtimeWithOutput(output: string) {
	return new CliProviderAdapter({
		definition: {
			id: "agy",
			name: "Agy",
			executable: process.execPath,
			capabilities: ["chat"],
			install: { supported: false },
			authStrategy: "none",
		},
		getAuthStatus: async () => ({ authenticated: true, strategy: "none" }),
		buildPrompt: async () => ({
			command: process.execPath,
			args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
		}),
	}).getRuntime();
}

test("Agy denied_actions is an error even with SUCCESS and exit code zero", async () => {
	const runtime = runtimeWithOutput(deniedResult);
	const session = await runtime.createSession({ cwd: "/tmp", title: "Test" });
	await runtime.prompt({ sessionId: session.id, prompt: "Test" });
	expect(
		await runtime.wait(session.id, { timeoutMs: 5000, pollIntervalMs: 10 }),
	).toBe("failed");
	expect(await runtime.lastError?.(session.id)).toContain("RunCommand");
	expect(await runtime.lastError?.(session.id)).toContain(
		"permission was denied",
	);
	expect(await runtime.lastError?.(session.id)).not.toContain(
		"--dangerously-skip-permissions",
	);
});

test("empty successful CLI output cannot silently complete", async () => {
	const runtime = runtimeWithOutput(
		'{"event":"result","result":{"status":"SUCCESS","response":""}}',
	);
	const session = await runtime.createSession({ cwd: "/tmp", title: "Test" });
	await runtime.prompt({ sessionId: session.id, prompt: "Test" });
	expect(
		await runtime.wait(session.id, { timeoutMs: 5000, pollIntervalMs: 10 }),
	).toBe("failed");
	expect(await runtime.lastError?.(session.id)).toContain(
		"without a text response",
	);
});

test("successful Agy text reaches the runtime output", async () => {
	const runtime = runtimeWithOutput(
		'{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"PONG"}}\n{"event":"result","result":{"status":"SUCCESS","response":"PONG"}}',
	);
	const session = await runtime.createSession({ cwd: "/tmp", title: "Test" });
	await runtime.prompt({ sessionId: session.id, prompt: "Test" });
	expect(
		await runtime.wait(session.id, { timeoutMs: 5000, pollIntervalMs: 10 }),
	).toBe("completed");
	expect((await runtime.readOutput?.(session.id))?.output).toBe("PONG");
});

test("Agy result errors retain partial assistant text", () => {
	const parsed = parseCliOutput(
		'{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"Working"}}\n{"event":"result","result":{"status":"ERROR","response":"","error":"Model unavailable"}}',
	);
	expect(parsed.output).toBe("Working");
	expect(parsed.error).toBe("Model unavailable");
});

test("agyPermissionArgs toggles the skip flag by permission mode", () => {
	expect(agyPermissionArgs({ mode: "auto" })).toEqual([
		"--dangerously-skip-permissions",
	]);
	expect(agyPermissionArgs({ mode: "ask" })).toEqual([
		"--dangerously-skip-permissions",
	]);
	// Undefined preserves the legacy accept-edits behavior.
	expect(agyPermissionArgs(undefined)).toEqual(["--mode", "accept-edits"]);
});

test("CliRuntime threads the permission env into the spawned process", async () => {
	// The child echoes LOOM_PERMISSION_TOKEN back through the stream-json result,
	// proving the per-run secret reaches Agy (and therefore its PreToolUse hook).
	const runtime = new CliProviderAdapter({
		definition: {
			id: "agy",
			name: "Agy",
			executable: process.execPath,
			capabilities: ["chat"],
			install: { supported: false },
			authStrategy: "none",
		},
		getAuthStatus: async () => ({ authenticated: true, strategy: "none" }),
		buildPrompt: async () => ({
			command: process.execPath,
			args: [
				"-e",
				'process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:process.env.LOOM_PERMISSION_TOKEN||"none"}}))',
			],
		}),
	}).getRuntime();
	const session = await runtime.createSession({ cwd: "/tmp", title: "Test" });
	await runtime.prompt({
		sessionId: session.id,
		prompt: "Test",
		permission: { mode: "ask", env: { LOOM_PERMISSION_TOKEN: "secret-token" } },
	});
	expect(
		await runtime.wait(session.id, { timeoutMs: 5000, pollIntervalMs: 10 }),
	).toBe("completed");
	expect(await runtime.readOutput?.(session.id)).toEqual({
		output: "secret-token",
	});
});
