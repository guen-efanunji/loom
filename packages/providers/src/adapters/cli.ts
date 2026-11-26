import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPromptFile, loadPromptText } from "@loom/distribution";
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
import {
	buildToolFileDiff,
	describeLineChanges,
	diffCountsFromPatch,
	extractToolFilePath,
} from "./diff";

/** Stay well below Linux MAX_ARG_STRLEN (128 KiB) and Windows CreateProcess (32 KiB). */
export const CLI_ARG_PROMPT_LIMIT_BYTES = 32_768;

export function shouldUseStdinForPrompt(text: string): boolean {
	return Buffer.byteLength(text, "utf8") > CLI_ARG_PROMPT_LIMIT_BYTES;
}

type CliPromptBuilder = (input: {
	prompt: string;
	model?: string;
	thinkingMode?: string;
	permission?: RuntimePermission;
	customInstructions?: boolean;
}) => Promise<{
	command: string;
	args: string[];
	/** Optional stdin payload. Supplying an empty string sends EOF immediately. */
	stdin?: string;
	env?: Record<string, string>;
}>;

export type CliAdapterOptions = {
	definition: ProviderDefinition;
	codingPrompt?: string;
	getAuthStatus: () => Promise<AuthStatus>;
	listModels?: () => Promise<AgentModel[]>;
	probeAuth?: () => Promise<AuthStatus>;
} & (
	| {
			runtime: AgentRuntime;
			buildPrompt?: CliPromptBuilder;
	  }
	| {
			runtime?: undefined;
			buildPrompt: CliPromptBuilder;
	  }
);

type SessionState = {
	id: string;
	executablePath: string;
	cwd: string;
	title: string;
	process: ChildProcess | null;
	status:
		| "queued"
		| "running"
		| "stopping"
		| "completed"
		| "failed"
		| "cancelled";
	closePromise: Promise<void> | null;
	resolveClose: (() => void) | null;
	parser: CliOutputParser;
	error: string | null;
	permission?: RuntimePermission;
	waiters: Set<() => void>;
};

export class CliProviderAdapter implements CliProviderAdapterContract {
	readonly definition: ProviderDefinition;
	readonly runtime: AgentRuntime;
	private readonly options: CliAdapterOptions;

