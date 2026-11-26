import type { AgentModel, AuthStatus } from "../core";
import { CliProviderAdapter, modelFromId, runCli } from "./cli";
import { CodexAppServerRuntime } from "./codex-app-server";
import { codexDefinition } from "./definitions";

export class CodexProviderAdapter extends CliProviderAdapter {
	constructor() {
		super({
			codingPrompt: "coding.md",
			definition: {
				...codexDefinition,
				capabilities: [
					"chat",
					"coding",
					"streaming",
					"sessions",
					"diff",
					"permissions",
					"models",
					"reasoning-effort",
				],
			},
			runtime: new CodexAppServerRuntime({ codingPrompt: "coding.md" }),
			getAuthStatus: codexAuthStatus,
			probeAuth: codexAuthStatus,
			listModels: knownModels,
		});
	}
}

async function knownModels(): Promise<AgentModel[]> {
	const result = await runCli("codex", ["debug", "models"], {
		timeoutMs: 30_000,
	});
	if (result?.exitCode !== 0) return [];
	try {
		const body = JSON.parse(result.stdout) as {
			models?: Array<{
				slug?: string;
				display_name?: string;
				visibility?: string;
				// `codex debug models` reports the real window per model (e.g. 272k
				// for the 5.6 family, 500k for 6.1) — surface it so the context
				// panel compacts against the model limit, not the default budget.
				context_window?: number;
				max_context_window?: number;
			}>;
		};
		return (body.models ?? [])
			.filter((model) => model.slug && model.visibility !== "hide")
			.map((model) => ({
				...modelFromId("codex", model.slug as string, model.display_name, {
					...(typeof model.context_window === "number" &&
					Number.isSafeInteger(model.context_window) &&
					model.context_window > 0
						? { contextWindow: model.context_window }
						: {}),
				}),
				metadata: {
					experimental: true,
					visibility: model.visibility,
					modelId: model.slug,
				},
			}));
	} catch {
		return [];
	}
}

async function codexAuthStatus(): Promise<AuthStatus> {
	const result = await runCli("codex", ["login", "status"]);
	const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
	const authenticated =
		result?.exitCode === 0 && /logged in|authenticated|signed in/i.test(output);
	return {
		authenticated,
		strategy: "provider-managed",
		message: authenticated
			? undefined
			: "Codex authentication could not be verified",
	};
}
