import type { AgentModel, AuthStatus } from "../core";
import { CliProviderAdapter, modelFromId, readPrompt, runCli } from "./cli";
import { antigravityDefinition } from "./definitions";

export class AgyProviderAdapter extends CliProviderAdapter {
	constructor() {
		super({
			codingPrompt: "coding.md",
			definition: {
				...antigravityDefinition,
				id: "antigravity",
				name: "Antigravity CLI",
				capabilities: [
					"chat",
					"coding",
					"streaming",
					"sessions",
					"resume-session",
					"diff",
					"models",
				],
				authCommand: undefined,
			},
			buildPrompt: async ({ prompt, model }) => ({
				command: "agy",
				args: [
					"--print",
					"--output-format",
					"stream-json",
					...(model ? ["--model", model] : []),
					`${await readPrompt("coding.md")}\n\n${prompt}`,
				],
			}),
			getAuthStatus: agyAuthStatus,
			probeAuth: agyAuthStatus,
			listModels: async () => listAgyModels(),
		});
	}
}

async function listAgyModels(): Promise<AgentModel[]> {
	const result = await runCli("agy", ["models", "--output-format", "json"]);
	if (result?.exitCode === 0) {
		try {
			const body = JSON.parse(result.stdout) as unknown;
			if (Array.isArray(body))
				return body.flatMap((item) => {
					if (typeof item === "string")
						return [modelFromId("antigravity", item)];
					if (
						typeof item === "object" &&
						item !== null &&
						"id" in item &&
						typeof item.id === "string"
					)
						return [modelFromId("antigravity", item.id)];
					return [];
				});
		} catch {}
	}
	return [modelFromId("antigravity", "default")];
}

async function agyAuthStatus(): Promise<AuthStatus> {
	const result = await runCli(
		"agy",
		["--print", "--output-format", "json", "ping"],
		{
			timeoutMs: 15_000,
		},
	);
	const authenticated = result?.exitCode === 0;
	return {
		authenticated,
		strategy: "provider-managed",
		message: authenticated
			? undefined
			: "Agy is not authenticated or could not answer a probe",
	};
}
