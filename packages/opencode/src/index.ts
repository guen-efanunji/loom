import { execFile as execFileCallback, spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const execFile = promisify(execFileCallback);

const registeredServiceSchema = z.object({
	url: z
		.string()
		.url()
		.refine((value) => {
			const hostname = new URL(value).hostname;
			return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
		}),
	password: z.string().optional(),
});

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

function authHeaders(
	headers?: RequestInit["headers"],
	servicePassword?: string,
): Headers {
	const result = new Headers(headers);
	const password =
		process.env.OPENCODE_SERVER_PASSWORD?.trim() || servicePassword?.trim();
	if (password && !result.has("authorization")) {
		const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
		result.set(
			"authorization",
			`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
		);
	}
	return result;
}

/**
 * OpenCode 2.2+ wraps almost every JSON payload in a `{ data: ... }` envelope —
 * lists and single entities alike, often next to a sibling `location`. A few
 * diagnostic endpoints (for example `/api/info`) still return bare payloads.
 * Normalizing the envelope away here keeps every caller reading the declared
 * schema shapes instead of leaking object bodies into `.flatMap`/`.find`.
 */
export function unwrapOpenCodeEnvelope<T>(body: unknown): T {
	if (
		body !== null &&
		typeof body === "object" &&
		!Array.isArray(body) &&
		"data" in (body as Record<PropertyKey, unknown>)
	) {
		return (body as Record<PropertyKey, unknown>).data as T;
	}
	return body as T;
}

/**
 * Guard for endpoints that must answer with a list. Old gateway versions
 * surfaced non-array bodies through generic array methods and crashed with a
 * cryptic `X.flatMap is not a function`; fail loudly with the endpoint instead.
 */
export function requireOpenCodeArray<T>(body: unknown, endpoint: string): T[] {
	if (Array.isArray(body)) return body as T[];
	throw new OpenCodeError(
		"INVALID_RESPONSE",
		`OpenCode returned an unexpected response shape from ${endpoint}`,
		{ endpoint },
	);
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
	version: z.string().optional(),
});

const defaultOpenCodePort = 4096;

function openCodeBaseUrl(port = defaultOpenCodePort): string {
	return `http://127.0.0.1:${port}`;
}

function openCodeServerUrl(info: unknown): string | null {
	if (!info || typeof info !== "object") return null;
	const urls = (info as { urls?: unknown }).urls;
	if (!Array.isArray(urls)) return null;
	return (
		urls.find(
			(value): value is string =>
				typeof value === "string" && /^https?:\/\//i.test(value),
		) ?? null
	);
}

type OpenCodeService = z.infer<typeof registeredServiceSchema>;

export async function discoverService(
	executable?: string | null,
	stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
): Promise<OpenCodeService | null> {
	const registrationPath = join(stateHome, "opencode", "service.json");
	try {
		const permissions = await stat(registrationPath);
		if ((permissions.mode & 0o077) !== 0) return null;
		const registration = registeredServiceSchema.safeParse(
			JSON.parse(await readFile(registrationPath, "utf8")),
		);
		if (registration.success) return registration.data;
	} catch {}

	const command = executable ?? (await discoverExecutable());
	if (!command) return null;
	try {
		const result = await execFile(command, ["service", "status"], {
			env: process.env,
			timeout: 2_000,
		});
		const url = result.stdout
			.trim()
			.split(/\s+/)
			.find((value) => /^https?:\/\//i.test(value));
		return url ? { url: url.replace(/\/$/, "") } : null;
	} catch {
		return null;
	}
}
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
	private baseUrl: string;
	private readonly healthTimeoutMs: number;
	private readonly pollIntervalMs: number;
	private readonly fetcher: Fetcher;
	private readonly processRunner: ProcessRunner;
	private readonly discoverer: () => Promise<string | null>;
	private process: ProcessHandle | null = null;
	private baseUrlResolution: Promise<void> | null = null;
	private readonly discoverService: boolean;
	private servicePassword: string | undefined;

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
		this.baseUrl = (options.baseUrl ?? openCodeBaseUrl()).replace(/\/$/, "");
		this.healthTimeoutMs = options.healthTimeoutMs ?? 10_000;
		this.pollIntervalMs = options.pollIntervalMs ?? 100;
		this.fetcher = options.fetcher ?? fetch;
		this.processRunner = options.processRunner ?? createProcessRunner();
		this.discoverer = options.discoverer ?? (() => discoverExecutable());
		this.discoverService =
			options.baseUrl === undefined && options.fetcher === undefined;
	}

	async discover(): Promise<boolean> {
		return (this.executable ?? (await this.discoverer())) !== null;
	}

	private resolveBaseUrl(): Promise<void> {
		if (this.baseUrlResolution) return this.baseUrlResolution;
		this.baseUrlResolution = (async () => {
			if (!this.discoverService || this.baseUrl !== openCodeBaseUrl()) return;
			const service = await discoverService(this.executable);
			if (service) {
				this.baseUrl = service.url.replace(/\/$/, "");
				this.servicePassword = service.password;
				return;
			}
			for (let port = 4096; port <= 4105; port += 1) {
				const candidate = openCodeBaseUrl(port);
				try {
					const response = await this.fetcher(`${candidate}/api/info`, {
						headers: authHeaders(undefined, this.servicePassword),
						signal: AbortSignal.timeout(750),
					});
					if (!response.ok) continue;
					if (openCodeServerUrl(await response.json())) {
						this.baseUrl = candidate;
						return;
					}
				} catch {}
			}
		})();
		return this.baseUrlResolution;
	}

	async health(): Promise<boolean> {
		await this.resolveBaseUrl();
		try {
			const response = await this.fetcher(`${this.baseUrl}/api/info`, {
				headers: authHeaders(undefined, this.servicePassword),
				signal: AbortSignal.timeout(3_000),
			});
			if (!response.ok) return false;
			const info = await response.json();
			return openCodeServerUrl(info) !== null;
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
	private baseUrl: string;
	private readonly fetcher: Fetcher;
	private readonly ensureServer?: () => Promise<void>;
	private readonly discoverService: boolean;
	private servicePassword: string | undefined;
	private baseUrlResolution: Promise<void> | null = null;
	private readonly directories = new Map<string, string>();
	private readonly cancelled = new Set<string>();
	private readonly lastErrors = new Map<string, string>();
	private readonly idleSince = new Map<string, number>();
	private readonly idleTimeoutMs: number;
	private lastServerEnsureAt = 0;

	constructor(
		options: {
			baseUrl?: string;
			fetcher?: Fetcher;
			idleTimeoutMs?: number;
			/**
			 * Bring the OpenCode server back when the HTTP gateway becomes
			 * unreachable (for example after a crash). Called at most once per
			 * failure burst; requests are retried once afterwards.
			 */
			ensureServer?: () => Promise<void>;
		} = {},
	) {
		this.baseUrl = (options.baseUrl ?? openCodeBaseUrl()).replace(/\/$/, "");
		this.fetcher = options.fetcher ?? fetch;
		this.ensureServer = options.ensureServer;
		this.discoverService =
			options.baseUrl === undefined && options.fetcher === undefined;
		this.idleTimeoutMs = options.idleTimeoutMs ?? 15_000;
	}

	private resolveBaseUrl(): Promise<void> {
		if (this.baseUrlResolution) return this.baseUrlResolution;
		this.baseUrlResolution = (async () => {
			if (!this.discoverService || this.baseUrl !== openCodeBaseUrl()) return;
			const service = await discoverService();
			if (service) {
				this.baseUrl = service.url.replace(/\/$/, "");
				this.servicePassword = service.password;
				return;
			}
			for (let port = 4096; port <= 4105; port += 1) {
				const candidate = openCodeBaseUrl(port);
				try {
					const response = await this.fetcher(`${candidate}/api/info`, {
						headers: authHeaders(undefined, this.servicePassword),
						signal: AbortSignal.timeout(750),
					});
					if (response.ok && openCodeServerUrl(await response.json())) {
						this.baseUrl = candidate;
						return;
					}
				} catch {}
			}
		})();
		return this.baseUrlResolution;
	}

	private describeFetchFailure(error: unknown, timeoutMs: number): string {
		if (!(error instanceof Error)) return String(error);
		const cause =
			error instanceof Error && "cause" in error && error.cause instanceof Error
				? error.cause
				: error;
		const text = `${error.message} ${cause.message ?? ""}`;
		if (
			error.name === "TimeoutError" ||
			/aborted due to timeout|timed?\s*out/i.test(text)
		)
			return `OpenCode did not answer within ${timeoutMs}ms`;
		return error.message;
	}

	private isServerUnreachable(error: unknown): boolean {
		if (!(error instanceof Error)) return false;
		const cause =
			"cause" in error && error.cause instanceof Error ? error.cause : error;
		const text = `${error.message} ${(cause as Error).message ?? ""}`;
		// Timeout aborts mean the server answered slowly; restarting it would
		// duplicate side effects such as a queued prompt.
		if (error.name === "TimeoutError") return false;
		return /fetch failed|unable to connect|failed to connect|connection (refused|reset|closed)|econnrefused|econnreset|enotfound|ehostunreach|enetunreach|epipe|socket hang ?up|network error|server terminated/i.test(
			text,
		);
	}

	async request<T = unknown>(
		path: string,
		init: RequestInit = {},
		directory?: string,
		requestOptions?: { timeoutMs?: number },
	): Promise<T> {
		const apiPath = path.startsWith("/api/") ? path : `/api${path}`;
		const sessionId = apiPath.match(/^\/api\/session\/([^/?]+)/)?.[1];
		const cwd =
			directory ??
			(sessionId
				? this.directories.get(decodeURIComponent(sessionId))
				: undefined);
		const timeoutMs = requestOptions?.timeoutMs ?? 5_000;
		let response: Response;
		// Service-discovery resolves the gateway URL and its password lazily on
		// the first call; build the headers inside `send` so every attempt
		// carries credentials even when discovery filled them in just now.
		const send = () => {
			const headers = authHeaders(init.headers, this.servicePassword);
			if (cwd) headers.set("x-opencode-directory", encodeURIComponent(cwd));
			if (init.body) headers.set("content-type", "application/json");
			return this.fetcher(`${this.baseUrl}${apiPath}`, {
				...init,
				headers,
				// Never let an unavailable OpenCode process block the Loom UI. Long
				// running agent work is asynchronous; HTTP control calls should fail
				// quickly and let the client remain usable.
				signal: init.signal ?? AbortSignal.timeout(timeoutMs),
			});
		};
		try {
			await this.resolveBaseUrl();
			response = await send();
		} catch (error) {
			if (
				this.isServerUnreachable(error) &&
				this.ensureServer &&
				Date.now() - this.lastServerEnsureAt > 1_500
			) {
				this.lastServerEnsureAt = Date.now();
				try {
					await this.ensureServer();
					response = await send();
				} catch (retryError) {
					throw new OpenCodeError(
						"HTTP_ERROR",
						"Unable to reach OpenCode server",
						{
							reason: this.describeFetchFailure(retryError, timeoutMs),
						},
					);
				}
			} else {
				throw new OpenCodeError(
					"HTTP_ERROR",
					"Unable to reach OpenCode server",
					{
						reason: this.describeFetchFailure(error, timeoutMs),
					},
				);
			}
		}
		if (!response.ok) {
			const responseBody = await response.text().catch(() => "");
			const detail = openCodeResponseErrorDetail(responseBody);
			throw new OpenCodeError(
				"HTTP_ERROR",
				[
					`OpenCode request failed with HTTP ${response.status} (${init.method ?? "GET"} ${apiPath})`,
					detail,
				]
					.filter(Boolean)
					.join(": "),
				{
					status: String(response.status),
					path: apiPath,
					...(detail ? { response: detail } : {}),
				},
			);
		}
		if (response.status === 204) return undefined as T;
		return unwrapOpenCodeEnvelope<T>(await response.json());
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
