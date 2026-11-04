import { describe, expect, test } from "bun:test";
import {
	buildContextPacket,
	buildHandoff,
	ContextBudgetError,
	resolveModelLimits,
} from "../src/context-compaction";

describe("provider-agnostic context budget", () => {
	test("accepts the catalog 1M limit for the matching Agy CLI model alias", () => {
		expect(
			resolveModelLimits({
				providerId: "agy",
				modelId: "gemini-3.8-flash-high",
				catalogModels: [
					{
						providerID: "custom-provider",
						modelID: "ag/gemini-3.8-flash-high",
						contextWindow: 1_048_576,
						outputLimit: 65_536,
					},
				],
			}),
		).toEqual({
			contextWindow: 1_048_576,
			outputLimit: 65_536,
			source: "open_code_alias",
		});
	});

	test("does not borrow ambiguous limits or a limit from another named model", () => {
		const catalogModels = [
			{
				providerID: "opencode",
				modelID: "first/gemini-3.8-flash-high",
				contextWindow: 1_048_576,
			},
			{
				providerID: "other",
				modelID: "second/gemini-3.8-flash-high",
				contextWindow: 500_000,
			},
		];
		expect(
			resolveModelLimits({
				providerId: "agy",
				modelId: "gemini-3.8-flash-high",
				catalogModels,
			}),
		).toEqual({ contextWindow: null, outputLimit: null, source: "unknown" });
		expect(
			resolveModelLimits({
				providerId: "agy",
				modelId: "gemini-3.8-pro-high",
				catalogModels,
			}),
		).toEqual({ contextWindow: null, outputLimit: null, source: "unknown" });
	});

	test("uses explicit catalog limits and rejects invalid metadata", () => {
		expect(
			resolveModelLimits({
				providerId: "custom",
				modelId: "BACKEND",
				runtimeContextWindow: 272_000,
				runtimeOutputLimit: 128_000,
			}),
		).toEqual({
			contextWindow: 272_000,
			outputLimit: 128_000,
			source: "runtime_catalog",
		});
		expect(
			resolveModelLimits({
				providerId: "agy",
				modelId: "unknown-model",
				runtimeContextWindow: -1,
			}),
		).toEqual({ contextWindow: null, outputLimit: null, source: "unknown" });
	});
	test("uses the context metadata for a 1M token model without reducing it to default", () => {
		const packet = buildContextPacket({
			providerId: "agy",
			modelId: "gemini-3.8-flash-high",
			mode: "handoff_only",
			contextWindowTokens: 1_048_576,
			contextWindowSource: "open_code_alias",
			history: [],
			currentPrompt: "Continue the existing conversation.",
		});
		expect(packet.info).toMatchObject({
			contextWindowTokens: 1_048_576,
			budgetTokens: 734_003,
			budgetSource: "model_catalog",
			contextWindowSource: "open_code_alias",
		});
	});

	test("compacts oversized latest assistant output while preserving the current user prompt", () => {
		const history = [
			{
				info: { id: "u-old", role: "user" },
				parts: [
					{
						id: "u-old-p",
						type: "text",
						text: "Keep the original constraints.",
					},
				],
			},
			{
				info: { id: "a-old", role: "assistant" },
				parts: [
					{ id: "a-old-p", type: "text", text: "Large answer. ".repeat(1200) },
				],
			},
			{
				info: { id: "u-current", role: "user" },
				parts: [
					{
						id: "u-current-p",
						type: "text",
						text: "Continue using exact constraints.",
					},
				],
			},
			{
				info: {
					id: "a-failed",
					role: "assistant",
					error: {
						name: "ProviderError",
						data: { message: "429 quota exceeded; switch to another model." },
					},
				},
				parts: [],
			},
		];
		const packet = buildContextPacket({
			providerId: "agy",
			mode: "handoff_only",
			contextWindowTokens: 1000,
			history,
			currentPrompt: "Continue using exact constraints.",
		});
		expect(packet.info.compacted).toBe(true);
		expect(packet.context).toContain("Continue using exact constraints.");
		expect(packet.context).toContain(
			"Assistant failure status (untrusted diagnostic",
		);
		expect(packet.context).toContain("429 quota exceeded");
	});

	test("unknown model limits use bounded fallback and compact rather than fail on discardable old output", () => {
		const packet = buildContextPacket({
			providerId: "agy",
			mode: "handoff_only",
			history: [
				{
					info: { id: "u-old", role: "user" },
					parts: [{ id: "p-u", type: "text", text: "Keep this constraint." }],
				},
				{
					info: { id: "a-old", role: "assistant" },
					parts: [
						{ id: "p-a", type: "text", text: "Long response. ".repeat(5000) },
					],
				},
				{
					info: { id: "a-new", role: "assistant" },
					parts: [{ id: "p-assistant", type: "text", text: "Recent reply. ".repeat(5_000) }],
				},
				{
					info: { id: "u-new", role: "user" },
					parts: [{ id: "p-new", type: "text", text: "Please continue." }],
				},
			],
			currentPrompt: "Please continue.",
		});
		expect(packet.info).toMatchObject({
			contextWindowTokens: null,
			budgetTokens: 12_288,
			budgetSource: "conservative_default",
			compacted: true,
		});
		expect(packet.context).toContain("Please continue.");
		expect(packet.context).toContain("Keep this constraint.");
		expect(packet.context).not.toContain("Long response. ".repeat(100));
	});

	test("creates a bounded handoff that preserves tool outcomes, errors, and latest work", () => {
		const handoff = buildHandoff([
			{
				info: { id: "user-1", role: "user" },
				parts: [{ id: "p1", type: "text", text: "Implement adaptive compaction" }],
			},
			{
				info: { id: "assistant-1", role: "assistant" },
				parts: [
					{
						id: "tool-1",
						type: "tool",
						tool: "read",
						state: { status: "completed", output: "Reviewed chat.ts" },
					},
				],
			},
			{
				info: {
					id: "assistant-failed",
					role: "assistant",
					error: { name: "ProviderError", data: { message: "Input exceeds context window" } },
				},
				parts: [],
			},
		]);
		expect(handoff).toContain("Implement adaptive compaction");
		expect(handoff).toContain("Reviewed chat.ts");
		expect(handoff).toContain("Input exceeds context window");
		expect(handoff.length).toBeLessThanOrEqual(24_000);
	});

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
