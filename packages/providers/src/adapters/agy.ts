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

/**
 * The canvas design contract forbids tool use. Headless Agy denies any tool it
 * would have to ask about, so the coding prompt - which invites the model to
 * read files and change project code - must never ride along with a design
 * request. Matched loosely because the create and refine prompts word the ban
 * slightly differently.
 */
const DESIGN_ONLY_PROMPT =
	/do not call tools[^\n]*shell commands[^\n]*(?:read or write files|create or edit project files)/i;

export function agyPromptText(
	prompt: string,
	codingPrompt: string,
	customInstructions = false,
): string {
	const designOnly = DESIGN_ONLY_PROMPT.test(prompt);
	return designOnly || customInstructions
		? prompt
		: `${codingPrompt}\n\n${prompt}`;
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
			buildPrompt: async ({
				prompt,
				model,
				permission,
				customInstructions,
			}) => {
				const permissionArgs = agyPermissionArgs(permission);
				// Canvas design requests already carry a dedicated no-tools output
				// contract. The coding prompt encourages shell exploration, which is
				// both unnecessary for drafting HTML and rejected by headless Agy.
				const codingPrompt = customInstructions
					? ""
					: await readPrompt("coding.md");
				return {
					command: "agy",
					args: [
						"--output-format",
						"stream-json",
						...permissionArgs,
						...(model ? ["--model", model] : []),
						`--print=${agyPromptText(prompt, codingPrompt, customInstructions)}`,
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
