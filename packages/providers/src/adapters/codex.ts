import type { AgentModel, AuthStatus } from "../core";
import { CliProviderAdapter, modelFromId, readPrompt, runCli } from "./cli";
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
			buildPrompt: async ({
				prompt,
				model,
				thinkingMode,
				permission,
				customInstructions,
			}) => ({
				command: "codex",
				// codex exec may wait for more stdin in non-TTY environments even
				// when the prompt is an argument. Send EOF explicitly to avoid that.
				stdin: "",
				args: [
					// This is a top-level Codex option; placing it after `exec` makes
					// current Codex CLI versions reject the invocation as an unknown flag.
					"--ask-for-approval",
					permission?.mode === "auto" ? "never" : "on-request",
					"exec",
					// Codex refuses to run outside a trusted Git worktree ("Not inside
					// a trusted directory and --skip-git-repo-check was not specified").
					// Loom sessions can live in worktrees that are not Git repos, and
					// the connectivity probe runs from the daemon cwd, so allow it.
					"--skip-git-repo-check",
					"--json",
					"--sandbox",
					permission?.mode === "read-only" ? "read-only" : "workspace-write",
					...(thinkingMode && thinkingMode !== "default"
						? ["--config", `model_reasoning_effort=${thinkingMode}`]
						: []),
					...(model ? ["--model", codexModelSlug(model)] : []),
					customInstructions
						? prompt
						: `${await readPrompt("coding.md")}\n\n${prompt}`,
				],
			}),
			getAuthStatus: codexAuthStatus,
			probeAuth: codexAuthStatus,
			listModels: knownModels,
		});
	}
}

function codexModelSlug(model: string): string {
	// The UI/catalog can expose a display label such as "GPT-5.6-Sol", while
	// `codex exec --model` expects the CLI slug (`gpt-5.6-sol`).
	return model.trim().toLowerCase().replace(/\s+/g, "-");
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
