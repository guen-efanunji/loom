import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../src/lib/chat";
import {
	groupTurns,
	permissionActionLabel,
	supersededIds,
	userMessageText,
} from "../src/lib/chat-utils";

const message = (
	id: string,
	role: string,
	text?: string,
	completed?: number,
): ChatMessage => ({
	info: {
		id,
		role,
		time: { created: 1, ...(completed ? { completed } : {}) },
	},
	parts: text ? [{ id: `${id}-p`, type: "text", text }] : [],
});

describe("chat-utils", () => {
	test("groups consecutive assistant messages into one turn", () => {
		const turns = groupTurns([
			message("u1", "user", "hi"),
			message("a1", "assistant", "part one"),
			message("a2", "assistant", "part two"),
			message("u2", "user", "again"),
		]);
		expect(turns.map((turn) => turn.key)).toEqual(["u1", "a1", "u2"]);
		expect(turns[1]?.messages).toHaveLength(2);
	});

	test("extracts only text parts from a user message", () => {
		const text = userMessageText(message("u1", "user", "  hello world  "));
		expect(text).toBe("hello world");
	});

	test("supersedes a user turn and its following assistant answers", () => {
		const messages = [
			message("u1", "user", "first"),
			message("a1", "assistant", "reply one"),
			message("u2", "user", "second"),
			message("a2", "assistant", "reply two"),
		];
		expect(supersededIds(messages, "u1")).toEqual(["u1", "a1"]);
		expect(supersededIds(messages, "u2")).toEqual(["u2", "a2"]);
		expect(supersededIds(messages, "missing")).toEqual([]);
	});

	test("labels permission actions from the tool name and target", () => {
		expect(permissionActionLabel("bash", ["ls -la"])).toBe("Run \u00b7 ls -la");
		expect(permissionActionLabel("edit_file", ["src/app.ts"])).toBe(
			"Edit \u00b7 src/app.ts",
		);
		expect(permissionActionLabel("read", [])).toBe("Read");
	});
});
