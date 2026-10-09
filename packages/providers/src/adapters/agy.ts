import type { AgentModel, AuthStatus, RuntimePermission } from "../core";
import { CliProviderAdapter, modelFromId, readPrompt, runCli } from "./cli";
import { antigravityDefinition } from "./definitions";

// Headless Agy denies native "ask" prompts before Loom can answer them. The
// registered PreToolUse hook makes the decision for both modes instead.
export function agyPermissionArgs(permission?: RuntimePermission): string[] {
	if (permission?.mode === "read-only") return ["--mode", "plan"];
	if (permission?.mode === "auto" || permission?.mode === "ask")
		return ["--dangerously-skip-permissions"];
	return ["--mode", "accept-edits"];
}

export function agyPromptText(prompt: string, codingPrompt: string): string {
	const designOnly = prompt.includes(
		"Do not call tools, run shell commands, read or write files",
	);
	return designOnly ? prompt : `${codingPrompt}\n\n${prompt}`;
}

export class AgyProviderAdapter extends CliProviderAdapter {
	constructor() {
		super({
			codingPrompt: "coding.md",
			definition: {
				...antigravityDefinition,
				id: "agy",
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
			buildPrompt: async ({ prompt, model, permission }) => {
				const permissionArgs = agyPermissionArgs(permission);
				// Canvas design requests already carry a dedicated no-tools output
				// contract. The coding prompt encourages shell exploration, which is
				// both unnecessary for drafting HTML and rejected by headless Agy.
				const codingPrompt = await readPrompt("coding.md");
				return {
					command: "agy",
					args: [
						"--output-format",
						"stream-json",
						...permissionArgs,
						...(model ? ["--model", model] : []),
						`--print=${agyPromptText(prompt, codingPrompt)}`,
					],
				};
			},
			getAuthStatus: agyAuthStatus,
			probeAuth: agyAuthStatus,
			listModels: listAgyModels,
		});
	}
}

async function listAgyModels(): Promise<AgentModel[]> {
	const result = await runCli("agy", ["models"], { timeoutMs: 30_000 });
	if (result?.exitCode !== 0) return [];
	const lines = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !/^fetching available models/i.test(line));
	const models = lines.map((line) => {
		const [modelId, ...label] = line.split(/\s{2,}|\t/);
		return modelFromId("agy", modelId ?? line, label.join(" ") || modelId);
	});
	return models;
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
