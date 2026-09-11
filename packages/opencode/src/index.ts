import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter } from "node:path";
import { z } from "zod";

export type OpenCodeManager = {
	discover(): Promise<boolean>;
	start(): Promise<void>;
	health(): Promise<boolean>;
	stop(): Promise<void>;
};

export type AgentRunStatus =
	| "queued"
	| "running"
	| "waiting_permission"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export type RuntimeOutput = {
	output: string;
	truncated?: boolean;
};

export type AgentRuntime = {
	createSession(input: { cwd: string; title: string }): Promise<{ id: string }>;
	prompt(input: { sessionId: string; prompt: string }): Promise<void>;
	status(sessionId: string): Promise<AgentRunStatus>;
	readOutput?(sessionId: string): Promise<RuntimeOutput | null>;
	wait(
		sessionId: string,
		options?: {
			timeoutMs?: number;
			pollIntervalMs?: number;
			onStatus?: (status: AgentRunStatus) => void | Promise<void>;
		},
	): Promise<
		Exclude<AgentRunStatus, "queued" | "running" | "waiting_permission">
	>;
	abort(sessionId: string): Promise<void>;
	getDiff(sessionId: string): Promise<unknown>;
};

export type ProcessHandle = {
	kill(signal?: NodeJS.Signals): boolean;
	once(
		event: "error" | "exit",
		listener: (...args: unknown[]) => void,
	): ProcessHandle;
};

export type ProcessRunner = (
	command: string,
	args: readonly string[],
	options: { env?: NodeJS.ProcessEnv },
) => ProcessHandle;

export class OpenCodeError extends Error {
	readonly code:
		| "NOT_INSTALLED"
		| "START_FAILED"
		| "HEALTH_TIMEOUT"
		| "HTTP_ERROR"
		| "INVALID_RESPONSE"
		| "STOP_FAILED";
	readonly details: Record<string, string>;

	constructor(
		code: OpenCodeError["code"],
		message: string,
		details: Record<string, string> = {},
	) {
		super(message);
		this.name = "OpenCodeError";
		this.code = code;
		this.details = details;
	}
}

const healthSchema = z.object({
	healthy: z.literal(true),
	version: z.string(),
});
const sessionSchema = z.object({ id: z.string().min(1) });
const statusSchema = z.object({
	status: z.enum([
		"queued",
		"running",
		"waiting_permission",
		"completed",
		"failed",
		"cancelled",
		"interrupted",
	]),
});

function parseJson<T>(
	schema: z.ZodType<T>,
	value: unknown,
	operation: string,
): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new OpenCodeError(
			"INVALID_RESPONSE",
			`OpenCode returned an invalid ${operation} response`,
			{
				issues: result.error.issues.map((issue) => issue.message).join("; "),
			},
		);
	}
	return result.data;
}

export function createProcessRunner(): ProcessRunner {
	return (command, args, options) =>
		spawn(command, [...args], {
			detached: false,
			env: options.env,
			stdio: "ignore",
		});
}

export async function discoverExecutable(
	env: NodeJS.ProcessEnv = process.env,
	fileAccess: (path: string) => Promise<void> = access,
): Promise<string | null> {
	const configured = env.OPENCODE_BIN?.trim();
	if (configured) {
		try {
			await fileAccess(configured);
			return configured;
		} catch {
			return null;
		}
	}
	const path = env.PATH?.split(delimiter) ?? [];
	for (const directory of path) {
		const candidate = `${directory}/opencode`;
		try {
			await fileAccess(candidate);
			return candidate;
		} catch {}
	}
	return null;
}

export class OpenCodeServerManager implements OpenCodeManager {
	private readonly executable: string | null;
	private readonly baseUrl: string;
	private readonly healthTimeoutMs: number;
	private readonly pollIntervalMs: number;
	private readonly fetcher: typeof fetch;
	private readonly processRunner: ProcessRunner;
	private readonly discoverer: () => Promise<string | null>;
	private process: ProcessHandle | null = null;

