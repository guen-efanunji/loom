import { expect, test } from "bun:test";
import { agyPermissionArgs, agyPromptText } from "../src/adapters/agy";
import { CliProviderAdapter, parseCliOutput } from "../src/adapters/cli";

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

test("CLI output preserves the provider order between text and tool events", () => {
	const parsed = parseCliOutput(
		[
			{
				type: "item.completed",
				item: {
					type: "agent_message",
					id: "msg-1",
					text: "Saya mulai dengan memeriksa file.",
				},
			},
			{
				type: "item.started",
				item: { type: "command_execution", id: "cmd-1", command: "pwd" },
			},
			{
				type: "item.completed",
				item: {
					type: "command_execution",
					id: "cmd-1",
					command: "pwd",
					exit_code: 0,
				},
			},
			{
				type: "item.completed",
				item: {
					type: "agent_message",
					id: "msg-2",
					text: "Saya menemukan struktur proyeknya.",
				},
			},
			{
				type: "item.started",
				item: { type: "command_execution", id: "cmd-2", command: "rg --files" },
			},
			{
				type: "item.completed",
				item: { type: "agent_message", id: "msg-3", text: "Berikut hasilnya." },
			},
			{ type: "result", result: { response: "Berikut hasilnya." } },
		]
			.map((event) => JSON.stringify(event))
			.join("\n"),
	);
	expect(parsed.parts.map((part) => part.type)).toEqual([
		"text",
		"activity",
		"text",
		"activity",
		"text",
	]);
	expect(
		parsed.parts
			.filter((part) => part.type === "text")
			.map((part) => part.text),
	).toEqual([
		"Saya mulai dengan memeriksa file.",
		"Saya menemukan struktur proyeknya.",
		"Berikut hasilnya.",
	]);
});

test("Codex item updates keep assistant text at its first streamed position", () => {
	const parsed = parseCliOutput(
		[
			{
				type: "item.started",
				item: { type: "agent_message", id: "msg-1", text: "" },
			},
			{
				type: "item.updated",
				item: {
					type: "agent_message",
					id: "msg-1",
					text: "Saya memeriksa file.",
				},
			},
			{
				type: "item.started",
				item: { type: "command_execution", id: "cmd-1", command: "pwd" },
			},
			{
				type: "item.completed",
				item: {
					type: "command_execution",
					id: "cmd-1",
					command: "pwd",
					exit_code: 0,
				},
			},
			{
				type: "item.updated",
				item: {
					type: "agent_message",
					id: "msg-1",
					text: "Saya memeriksa file dan menemukan entry point.",
				},
			},
			{
				type: "item.completed",
				item: {
					type: "agent_message",
					id: "msg-1",
					text: "Saya memeriksa file dan menemukan entry point.",
				},
			},
		]
			.map((event) => JSON.stringify(event))
			.join("\n"),
	);

	expect(parsed.parts.map((part) => part.type)).toEqual(["text", "activity"]);
	expect(parsed.parts[0]).toMatchObject({
		type: "text",
		text: "Saya memeriksa file dan menemukan entry point.",
	});
	expect(parsed.output).toBe("Saya memeriksa file dan menemukan entry point.");
});

test("Codex final-only responses remain after the provider's tool events", () => {
	const parsed = parseCliOutput(
		[
			{
				type: "item.completed",
				item: {
					type: "command_execution",
					id: "cmd-1",
					command: "pwd",
					exit_code: 0,
				},
			},
			{
				type: "item.completed",
				item: {
					type: "command_execution",
					id: "cmd-2",
					command: "rg --files",
					exit_code: 0,
				},
			},
			{
				type: "item.completed",
				item: {
					type: "agent_message",
					id: "msg-1",
					text: "Struktur proyek sudah diperiksa.",
				},
			},
		]
			.map((event) => JSON.stringify(event))
			.join("\n"),
	);

	expect(parsed.parts.map((part) => part.type)).toEqual([
		"activity",
		"activity",
		"text",
	]);
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

test("design-only Agy prompt excludes coding instructions that invite tools", () => {
	expect(
		agyPromptText(
			"Please implement a feature",
			"Use shell tools to inspect the project",
		),
	).toBe(
		"Use shell tools to inspect the project\n\nPlease implement a feature",
	);
	expect(
		agyPromptText(
			"Do not call tools, run shell commands, read or write files. Generate HTML only.",
			"Use shell tools to inspect the project",
		),
	).toContain("Generate HTML only.");
	expect(
		agyPromptText(
			"Do not call tools, run shell commands, read or write files. Generate HTML only.",
			"Use shell tools to inspect the project",
		),
	).not.toContain("Use shell tools");
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
	expect((await runtime.readOutput?.(session.id))?.output).toBe("secret-token");
});
