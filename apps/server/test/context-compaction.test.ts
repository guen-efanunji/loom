import { describe, expect, test } from "bun:test";
import {
	buildContextPacket,
	buildHandoff,
	ContextBudgetError,
	estimateHistoryTokens,
	proactiveTriggerTokens,
	resolveActiveContextBudget,
	resolveModelLimits,
	shouldTriggerNativeCompaction,
} from "../src/context-compaction";

describe("proactive compaction triggers", () => {
	test("derives the active budget from a verified window and marks unknown windows", () => {
		const known = resolveActiveContextBudget(1_048_576);
		expect(known.windowKnown).toBe(true);
		expect(known.budgetTokens).toBe(734_003);
		const unknown = resolveActiveContextBudget(undefined);
		expect(unknown).toEqual({
			budgetTokens: 12_288,
			windowKnown: false,
		});
		expect(resolveActiveContextBudget(-4).windowKnown).toBe(false);
	});

	test("proactive trigger sits at 70 percent of the active budget", () => {
		expect(proactiveTriggerTokens(734_003)).toBe(513_802);
		expect(proactiveTriggerTokens(1_000_000)).toBe(700_000);
	});

	test("compacts before the full budget when the proactive trigger passes", () => {
		// 6 older messages ~80 tokens each plus 4 small recent messages: above
		// the 490-token proactive trigger for a 1000-token window (full budget
		// is 700), but below the point where the whole history is unusable.
		const oldMessage = (index: number) => ({
			info: { id: `u-old-${index}`, role: "user" as const },
			parts: [
				{
					id: `p-old-${index}`,
					type: "text",
					text: "Old instruction. ".repeat(20),
				},
			],
		});
		const history = [
			oldMessage(0),
			oldMessage(1),
			oldMessage(2),
			oldMessage(3),
			oldMessage(4),
			oldMessage(5),
			{
				info: { id: "u-new-1", role: "user" as const },
				parts: [{ id: "p-new-1", type: "text", text: "Recent note." }],
			},
			{
				info: { id: "a-new-1", role: "assistant" as const },
				parts: [{ id: "pa-new-1", type: "text", text: "Noted." }],
			},
			{
				info: { id: "u-new-2", role: "user" as const },
				parts: [{ id: "p-new-2", type: "text", text: "Second note." }],
			},
			{
				info: { id: "a-new-2", role: "assistant" as const },
				parts: [{ id: "pa-new-2", type: "text", text: "Done." }],
			},
		];
		const triggerTokens = proactiveTriggerTokens(
			resolveActiveContextBudget(1_000).budgetTokens,
		);
		// Without a proactive trigger the packet stays uncompacted (reactive
		// behavior only compacts once the full budget is exceeded).
		expect(
			buildContextPacket({
				providerId: "custom",
				mode: "loom_owned",
				contextWindowTokens: 1_000,
				history: [...history],
				currentPrompt: "Continue.",
			}).info.compacted,
		).toBe(false);
		const proactive = buildContextPacket({
			providerId: "custom",
			mode: "loom_owned",
			contextWindowTokens: 1_000,
			history: [...history],
			currentPrompt: "Continue.",
			compactionTriggerTokens: triggerTokens,
		});
		expect(proactive.info.compacted).toBe(true);
		expect(proactive.info.compactionReason).toContain("compacted early");
		expect(proactive.info.checkpointBoundary?.coveredMessageCount).toBe(6);
		expect(proactive.info.checkpointBoundary?.lastMessageId).toBe("u-old-5");
		expect(proactive.context).toContain("Old instruction");
		expect(proactive.context).toContain("Recent note.");
	});

	test("a trigger token value of zero forces compaction for a manual request", () => {
		const history = [
			...Array.from({ length: 5 }, (_, index) => ({
				info: { id: `u-old-${index}`, role: "user" as const },
				parts: [{ id: `p-old-${index}`, type: "text", text: "Context note." }],
			})),
			{
				info: { id: "u-new", role: "user" as const },
				parts: [{ id: "p-new", type: "text", text: "Recent note." }],
			},
		];
		const packet = buildContextPacket({
			providerId: "custom",
			mode: "loom_owned",
			contextWindowTokens: 1_000_000,
			history,
			currentPrompt: "Continue.",
			compactionTriggerTokens: 0,
		});
		expect(packet.info.compacted).toBe(true);
		expect(packet.info.checkpointBoundary?.coveredMessageCount).toBe(2);
		expect(packet.context).toContain("Context note.");
		expect(packet.context).toContain("Recent note.");
	});

	test("native compaction respects message growth and cooldown", () => {
		const now = 1_700_000_000_000;
		// First trigger: nothing recorded yet.
		expect(shouldTriggerNativeCompaction(undefined, 40, now)).toBe(true);
		const recently = {
			messageCount: 40,
			lastCompactedAt: now - 60_000,
		};
		// No growth since the last compact: never re-trigger.
		expect(shouldTriggerNativeCompaction(recently, 40, now)).toBe(false);
		// Fresh turns below the delta and inside the cooldown: wait.
		expect(shouldTriggerNativeCompaction(recently, 45, now)).toBe(false);
		// Enough new conversation since the last compact: trigger.
		expect(shouldTriggerNativeCompaction(recently, 55, now)).toBe(true);
		// Cooldown elapsed with any growth: trigger.
		expect(shouldTriggerNativeCompaction(recently, 41, now + 11 * 60_000)).toBe(
			true,
		);
		// Shrinking history (a native compaction already ran): wait.
		expect(shouldTriggerNativeCompaction(recently, 10, now)).toBe(false);
		// A provider that rejected native compaction before: never retry it.
		expect(
			shouldTriggerNativeCompaction(
				{ messageCount: 40, lastCompactedAt: now, nativeUnsupported: true },
				999,
				now,
			),
		).toBe(false);
	});

	test("estimates stored conversation size from the same rendering used by packets", () => {
		const history = [
			{
				info: { id: "u-1", role: "user" },
				parts: [{ id: "p-1", type: "text", text: "x".repeat(400) }],
			},
		];
		const base = estimateHistoryTokens(history);
		expect(base).toBeGreaterThan(90);
		expect(base).toBeLessThan(120);
		expect(estimateHistoryTokens(history, "y".repeat(40))).toBeGreaterThan(
			base,
		);
	});
});

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

	test("borrows the gateway catalog limit for an Agy tier by its base model", () => {
		expect(
			resolveModelLimits({
				providerId: "agy",
				modelId: "gemini-3.8-flash-high",
				catalogModels: [
					{
						providerID: "commandcode",
						modelID: "google/gemini-3.8-flash",
						contextWindow: 1_000_000,
					},
					{
						providerID: "google",
						modelID: "google/gemini-3.8-flash",
						contextWindow: 1_048_576,
					},
				],
			}),
		).toEqual({
			contextWindow: 1_048_576,
			outputLimit: null,
			source: "open_code_alias",
		});
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
					parts: [
						{
							id: "p-assistant",
							type: "text",
							text: "Recent reply. ".repeat(5_000),
						},
					],
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
				parts: [
					{ id: "p1", type: "text", text: "Implement adaptive compaction" },
				],
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
					error: {
						name: "ProviderError",
						data: { message: "Input exceeds context window" },
					},
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

	describe("tool state excerpting", () => {
		test("renders object-shaped tool errors without crashing", () => {
			// OpenCode 2.2 returns tool state errors as {name, data: {message}}
			// rather than a plain string; the excerpt builder used to throw
			// "error.slice is not a function" on these parts (crash in sends
			// while the user's model is a CLI provider building handoff text).
			const handoff = buildHandoff([
				{
					info: { id: "u1", role: "user" },
					parts: [{ id: "u1-p", type: "text", text: "fix the bug" }],
				},
				{
					info: { id: "a1", role: "assistant" },
					parts: [
						{
							id: "a1-tool",
							type: "tool",
							tool: "bash",
							state: {
								status: "error",
								input: { command: "ls" },
								output: "boom",
								error: {
									name: "PermissionError",
									data: { message: "permission denied" },
								},
							},
						},
						{
							id: "a1-tool-2",
							type: "tool",
							tool: "read",
							state: {
								status: "error",
								error: "file not found",
							},
						},
					],
				},
			]);
			expect(handoff).toContain("permission denied");
			expect(handoff).toContain("file not found");
			expect(handoff).toContain("Untrusted tool event bash");
		});
	});
