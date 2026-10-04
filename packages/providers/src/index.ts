export * from "./adapters/definitions";
export * from "./adapters/opencode";
export * from "./adapters/unsupported";
export * from "./core";
export type {
	AgentRunStatus,
	AgentRuntime,
	RuntimeOutput,
} from "./core/runtime";

import type { OpenCodeManager } from "@loom/opencode";
import {
	antigravityDefinition,
	claudeCodeDefinition,
	codexDefinition,
	grokDefinition,
} from "./adapters/definitions";
import { OpenCodeProviderAdapter } from "./adapters/opencode";
import { createUnsupportedAdapter } from "./adapters/unsupported";
import { ProviderRegistry } from "./core";

export function createDefaultProviderRegistry(
	manager: OpenCodeManager,
	runtime: ConstructorParameters<typeof OpenCodeProviderAdapter>[0]["runtime"],
): ProviderRegistry {
	return new ProviderRegistry()
		.register(new OpenCodeProviderAdapter({ manager, runtime }))
		.register(createUnsupportedAdapter(claudeCodeDefinition))
		.register(createUnsupportedAdapter(codexDefinition))
		.register(createUnsupportedAdapter(antigravityDefinition))
		.register(createUnsupportedAdapter(grokDefinition));
}