	constructor(
		options: {
			executable?: string | null;
			baseUrl?: string;
			healthTimeoutMs?: number;
			pollIntervalMs?: number;
			fetcher?: typeof fetch;
			processRunner?: ProcessRunner;
			discoverer?: () => Promise<string | null>;
		} = {},
	) {
		this.executable = options.executable ?? null;
		this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4096").replace(
			/\/$/,
			"",
		);
		this.healthTimeoutMs = options.healthTimeoutMs ?? 10_000;
		this.pollIntervalMs = options.pollIntervalMs ?? 100;
		this.fetcher = options.fetcher ?? fetch;
		this.processRunner = options.processRunner ?? createProcessRunner();
		this.discoverer = options.discoverer ?? (() => discoverExecutable());
	}

	async discover(): Promise<boolean> {
		return (this.executable ?? (await this.discoverer())) !== null;
	}

	async health(): Promise<boolean> {
		try {
			const response = await this.fetcher(`${this.baseUrl}/global/health`);
			if (!response.ok) return false;
			parseJson(healthSchema, await response.json(), "health");
			return true;
		} catch {
			return false;
		}
	}

	async start(): Promise<void> {
		if (await this.health()) return;
		const executable = this.executable ?? (await this.discoverer());
		if (!executable) {
			throw new OpenCodeError(
				"NOT_INSTALLED",
				"OpenCode executable was not found",
				{
					action: "Install OpenCode or set OPENCODE_BIN to its executable path",
				},
			);
		}
		try {
			this.process = this.processRunner(
				executable,
				["serve", "--hostname", "127.0.0.1", "--port", "4096"],
				{
					env: process.env,
				},
			);
		} catch (error) {
			throw new OpenCodeError(
				"START_FAILED",
				"Unable to start OpenCode server",
				{
					reason: error instanceof Error ? error.message : String(error),
				},
			);
		}
		const deadline = Date.now() + this.healthTimeoutMs;
		while (Date.now() < deadline) {
			if (await this.health()) return;
			await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
		}
		await this.stop();
		throw new OpenCodeError(
			"HEALTH_TIMEOUT",
			"OpenCode server did not become healthy before timeout",
			{
				action: "Check OpenCode installation and server logs",
			},
		);
	}

	async stop(): Promise<void> {
		const processHandle = this.process;
		this.process = null;
		if (!processHandle) return;
		if (!processHandle.kill("SIGTERM")) {
			throw new OpenCodeError("STOP_FAILED", "Unable to stop OpenCode server");
		}
	}
}

export class OpenCodeHttpRuntime implements AgentRuntime {
	private readonly baseUrl: string;
	private readonly fetcher: typeof fetch;

