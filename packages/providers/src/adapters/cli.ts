import { type ChildProcess, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type {
	AgentEvent,
	AgentModel,
	AgentRuntime,
	AgentSession,
	AuthStatus,
	CliProviderAdapter as CliProviderAdapterContract,
	CreateSessionInput,
	ProviderDefinition,
	ProviderDetectionResult,
	SendMessageInput,
} from "../core";
import { connectionId, normalizeModel, ProviderError } from "../core";

export type CliAdapterOptions = {
	definition: ProviderDefinition;
	codingPrompt?: string;
	buildPrompt: (input: { prompt: string; model?: string }) => Promise<{
		command: string;
		args: string[];
	}>;
	getAuthStatus: () => Promise<AuthStatus>;
	listModels?: () => Promise<AgentModel[]>;
	probeAuth?: () => Promise<AuthStatus>;
};

type SessionState = {
	id: string;
	executablePath: string;
	cwd: string;
	title: string;
	process: ChildProcess | null;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	output: string;
	error: string | null;
};

export class CliProviderAdapter implements CliProviderAdapterContract {
	readonly definition: ProviderDefinition;
	readonly runtime: CliRuntime;
	private readonly options: CliAdapterOptions;

	constructor(options: CliAdapterOptions) {
		this.options = options;
		this.definition = options.definition;
		this.runtime = new CliRuntime(options);
	}

	async detect(): Promise<ProviderDetectionResult> {
		const executablePath = await findExecutable(this.definition.executable);
		if (!executablePath) return { installed: false };
		return {
			installed: true,
			executablePath,
			version: await readVersion(executablePath),
		};
	}

	async getVersion(): Promise<string | null> {
		return (await this.detect()).version ?? null;
	}

	getAuthStatus(): Promise<AuthStatus> {
		return this.options.getAuthStatus();
	}

	async authenticate(): Promise<{
		status: AuthStatus;
		launched: boolean;
		command?: readonly string[];
	}> {
		const status = await (
			this.options.probeAuth ?? this.options.getAuthStatus
		)();
		return {
			status,
			launched: false,
			command: status.authenticated ? undefined : this.definition.authCommand,
		};
	}

	async disconnect(): Promise<void> {}

	async listModels(): Promise<AgentModel[]> {
		return (await this.options.listModels?.()) ?? [];
	}

	async createSession(input: CreateSessionInput): Promise<AgentSession> {
		const session = await this.runtime.createSession(input);
		return {
			id: session.id,
			providerId: this.definition.id,
			connectionId: connectionId(this.definition.id),
			providerSessionId: session.id,
			createdAt: new Date().toISOString(),
		};
	}

	async *sendMessage(input: SendMessageInput): AsyncIterable<AgentEvent> {
		yield { type: "session.started", providerSessionId: input.sessionId };
		try {
			await this.runtime.prompt({
				sessionId: input.sessionId,
				prompt: input.message,
				model: {
					providerID: input.model.providerId,
					modelID: input.model.modelId,
				},
			});
			const status = await this.runtime.wait(input.sessionId);
			if (status !== "completed")
				throw new ProviderError(
					"PROCESS_FAILED",
					(await this.runtime.lastError(input.sessionId)) ??
						`${this.definition.name} failed`,
					{ providerId: this.definition.id },
				);
			const output = await this.runtime.readOutput(input.sessionId);
			if (output?.output) yield { type: "message.delta", text: output.output };
			yield { type: "message.completed" };
			yield { type: "session.completed" };
		} catch (error) {
			yield {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	cancelSession(sessionId: string): Promise<void> {
		return this.runtime.abort(sessionId);
	}

	getRuntime(): AgentRuntime {
		return this.runtime;
	}
}

class CliRuntime implements AgentRuntime {
	private readonly sessions = new Map<string, SessionState>();
	private nextId = 0;
	private readonly options: CliAdapterOptions;

	constructor(options: CliAdapterOptions) {
		this.options = options;
	}

	async createSession(input: {
		cwd: string;
		title: string;
		readOnly?: boolean;
	}): Promise<{ id: string }> {
		const id = `loom-${this.options.definition.id}-${++this.nextId}`;
		this.sessions.set(id, {
			id,
			executablePath: this.options.definition.executable,
			cwd: input.cwd,
			title: input.title,
			process: null,
			status: "queued",
			output: "",
			error: null,
		});
		return { id };
	}

	async prompt(input: {
		sessionId: string;
		prompt: string;
		model?: { providerID: string; modelID: string };
	}): Promise<void> {
		const session = this.requireSession(input.sessionId);
		if (session.process)
			throw new ProviderError("PROCESS_FAILED", "Session is already running");
		const command = await this.options.buildPrompt({
			prompt: input.prompt,
			model: input.model?.modelID,
		});
		const executable = await findExecutable(command.command);
		if (!executable)
			throw new ProviderError(
				"NOT_INSTALLED",
				`${this.options.definition.name} executable was not found`,
				{
					providerId: this.options.definition.id,
				},
			);
		session.executablePath = executable;
		const child = spawn(executable, command.args, {
			cwd: session.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		session.process = child;
		session.status = "running";
		session.output = "";
		session.error = null;
		child.stdout.on("data", (chunk: Buffer) => {
			session.output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			session.error = `${session.error ?? ""}${chunk.toString()}`.trim();
		});
		child.once("error", (error) => {
			session.process = null;
			session.status = "failed";
			session.error = error.message;
		});
		child.once("exit", (code, signal) => {
			session.process = null;
			if (session.status === "cancelled") return;
			session.status = code === 0 ? "completed" : "failed";
			if (code !== 0 && !session.error)
				session.error = `${this.options.definition.name} exited with ${signal ?? `code ${code}`}`;
		});
	}

	async status(sessionId: string) {
		return this.requireSession(sessionId).status;
	}

	async lastError(sessionId: string): Promise<string | null> {
		return this.requireSession(sessionId).error;
	}

	async readOutput(sessionId: string) {
		const session = this.requireSession(sessionId);
		return { output: session.output };
	}

	async wait(
		sessionId: string,
		options: { timeoutMs?: number; pollIntervalMs?: number } = {},
	): Promise<"completed" | "failed" | "cancelled" | "interrupted"> {
		const deadline = Date.now() + (options.timeoutMs ?? 300_000);
		while (Date.now() <= deadline) {
			const status = await this.status(sessionId);
			if (
				status === "completed" ||
				status === "failed" ||
				status === "cancelled"
			)
				return status;
			await new Promise((resolve) =>
				setTimeout(resolve, options.pollIntervalMs ?? 100),
			);
		}
		throw new ProviderError(
			"PROCESS_FAILED",
			`${this.options.definition.name} timed out`,
			{
				providerId: this.options.definition.id,
			},
		);
	}

	async abort(sessionId: string): Promise<void> {
		const session = this.requireSession(sessionId);
		session.status = "cancelled";
		session.process?.kill("SIGTERM");
		session.process = null;
	}

	async getDiff(): Promise<unknown> {
		return [];
	}

	private requireSession(id: string): SessionState {
		const session = this.sessions.get(id);
		if (!session)
			throw new ProviderError("PROCESS_FAILED", `Session not found: ${id}`);
		return session;
	}
}

export async function findExecutable(command: string): Promise<string | null> {
	if (command.includes("/") || command.includes("\\")) {
		try {
			await access(command);
			return command;
		} catch {
			return null;
		}
	}
	const configured =
		process.env[`${command.toUpperCase().replaceAll("-", "_")}_BIN`]?.trim();
	const directories = [
		...(process.env.PATH?.split(delimiter) ?? []),
		join(homedir(), ".local", "bin"),
		join(homedir(), ".npm-global", "bin"),
		join(homedir(), ".bun", "bin"),
		join(homedir(), ".claude", "local"),
		"/usr/local/bin",
	];
	const candidates = configured
		? [configured]
		: directories.map((directory) => join(directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {}
	}
	return null;
}

export async function runCli(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null } | null> {
	const executable = await findExecutable(command);
	if (!executable) return null;
	return new Promise((resolveResult) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			resolveResult({ stdout, stderr, exitCode: null });
		}, options.timeoutMs ?? 5_000);
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.once("error", () => {
			clearTimeout(timer);
			resolveResult(null);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolveResult({ stdout, stderr, exitCode: code });
		});
	});
}

export async function readVersion(
	executable: string,
): Promise<string | undefined> {
	for (const args of [["--version"], ["-v"], ["version"]]) {
		const result = await runCli(executable, args);
		if (!result) continue;
		const text = `${result.stdout}\n${result.stderr}`.trim();
		const line =
			text.split("\n").find((value) => /\d/.test(value)) ?? text.split("\n")[0];
		if (line?.trim()) return line.trim();
	}
	return undefined;
}

export function promptPath(name: string): string {
	const root =
		process.env.LOOM_PROMPTS_DIR?.trim() || resolve(process.cwd(), "prompts");
	return join(root, name);
}

export async function readPrompt(name: string): Promise<string> {
	const path = promptPath(name);
	try {
		return await Bun.file(path).text();
	} catch {
		throw new Error(`Prompt file is missing: ${path}`);
	}
}

export function modelFromId(providerId: string, modelId: string): AgentModel {
	return normalizeModel({
		providerId,
		connectionId: connectionId(providerId),
		modelId,
		name: modelId,
		displayName: modelId,
		capabilities: ["text", "coding"],
		isAvailable: true,
	});
}
