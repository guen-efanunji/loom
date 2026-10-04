import { describe, expect, test } from "bun:test";
import {
	type CliProviderAdapter,
	InMemoryModelCatalog,
	type ProviderDefinition,
	ProviderManager,
	ProviderRegistry,
} from "../src";

const definition: ProviderDefinition = {
	id: "fixture",
	name: "Fixture",
	executable: "fixture",
	capabilities: ["models"],
	install: { supported: false },
	authStrategy: "none",
};

function adapter(
	overrides: Partial<CliProviderAdapter> = {},
): CliProviderAdapter {
	return {
		definition,
		detect: async () => ({ installed: true, version: "1.0.0" }),
		getVersion: async () => "1.0.0",
		getAuthStatus: async () => ({ authenticated: true, strategy: "none" }),
		authenticate: async () => ({
			launched: false,
			status: { authenticated: true, strategy: "none" },
		}),
		disconnect: async () => {},
		listModels: async () => [],
		createSession: async () => ({
			id: "session",
			providerId: "fixture",
			connectionId: "fixture:local",
			createdAt: new Date().toISOString(),
		}),
		sendMessage: async function* () {
			yield { type: "message.completed" };
		},
		cancelSession: async () => {},
		...overrides,
	};
}

describe("provider core", () => {
	test("registers providers and normalizes composite model identity", () => {
		const registry = new ProviderRegistry().register(adapter());
		const catalog = new InMemoryModelCatalog();
		catalog.set([
			{
				id: "fixture:local:model",
				providerId: "fixture",
				connectionId: "fixture:local",
				name: "Model",
				displayName: "Model",
				capabilities: ["text"],
				isAvailable: true,
				metadata: { modelId: "model" },
			},
		]);
		expect(registry.require("fixture").definition.id).toBe("fixture");
		expect(
			catalog.get({
				providerId: "fixture",
				connectionId: "fixture:local",
				modelId: "model",
			})?.displayName,
		).toBe("Model");
	});

	test("isolates detection failures", async () => {
		const broken: CliProviderAdapter = {
			...adapter(),
			definition: { ...definition, id: "broken" },
			detect: async () => {
				throw new Error("failed");
			},
		};
		const manager = new ProviderManager({
			registry: new ProviderRegistry().register(adapter()).register(broken),
		});
		const results = await manager.refreshAll();
		expect(results.find((item) => item.providerId === "fixture")?.status).toBe(
			"connected",
		);
		expect(results.find((item) => item.providerId === "broken")?.status).toBe(
			"error",
		);
	});

	test("does not claim unsupported execution", async () => {
		const unsupported = adapter({
			createSession: async () => {
				throw new Error("unsupported");
			},
			listModels: async () => [],
		});
		await expect(unsupported.listModels()).resolves.toEqual([]);
	});
});
