export * from "./adapters/agy";
export * from "./adapters/claude";
export type { CliAdapterOptions } from "./adapters/cli";
export {
	CliProviderAdapter as GenericCliProviderAdapter,
	findExecutable,
	modelFromId,
	promptPath,
	readPrompt,
	readVersion,
	runCli,
} from "./adapters/cli";
export * from "./adapters/codex";
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
import { AgyProviderAdapter } from "./adapters/agy";
import { ClaudeProviderAdapter } from "./adapters/claude";
import { CodexProviderAdapter } from "./adapters/codex";
import { grokDefinition } from "./adapters/definitions";
import { OpenCodeProviderAdapter } from "./adapters/opencode";
import { createUnsupportedAdapter } from "./adapters/unsupported";
import { ProviderRegistry } from "./core";

export function createDefaultProviderRegistry(
	manager: OpenCodeManager,
	runtime: ConstructorParameters<typeof OpenCodeProviderAdapter>[0]["runtime"],
): ProviderRegistry {
	return new ProviderRegistry()
		.register(new OpenCodeProviderAdapter({ manager, runtime }))
		.register(new ClaudeProviderAdapter())
		.register(new CodexProviderAdapter())
		.register(new AgyProviderAdapter())
		.register(createUnsupportedAdapter(grokDefinition));
}
