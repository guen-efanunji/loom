import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
	RuntimeActivity,
	RuntimeOutput,
	RuntimePermission,
	SendMessageInput,
} from "../core";
import { connectionId, normalizeModel, ProviderError } from "../core";

export type CliAdapterOptions = {
	definition: ProviderDefinition;
	codingPrompt?: string;
	buildPrompt: (input: {
		prompt: string;
		model?: string;
		permission?: RuntimePermission;
	}) => Promise<{
		command: string;
		args: string[];
		/** Optional stdin payload. Supplying an empty string sends EOF immediately. */
		stdin?: string;
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
	permission?: RuntimePermission;
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
		permission?: RuntimePermission;
	}): Promise<void> {
		const session = this.requireSession(input.sessionId);
		if (session.process)
			throw new ProviderError("PROCESS_FAILED", "Session is already running");
		if (input.permission) session.permission = input.permission;
		const command = await this.options.buildPrompt({
			prompt: input.prompt,
			model: input.model?.modelID,
			permission: input.permission ?? session.permission,
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
			stdio: [command.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: { ...process.env, ...session.permission?.env },
			windowsHide: true,
		});
		session.process = child;
		session.status = "running";
		session.output = "";
		session.error = null;
		child.stdout?.on("data", (chunk: Buffer) => {
			session.output += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			session.error = `${session.error ?? ""}${chunk.toString()}`.trim();
		});
		if (command.stdin !== undefined) child.stdin?.end(command.stdin);
		child.once("error", (error) => {
			session.process = null;
			session.status = "failed";
			session.error = error.message;
		});
		child.once("close", (code, signal) => {
			session.process = null;
			if (session.status === "cancelled") return;
			// Codex prints this informational notice while consuming non-TTY stdin.
			// It is not a failure reason and should not become the chat error message.
			session.error =
				session.error
					?.replace(/Reading additional input from stdin\.\.\.\s*/g, "")
					.trim() || null;
			const result =
				this.options.definition.id === "claude"
					? { output: session.output.trim(), error: undefined }
					: parseCliOutput(session.output);
			const emptyResponse = code === 0 && !result.output.trim();
			session.status =
				code === 0 && !result.error && !emptyResponse ? "completed" : "failed";
			if (result.error) session.error = result.error;
			else if (emptyResponse && !session.error)
				session.error = `${this.options.definition.name} finished without a text response. Check the provider's permissions and authentication, then retry.`;
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
		return parseCliOutput(session.output);
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
	const loginPath = process.env.PATH?.trim();
	if (loginPath) directories.push(...loginPath.split(delimiter));
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
	const configured = process.env.LOOM_PROMPTS_DIR?.trim();
	const candidates = [
		...(configured ? [join(configured, name)] : []),
		join(process.cwd(), "prompts", name),
		resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../../../prompts",
			name,
		),
	];
	return (
		candidates.find((path) => existsSync(path)) ??
		candidates[0] ??
		join(process.cwd(), "prompts", name)
	);
}

export async function readPrompt(name: string): Promise<string> {
	const path = promptPath(name);
	try {
		return await Bun.file(path).text();
	} catch {
		throw new Error(`Prompt file is missing: ${path}`);
	}
}

export function normalizeCliOutput(output: string): string {
	return parseCliOutput(output).output;
}

export function parseCliOutput(output: string): {
	output: string;
	error?: string;
	activities: RuntimeActivity[];
	parts: NonNullable<RuntimeOutput["parts"]>;
} {
	const text: string[] = [];
	const agySteps = new Map<number, number>();
	const activities = new Map<string, RuntimeActivity>();
	const orderedParts: Array<
		{ type: "text"; id: string } | { type: "activity"; id: string }
	> = [];
	const orderedText = new Map<string, string>();
	const orderedActivityIds = new Set<string>();
	function setActivity(activity: RuntimeActivity) {
		activities.set(activity.id, activity);
		if (!orderedActivityIds.has(activity.id)) {
			orderedActivityIds.add(activity.id);
			orderedParts.push({ type: "activity", id: activity.id });
		}
	}
	function setText(id: string, value: string, append = false) {
		if (!orderedText.has(id)) orderedParts.push({ type: "text", id });
		orderedText.set(
			id,
			append ? `${orderedText.get(id) ?? ""}${value}` : value,
		);
	}
	let error: string | undefined;
	let finalResponse: string | undefined;
	for (const line of output.split("\n").filter(Boolean)) {
		try {
			const event = JSON.parse(line);
			if (!event || typeof event !== "object") {
				text.push(line);
				setText(`plain-${orderedParts.length}`, line);
				continue;
			}
			if (event.event === "result" && event.result) {
				const denied = event.result.denied_actions;
				if (Array.isArray(denied) && denied.length) {
					const actions = denied
						.map((action) => action.display_name || action.action)
						.filter((action) => typeof action === "string");
					error = `Agy could not complete the request because tool permission was denied${actions.length ? `: ${actions.join(", ")}` : ""}. Noninteractive mode cannot ask for approval. Configure a specific allow-rule in Agy settings or run the task interactively, then retry.`;
				} else if (event.result.status && event.result.status !== "SUCCESS") {
					error =
						typeof event.result.error === "string"
							? event.result.error
							: event.result.error?.message ||
								`Agy finished with status ${event.result.status}`;
				}
			}
			if (event.type === "error" || event.type === "turn.failed") {
				const message =
					typeof event.error === "string"
						? event.error
						: (event.error?.message ?? event.message);
				if (typeof message === "string" && message.trim())
					error = message.trim();
			}
			const step = event.step_update;
			if (step?.step_type === "tool") {
				const toolInfo = step.tool_info ?? {};
				const name = step.tool_name ?? toolInfo.name ?? "tool";
				const params = toolInfo.parameters;
				const input =
					params && typeof params === "object" && !Array.isArray(params)
						? (params as Record<string, unknown>)
						: undefined;
				const stepId = `agy-${step.step_index ?? activities.size}`;
				const patch =
					typeof toolInfo.diff === "string" ? toolInfo.diff : undefined;
				const file = input?.TargetFile ?? input?.filePath ?? input?.path;
				const activity: RuntimeActivity = {
					id: stepId,
					tool: String(name),
					status: toolInfo.error
						? "error"
						: step.state === "ACTIVE"
							? "running"
							: "completed",
					...(input ? { input } : {}),
					...(typeof toolInfo.output === "string"
						? { output: toolInfo.output }
						: {}),
					...(typeof toolInfo.error?.message === "string"
						? { error: toolInfo.error.message }
						: {}),
					...(toolInfo.filediff || toolInfo.files || toolInfo.diff
						? {
								metadata: {
									...(toolInfo.filediff
										? { filediff: toolInfo.filediff }
										: patch && file
											? {
													filediff: {
														file,
														patch,
														additions: patch
															.split("\n")
															.filter(
																(line: string) =>
																	line.startsWith("+") &&
																	!line.startsWith("+++"),
															).length,
														deletions: patch
															.split("\n")
															.filter(
																(line: string) =>
																	line.startsWith("-") &&
																	!line.startsWith("---"),
															).length,
													},
												}
											: {}),
									...(toolInfo.files ? { files: toolInfo.files } : {}),
									...(toolInfo.diff ? { diff: toolInfo.diff } : {}),
								},
							}
						: {}),
				};
				setActivity(activity);
			}
			const item = event.item;
			if (
				(event.type === "item.started" || event.type === "item.completed") &&
				item &&
				typeof item === "object"
			) {
				const itemType = String(item.type ?? "");
				const itemId = String(item.id ?? `${itemType}-${activities.size}`);
				if (itemType === "file_change" && Array.isArray(item.changes)) {
					for (const [index, change] of item.changes.entries()) {
						if (!change || typeof change !== "object") continue;
						const file = change.path ?? change.filePath ?? change.file;
						const changeId = `codex-${itemId}-${index}`;
						setActivity({
							id: changeId,
							tool: "file_change",
							status: event.type === "item.started" ? "running" : "completed",
							input: {
								...(typeof file === "string" ? { path: file } : {}),
								kind: change.kind,
							},
							...(typeof change.diff === "string"
								? {
										metadata: {
											filediff: {
												file,
												patch: change.diff,
												additions: change.diff
													.split("\n")
													.filter(
														(line: string) =>
															line.startsWith("+") && !line.startsWith("+++"),
													).length,
												deletions: change.diff
													.split("\n")
													.filter(
														(line: string) =>
															line.startsWith("-") && !line.startsWith("---"),
													).length,
											},
										},
									}
								: {}),
						});
					}
				} else if (
					["command_execution", "shell", "tool_call"].includes(itemType)
				) {
					const activity: RuntimeActivity = {
						id: `codex-${itemId}`,
						tool: itemType,
						status:
							event.type === "item.started"
								? "running"
								: item.exit_code && item.exit_code !== 0
									? "error"
									: "completed",
						input: {
							...(typeof item.command === "string"
								? { command: item.command }
								: {}),
							...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
						},
						...(typeof item.aggregated_output === "string"
							? { output: item.aggregated_output }
							: {}),
					};
					setActivity(activity);
				}
			}
			if (event.type === "assistant" && Array.isArray(event.message?.content)) {
				for (const [index, block] of event.message.content.entries()) {
					if (block.type === "text" && typeof block.text === "string") {
						text.push(block.text);
						setText(
							`claude-${event.message.id ?? orderedParts.length}-${index}`,
							block.text,
						);
					}
					if (block.type === "tool_use" && typeof block.name === "string") {
						const input =
							block.input &&
							typeof block.input === "object" &&
							!Array.isArray(block.input)
								? (block.input as Record<string, unknown>)
								: undefined;
						const activityId = `claude-${block.id ?? activities.size}`;
						setActivity({
							id: activityId,
							tool: block.name,
							status: "running",
							...(input ? { input } : {}),
						});
					}
				}
			}
			if (event.type === "user" && Array.isArray(event.message?.content)) {
				for (const block of event.message.content) {
					if (
						block.type !== "tool_result" ||
						typeof block.tool_use_id !== "string"
					)
						continue;
					const activityId = `claude-${block.tool_use_id}`;
					const activity = activities.get(activityId);
					if (activity)
						setActivity({
							...activity,
							status: block.is_error ? "error" : "completed",
							...(typeof block.content === "string"
								? { output: block.content }
								: {}),
						});
				}
			}
			if (
				event.type === "result" &&
				typeof event.result === "object" &&
				typeof event.result?.response === "string"
			)
				finalResponse = event.result.response;
			if (typeof event.result?.response === "string") {
				if (event.result.response.trim()) finalResponse = event.result.response;
			} else if (event.type === "result" && typeof event.result === "string")
				finalResponse = event.result;
			else if (
				event.step_update?.step_type === "agent_response" &&
				typeof event.step_update.text_delta === "string"
			) {
				const step = event.step_update.step_index ?? 0;
				let index = agySteps.get(step);
				if (index === undefined) {
					index = text.length;
					agySteps.set(step, index);
					text.push("");
				}
				text[index] += event.step_update.text_delta;
				setText(`agy-${step}`, event.step_update.text_delta, true);
			} else if (typeof event.step_update?.agent_response?.text === "string") {
				const step = event.step_update.step_index ?? orderedParts.length;
				text.push(event.step_update.agent_response.text);
				setText(`agy-${step}`, event.step_update.agent_response.text);
			} else if (
				event.type === "item.completed" &&
				event.item?.type === "agent_message" &&
				typeof event.item.text === "string"
			) {
				text.push(event.item.text);
				setText(
					`codex-${event.item.id ?? orderedParts.length}`,
					event.item.text,
				);
			} else if (!event.type && !event.event) {
				text.push(line);
				setText(`plain-${orderedParts.length}`, line);
			}
		} catch {
			// A partial JSON event will be parsed on the next output poll.
			if (!line.trimStart().startsWith("{")) {
				text.push(line);
				setText(`plain-${orderedParts.length}`, line);
			}
		}
	}
	if (!orderedText.size && finalResponse?.trim())
		setText("final-response", finalResponse);
	const parts: NonNullable<RuntimeOutput["parts"]> = [];
	for (const part of orderedParts) {
		if (part.type === "text") {
			const value = orderedText.get(part.id) ?? "";
			if (value.trim()) parts.push({ ...part, text: value });
		} else {
			parts.push(part);
		}
	}
	return {
		output: (finalResponse ?? text.join("\n")).trim(),
		error,
		activities: [...activities.values()],
		parts,
	};
}

export function modelFromId(
	providerId: string,
	modelId: string,
	name = modelId,
): AgentModel {
	return normalizeModel({
		providerId,
		connectionId: connectionId(providerId),
		modelId,
		name,
		displayName: name,
		capabilities: ["text", "coding"],
		isAvailable: true,
	});
}
