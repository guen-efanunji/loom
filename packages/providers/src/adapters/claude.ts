import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentModel, AuthStatus } from "../core";
import { CliProviderAdapter, modelFromId, promptPath, runCli } from "./cli";
import { claudeCodeDefinition } from "./definitions";

export class ClaudeProviderAdapter extends CliProviderAdapter {
	constructor() {
		super({
			codingPrompt: "coding.md",
			definition: {
				...claudeCodeDefinition,
				capabilities: [
					"chat",
					"coding",
					"streaming",
					"sessions",
					"permissions",
					"system-prompt",
					"diff",
					"models",
				],
			},
			buildPrompt: async ({ prompt, model }) => ({
				command: "claude",
				args: [
					"--print",
					"--output-format",
					"text",
					"--append-system-prompt-file",
					promptPath("coding.md"),
					...(model ? ["--model", model] : []),
					prompt,
				],
			}),
			getAuthStatus: claudeAuthStatus,
			probeAuth: claudeAuthStatus,
			listModels: knownModels,
		});
	}
}

async function knownModels(): Promise<AgentModel[]> {
	const result = await runCli("claude", ["models"], { timeoutMs: 30_000 });
	if (result?.exitCode === 0) {
		const models = result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !/^usage:|^claude code/i.test(line))
			.map((line) => {
				const [modelId, ...label] = line.split(/\s{2,}|\t/);
				return modelFromId(
					"claude",
					modelId ?? line,
					label.join(" ") || modelId,
				);
			});
		if (models.length) return models;
	}
	return [];
}

async function claudeAuthStatus(): Promise<AuthStatus> {
	const result = await runCli("claude", ["auth", "status", "--json"]);
	if (result?.exitCode === 0) {
		try {
			const body = JSON.parse(result.stdout) as {
				loggedIn?: boolean;
				authMethod?: string;
			};
			return {
				authenticated: body.loggedIn === true,
				strategy: "provider-managed",
				accountLabel: body.authMethod,
				message:
					body.loggedIn === true
						? undefined
						: "Claude Code is not authenticated",
			};
		} catch {}
	}
	for (const path of [
		join(homedir(), ".claude.json"),
		join(homedir(), ".claude", ".credentials.json"),
	]) {
		try {
			const body = JSON.parse(await readFile(path, "utf8")) as Record<
				string,
				unknown
			>;
			if (hasClaudeAccount(body))
				return { authenticated: true, strategy: "provider-managed" };
		} catch {}
	}
	return {
		authenticated: false,
		strategy: "provider-managed",
		message: "Claude Code authentication could not be verified",
	};
}

function hasClaudeAccount(body: Record<string, unknown>): boolean {
	const account = body.oauthAccount;
	return (
		typeof account === "object" &&
		account !== null &&
		Object.keys(account).length > 0
	);
}
