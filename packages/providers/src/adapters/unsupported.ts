import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
	type AgentEvent,
	type AgentModel,
	type AuthenticateInput,
	type AuthResult,
	type AuthStatus,
	type CliProviderAdapter,
	type CreateSessionInput,
	type ProviderDefinition,
	type ProviderDetectionResult,
	ProviderError,
	type SendMessageInput,
} from "../core";

export function createUnsupportedAdapter(
	definition: ProviderDefinition,
): CliProviderAdapter {
	return new UnsupportedProviderAdapter(definition);
}

class UnsupportedProviderAdapter implements CliProviderAdapter {
	readonly definition: ProviderDefinition;
	constructor(definition: ProviderDefinition) {
		this.definition = definition;
	}

	async detect(): Promise<ProviderDetectionResult> {
		const executablePath = await findExecutable(this.definition.executable);
		if (!executablePath) return { installed: false };
		const version = await run(executablePath, ["--version"]);
		if (!version)
			return {
				installed: false,
				executablePath,
				error: "Executable did not respond to --version",
			};
		return {
			installed: true,
			executablePath,
			version: version?.trim() || undefined,
		};
	}

	async getVersion(): Promise<string | null> {
		return (await this.detect()).version ?? null;
	}

	async getAuthStatus(): Promise<AuthStatus> {
		return {
			authenticated: false,
			strategy: this.definition.authStrategy,
			message: "Authentication status is not exposed by this adapter",
		};
	}

	async authenticate(_input?: AuthenticateInput): Promise<AuthResult> {
		const status = await this.getAuthStatus();
		return {
			status,
			launched: false,
			command: this.definition.authCommand,
		};
	}

	async disconnect(): Promise<void> {}

	async listModels(): Promise<AgentModel[]> {
		return [];
	}

	async createSession(_input: CreateSessionInput): Promise<never> {
		throw new ProviderError(
			"UNSUPPORTED",
			`${this.definition.name} execution is not available yet`,
			{ providerId: this.definition.id },
		);
	}

	async *sendMessage(_input: SendMessageInput): AsyncIterable<AgentEvent> {
		yield {
			type: "error",
			message: `${this.definition.name} execution is not available yet`,
		};
	}

	async cancelSession(_sessionId: string): Promise<void> {
		throw new ProviderError(
			"UNSUPPORTED",
			`${this.definition.name} execution is not available yet`,
			{ providerId: this.definition.id },
		);
	}
}

async function findExecutable(command: string): Promise<string | null> {
	const configuredPath =
		process.env[`${command.toUpperCase().replaceAll("-", "_")}_BIN`]?.trim();
	const candidates = configuredPath
		? [configuredPath]
		: (process.env.PATH?.split(delimiter) ?? []).map((directory) =>
				join(
					directory,
					process.platform === "win32" ? `${command}.exe` : command,
				),
			);
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {}
	}
	return null;
}

function run(command: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		let stdout = "";
		const timer = setTimeout(() => {
			child.kill();
			resolve(null);
		}, 5000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.once("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(stdout);
		});
	});
}