	constructor(options: { baseUrl?: string; fetcher?: typeof fetch } = {}) {
		this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4096").replace(
			/\/$/,
			"",
		);
		this.fetcher = options.fetcher ?? fetch;
	}

	private async request(path: string, init: RequestInit): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetcher(`${this.baseUrl}${path}`, init);
		} catch (error) {
			throw new OpenCodeError("HTTP_ERROR", "Unable to reach OpenCode server", {
				reason: error instanceof Error ? error.message : String(error),
			});
		}
		if (!response.ok) {
			throw new OpenCodeError(
				"HTTP_ERROR",
				`OpenCode request failed with HTTP ${response.status}`,
				{
					status: String(response.status),
				},
			);
		}
		return response.status === 204 ? undefined : response.json();
	}

	async createSession(input: {
		cwd: string;
		title: string;
	}): Promise<{ id: string }> {
		const response = await this.request("/session", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-opencode-directory": input.cwd,
			},
			body: JSON.stringify({ title: input.title }),
		});
		return parseJson(sessionSchema, response, "session");
	}

	async prompt(input: { sessionId: string; prompt: string }): Promise<void> {
		await this.request(
			`/session/${encodeURIComponent(input.sessionId)}/prompt_async`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ parts: [{ type: "text", text: input.prompt }] }),
			},
		);
	}

	async status(sessionId: string): Promise<AgentRunStatus> {
		const response = await this.request(
			`/session/${encodeURIComponent(sessionId)}/status`,
			{ method: "GET" },
		);
		return parseJson(statusSchema, response, "status").status;
	}

	async wait(
		sessionId: string,
		options: {
			timeoutMs?: number;
			pollIntervalMs?: number;
			onStatus?: (status: AgentRunStatus) => void | Promise<void>;
		} = {},
	): Promise<
		Exclude<AgentRunStatus, "queued" | "running" | "waiting_permission">
	> {
		const timeoutMs = options.timeoutMs ?? 300_000;
		const pollIntervalMs = options.pollIntervalMs ?? 250;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			const status = await this.status(sessionId);
			await options.onStatus?.(status);
			if (
				status === "completed" ||
				status === "failed" ||
				status === "cancelled" ||
				status === "interrupted"
			)
				return status;
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
		throw new OpenCodeError(
			"HEALTH_TIMEOUT",
			"OpenCode agent did not finish before timeout",
		);
	}

	async abort(sessionId: string): Promise<void> {
		await this.request(`/session/${encodeURIComponent(sessionId)}/abort`, {
			method: "POST",
		});
	}

	async readOutput(sessionId: string): Promise<RuntimeOutput | null> {
		const response = await this.request(
			`/session/${encodeURIComponent(sessionId)}/output`,
			{ method: "GET" },
		);
		if (response === undefined) return null;
		return z
			.object({ output: z.string(), truncated: z.boolean().optional() })
			.parse(response);
	}

	async getDiff(sessionId: string): Promise<unknown> {
		return this.request(`/session/${encodeURIComponent(sessionId)}/diff`, {
			method: "GET",
		});
	}
}

export class MockAgentRuntime implements AgentRuntime {
	readonly sessions = new Map<
		string,
		{
			cwd: string;
			title: string;
			prompts: string[];
			aborted: boolean;
			status: AgentRunStatus;
			output: string;
		}
	>();
	private nextId = 0;

	async createSession(input: {
		cwd: string;
		title: string;
	}): Promise<{ id: string }> {
		const id = `mock-session-${++this.nextId}`;
		this.sessions.set(id, {
			...input,
			prompts: [],
			aborted: false,
			status: "queued",
			output: "",
		});
		return { id };
	}

	async prompt(input: { sessionId: string; prompt: string }): Promise<void> {
		const session = this.sessions.get(input.sessionId);
		if (!session)
			throw new OpenCodeError("HTTP_ERROR", "Mock session was not found");
		session.prompts.push(input.prompt);
		session.output = input.prompt;
		session.status = "completed";
	}

	async readOutput(sessionId: string): Promise<RuntimeOutput | null> {
		const session = this.sessions.get(sessionId);
		if (!session)
			throw new OpenCodeError("HTTP_ERROR", "Mock session was not found");
		return { output: session.output };
	}

	async status(sessionId: string): Promise<AgentRunStatus> {
		const session = this.sessions.get(sessionId);
		if (!session)
			throw new OpenCodeError("HTTP_ERROR", "Mock session was not found");
		return session.status;
	}

	async wait(
		sessionId: string,
	): Promise<
		Exclude<AgentRunStatus, "queued" | "running" | "waiting_permission">
	> {
		const status = await this.status(sessionId);
		if (
			status === "completed" ||
			status === "failed" ||
			status === "cancelled" ||
			status === "interrupted"
		)
			return status;
		throw new OpenCodeError("HEALTH_TIMEOUT", "Mock agent did not finish");
	}

	async abort(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session)
			throw new OpenCodeError("HTTP_ERROR", "Mock session was not found");
		session.aborted = true;
		session.status = "cancelled";
	}

	async getDiff(sessionId: string): Promise<unknown> {
		if (!this.sessions.has(sessionId))
			throw new OpenCodeError("HTTP_ERROR", "Mock session was not found");
		return [];
	}
}

export const opencodeHealthSchema = healthSchema;
export const opencodeSessionSchema = sessionSchema;
