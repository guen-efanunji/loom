import { type ChildProcess, spawn } from "node:child_process";
import type {
	AgentRunStatus,
	AgentRuntime,
	RuntimeActivity,
	RuntimeOutput,
	RuntimePermission,
	RuntimeToolAuthorization,
} from "../core";
import { ProviderError } from "../core";
import { findExecutable, readPrompt } from "./cli";
import { diffCountsFromPatch } from "./diff";

type JsonRpcMessage = {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message?: string; code?: number };
};

type OrderedPart =
	| { type: "text"; id: string }
	| { type: "activity"; id: string };

type CodexSessionState = {
	id: string;
	cwd: string;
	title: string;
	readOnly: boolean;
	threadId: string | null;
	threadInstructions: string | null;
	activeTurnId: string | null;
	lastCompletedTurnId: string | null;
	turnStartPromise: Promise<void> | null;
	abortRequested: boolean;
	status: AgentRunStatus;
	error: string | null;
	permission?: RuntimePermission;
	authorizeTool?: RuntimeToolAuthorization;
	orderedParts: OrderedPart[];
	textByItem: Map<string, string>;
	activities: Map<string, RuntimeActivity>;
	tokens?: RuntimeOutput["tokens"];
	waiters: Set<() => void>;
	turnSettled?: () => void;
};

export type CodexAppServerOptions = {
	command?: string;
	args?: string[];
	codingPrompt?: string;
	env?: Record<string, string>;
};

const DEFAULT_ARGS = ["app-server", "--listen", "stdio://"];
const STDERR_LIMIT_BYTES = 8_192;

