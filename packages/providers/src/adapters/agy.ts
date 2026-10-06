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
			listModels: listAgyModels,
		});
	}
}

async function listAgyModels(): Promise<AgentModel[]> {
	const result = await runCli("agy", ["models"], { timeoutMs: 30_000 });
	if (result?.exitCode !== 0) return [modelFromId("antigravity", "default")];
	const lines = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !/^fetching available models/i.test(line));
	const models = lines.map((line) => {
		const [modelId, ...label] = line.split(/\s{2,}|\t/);
		return modelFromId(
			"antigravity",
			modelId ?? line,
			label.join(" ") || modelId,
		);
	});
	return models.length ? models : [modelFromId("antigravity", "default")];
}

async function agyAuthStatus(): Promise<AuthStatus> {
	const result = await runCli(
		"agy",
		["--output-format", "json", "--print=ping"],
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
