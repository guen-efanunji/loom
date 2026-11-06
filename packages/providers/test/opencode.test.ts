import { describe, expect, test } from "bun:test";

import { OpenCodeHttpRuntime } from "@loom/opencode";
import { OpenCodeProviderAdapter } from "../src/adapters/opencode";

describe("OpenCode provider adapter", () => {
	test("maps the current model API catalog to Loom models", async () => {
		const runtime = new OpenCodeHttpRuntime({
			baseUrl: "http://127.0.0.1:49374",
			fetcher: async (input) => {
				expect(String(input)).toBe("http://127.0.0.1:49374/api/model");
				return Response.json([
					{
						id: "glm-5.3-flash-free",
						modelID: "glm-5.3-flash-free",
						providerID: "opencode",
						name: "GLM 5.3 Flash Free",
						capabilities: { tools: true },
						limit: { context: 32_000, output: 4_000 },
					},
				]);
			},
		});
		const adapter = new OpenCodeProviderAdapter({
			manager: {
				discover: async () => true,
				start: async () => {},
				health: async () => true,
				stop: async () => {},
			},
			runtime,
		});

		await expect(adapter.listModels()).resolves.toMatchObject([
			{
				providerId: "opencode",
				connectionId: "opencode:local",
				name: "GLM 5.3 Flash Free",
				metadata: {
					modelId: "opencode/glm-5.3-flash-free",
					upstreamProviderId: "opencode",
				},
				contextWindow: 32_000,
				outputLimit: 4_000,
				isAvailable: true,
			},
		]);
	});
});
