import { describe, expect, test } from "bun:test";
import {
	buildContextPacket,
	ContextBudgetError,
} from "../src/context-compaction";

describe("provider-agnostic context budget", () => {
	test("does not apply a minimum that exceeds a small reported model window", () => {
		try {
			buildContextPacket({
				providerId: "custom",
				mode: "loom_owned",
				contextWindowTokens: 100,
				history: [
					{
						info: { id: "protected-user-input", role: "user" },
						parts: [
							{
								id: "text",
								type: "text",
								text: "Keep this user instruction. ".repeat(20),
							},
						],
					},
				],
				currentPrompt: "Continue safely.",
			});
			throw new Error(
				"Expected the protected context to exceed the reported budget",
			);
		} catch (error) {
			expect(error).toBeInstanceOf(ContextBudgetError);
			expect((error as ContextBudgetError).budgetTokens).toBe(70);
		}
	});
});
