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
				args: [
					"exec",
					"--json",
					"--sandbox",
					"workspace-write",
					...(model ? ["--model", model] : []),
					`${await readPrompt("coding.md")}\n\n${prompt}`,
				],
			}),
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
	if (result?.exitCode === 0) {
		try {
			const body = JSON.parse(result.stdout) as {
				models?: Array<{
					slug?: string;
					display_name?: string;
					visibility?: string;
				}>;
			};
			const models = (body.models ?? [])
				.filter((model) => model.slug && model.visibility !== "hide")
				.map((model) =>
					modelFromId("codex", model.slug as string, model.display_name),
				);
			if (models.length) return models;
		} catch {}
	}
	return [
		modelFromId("codex", "gpt-6.1-sol"),
		modelFromId("codex", "gpt-6-astra"),
	];
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