	constructor(options: CliAdapterOptions) {
		this.options = options;
		this.definition = options.definition;
		this.runtime = options.runtime ?? new CliRuntime(options);
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

	async disconnect(): Promise<void> {
		await this.runtime.dispose?.();
	}

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
					(await this.runtime.lastError?.(input.sessionId)) ??
						`${this.definition.name} failed`,
					{ providerId: this.definition.id },
				);
			const output = await this.runtime.readOutput?.(input.sessionId);
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
			closePromise: null,
			resolveClose: null,
			parser: new CliOutputParser(),
			error: null,
			waiters: new Set(),
		});
		return { id };
	}

	async prompt(input: {
		sessionId: string;
		prompt: string;
		system?: string;
		model?: { providerID: string; modelID: string };
		thinkingMode?: string;
		images?: Array<{ mime: string; data: string }>;
		permission?: RuntimePermission;
	}): Promise<void> {
		const session = this.requireSession(input.sessionId);
		if (session.process)
			throw new ProviderError("PROCESS_FAILED", "Session is already running");
		// CLI backends cannot take inline base64 images, but the underlying
		// models read images from disk: persist the attachments under the loom
		// home and reference their paths in the prompt instead of dropping them.
		const promptText = input.images?.length
			? `${input.prompt}\n\n${await this.persistAndReferenceImages(session.id, input.images)}`
			: input.prompt;
		if (!this.options.buildPrompt)
			throw new ProviderError(
				"PROCESS_FAILED",
				`${this.options.definition.name} CLI prompt builder is not configured`,
				{ providerId: this.options.definition.id },
			);
		if (input.permission) session.permission = input.permission;
		const command = await this.options.buildPrompt({
			prompt: input.system
				? `${input.system.trim()}\n\n---\n\n${promptText}`
				: promptText,
			model: input.model?.modelID,
			thinkingMode: input.thinkingMode,
			permission: input.permission ?? session.permission,
			customInstructions: !!input.system,
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
			env: { ...process.env, ...session.permission?.env, ...command.env },
			windowsHide: true,
			// POSIX process groups let abort signal CLI descendants that may keep
			// writing into this workspace after the top-level CLI exits.
			detached: process.platform !== "win32",
		});
		session.process = child;
		session.status = "running";
		session.closePromise = new Promise<void>((resolve) => {
			session.resolveClose = resolve;
		});
		session.parser = new CliOutputParser();
		session.error = null;
		child.stdout?.on("data", (chunk: Buffer) => {
			session.parser.push(chunk.toString());
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			session.error = `${session.error ?? ""}${chunk.toString()}`.trim();
		});
		if (command.stdin !== undefined) child.stdin?.end(command.stdin);
		child.once("error", (error) => {
			session.process = null;
			session.status = "failed";
			session.error = error.message;
			session.resolveClose?.();
			session.resolveClose = null;
			session.closePromise = null;
			this.notifyWaiters(session);
		});
		child.once("close", (code, signal) => {
			session.process = null;
			session.resolveClose?.();
			session.resolveClose = null;
			session.closePromise = null;
			session.parser.finish();
			if (session.status === "cancelled" || session.status === "stopping") {
				this.notifyWaiters(session);
				return;
			}
			// Codex prints this informational notice while consuming non-TTY stdin.
			// It is not a failure reason and should not become the chat error message.
			session.error =
				session.error
					?.replace(/Reading additional input from stdin\.\.\.\s*/g, "")
					.trim() || null;
			const result = session.parser.snapshot();
			const emptyResponse = code === 0 && !result.output.trim();
			session.status =
				code === 0 && !result.error && !emptyResponse ? "completed" : "failed";
			if (result.error) session.error = result.error;
			else if (emptyResponse && !session.error)
				session.error = `${this.options.definition.name} finished without a text response. Check the provider's permissions and authentication, then retry.`;
			if (code !== 0 && !session.error)
				session.error = `${this.options.definition.name} exited with ${signal ?? `code ${code}`}`;
			this.notifyWaiters(session);
		});
	}

	async status(
		sessionId: string,
	): Promise<"queued" | "running" | "completed" | "failed" | "cancelled"> {
		const status = this.requireSession(sessionId).status;
		// `stopping` is an internal lifecycle state, exposed as running so callers
		// cannot mistake a termination request for a completed cancellation.
		return status === "stopping" ? "running" : status;
	}

	async lastError(sessionId: string): Promise<string | null> {
		return this.requireSession(sessionId).error;
	}

	async readOutput(sessionId: string) {
		const session = this.requireSession(sessionId);
		return session.parser.snapshot();
	}

	/**
	 * CLI backends read images from disk, not from base64 channels: save each
	 * attachment under the loom image store and return a prompt section that
	 * points the model at the saved files. The store lives outside the session
	 * cwd so agent-driven diffs and "changed files" views stay clean.
	 */
	private async persistAndReferenceImages(
		sessionId: string,
		images: Array<{ mime: string; data: string }>,
	): Promise<string> {
		const imageStore = join(
			process.env.LOOM_HOME ?? join(homedir(), ".loom"),
			"images",
			sessionId,
		);
		const stamp = Date.now();
		const saved: string[] = [];
		try {
			await mkdir(imageStore, { recursive: true });
			for (const [index, image] of images.entries()) {
				const extension = IMAGE_EXTENSIONS[image.mime] ?? "bin";
				const path = join(
					imageStore,
					`attachment-${stamp}-${index + 1}.${extension}`,
				);
				await writeFile(path, Buffer.from(image.data, "base64"));
				saved.push(path);
			}
		} catch (error) {
			throw new ProviderError(
				"PROCESS_FAILED",
				`Saving image attachments failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ providerId: this.options.definition.id },
			);
		}
		return [
			"The user attached these image files; read or open them to see the referenced visuals:",
			...saved.map((path, index) => `${index + 1}. ${path}`),
		].join("\n");
	}

	async wait(
		sessionId: string,
		options: {
			timeoutMs?: number;
			pollIntervalMs?: number;
			onStatus?: (
				status: "queued" | "running" | "completed" | "failed" | "cancelled",
			) => void | Promise<void>;
		} = {},
	): Promise<"completed" | "failed" | "cancelled" | "interrupted"> {
		const session = this.requireSession(sessionId);
		const deadline = Date.now() + (options.timeoutMs ?? 300_000);
		let lastObserved:
			| "queued"
			| "running"
			| "completed"
			| "failed"
			| "cancelled"
			| null = null;
		while (true) {
			const current = await this.status(sessionId);
			if (options.onStatus && current !== lastObserved) {
				lastObserved = current;
				await options.onStatus(current);
			}
			if (
				current === "completed" ||
				current === "failed" ||
				current === "cancelled"
			)
				return current;
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await new Promise<void>((resolve) => {
				let settled = false;
				const wake = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					session.waiters.delete(wake);
					resolve();
				};
				const timer = setTimeout(wake, remaining);
				session.waiters.add(wake);
			});
		}
		const current = await this.status(sessionId);
		if (
			current === "completed" ||
			current === "failed" ||
			current === "cancelled"
		)
			return current;
		await this.abort(sessionId);
		this.requireSession(sessionId).error =
			`${this.options.definition.name} timed out`;
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
		const child = session.process;
		if (!child) {
			if (session.status === "running" || session.status === "stopping") {
				session.status = "failed";
				this.notifyWaiters(session);
			}
			return;
		}
		if (session.status === "cancelled") {
			await session.closePromise;
			return;
		}
		if (session.status === "stopping") {
			await session.closePromise;
			if (session.process === child)
				throw new ProviderError(
					"PROCESS_FAILED",
					`${this.options.definition.name} did not confirm process shutdown`,
					{ providerId: this.options.definition.id },
				);
			return;
		}
		session.status = "stopping";
		const closed = session.closePromise;
		try {
			if (process.platform !== "win32" && child.pid)
				process.kill(-child.pid, "SIGTERM");
			else child.kill("SIGTERM");
		} catch (error) {
			session.error = error instanceof Error ? error.message : String(error);
			child.kill("SIGTERM");
		}
		// SIGTERM is only a request. Keep process ownership until close confirms
		// the child has exited; escalate if it does not terminate promptly.
		const graceful = await Promise.race([
			closed?.then(() => true) ?? Promise.resolve(true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 1500)),
		]);
		const processGroupMayRemain = () => {
			if (process.platform === "win32" || !child.pid) return false;
			try {
				process.kill(-child.pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		if (!graceful || processGroupMayRemain()) {
			try {
				if (process.platform !== "win32" && child.pid)
					process.kill(-child.pid, "SIGKILL");
				else if (session.process === child) child.kill("SIGKILL");
			} catch (error) {
				session.error = error instanceof Error ? error.message : String(error);
				if (session.process === child) child.kill("SIGKILL");
			}
			await closed;
			if (process.platform !== "win32" && child.pid) {
				const descendantsStoppedAt = Date.now() + 5000;
				while (processGroupMayRemain() && Date.now() < descendantsStoppedAt)
					await new Promise((resolve) => setTimeout(resolve, 25));
				if (processGroupMayRemain())
					throw new ProviderError(
						"PROCESS_FAILED",
						`${this.options.definition.name} descendants did not confirm shutdown`,
						{ providerId: this.options.definition.id },
					);
			}
		}
		if (session.process === child)
			throw new ProviderError(
				"PROCESS_FAILED",
				`${this.options.definition.name} did not confirm process shutdown`,
				{ providerId: this.options.definition.id },
			);
		session.status = "cancelled";
		this.notifyWaiters(session);
	}

	private notifyWaiters(session: SessionState): void {
		for (const wake of session.waiters) wake();
	}

	async getDiff(): Promise<unknown> {
		return [];
	}

	async deleteSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		if (session.status === "running" || session.status === "stopping") {
			await this.abort(sessionId);
		}
		this.sessions.delete(sessionId);
	}

	async dispose(): Promise<void> {
		for (const sessionId of [...this.sessions.keys()]) {
			await this.deleteSession(sessionId).catch(() => {});
		}
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

/** Repository prompt folder, used while running from a checkout. */
const modulePrompts = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../prompts",
);

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
};

export function promptPath(name: string): string {
	return loadPromptFile(name, [modulePrompts]);
}

export async function readPrompt(name: string): Promise<string> {
	return loadPromptText(name, [modulePrompts]);
}

export function normalizeCliOutput(output: string): string {
	return parseCliOutput(output).output;
}

export type ParsedCliOutput = {
	output: string;
	error?: string;
	tokens?: NonNullable<RuntimeOutput["tokens"]>;
	cost?: number;
	activities: RuntimeActivity[];
	parts: NonNullable<RuntimeOutput["parts"]>;
};

export class CliOutputParser {
	private lineBuffer = "";
	private readonly text: string[] = [];
	private readonly agySteps = new Map<number, number>();
	private readonly activities = new Map<string, RuntimeActivity>();
	private readonly orderedParts: Array<
		{ type: "text"; id: string } | { type: "activity"; id: string }
	> = [];
	private readonly orderedText = new Map<string, string>();
	private readonly orderedActivityIds = new Set<string>();
	private readonly completedCodexMessages = new Set<string>();
	private error: string | undefined;
	private finalResponse: string | undefined;
	private tokens: NonNullable<RuntimeOutput["tokens"]> | undefined;
	private cost: number | undefined;

	push(chunk: string): void {
		this.lineBuffer += chunk;
		for (
			let idx = this.lineBuffer.indexOf("\n");
			idx >= 0;
			idx = this.lineBuffer.indexOf("\n")
		) {
			const line = this.lineBuffer.slice(0, idx);
			this.lineBuffer = this.lineBuffer.slice(idx + 1);
			if (line) this.processLine(line);
		}
	}

	finish(): void {
		if (this.lineBuffer) {
			const line = this.lineBuffer;
			this.lineBuffer = "";
			this.processLine(line);
		}
	}

	snapshot(): ParsedCliOutput {
		const trailing =
			this.lineBuffer && !this.lineBuffer.trimStart().startsWith("{")
				? this.lineBuffer
				: undefined;
		const parts: NonNullable<RuntimeOutput["parts"]> = [];
		for (const part of this.orderedParts) {
			if (part.type === "text") {
				const value = this.orderedText.get(part.id) ?? "";
				if (value.trim()) parts.push({ ...part, text: value });
			} else {
				parts.push(part);
			}
		}
		if (!this.orderedText.size && this.finalResponse?.trim()) {
			parts.push({
				type: "text",
				id: "final-response",
				text: this.finalResponse,
			});
		}
		if (trailing?.trim()) {
			parts.push({
				type: "text",
				id: `plain-${this.orderedParts.length}`,
				text: trailing,
			});
		}
		const outputText =
			this.finalResponse ??
			(trailing ? [...this.text, trailing] : this.text).join("\n");
		return {
			output: outputText.trim(),
			error: this.error,
			...(this.tokens ? { tokens: this.tokens } : {}),
			...(this.cost !== undefined ? { cost: this.cost } : {}),
			activities: [...this.activities.values()],
			parts,
		};
	}

	private setActivity(activity: RuntimeActivity): void {
		this.activities.set(activity.id, activity);
		if (!this.orderedActivityIds.has(activity.id)) {
			this.orderedActivityIds.add(activity.id);
			this.orderedParts.push({ type: "activity", id: activity.id });
		}
	}

	private setText(id: string, value: string, append = false): void {
		if (!this.orderedText.has(id)) this.orderedParts.push({ type: "text", id });
		this.orderedText.set(
			id,
			append ? `${this.orderedText.get(id) ?? ""}${value}` : value,
		);
	}

	private processLine(line: string): void {
		const { text, agySteps, activities, orderedParts, completedCodexMessages } =
			this;
		const setActivity = (activity: RuntimeActivity) =>
			this.setActivity(activity);
		const setText = (id: string, value: string, append = false) =>
			this.setText(id, value, append);
		try {
			const event = JSON.parse(line);
			if (!event || typeof event !== "object") {
				text.push(line);
				setText(`plain-${orderedParts.length}`, line);
				return;
			}
			if (event.event === "result" && event.result) {
				const denied = event.result.denied_actions;
				if (Array.isArray(denied) && denied.length) {
					const actions = denied
						.map((action) => action.display_name || action.action)
						.filter((action) => typeof action === "string");
					this.error = `Agy could not complete the request because tool permission was denied${actions.length ? `: ${actions.join(", ")}` : ""}. Noninteractive mode cannot ask for approval. Configure a specific allow-rule in Agy settings or run the task interactively, then retry.`;
				} else if (event.result.status && event.result.status !== "SUCCESS") {
					this.error =
						typeof event.result.error === "string"
							? event.result.error
							: event.result.error?.message ||
								`Agy finished with status ${event.result.status}`;
				}
			}
			if (event.type === "result" && event.is_error === true) {
				const message =
					typeof event.result === "string"
						? event.result
						: Array.isArray(event.errors)
							? event.errors
									.filter((item: unknown) => typeof item === "string")
									.join("; ")
							: typeof event.error === "string"
								? event.error
								: event.error?.message;
				this.error =
					typeof message === "string" && message.trim()
						? message.trim()
						: (this.error ?? "Provider returned an error result");
			}
			if (event.type === "error" || event.type === "turn.failed") {
				const message =
					typeof event.error === "string"
						? event.error
						: (event.error?.message ?? event.message);
				if (typeof message === "string" && message.trim())
					this.error = message.trim();
			}
			// CLI providers place usage in different envelopes: Codex turn.completed,
			// Claude result.usage, and Agy result.usage. Normalize the known field
			// spellings while retaining cache counts separately for the shared UI.
			const usage =
				event.type === "turn.completed" &&
				event.usage &&
				typeof event.usage === "object"
					? event.usage
					: event.usage && typeof event.usage === "object"
						? event.usage
						: event.usageMetadata && typeof event.usageMetadata === "object"
							? event.usageMetadata
							: event.result?.usage && typeof event.result.usage === "object"
								? event.result.usage
								: event.result?.usageMetadata &&
										typeof event.result.usageMetadata === "object"
									? event.result.usageMetadata
									: undefined;
			const numeric = (value: unknown) =>
				typeof value === "number" && Number.isFinite(value) && value >= 0
					? value
					: undefined;
			if (usage) {
				const rawInput = numeric(
					usage.input_tokens ??
						usage.inputTokens ??
						usage.prompt_tokens ??
						usage.promptTokenCount,
				);
				const cacheRead = numeric(
					usage.cached_input_tokens ??
						usage.cache_read_input_tokens ??
						usage.cacheReadInputTokens ??
						usage.cacheReadTokens ??
						usage.prompt_tokens_details?.cached_tokens ??
						usage.input_tokens_details?.cached_tokens ??
						usage.cachedContentTokenCount,
				);
				const cacheWrite = numeric(
					usage.cache_write_input_tokens ??
						usage.cache_creation_input_tokens ??
						usage.cacheWriteInputTokens ??
						usage.cacheCreationInputTokens,
				);
				const inputIncludesCache =
					event.type === "turn.completed" ||
					usage.prompt_tokens !== undefined ||
					usage.promptTokenCount !== undefined ||
					usage.cached_input_tokens !== undefined ||
					usage.input_tokens_details?.cached_tokens !== undefined;
				const input =
					rawInput === undefined
						? undefined
						: Math.max(
								0,
								rawInput -
									(inputIncludesCache
										? (cacheRead ?? 0) + (cacheWrite ?? 0)
										: 0),
							);
				const outputTokens = numeric(
					usage.output_tokens ??
						usage.outputTokens ??
						usage.completion_tokens ??
						usage.candidatesTokenCount,
				);
				const reasoning = numeric(
					usage.reasoning_output_tokens ??
						usage.reasoning_tokens ??
						usage.reasoningOutputTokens ??
						usage.completion_tokens_details?.reasoning_tokens ??
						usage.thoughtsTokenCount,
				);
				const reportedTotal = numeric(
					usage.total_tokens ?? usage.totalTokenCount,
				);
				const total =
					reportedTotal ??
					(rawInput === undefined && outputTokens === undefined
						? undefined
						: (rawInput ?? 0) +
							(outputTokens ?? 0) +
							(inputIncludesCache ? 0 : (cacheRead ?? 0) + (cacheWrite ?? 0)));
				const normalizedTokens = {
					...(total !== undefined ? { total } : {}),
					...(input !== undefined ? { input } : {}),
					...(outputTokens !== undefined ? { output: outputTokens } : {}),
					...(reasoning !== undefined ? { reasoning } : {}),
					...(cacheRead !== undefined || cacheWrite !== undefined
						? {
								cache: {
									...(cacheRead !== undefined ? { read: cacheRead } : {}),
									...(cacheWrite !== undefined ? { write: cacheWrite } : {}),
								},
							}
						: {}),
				};
				if (Object.keys(normalizedTokens).length)
					this.tokens = normalizedTokens;
			}
			this.cost ??= numeric(
				event.total_cost_usd ??
					event.totalCostUsd ??
					event.cost_usd ??
					event.costUsd ??
					event.cost ??
					event.result?.total_cost_usd ??
					event.result?.totalCostUsd ??
					event.result?.cost_usd,
			);
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
					typeof toolInfo.diff === "string"
						? toolInfo.diff
						: typeof toolInfo.patch === "string"
							? toolInfo.patch
							: undefined;
				const file = extractToolFilePath(input);
				const computedFilediff = toolInfo.filediff
					? undefined
					: buildToolFileDiff(String(name), input, patch, file);
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
					...(toolInfo.filediff || computedFilediff || toolInfo.files || patch
						? {
								metadata: {
									...(toolInfo.filediff
										? { filediff: toolInfo.filediff }
										: computedFilediff
											? { filediff: computedFilediff }
											: {}),
									...(toolInfo.files ? { files: toolInfo.files } : {}),
									...(patch ? { diff: patch } : {}),
								},
							}
						: {}),
				};
				setActivity(activity);
			}
			const item = event.item;
			if (
				["item.started", "item.updated", "item.completed"].includes(
					event.type,
				) &&
				item &&
				typeof item === "object"
			) {
				const itemType = String(item.type ?? "");
				const itemId = String(item.id ?? `${itemType}-${activities.size}`);
				if (
					itemType === "agent_message" &&
					typeof item.text === "string" &&
					item.text.trim()
				) {
					const messageId = `codex-${itemId}`;
					setText(messageId, item.text);
					if (
						event.type === "item.completed" &&
						!completedCodexMessages.has(messageId)
					) {
						completedCodexMessages.add(messageId);
						text.push(item.text);
					}
				} else if (itemType === "file_change" && Array.isArray(item.changes)) {
					for (const [index, change] of item.changes.entries()) {
						if (!change || typeof change !== "object") continue;
						const file = change.path ?? change.filePath ?? change.file;
						const changeId = `codex-${itemId}-${index}`;
						const rawDiff =
							typeof change.diff === "string"
								? change.diff
								: typeof change.patch === "string"
									? change.patch
									: undefined;
						const filediff = rawDiff
							? {
									file,
									patch: rawDiff,
									...diffCountsFromPatch(rawDiff),
								}
							: typeof change.before === "string" ||
									typeof change.after === "string" ||
									typeof change.content === "string"
								? {
										file,
										...describeLineChanges(
											typeof change.before === "string" ? change.before : "",
											typeof change.after === "string"
												? change.after
												: typeof change.content === "string"
													? change.content
													: "",
										),
									}
								: undefined;
						setActivity({
							id: changeId,
							tool: "file_change",
							status: event.type === "item.completed" ? "completed" : "running",
							input: {
								...(typeof file === "string" ? { path: file } : {}),
								kind: change.kind,
							},
							...(filediff ? { metadata: { filediff } } : {}),
						});
					}
				} else if (
					["command_execution", "shell", "tool_call"].includes(itemType)
				) {
					let callInput: Record<string, unknown> | undefined;
					if (itemType === "tool_call") {
						const rawInput = item.input ?? item.arguments;
						if (
							rawInput &&
							typeof rawInput === "object" &&
							!Array.isArray(rawInput)
						) {
							callInput = rawInput as Record<string, unknown>;
						} else if (typeof rawInput === "string") {
							try {
								const parsed = JSON.parse(rawInput);
								if (
									parsed &&
									typeof parsed === "object" &&
									!Array.isArray(parsed)
								)
									callInput = parsed as Record<string, unknown>;
							} catch {}
						}
					}
					const toolName =
						typeof item.name === "string" && item.name.trim()
							? item.name
							: itemType;
					const callFilediff =
						itemType === "tool_call"
							? buildToolFileDiff(
									toolName,
									callInput,
									typeof item.diff === "string"
										? item.diff
										: typeof item.patch === "string"
											? item.patch
											: undefined,
								)
							: undefined;
					const activity: RuntimeActivity = {
						id: `codex-${itemId}`,
						tool: toolName,
						status:
							event.type !== "item.completed"
								? "running"
								: item.exit_code && item.exit_code !== 0
									? "error"
									: "completed",
						input: callInput ?? {
							...(typeof item.command === "string"
								? { command: item.command }
								: {}),
							...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
						},
						...(typeof item.aggregated_output === "string"
							? { output: item.aggregated_output }
							: typeof item.output === "string"
								? { output: item.output }
								: {}),
						...(callFilediff ? { metadata: { filediff: callFilediff } } : {}),
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
						const filediff = buildToolFileDiff(block.name, input);
						setActivity({
							id: activityId,
							tool: block.name,
							status: "running",
							...(input ? { input } : {}),
							...(filediff ? { metadata: { filediff } } : {}),
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
					if (activity) {
						const resultOutput =
							typeof block.content === "string"
								? block.content
								: Array.isArray(block.content)
									? block.content
											.flatMap((entry: unknown) =>
												entry &&
												typeof entry === "object" &&
												"text" in entry &&
												typeof (entry as { text?: unknown }).text === "string"
													? [(entry as { text: string }).text]
													: [],
											)
											.join("\n")
									: undefined;
						const toolResult =
							event.tool_use_result &&
							typeof event.tool_use_result === "object" &&
							!Array.isArray(event.tool_use_result)
								? (event.tool_use_result as {
										filePath?: unknown;
										originalFile?: unknown;
										content?: unknown;
										structuredPatch?: Array<{
											oldStart?: number;
											oldLines?: number;
											newStart?: number;
											newLines?: number;
											lines?: string[];
										}>;
									})
								: undefined;
						let resultFilediff = activity.metadata?.filediff;
						if (
							Array.isArray(toolResult?.structuredPatch) &&
							toolResult.structuredPatch.length
						) {
							const patch = toolResult.structuredPatch
								.filter(
									(hunk) =>
										typeof hunk?.oldStart === "number" &&
										typeof hunk?.newStart === "number" &&
										Array.isArray(hunk.lines),
								)
								.map(
									(hunk) =>
										`@@ -${hunk.oldStart},${hunk.oldLines ?? 0} +${hunk.newStart},${hunk.newLines ?? 0} @@\n${hunk.lines!.join("\n")}`,
								)
								.join("\n");
							if (patch) {
								resultFilediff = buildToolFileDiff(
									activity.tool,
									activity.input,
									patch,
									typeof toolResult.filePath === "string"
										? toolResult.filePath
										: undefined,
								);
							}
						} else if (
							typeof toolResult?.originalFile === "string" &&
							typeof toolResult?.content === "string"
						) {
							const file =
								(typeof toolResult.filePath === "string" &&
									toolResult.filePath) ||
								extractToolFilePath(activity.input);
							resultFilediff = {
								file: file || "Changes",
								...describeLineChanges(
									toolResult.originalFile,
									toolResult.content,
								),
							};
						}
						setActivity({
							...activity,
							status: block.is_error ? "error" : "completed",
							...(resultOutput !== undefined ? { output: resultOutput } : {}),
							...(resultFilediff
								? {
										metadata: {
											...activity.metadata,
											filediff: resultFilediff,
										},
									}
								: {}),
						});
					}
				}
			}
			if (
				event.type === "result" &&
				!event.is_error &&
				typeof event.result === "object" &&
				typeof event.result?.response === "string"
			)
				this.finalResponse = event.result.response;
			if (!event.is_error && typeof event.result?.response === "string") {
				if (event.result.response.trim())
					this.finalResponse = event.result.response;
			} else if (
				event.type === "result" &&
				!event.is_error &&
				typeof event.result === "string"
			)
				this.finalResponse = event.result;
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
}

export function parseCliOutput(output: string): ParsedCliOutput {
	const parser = new CliOutputParser();
	parser.push(output);
	parser.finish();
	return parser.snapshot();
}

export type CliModelMetadata = {
	contextWindow?: number;
	outputLimit?: number;
};

export function modelFromId(
	providerId: string,
	modelId: string,
	name = modelId,
	limits: CliModelMetadata = {},
): AgentModel {
	return normalizeModel({
		providerId,
		connectionId: connectionId(providerId),
		modelId,
		name,
		displayName: name,
		...(limits.contextWindow ? { contextWindow: limits.contextWindow } : {}),
		...(limits.outputLimit ? { outputLimit: limits.outputLimit } : {}),
		capabilities: ["text", "coding"],
		isAvailable: true,
	});
}