export function normalizeCodexModelSlug(model: string): string {
	// The UI/catalog can expose a display label such as "GPT-5.6-Sol", while
	// Codex CLI / app-server expects the lowercase slug (`gpt-5.6-sol`).
	return model.trim().toLowerCase().replace(/\s+/g, "-");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function mapCodexItemStatus(
	status: unknown,
	fallback: RuntimeActivity["status"] = "completed",
): RuntimeActivity["status"] {
	if (status === "inProgress") return "running";
	if (status === "failed" || status === "declined") return "error";
	if (status === "completed") return "completed";
	return fallback;
}

export class CodexAppServerRuntime implements AgentRuntime {
	private readonly options: CodexAppServerOptions;
	private process: ChildProcess | null = null;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private pending = new Map<number | string, (msg: JsonRpcMessage) => void>();
	private nextId = 1;
	private readyPromise: Promise<void> | null = null;
	private sessions = new Map<string, CodexSessionState>();
	private threadToSession = new Map<string, string>();
	private nextSessionId = 0;

	constructor(options: CodexAppServerOptions = {}) {
		this.options = options;
	}

	private async ensureProcess(): Promise<void> {
		if (this.process && !this.process.killed && this.process.stdin?.writable)
			return;
		if (this.readyPromise) return this.readyPromise;
		this.readyPromise = (async () => {
			const command = this.options.command ?? "codex";
			const executable = await findExecutable(command);
			if (!executable) {
				throw new ProviderError(
					"NOT_INSTALLED",
					"Codex executable was not found",
					{ providerId: "codex" },
				);
			}
			const child = spawn(executable, this.options.args ?? DEFAULT_ARGS, {
				stdio: ["pipe", "pipe", "pipe"],
				env: this.options.env
					? { ...process.env, ...this.options.env }
					: process.env,
				windowsHide: true,
			});
			this.process = child;
			this.stdoutBuffer = "";
			this.stderrBuffer = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				this.stdoutBuffer += chunk.toString();
				for (
					let idx = this.stdoutBuffer.indexOf("\n");
					idx >= 0;
					idx = this.stdoutBuffer.indexOf("\n")
				) {
					const line = this.stdoutBuffer.slice(0, idx).trim();
					this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
					if (!line) continue;
					try {
						const msg = JSON.parse(line) as JsonRpcMessage;
						this.handleIncomingMessage(msg);
					} catch {
						// Ignore non-JSON noise on stdout.
					}
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				const next = `${this.stderrBuffer}${chunk.toString()}`;
				this.stderrBuffer =
					next.length > STDERR_LIMIT_BYTES
						? next.slice(-STDERR_LIMIT_BYTES)
						: next;
			});
			child.once("error", (error) => {
				this.handleProcessClosed(`Codex app-server error: ${error.message}`);
			});
			child.once("exit", (code, signal) => {
				const reason = this.stderrBuffer.trim()
					? `Codex app-server exited (${signal ?? `code ${code ?? "unknown"}`}): ${this.stderrBuffer.trim()}`
					: `Codex app-server exited (${signal ?? `code ${code ?? "unknown"}`})`;
				this.handleProcessClosed(reason);
			});
			const initResp = await this.request("initialize", {
				clientInfo: { name: "loom", version: "0.5.5" },
				capabilities: {},
			});
			if (initResp.error) {
				throw new ProviderError(
					"PROCESS_FAILED",
					initResp.error.message ?? "Codex app-server initialize failed",
					{ providerId: "codex" },
				);
			}
			this.notify("initialized", {});
		})().catch((error) => {
			this.readyPromise = null;
			throw error;
		});
		return this.readyPromise;
	}

	private handleProcessClosed(reason: string): void {
		this.process = null;
		this.readyPromise = null;
		for (const resolver of this.pending.values()) {
			resolver({ error: { message: reason } });
		}
		this.pending.clear();
		for (const session of this.sessions.values()) {
			if (
				session.status === "running" ||
				session.status === "waiting_permission"
			) {
				session.activeTurnId = null;
				if (session.abortRequested) {
					session.status = "cancelled";
				} else {
					session.error ??= reason;
					session.status = "failed";
				}
				session.turnSettled?.();
				session.turnSettled = undefined;
				this.notifyWaiters(session);
			}
		}
	}

	private handleIncomingMessage(msg: JsonRpcMessage): void {
		if (msg.id != null && !msg.method && this.pending.has(msg.id)) {
			const resolver = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			resolver(msg);
			return;
		}
		if (msg.id != null && typeof msg.method === "string") {
			void this.handleServerRequest(msg);
			return;
		}
		if (typeof msg.method === "string") {
			this.handleNotification(msg.method, msg.params);
		}
	}

	private resolveSessionForMessage(
		params: Record<string, unknown> | undefined,
	): CodexSessionState | undefined {
		const threadId = asString(params?.threadId);
		if (threadId) {
			const sessionId = this.threadToSession.get(threadId);
			if (sessionId) return this.sessions.get(sessionId);
		}
		const turnId =
			asString(params?.turnId) ?? asString(asRecord(params?.turn)?.id);
		if (turnId) {
			for (const session of this.sessions.values()) {
				if (session.activeTurnId === turnId) return session;
			}
		}
		return undefined;
	}

	private async handleServerRequest(msg: JsonRpcMessage): Promise<void> {
		const id = msg.id!;
		const method = msg.method!;
		const params = asRecord(msg.params);
		const session = this.resolveSessionForMessage(params);

		if (
			method === "item/commandExecution/requestApproval" ||
			method === "item/fileChange/requestApproval" ||
			method === "execCommandApproval" ||
			method === "applyPatchApproval" ||
			method === "item/permissions/requestApproval"
		) {
			const allowed = await this.authorizeServerApproval(
				session,
				method,
				params,
			);
			if (method === "execCommandApproval" || method === "applyPatchApproval") {
				this.respond(id, { decision: allowed ? "approved" : "denied" });
				return;
			}
			if (method === "item/permissions/requestApproval") {
				this.respond(id, {
					permissions: allowed ? (params?.permissions ?? {}) : {},
					scope: "turn",
				});
				return;
			}
			this.respond(id, { decision: allowed ? "accept" : "decline" });
			return;
		}

		if (method === "item/tool/requestUserInput") {
			this.respond(id, { answers: {} });
			return;
		}

		this.respondError(id, -32601, `Unsupported server request: ${method}`);
	}

	private async authorizeServerApproval(
		session: CodexSessionState | undefined,
		method: string,
		params: Record<string, unknown> | undefined,
	): Promise<boolean> {
		if (!session) return false;
		const mode = session.permission?.mode;
		if (mode === "read-only" || session.readOnly) return false;
		if (mode === "auto") return true;

		const toolName =
			method === "item/fileChange/requestApproval" ||
			method === "applyPatchApproval"
				? "file_change"
				: method === "item/permissions/requestApproval"
					? "permissions"
					: "command_execution";
		const reason =
			asString(params?.reason) ?? `Codex requested approval for ${toolName}`;
		const args = params ?? {};

		const previousStatus = session.status;
		if (previousStatus === "running") {
			session.status = "waiting_permission";
			this.notifyWaiters(session);
		}
		try {
			if (session.authorizeTool) {
				return await session.authorizeTool({
					toolName,
					args,
					reason,
					sessionId: session.id,
					cwd: session.cwd,
				});
			}
			const url = session.permission?.env?.LOOM_PERMISSION_URL;
			const token = session.permission?.env?.LOOM_PERMISSION_TOKEN;
			if (url && token) {
				try {
					const response = await fetch(url, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							token,
							tool_name: toolName,
							tool_input: args,
							reason,
						}),
					});
					if (!response.ok) return false;
					const body = asRecord(await response.json());
					const decision = asString(body?.decision);
					return (
						body?.allow === true ||
						decision === "allow" ||
						decision === "approve"
					);
				} catch {
					return false;
				}
			}
			return mode !== "ask";
		} finally {
			if (session.status === "waiting_permission") {
				session.status = "running";
				this.notifyWaiters(session);
			}
		}
	}

	private handleNotification(
		method: string,
		params: Record<string, unknown> | undefined,
	): void {
		const session = this.resolveSessionForMessage(params);
		if (!session) return;
		const turnId =
			asString(params?.turnId) ?? asString(asRecord(params?.turn)?.id);
		if (session.activeTurnId && turnId && turnId !== session.activeTurnId)
			return;

		if (method === "item/agentMessage/delta") {
			const itemId = asString(params?.itemId) ?? "agent-message";
			const delta = asString(params?.delta) ?? "";
			if (!delta) return;
			this.appendSessionText(session, itemId, delta);
			return;
		}

		if (method === "item/commandExecution/outputDelta") {
			const itemId = asString(params?.itemId);
			const delta = asString(params?.delta);
			if (!itemId || !delta) return;
			const existing = session.activities.get(itemId);
			if (existing) {
				this.setSessionActivity(session, {
					...existing,
					output: `${existing.output ?? ""}${delta}`,
				});
			} else {
				this.setSessionActivity(session, {
					id: itemId,
					tool: "command_execution",
					status: "running",
					output: delta,
				});
			}
			return;
		}

		if (method === "item/started" || method === "item/completed") {
			const item = asRecord(params?.item);
			if (!item) return;
			this.handleThreadItem(session, item, method === "item/completed");
			return;
		}

		if (method === "thread/tokenUsage/updated") {
			const tokenUsage = asRecord(params?.tokenUsage);
			const breakdown =
				asRecord(tokenUsage?.last) ?? asRecord(tokenUsage?.total);
			if (!breakdown) return;
			const total = asNumber(breakdown.totalTokens);
			const rawInput = asNumber(breakdown.inputTokens);
			const cacheRead = asNumber(breakdown.cachedInputTokens);
			const cacheWrite = asNumber(breakdown.cacheWriteInputTokens);
			const output = asNumber(breakdown.outputTokens);
			const reasoning = asNumber(breakdown.reasoningOutputTokens);
			const input =
				rawInput === undefined
					? undefined
					: Math.max(0, rawInput - (cacheRead ?? 0) - (cacheWrite ?? 0));
			const normalized: NonNullable<RuntimeOutput["tokens"]> = {
				...(total !== undefined ? { total } : {}),
				...(input !== undefined ? { input } : {}),
				...(output !== undefined ? { output } : {}),
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
			if (Object.keys(normalized).length) session.tokens = normalized;
			return;
		}

		if (method === "error") {
			if (params?.willRetry === true) return;
			const turnError = asRecord(params?.error);
			const message = asString(turnError?.message);
			if (message?.trim()) session.error = message.trim();
			return;
		}

		if (method === "turn/completed") {
			const turn = asRecord(params?.turn);
			const turnStatus = asString(turn?.status);
			const turnError = asRecord(turn?.error);
			const errorMessage = asString(turnError?.message);
			session.activeTurnId = null;
			if (turnId) session.lastCompletedTurnId = turnId;
			if (session.abortRequested) {
				session.status = "cancelled";
			} else if (turnStatus === "interrupted") {
				session.status = "interrupted";
				if (errorMessage) session.error = errorMessage;
			} else if (turnStatus === "failed") {
				session.error = errorMessage ?? session.error ?? "Codex turn failed";
				session.status = "failed";
			} else {
				session.status = "completed";
			}
			session.turnSettled?.();
			session.turnSettled = undefined;
			this.notifyWaiters(session);
		}
	}

	private handleThreadItem(
		session: CodexSessionState,
		item: Record<string, unknown>,
		completed: boolean,
	): void {
		const itemType = asString(item.type) ?? "";
		const itemId =
			asString(item.id) ?? `${itemType}-${session.activities.size}`;

		if (itemType === "agentMessage") {
			const text = asString(item.text);
			if (completed && typeof text === "string") {
				this.setSessionText(session, itemId, text);
			} else {
				this.ensureTextPart(session, itemId);
			}
			return;
		}

		if (itemType === "commandExecution") {
			const existing = session.activities.get(itemId);
			const command = asString(item.command);
			const cwd = asString(item.cwd);
			const aggregatedOutput = asString(item.aggregatedOutput);
			const exitCode =
				typeof item.exitCode === "number" ? item.exitCode : undefined;
			const status = mapCodexItemStatus(
				item.status,
				completed
					? exitCode && exitCode !== 0
						? "error"
						: "completed"
					: "running",
			);
			this.setSessionActivity(session, {
				id: itemId,
				tool: "command_execution",
				status,
				input: {
					...(command ? { command } : {}),
					...(cwd ? { cwd } : {}),
				},
				...(aggregatedOutput !== undefined
					? { output: aggregatedOutput }
					: existing?.output !== undefined
						? { output: existing.output }
						: {}),
			});
			return;
		}

		if (itemType === "fileChange" && Array.isArray(item.changes)) {
			const status = mapCodexItemStatus(
				item.status,
				completed ? "completed" : "running",
			);
			for (const [index, entry] of item.changes.entries()) {
				const change = asRecord(entry);
				if (!change) continue;
				const path = asString(change.path);
				const kind =
					asString(asRecord(change.kind)?.type) ?? asString(change.kind);
				const diff = asString(change.diff);
				const filediff =
					path && diff
						? {
								file: path,
								patch: diff,
								...diffCountsFromPatch(diff),
							}
						: undefined;
				this.setSessionActivity(session, {
					id: `${itemId}-${index}`,
					tool: "file_change",
					status,
					input: {
						...(path ? { path } : {}),
						...(kind ? { kind } : {}),
					},
					...(filediff ? { metadata: { filediff } } : {}),
				});
			}
			return;
		}

		if (itemType === "mcpToolCall") {
			const server = asString(item.server);
			const tool = asString(item.tool) ?? "mcp_tool";
			const toolError = asRecord(item.error);
			const errorMessage = asString(toolError?.message);
			this.setSessionActivity(session, {
				id: itemId,
				tool: server ? `${server}:${tool}` : tool,
				status: mapCodexItemStatus(
					item.status,
					completed ? "completed" : "running",
				),
				...(asRecord(item.arguments)
					? { input: asRecord(item.arguments) }
					: {}),
				...(errorMessage ? { error: errorMessage } : {}),
			});
			return;
		}

		if (itemType === "dynamicToolCall") {
			const tool = asString(item.tool) ?? "tool_call";
			this.setSessionActivity(session, {
				id: itemId,
				tool,
				status: mapCodexItemStatus(
					item.status,
					completed ? "completed" : "running",
				),
				...(asRecord(item.arguments)
					? { input: asRecord(item.arguments) }
					: {}),
			});
			return;
		}

		if (itemType === "webSearch") {
			const query = asString(item.query);
			this.setSessionActivity(session, {
				id: itemId,
				tool: "web_search",
				status: completed ? "completed" : "running",
				...(query ? { input: { query } } : {}),
			});
		}
	}

	private ensureTextPart(session: CodexSessionState, itemId: string): void {
		if (!session.textByItem.has(itemId)) {
			session.textByItem.set(itemId, "");
			session.orderedParts.push({ type: "text", id: itemId });
		}
	}

	private appendSessionText(
		session: CodexSessionState,
		itemId: string,
		delta: string,
	): void {
		this.ensureTextPart(session, itemId);
		session.textByItem.set(
			itemId,
			`${session.textByItem.get(itemId) ?? ""}${delta}`,
		);
	}

	private setSessionText(
		session: CodexSessionState,
		itemId: string,
		text: string,
	): void {
		this.ensureTextPart(session, itemId);
		session.textByItem.set(itemId, text);
	}

	private setSessionActivity(
		session: CodexSessionState,
		activity: RuntimeActivity,
	): void {
		const existed = session.activities.has(activity.id);
		session.activities.set(activity.id, activity);
		if (!existed) {
			session.orderedParts.push({ type: "activity", id: activity.id });
		}
	}

	private notifyWaiters(session: CodexSessionState): void {
		for (const wake of session.waiters) wake();
	}

	private writeMessage(payload: Record<string, unknown>): boolean {
		const stdin = this.process?.stdin;
		if (!stdin?.writable) return false;
		stdin.write(`${JSON.stringify(payload)}\n`);
		return true;
	}

	private request(
		method: string,
		params: unknown,
		timeoutMs?: number,
	): Promise<JsonRpcMessage> {
		return new Promise((resolve) => {
			const id = this.nextId++;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (msg: JsonRpcMessage) => {
				if (timer) clearTimeout(timer);
				this.pending.delete(id);
				resolve(msg);
			};
			if (timeoutMs) {
				timer = setTimeout(() => {
					finish({ error: { message: `${method} timed out` } });
				}, timeoutMs);
			}
			this.pending.set(id, finish);
			if (
				!this.writeMessage({
					jsonrpc: "2.0",
					id,
					method,
					params,
				})
			) {
				finish({
					error: { message: "Codex app-server stdin is not writable" },
				});
			}
		});
	}

	private notify(method: string, params: unknown): void {
		this.writeMessage({ jsonrpc: "2.0", method, params });
	}

	private respond(id: number | string, result: unknown): void {
		this.writeMessage({ jsonrpc: "2.0", id, result });
	}

	private respondError(
		id: number | string,
		code: number,
		message: string,
	): void {
		this.writeMessage({
			jsonrpc: "2.0",
			id,
			error: { code, message },
		});
	}

	async createSession(input: {
		cwd: string;
		title: string;
		readOnly?: boolean;
	}): Promise<{ id: string }> {
		const id = `loom-codex-${++this.nextSessionId}`;
		this.sessions.set(id, {
			id,
			cwd: input.cwd,
			title: input.title,
			readOnly: !!input.readOnly,
			threadId: null,
			threadInstructions: null,
			activeTurnId: null,
			lastCompletedTurnId: null,
			turnStartPromise: null,
			abortRequested: false,
			status: "queued",
			error: null,
			orderedParts: [],
			textByItem: new Map(),
			activities: new Map(),
			waiters: new Set(),
		});
		return { id };
	}

	async prompt(input: {
		sessionId: string;
		prompt: string;
		system?: string;
		model?: { providerID: string; modelID?: string; modelId?: string };
		thinkingMode?: string;
		images?: Array<{ mime: string; data: string }>;
		permission?: RuntimePermission;
		authorizeTool?: RuntimeToolAuthorization;
	}): Promise<void> {
		const session = this.sessions.get(input.sessionId);
		if (!session) {
			throw new ProviderError(
				"PROCESS_FAILED",
				`Session not found: ${input.sessionId}`,
				{ providerId: "codex" },
			);
		}
		if (
			session.status === "running" ||
			session.status === "waiting_permission"
		) {
			throw new ProviderError("PROCESS_FAILED", "Session is already running", {
				providerId: "codex",
			});
		}

		session.status = "running";
		session.error = null;
		session.abortRequested = false;
		session.activeTurnId = null;
		session.lastCompletedTurnId = null;
		session.orderedParts = [];
		session.textByItem.clear();
		session.activities.clear();
		session.tokens = undefined;
		if (input.permission) session.permission = input.permission;
		session.authorizeTool = input.authorizeTool;

		const rawModel = input.model?.modelID ?? input.model?.modelId;
		const model = rawModel ? normalizeCodexModelSlug(rawModel) : undefined;
		const effectivePermission = input.permission ?? session.permission;
		const isReadOnly =
			session.readOnly || effectivePermission?.mode === "read-only";
		const approvalPolicy =
			effectivePermission?.mode === "ask" ? "on-request" : "never";

		let instructions = input.system?.trim() || undefined;
		if (!instructions && !isReadOnly && this.options.codingPrompt) {
			instructions = (await readPrompt(this.options.codingPrompt)).trim();
		}

		try {
			await this.ensureProcess();
			if (session.abortRequested) {
				session.status = "cancelled";
				this.notifyWaiters(session);
				return;
			}

			let promptText = input.prompt;
			if (!session.threadId) {
				const threadResp = await this.request("thread/start", {
					...(model ? { model } : {}),
					cwd: session.cwd,
					approvalPolicy,
					sandbox: isReadOnly ? "read-only" : "workspace-write",
					...(instructions ? { developerInstructions: instructions } : {}),
				});
				if (threadResp.error) {
					throw new ProviderError(
						"PROCESS_FAILED",
						threadResp.error.message ?? "thread/start failed",
						{ providerId: "codex" },
					);
				}
				const thread = asRecord(threadResp.result?.thread);
				const tid = asString(thread?.id);
				if (!tid) {
					throw new ProviderError(
						"PROCESS_FAILED",
						"thread/start did not return thread id",
						{ providerId: "codex" },
					);
				}
				session.threadId = tid;
				session.threadInstructions = instructions ?? null;
				this.threadToSession.set(tid, session.id);
			} else if (instructions && instructions !== session.threadInstructions) {
				promptText = `${instructions}\n\n---\n\n${input.prompt}`;
			}

			if (session.abortRequested) {
				session.status = "cancelled";
				this.notifyWaiters(session);
				return;
			}

			const turnInput: Array<Record<string, unknown>> = [
				{ type: "text", text: promptText, text_elements: [] },
				...(input.images?.map((image) => ({
					type: "image",
					url: `data:${image.mime};base64,${image.data}`,
				})) ?? []),
			];

			let resolveTurnStart!: () => void;
			session.turnStartPromise = new Promise<void>((resolve) => {
				resolveTurnStart = resolve;
			});
			let turnResp: JsonRpcMessage;
			try {
				turnResp = await this.request("turn/start", {
					threadId: session.threadId,
					cwd: session.cwd,
					approvalPolicy,
					...(isReadOnly
						? { sandboxPolicy: { type: "readOnly", networkAccess: false } }
						: {}),
					...(model ? { model } : {}),
					...(input.thinkingMode && input.thinkingMode !== "default"
						? { effort: input.thinkingMode }
						: {}),
					input: turnInput,
				});
			} finally {
				session.turnStartPromise = null;
				resolveTurnStart();
			}

			if (turnResp.error) {
				throw new ProviderError(
					"PROCESS_FAILED",
					turnResp.error.message ?? "turn/start failed",
					{ providerId: "codex" },
				);
			}

			const turn = asRecord(turnResp.result?.turn);
			const turnId = asString(turn?.id) ?? null;
			const turnAlreadyCompleted =
				!!turnId && session.lastCompletedTurnId === turnId;
			if (!turnAlreadyCompleted) {
				if (
					session.status === "running" ||
					session.status === "waiting_permission"
				) {
					session.activeTurnId = turnId;
				} else if (
					session.abortRequested &&
					session.status === "cancelled" &&
					turnId &&
					session.threadId &&
					this.process &&
					!this.process.killed
				) {
					// abort() finished waiting before turn/start returned; still interrupt
					// the newly created turn so it does not keep running in app-server.
					void this.request(
						"turn/interrupt",
						{ threadId: session.threadId, turnId },
						2_000,
					);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			session.activeTurnId = null;
			if (session.abortRequested) {
				session.status = "cancelled";
			} else {
				session.error = message;
				session.status = "failed";
			}
			this.notifyWaiters(session);
			throw error;
		}
	}

	async status(sessionId: string): Promise<AgentRunStatus> {
		return this.sessions.get(sessionId)?.status ?? "failed";
	}

	async lastError(sessionId: string): Promise<string | null> {
		return this.sessions.get(sessionId)?.error ?? null;
	}

	async readOutput(sessionId: string): Promise<RuntimeOutput | null> {
		const session = this.sessions.get(sessionId);
		if (!session) return null;
		const textChunks: string[] = [];
		const parts: NonNullable<RuntimeOutput["parts"]> = [];
		for (const part of session.orderedParts) {
			if (part.type === "text") {
				const text = session.textByItem.get(part.id) ?? "";
				if (text.trim()) {
					textChunks.push(text);
					parts.push({ type: "text", id: part.id, text });
				}
			} else {
				parts.push(part);
			}
		}
		if (
			!textChunks.length &&
			!session.activities.size &&
			!session.tokens &&
			session.status === "queued"
		) {
			return null;
		}
		return {
			output: textChunks.join("\n").trim(),
			...(session.tokens ? { tokens: session.tokens } : {}),
			activities: [...session.activities.values()],
			parts,
		};
	}

	async wait(
		sessionId: string,
		options?: {
			timeoutMs?: number;
			pollIntervalMs?: number;
			onStatus?: (status: AgentRunStatus) => void | Promise<void>;
		},
	): Promise<"completed" | "failed" | "cancelled" | "interrupted"> {
		const session = this.sessions.get(sessionId);
		if (!session) return "failed";
		const deadline = Date.now() + (options?.timeoutMs ?? 300_000);
		let lastObserved: AgentRunStatus | null = null;
		while (true) {
			const current = session.status;
			if (options?.onStatus && current !== lastObserved) {
				lastObserved = current;
				await options.onStatus(current);
			}
			if (
				current === "completed" ||
				current === "failed" ||
				current === "cancelled" ||
				current === "interrupted"
			) {
				return current;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) return "interrupted";
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
	}

	async abort(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		if (
			session.status === "completed" ||
			session.status === "failed" ||
			session.status === "cancelled" ||
			session.status === "interrupted"
		) {
			return;
		}
		session.abortRequested = true;
		if (session.status === "queued") {
			session.status = "cancelled";
			this.notifyWaiters(session);
			return;
		}
		if (session.turnStartPromise) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				session.turnStartPromise,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 2_000);
				}),
			]);
			if (timer) clearTimeout(timer);
		}
		const threadId = session.threadId;
		const turnId = session.activeTurnId;
		if (threadId && turnId && this.process && !this.process.killed) {
			const settledPromise = new Promise<void>((resolve) => {
				if (!session.activeTurnId) {
					resolve();
					return;
				}
				const prev = session.turnSettled;
				const timer = setTimeout(resolve, 1_500);
				session.turnSettled = () => {
					clearTimeout(timer);
					prev?.();
					resolve();
				};
			});
			await this.request("turn/interrupt", { threadId, turnId }, 2_000);
			await settledPromise;
		}
		session.activeTurnId = null;
		session.status = "cancelled";
		this.notifyWaiters(session);
	}

	async deleteSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		if (
			session.status === "running" ||
			session.status === "waiting_permission"
		) {
			await this.abort(sessionId);
		}
		if (session.threadId) {
			this.threadToSession.delete(session.threadId);
		}
		this.sessions.delete(sessionId);
	}

	async getDiff(): Promise<unknown> {
		return [];
	}

	async dispose(): Promise<void> {
		const child = this.process;
		this.process = null;
		this.readyPromise = null;
		if (!child || child.killed) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
				resolve();
			}, 1_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			try {
				child.kill("SIGTERM");
			} catch {
				clearTimeout(timer);
				resolve();
			}
		});
	}
}
