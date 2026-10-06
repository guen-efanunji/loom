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
			listModels: async () => knownModels(),
		});
	}
}

function knownModels(): AgentModel[] {
	return [modelFromId("codex", "gpt-5-codex"), modelFromId("codex", "gpt-5")];
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
