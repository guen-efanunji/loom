import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { z } from "zod";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

type GatewaySessionStatus = {
	type: string;
	message?: string;
	attempt?: number;
	next?: number;
	action?: { reason?: string; title?: string; message?: string };
};

function retryFailure(status: GatewaySessionStatus): string | null {
	if (status.type !== "retry") return null;
	const detail = [status.message, status.action?.title, status.action?.message]
		.filter((value): value is string => Boolean(value?.trim()))
		.filter((value, index, values) => values.indexOf(value) === index)
		.join(". ");
	const delay = typeof status.next === "number" ? status.next - Date.now() : 0;
	const exhausted =
		status.action?.reason === "free_tier_limit" ||
		/quota|usage exceeded|billing|subscribe/i.test(detail ?? "");
	if (!exhausted) return null;
	const retryIn =
		delay > 0
			? ` Retry scheduled in ${formatRetryDelay(delay)}${status.attempt ? ` (attempt ${status.attempt})` : ""}.`
			: "";
	return `${detail || "Provider retry is not expected soon."}${retryIn}`;
}

function formatRetryDelay(delay: number): string {
	const minutes = Math.ceil(delay / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remaining = minutes % 60;
	return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function authHeaders(headers?: RequestInit["headers"]): Headers {
	const result = new Headers(headers);
	const password = process.env.OPENCODE_SERVER_PASSWORD?.trim();
	if (password && !result.has("authorization")) {
		const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
		result.set(
			"authorization",
			`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
		);
	}
	return result;
}

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
	/** Assistant text parts plus tool activities, in conversation order. */
	parts?: Array<
		| { type: "text"; id: string; text: string }
		| { type: "activity"; id: string }
	>;
	/** Normalized tool calls made during the run. */
	activities?: Array<{
		id: string;
		tool: string;
		status: "running" | "completed" | "error";
		input?: Record<string, unknown>;
		output?: string;
		error?: string;
		metadata?: Record<string, unknown>;
	}>;
	/** Usage the gateway reported for the turn. */
	tokens?: {
		total?: number;
		input?: number;
		output?: number;
		reasoning?: number;
		cache?: { read?: number; write?: number };
	};
	cost?: number;
};

export type AgentModel = {
	providerID: string;
	modelID: string;
};

export type AgentRuntime = {
	createSession(input: {
		cwd: string;
		title: string;
		readOnly?: boolean;
	}): Promise<{ id: string }>;
	prompt(input: {
		sessionId: string;
		prompt: string;
		system?: string;
		model?: AgentModel;
		images?: Array<{ mime: string; data: string }>;
	}): Promise<void>;
	status(sessionId: string): Promise<AgentRunStatus>;
	lastError?(sessionId: string): Promise<string | null>;
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
	deleteSession?(sessionId: string): Promise<void>;
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
		const candidate = join(
			directory,
			process.platform === "win32" ? "opencode.exe" : "opencode",
		);
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
	private readonly fetcher: Fetcher;
	private readonly processRunner: ProcessRunner;
	private readonly discoverer: () => Promise<string | null>;
	private process: ProcessHandle | null = null;

	constructor(
		options: {
			executable?: string | null;
			baseUrl?: string;
			healthTimeoutMs?: number;
			pollIntervalMs?: number;
			fetcher?: Fetcher;
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
			const response = await this.fetcher(`${this.baseUrl}/global/health`, {
				headers: authHeaders(),
				signal: AbortSignal.timeout(3_000),
			});
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
	private readonly fetcher: Fetcher;
	private readonly directories = new Map<string, string>();
	private readonly cancelled = new Set<string>();
	private readonly lastErrors = new Map<string, string>();
	private readonly idleSince = new Map<string, number>();
	private readonly idleTimeoutMs: number;

	constructor(
		options: {
			baseUrl?: string;
			fetcher?: Fetcher;
			idleTimeoutMs?: number;
		} = {},
	) {
		this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4096").replace(
			/\/$/,
			"",
		);
		this.fetcher = options.fetcher ?? fetch;
		this.idleTimeoutMs = options.idleTimeoutMs ?? 15_000;
	}

	async request<T = unknown>(
		path: string,
		init: RequestInit = {},
		directory?: string,
	): Promise<T> {
		const headers = authHeaders(init.headers);
		const sessionId = path.match(/^\/session\/([^/?]+)/)?.[1];
		const cwd =
			directory ??
			(sessionId
				? this.directories.get(decodeURIComponent(sessionId))
				: undefined);
		if (cwd) headers.set("x-opencode-directory", encodeURIComponent(cwd));
		if (init.body) headers.set("content-type", "application/json");
		let response: Response;
		try {
			response = await this.fetcher(`${this.baseUrl}${path}`, {
				...init,
				headers,
				// Never let an unavailable OpenCode process block the Loom UI. Long
				// running agent work is asynchronous; HTTP control calls should fail
				// quickly and let the client remain usable.
				signal: init.signal ?? AbortSignal.timeout(5_000),
			});
		} catch (error) {
			throw new OpenCodeError("HTTP_ERROR", "Unable to reach OpenCode server", {
				reason: error instanceof Error ? error.message : String(error),
			});
		}
		if (!response.ok) {
			const responseBody = await response.text().catch(() => "");
			const detail = openCodeResponseErrorDetail(responseBody);
			throw new OpenCodeError(
				"HTTP_ERROR",
				[
					`OpenCode request failed with HTTP ${response.status} (${init.method ?? "GET"} ${path})`,
					detail,
				]
					.filter(Boolean)
					.join(": "),
				{
					status: String(response.status),
					path,
					...(detail ? { response: detail } : {}),
				},
			);
		}
		return (response.status === 204 ? undefined : await response.json()) as T;
	}

	async createSession(input: {
		cwd: string;
		title: string;
		readOnly?: boolean;
	}): Promise<{ id: string }> {
		const response = await this.request("/session", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-opencode-directory": encodeURIComponent(input.cwd),
			},
			body: JSON.stringify({
				title: input.title,
				// A read-only session must stop the agent from mutating the repo, but
				// it cannot deny every permission: OpenCode's free-tier provider
				// requires `bash` to stay available, and a blanket `{permission:"*"}`
				// deny makes the gateway reject the run with
				// "OpenCode's free tier can only be used from within OpenCode".
				// Denying just `edit` keeps the canvas/planner read-only while
				// leaving free-tier models usable.
				...(input.readOnly
					? {
							permission: [
								{ permission: "edit", pattern: "*", action: "deny" },
							],
						}
					: {}),
			}),
		});
		const session = parseJson(sessionSchema, response, "session");
		this.directories.set(session.id, input.cwd);
		return session;
	}

	async prompt(input: {
		sessionId: string;
		prompt: string;
		system?: string;
		model?: AgentModel;
		images?: Array<{ mime: string; data: string }>;
	}): Promise<void> {
		this.cancelled.delete(input.sessionId);
		// Catalog ids for this adapter's own models arrive already prefixed with
		// the gateway's upstream provider (e.g. `opencode/glm-5.3-flash-free`).
		// Passing that string as `modelID` makes the gateway fail the run with
		// ProviderModelNotFoundError before any assistant message exists, which
		// then reports as "stopped reporting status". Match the chat handler and
		// re-split a prefixed modelID into its provider and model parts.
		const model = input.model
			? input.model.providerID.toLowerCase() === "opencode" &&
				input.model.modelID.includes("/")
				? (() => {
						const separator = input.model!.modelID.indexOf("/");
						return {
							providerID: input.model!.modelID.slice(0, separator),
							modelID: input.model!.modelID.slice(separator + 1),
						};
					})()
				: input.model
			: undefined;
		await this.request(
			`/session/${encodeURIComponent(input.sessionId)}/prompt_async`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...(input.system ? { system: input.system } : {}),
					...(model
						? {
								model: {
									providerID: model.providerID,
									modelID: model.modelID,
								},
							}
						: {}),
					parts: [
						{ type: "text", text: input.prompt },
						...(input.images ?? []).map((image) => ({
							type: "file",
							mime: image.mime,
							url: `data:${image.mime};base64,${image.data}`,
						})),
					],
				}),
			},
		);
	}

	async status(sessionId: string): Promise<AgentRunStatus> {
		if (this.cancelled.has(sessionId)) return "cancelled";
		const directory = this.directories.get(sessionId);
		const statuses = await this.request<Record<string, GatewaySessionStatus>>(
			"/session/status",
			{},
			directory,
		);
		const gatewayStatus = statuses[sessionId];
		const entry = gatewayStatus?.type;
		const retryError = gatewayStatus ? retryFailure(gatewayStatus) : null;
		if (retryError) {
			this.lastErrors.set(sessionId, retryError);
			this.idleSince.delete(sessionId);
			return "failed";
		}
		if (entry === "busy" || entry === "retry") {
			this.idleSince.delete(sessionId);
			return "running";
		}
		const messages = await this.request<
			Array<{
				info: {
					role: string;
					error?: { name?: string; data?: { message?: string } };
					time: { completed?: number };
				};
			}>
		>(`/session/${encodeURIComponent(sessionId)}/message`);
		const last = messages.at(-1)?.info;
		if (last?.error) {
			const detail = last.error.data?.message || last.error.name || "";
			this.lastErrors.set(sessionId, detail || "the agent reported an error");
			this.idleSince.delete(sessionId);
			return "failed";
		}
		if (last?.role === "assistant" && last.time.completed) {
			this.idleSince.delete(sessionId);
			this.lastErrors.delete(sessionId);
			return "completed";
		}
		// An absent status entry is not a sign of progress: the server may have
		// restarted, dropped the session, or the prompt failed before any
		// assistant response. Waiting forever here is what previously left task
		// runs stuck as "running" with no provider output.
		if (!entry || entry === "idle") {
			const now = Date.now();
			const since = this.idleSince.get(sessionId) ?? now;
			this.idleSince.set(sessionId, since);
			if (now - since >= this.idleTimeoutMs) {
				this.lastErrors.set(
					sessionId,
					entry
						? "OpenCode became idle without an assistant response. Check that the selected provider and model are available in OpenCode, then retry the task."
						: "OpenCode stopped reporting status for this session without an assistant response. Check that the selected provider and model are available in OpenCode, then retry the task.",
				);
				return "failed";
			}
		}
		this.lastErrors.delete(sessionId);
		return "running";
	}

	/**
	 * The real reason the last run failed, captured while polling status. Loom
	 * shows this instead of guessing at a credential problem.
	 */
	async lastError(sessionId: string): Promise<string | null> {
		return this.lastErrors.get(sessionId) ?? null;
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
		this.cancelled.add(sessionId);
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.request(`/session/${encodeURIComponent(sessionId)}`, {
			method: "DELETE",
		});
		this.directories.delete(sessionId);
		this.cancelled.delete(sessionId);
		this.lastErrors.delete(sessionId);
		this.idleSince.delete(sessionId);
	}

	async readOutput(sessionId: string): Promise<RuntimeOutput | null> {
		const messages = await this.request<
			Array<{
				info: {
					id?: string;
					role: string;
					tokens?: {
						total?: number;
						input?: number;
						output?: number;
						reasoning?: number;
						cache?: { read?: number; write?: number };
					};
					cost?: number;
				};
				parts: Array<{
					id?: string;
					type: string;
					text?: string;
					tool?: string;
					state?: {
						status?: string;
						input?: Record<string, unknown>;
						output?: string;
						error?: string | { message?: string };
					};
				}>;
			}>
		>(`/session/${encodeURIComponent(sessionId)}/message`);
		const parts: RuntimeOutput["parts"] = [];
		const activities: RuntimeOutput["activities"] = [];
		const texts: string[] = [];
		let tokens: RuntimeOutput["tokens"];
		let cost: number | undefined;
		for (const message of messages) {
			if (message.info.role !== "assistant") continue;
			if (message.info.tokens && typeof message.info.tokens === "object")
				tokens ??= message.info.tokens;
			if (typeof message.info.cost === "number") cost ??= message.info.cost;
			for (const [index, part] of message.parts.entries()) {
				const id = part.id ?? `${message.info.id ?? "msg"}-${index}`;
				if (part.type === "text" && part.text?.trim()) {
					texts.push(part.text);
					parts.push({ type: "text", id, text: part.text });
					continue;
				}
				if (part.type !== "tool") continue;
				// Trace + chat surfaces need every tool call the agent made,
				// including the one that failed or was permission-denied.
				const rawStatus = part.state?.status;
				const error =
					typeof part.state?.error === "string"
						? part.state.error
						: (part.state?.error?.message ?? undefined);
				activities.push({
					id,
					tool: part.tool ?? "tool",
					status:
						rawStatus === "running" || rawStatus === "pending"
							? "running"
							: rawStatus === "error"
								? "error"
								: "completed",
					...(part.state?.input ? { input: part.state.input } : {}),
					...(typeof part.state?.output === "string"
						? { output: part.state.output }
						: {}),
					...(error ? { error } : {}),
				});
				parts.push({ type: "activity", id });
			}
		}
		return {
			output: texts.join("\n\n"),
			...(tokens ? { tokens } : {}),
			...(cost !== undefined ? { cost } : {}),
			...(parts.length ? { parts } : {}),
			...(activities.length ? { activities } : {}),
		};
	}

	async getDiff(sessionId: string): Promise<unknown> {
		return this.request(`/session/${encodeURIComponent(sessionId)}/diff`, {
			method: "GET",
		});
	}
}

function openCodeResponseErrorDetail(body: string): string {
	if (!body.trim()) return "";
	let detail = body.trim();
	try {
		const payload: unknown = JSON.parse(body);
		if (payload && typeof payload === "object") {
			const value = payload as {
				message?: unknown;
				error?: { message?: unknown } | string;
				data?: { message?: unknown; errors?: unknown };
				errors?: unknown;
				issues?: Array<{ path?: unknown[]; message?: unknown }>;
			};
			const validationIssues =
				value.issues ??
				(Array.isArray(value.errors)
					? (value.errors as Array<{ path?: unknown[]; message?: unknown }>)
					: undefined);
			const issues = validationIssues
				?.map((issue) => {
					const path = Array.isArray(issue.path)
						? issue.path.map(String).join(".")
						: "";
					const message =
						typeof issue.message === "string" ? issue.message : "";
					return [path, message].filter(Boolean).join(": ");
				})
				.filter(Boolean);
			const messages = [
				typeof value.message === "string" ? value.message : "",
				typeof value.data?.message === "string" ? value.data.message : "",
				typeof value.error === "string"
					? value.error
					: typeof value.error?.message === "string"
						? value.error.message
						: "",
				...(issues ?? []),
			].filter(Boolean);
			if (messages.length) detail = [...new Set(messages)].join("; ");
		}
	} catch {
		// Non-JSON errors are still useful when OpenCode returns plain text.
	}
	return detail
		.replace(/("?apiKey"?\s*[:=]\s*"?)[^",\s}]+/gi, "$1[redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
		.replace(/\s+/g, " ")
		.slice(0, 600);
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
		readOnly?: boolean;
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

	async prompt(input: {
		sessionId: string;
		prompt: string;
		images?: Array<{ mime: string; data: string }>;
	}): Promise<void> {
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
