import { describe, expect, test } from "bun:test";
import { runtimeModelRef } from "../src/executor-model";

describe("runtimeModelRef", () => {
	test("splits OpenCode catalog pairs into the upstream provider reference", () => {
		expect(runtimeModelRef("opencode", "opencode/glm-5.3-flash-free")).toEqual({
			providerID: "opencode",
			modelID: "glm-5.3-flash-free",
		});
		expect(runtimeModelRef("opencode", "anthropic/claude-sonnet-4-5")).toEqual({
			providerID: "anthropic",
			modelID: "claude-sonnet-4-5",
		});
		// Some model ids themselves contain slashes; only the first segment is
		// the provider.
		expect(runtimeModelRef("opencode", "openai/gpt-5.5/preview")).toEqual({
			providerID: "openai",
			modelID: "gpt-5.5/preview",
		});
	});

	test("keeps non-OpenCode adapters on their own adapter identifier", () => {
		expect(runtimeModelRef("claude", "claude-sonnet-4-5")).toEqual({
			providerID: "claude",
			modelID: "claude-sonnet-4-5",
		});
		expect(runtimeModelRef("custom", "relay/model-a")).toEqual({
			providerID: "custom",
			modelID: "relay/model-a",
		});
	});

	test("accepts an OpenCode model without an upstream prefix unchanged", () => {
		expect(runtimeModelRef("opencode", "glm-5.3-flash-free")).toEqual({
			providerID: "opencode",
			modelID: "glm-5.3-flash-free",
		});
	});
});
