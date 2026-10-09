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
				],
			},
			buildPrompt: async ({ prompt, model }) => ({
				command: "codex",
				// codex exec may wait for more stdin in non-TTY environments even
				// when the prompt is an argument. Send EOF explicitly to avoid that.
				stdin: "",
				args: [
					"exec",
					"--json",
					"--sandbox",
					"workspace-write",
					...(model ? ["--model", codexModelSlug(model)] : []),
					`${await readPrompt("coding.md")}\n\n${prompt}`,
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
			}>;
		};
		return (body.models ?? [])
			.filter((model) => model.slug && model.visibility !== "hide")
			.map((model) => ({
				...modelFromId("codex", model.slug as string, model.display_name),
				metadata: { experimental: true, visibility: model.visibility },
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
