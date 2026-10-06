import { expect, test } from "bun:test";
import { normalizeCliOutput } from "../src/adapters/cli";

test("extracts Codex assistant text without exposing tool events", () => {
	const events = [
		{ type: "thread.started", thread_id: "thread" },
		{
			type: "item.completed",
			item: { type: "command_execution", aggregated_output: "tool output" },
		},
		{
			type: "item.completed",
			item: { type: "agent_message", text: "Hello from Codex" },
		},
		{ type: "turn.completed", usage: {} },
	];
	expect(
		normalizeCliOutput(events.map((event) => JSON.stringify(event)).join("\n")),
	).toBe("Hello from Codex");
});
test("uses Agy final response once instead of repeating streamed text", () => {
	expect(
		normalizeCliOutput(
			[
				JSON.stringify({ step_update: { agent_response: { text: "Hello" } } }),
				JSON.stringify({ result: { response: "Hello" } }),
			].join("\n"),
		),
	).toBe("Hello");
});
test("preserves Claude plain text and reads Claude JSON responses", () => {
	expect(normalizeCliOutput("Hello\nworld\n")).toBe("Hello\nworld");
	expect(
		normalizeCliOutput(
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "Hello" }] },
			}),
		),
	).toBe("Hello");
});
test("does not display incomplete JSON or lifecycle events as assistant text", () => {
	expect(
		normalizeCliOutput('{"type":"thread.started"}\n{"type":"item.com'),
	).toBe("");
});

test("streams the real Agy text_delta format before the result arrives", () => {
	const stream = [
		{
			event: "step_update",
			step_update: { step_index: 0, step_type: "user_input", state: "DONE" },
		},
		{
			event: "step_update",
			step_update: {
				step_index: 1,
				step_type: "agent_response",
				state: "ACTIVE",
				text_delta: "PO",
			},
		},
		{
			event: "step_update",
			step_update: {
				step_index: 1,
				step_type: "agent_response",
				state: "DONE",
				text_delta: "NG\n",
			},
		},
	]
		.map((event) => JSON.stringify(event))
		.join("\n");
	expect(normalizeCliOutput(stream)).toBe("PONG");
	expect(
		normalizeCliOutput(
			stream +
				'\n{"event":"result","result":{"status":"SUCCESS","response":""}}',
		),
	).toBe("PONG");
	expect(
		normalizeCliOutput(
			stream +
				'\n{"event":"result","result":{"status":"SUCCESS","response":"PONG\\n"}}',
		),
	).toBe("PONG");
});
