import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { dataDirectory, log } from "@loom/distribution";

const LIVE_PER_PROJECT = 8;
const LIVE_GLOBAL = 16;
const RETAINED = 32;
const HISTORY_BYTES = 256 * 1024;
const TICKET_TTL_MS = 30_000;
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 512 * 1024;
const shellNames = new Set([
	"bash",
	"zsh",
	"fish",
	"pwsh",
	"powershell",
	"cmd",
]);

/**
 * Terminal sessions that run a custom command (SSH) live under this pseudo
 * project scope instead of a real project id.
 */
export const SSH_SCOPE = "__ssh__";

export type TerminalStatus =
	| "creating"
	| "running"
	| "restarting"
	| "exited"
	| "failed";
export type TerminalSession = {
	id: string;
	projectId: string;
	workspaceId: string;
	label: string;
	generation: number;
	status: TerminalStatus;
	cols: number;
	rows: number;
	createdAt: string;
	exitedAt?: string;
	exitCode?: number;
	error?: string;
	interrupted?: boolean;
};

type PtyProcess = import("bun-pty").IPty;
type HistoryItem = { sequence: number; data: string; bytes: number };
type InternalSession = {
	metadata: TerminalSession;
	cwd: string;
	shell: string;
	/** Custom command (e.g. ssh) replacing the default interactive shell. */
	command?: string[];
	pty?: PtyProcess;
	ptyDataSubscription?: { dispose(): void };
	ptyExitSubscription?: { dispose(): void };
	attachment?: {
		id: string;
		send: (value: unknown) => void;
		close: () => void;
		pendingBytes: number;
		sentBytes: Map<number, number>;
	};
	tickets: Map<string, number>;
	history: HistoryItem[];
	historyBytes: number;
	sequence: number;
	inputEvents: number[];
	createKeys: Map<string, TerminalSession>;
	restartKeys: Map<string, TerminalSession>;
	startPromise?: Promise<void>;
	waitExit?: (code: number) => void;
	lifecycle: Promise<unknown>;
};

function validDimensions(cols: number, rows: number) {
	return (
		Number.isInteger(cols) &&
		cols >= 20 &&
		cols <= 300 &&
		Number.isInteger(rows) &&
		rows >= 5 &&
		rows <= 120
	);
}

function safeShell() {
	const candidates =
		process.platform === "win32"
			? [
					process.env.PWSH_PATH,
					process.env.POWERSHELL_EXE,
					"pwsh.exe",
					"powershell.exe",
					"cmd.exe",
				]
			: [process.env.SHELL, "/bin/bash", "/bin/sh"];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const name = basename(candidate)
			.replace(/\.exe$/i, "")
			.toLowerCase();
		if (!shellNames.has(name)) continue;
		const path = Bun.which(candidate);
		if (path) return path;
	}
	throw new Error("No supported interactive shell was found on this system.");
}

function shellCandidates(primary: string) {
	const fallbacks =
		process.platform === "win32"
			? ["pwsh.exe", "powershell.exe", "cmd.exe"]
			: ["/bin/bash", "/bin/sh"];
	const candidates = [primary];
	const seen = new Set([resolve(primary)]);
	for (const fallback of fallbacks) {
		const path = Bun.which(fallback);
		if (!path) continue;
		const normalized = resolve(path);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			candidates.push(path);
		}
	}
	return candidates;
}

function shellArgs(shell: string) {
	const name = basename(shell)
		.replace(/\.exe$/i, "")
		.toLowerCase();
	if (name === "pwsh" || name === "powershell") return ["-NoLogo"];
	if (name === "cmd") return [];
	return process.platform === "win32" ? [] : ["-i"];
}

export class TerminalManager {
	private sessions = new Map<string, InternalSession>();
	private createIdempotency = new Map<string, string>();
	private createTimes = new Map<string, number[]>();
	private ptyProviderPromise?: Promise<typeof import("bun-pty")>;
	private closing = false;
	private readyPromise?: Promise<void>;
	private persistPromise: Promise<void> = Promise.resolve();
	private metadataPath = join(
		dataDirectory(),
		"cache",
		"terminal-sessions.json",
	);

	ready() {
		if (!this.readyPromise) this.readyPromise = this.loadMetadata();
		return this.readyPromise;
	}

	private async loadMetadata() {
		try {
			const rows: unknown = JSON.parse(
				await Bun.file(this.metadataPath).text(),
			);
			if (!Array.isArray(rows)) return;
			for (const row of rows.slice(-RETAINED)) {
				const item = row as { metadata?: TerminalSession; cwd?: string };
				const value = item?.metadata;
				if (
					!value ||
					typeof value.id !== "string" ||
					typeof value.projectId !== "string" ||
					typeof item.cwd !== "string" ||
					!validDimensions(value.cols, value.rows)
				)
					continue;
				const interrupted = Boolean(
					value.interrupted ||
						["creating", "running", "restarting"].includes(value.status),
				);
				const metadata: TerminalSession = {
					...value,
					status: "exited",
					interrupted,
					exitedAt: value.exitedAt ?? new Date().toISOString(),
					...(interrupted
						? {
								error: "Terminal was interrupted when the Loom daemon stopped.",
							}
						: {}),
				};
				this.sessions.set(metadata.id, {
					metadata,
					cwd: resolve(item.cwd),
					shell: "",
					tickets: new Map(),
					history: [],
					historyBytes: 0,
					sequence: 0,
					inputEvents: [],
					createKeys: new Map(),
					restartKeys: new Map(),
					lifecycle: Promise.resolve(),
				});
			}
			await this.persist();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				log(
					"terminal",
					"metadata-load-failed",
					{ error: error instanceof Error ? error.message : String(error) },
					"warn",
				);
		}
	}

	private persist() {
		const snapshot = JSON.stringify(
			[...this.sessions.values()]
				.slice(-RETAINED)
				.map(({ metadata, cwd }) => ({ metadata, cwd })),
		);
		this.persistPromise = this.persistPromise
			.catch(() => {})
			.then(async () => {
				await mkdir(join(dataDirectory(), "cache"), {
					recursive: true,
					mode: 0o700,
				});
				const temporary = `${this.metadataPath}.${randomUUID()}.tmp`;
				await writeFile(temporary, `${snapshot}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
				await rename(temporary, this.metadataPath);
			});
		void this.persistPromise.catch((error) =>
			log(
				"terminal",
				"metadata-write-failed",
				{ error: error instanceof Error ? error.message : String(error) },
				"warn",
			),
		);
		return this.persistPromise;
	}

	async list(projectId: string, _workspaceId?: string) {
		return [...this.sessions.values()]
			.filter((session) => session.metadata.projectId === projectId)
			.map((session) => ({ ...session.metadata }));
	}

	hasLiveSessions(projectId: string) {
		return [...this.sessions.values()].some(
			(session) =>
				session.metadata.projectId === projectId &&
				["creating", "running", "restarting"].includes(session.metadata.status),
		);
	}

	async create(input: {
		projectId: string;
		workspaceId: string;
		cwd: string;
		cols: number;
		rows: number;
		idempotencyKey: string;
	}) {
		return this.createSession({ ...input, command: undefined });
	}

	async createSsh(input: {
		connectionId: string;
		label: string;
		sshPath: string;
		username: string;
		host: string;
		port: number;
		auth: "agent" | "key" | "password";
		cols: number;
		rows: number;
		idempotencyKey: string;
	}) {
		if (!validDimensions(input.cols, input.rows))
			throw new Error("Terminal dimensions are out of range.");
		if (!input.idempotencyKey || input.idempotencyKey.length > 120)
			throw new Error("A valid idempotency key is required.");
		const sshPath = resolve(input.sshPath);
		const args = [
			sshPath,
			`${input.username}@${input.host}`,
			"-p",
			String(input.port),
		];
		// Keep auth prompts interactive; ssh already prefers agent/keys first.
		if (input.auth === "agent") args.push("-o", "BatchMode=no");
		const params = {
			projectId: SSH_SCOPE,
			workspaceId: `${input.username}@${input.host}:${input.port}`,
			label: input.label,
			cwd: this.homeDirectory(),
			command: [sshPath, ...args.slice(1)],
			cols: input.cols,
			rows: input.rows,
			idempotencyKey: input.idempotencyKey,
			idempotencySalt: `ssh:${input.connectionId}`,
		};
		return this.createSession(params);
	}

	private homeDirectory() {
		return process.env.HOME || process.env.USERPROFILE || process.cwd();
	}

	private async createSession(input: {
		projectId: string;
		workspaceId: string;
		label?: string;
		cwd: string;
		cols: number;
		rows: number;
		idempotencyKey: string;
		command?: string[];
		idempotencySalt?: string;
	}) {
		if (!validDimensions(input.cols, input.rows))
			throw new Error("Terminal dimensions are out of range.");
		if (!input.idempotencyKey || input.idempotencyKey.length > 120)
			throw new Error("A valid idempotency key is required.");
		const key = `${input.projectId}:${input.workspaceId}:${input.idempotencySalt ?? ""}:${input.idempotencyKey}`;
		const previousId = this.createIdempotency.get(key);
		if (previousId) {
			const previous = this.sessions.get(previousId);
			if (previous) return { ...previous.metadata };
		}
		this.prune();
		const projectSessions = [...this.sessions.values()].filter(
			(session) =>
				session.metadata.projectId === input.projectId &&
				["creating", "running", "restarting"].includes(session.metadata.status),
		);
		const live = [...this.sessions.values()].filter((session) =>
			["creating", "running", "restarting"].includes(session.metadata.status),
		);
		if (
			projectSessions.length >= LIVE_PER_PROJECT ||
			live.length >= LIVE_GLOBAL
		)
			throw new Error(
				`Terminal limit reached (${LIVE_PER_PROJECT} per project, ${LIVE_GLOBAL} total).`,
			);
		const now = Date.now();
		const recent = (this.createTimes.get(input.projectId) ?? []).filter(
			(time) => now - time < 10_000,
		);
		if (recent.length >= 8)
			throw new Error(
				"Too many terminal creation requests. Try again shortly.",
			);
		recent.push(now);
		this.createTimes.set(input.projectId, recent);
		const metadata: TerminalSession = {
			id: randomUUID(),
			projectId: input.projectId,
			workspaceId: input.workspaceId,
			label: input.label ?? `Terminal ${this.sessions.size + 1}`,
			generation: 1,
			status: "creating",
			cols: input.cols,
			rows: input.rows,
			createdAt: new Date(now).toISOString(),
		};
		const session: InternalSession = {
			metadata,
			cwd: resolve(input.cwd),
			shell: input.command?.[0] ?? safeShell(),
			command: input.command ? [...input.command] : undefined,
			tickets: new Map(),
			history: [],
			historyBytes: 0,
			sequence: 0,
			inputEvents: [],
			createKeys: new Map(),
			restartKeys: new Map(),
			lifecycle: Promise.resolve(),
		};
		this.sessions.set(metadata.id, session);
		this.createIdempotency.set(key, metadata.id);
		session.createKeys.set(input.idempotencyKey, metadata);
		void this.persist();
		session.startPromise = this.start(session).catch(() => {});
		return { ...metadata };
	}

	issueTicket(sessionId: string, projectId: string) {
		const session = this.sessions.get(sessionId);
		if (!session || session.metadata.projectId !== projectId)
			throw new Error("Terminal session not found.");
		const ticket = randomUUID() + randomUUID();
		session.tickets.set(ticket, Date.now() + TICKET_TTL_MS);
		return { ticket, expiresInMs: TICKET_TTL_MS };
	}

	attach(
		sessionId: string,
		ticket: string,
		socket: {
			send(value: string): void;
			close(code?: number, reason?: string): void;
		},
	) {
		const session = this.sessions.get(sessionId);
		const expiry = session?.tickets.get(ticket);
		if (!session || !expiry || expiry < Date.now()) {
			socket.close(1008, "Terminal attachment expired");
			return { id: "", detach: () => {} };
		}
		session.tickets.delete(ticket);
		session.attachment?.close();
		const attachmentId = randomUUID();
		const attachment = {
			id: attachmentId,
			pendingBytes: 0,
			sentBytes: new Map<number, number>(),
			send: (value: unknown) => socket.send(JSON.stringify(value)),
			close: () => socket.close(1000, "Terminal reattached elsewhere"),
		};
		session.attachment = attachment;
		attachment.send({ type: "session", session: session.metadata });
		const firstHistoryItem = session.history[0];
		if (firstHistoryItem && firstHistoryItem.sequence > 1)
			attachment.send({
				type: "history_truncated",
				firstSequence: firstHistoryItem.sequence,
			});
		if (session.history.length)
			attachment.send({
				type: "history_replay",
				message:
					"Recent output is replayed; interactive screen state may be incomplete.",
			});
		for (const item of session.history)
			attachment.send({
				type: "output",
				generation: session.metadata.generation,
				sequence: item.sequence,
				data: item.data,
			});
		if (
			session.metadata.status === "exited" ||
			session.metadata.status === "failed"
		)
			attachment.send({
				type: "exited",
				generation: session.metadata.generation,
				exitCode: session.metadata.exitCode,
				error: session.metadata.error,
			});
		else if (session.metadata.status === "running")
			attachment.send({
				type: "ready",
				generation: session.metadata.generation,
			});
		return {
			id: attachmentId,
			detach: () => {
				if (session.attachment?.id === attachmentId)
					session.attachment = undefined;
			},
		};
	}

	message(sessionId: string, attachmentId: string, raw: string) {
		const session = this.sessions.get(sessionId);
		if (!session || session.attachment?.id !== attachmentId) return;
		if (raw.length > 50_000)
			return this.sendError(session, "Terminal frame is too large.");
		let input: {
			type?: string;
			generation?: number;
			data?: string;
			cols?: number;
			rows?: number;
			sequence?: number;
		};
		try {
			input = JSON.parse(raw);
		} catch {
			return this.sendError(session, "Invalid terminal message.");
		}
		if (input.generation !== session.metadata.generation)
			return this.sendError(
				session,
				"This terminal tab has a stale generation.",
			);
		if (input.type === "input") {
			if (session.metadata.status !== "running")
				return this.sendError(session, "The shell is not running.");
			if (
				typeof input.data !== "string" ||
				input.data.length > MAX_INPUT_BYTES * 2
			)
				return this.sendError(session, "Terminal input is too large.");
			const data = Buffer.from(input.data, "base64");
			if (
				data.length > MAX_INPUT_BYTES ||
				data.toString("base64") !== input.data
			)
				return this.sendError(session, "Invalid terminal input frame.");
			const now = Date.now();
			session.inputEvents = session.inputEvents.filter(
				(time) => now - time < 1000,
			);
			if (session.inputEvents.length >= 120)
				return this.sendError(
					session,
					"Terminal input is arriving too quickly.",
				);
			session.inputEvents.push(now);
			try {
				session.pty?.write(data.toString("utf8"));
			} catch {
				this.sendError(session, "Terminal input could not be written.");
			}
		} else if (input.type === "resize") {
			const { cols, rows } = input;
			if (!validDimensions(cols ?? 0, rows ?? 0))
				return this.sendError(session, "Terminal dimensions are out of range.");
			session.metadata.cols = cols ?? session.metadata.cols;
			session.metadata.rows = rows ?? session.metadata.rows;
			try {
				session.pty?.resize(session.metadata.cols, session.metadata.rows);
			} catch {
				this.sendError(session, "Terminal could not be resized.");
			}
		} else if (input.type === "ack") {
			if (!Number.isSafeInteger(input.sequence) || (input.sequence ?? -1) < 0)
				return this.sendError(session, "Invalid terminal acknowledgement.");
			const acknowledgedSequence = input.sequence ?? -1;
			for (const [sequence, bytes] of session.attachment.sentBytes) {
				if (sequence > acknowledgedSequence) break;
				session.attachment.pendingBytes = Math.max(
					0,
					session.attachment.pendingBytes - bytes,
				);
				session.attachment.sentBytes.delete(sequence);
			}
		} else this.sendError(session, "Unsupported terminal message.");
	}

	async closeSession(
		sessionId: string,
		projectId: string,
		expectedGeneration: number,
		approved: boolean,
	) {
		const session = this.sessions.get(sessionId);
		if (!session) return { closed: true };
		if (session.metadata.projectId !== projectId)
			throw new Error("Terminal session not found.");
		if (!approved) throw new Error("Terminal close confirmation is required.");
		const operation = session.lifecycle.then(async () => {
			if (this.sessions.get(sessionId) !== session) return { closed: true };
			if (session.metadata.generation !== expectedGeneration)
				throw new Error(
					"Terminal changed; refresh this tab before closing it.",
				);
			if (session.metadata.status === "creating")
				await session.startPromise?.catch(() => {});
			if (
				session.pty &&
				["creating", "running", "restarting"].includes(session.metadata.status)
			) {
				const stopped = await this.stopPty(session);
				if (!stopped) {
					session.metadata.status = "failed";
					session.metadata.error =
						"Shell shutdown could not be confirmed; the tab remains open.";
					this.broadcast(session, {
						type: "session",
						session: session.metadata,
					});
					void this.persist();
					throw new Error(session.metadata.error);
				}
			}
			session.attachment?.close();
			session.attachment = undefined;
			session.tickets.clear();
			this.sessions.delete(sessionId);
			for (const [key, value] of this.createIdempotency) {
				if (value === sessionId) this.createIdempotency.delete(key);
			}
			await this.persist();
			return { closed: true };
		});
		session.lifecycle = operation.catch(() => {});
		return operation;
	}

	async restart(
		sessionId: string,
		projectId: string,
		cwd: string,
		expectedGeneration: number,
		approved: boolean,
		idempotencyKey: string,
	) {
		const session = this.sessions.get(sessionId);
		if (!session || session.metadata.projectId !== projectId)
			throw new Error("Terminal session not found.");
		if (!approved) throw new Error("Restart confirmation is required.");
		if (!idempotencyKey || idempotencyKey.length > 120)
			throw new Error("A valid idempotency key is required.");
		const cached = session.restartKeys.get(idempotencyKey);
		if (cached) return { ...cached };
		const operation = session.lifecycle.then(async () => {
			if (session.metadata.generation !== expectedGeneration)
				throw new Error(
					"Terminal changed; refresh this tab before restarting.",
				);
			if (
				session.metadata.status === "restarting" ||
				session.metadata.status === "creating"
			)
				throw new Error("Terminal lifecycle operation is already in progress.");
			session.metadata.status = "restarting";
			void this.persist();
			this.broadcast(session, { type: "session", session: session.metadata });
			if (session.pty && session.metadata.exitCode === undefined) {
				const stopped = await this.stopPty(session);
				if (!stopped) {
					session.metadata.status = "failed";
					session.metadata.error =
						"Shell shutdown could not be confirmed; no replacement was started.";
					this.broadcast(session, {
						type: "error",
						message: session.metadata.error,
					});
					throw new Error(session.metadata.error);
				}
			}
			session.metadata.generation += 1;
			if (session.attachment) {
				session.attachment.pendingBytes = 0;
				session.attachment.sentBytes.clear();
			}
			session.cwd = cwd;
			session.shell = safeShell();
			session.metadata.exitCode = undefined;
			session.metadata.exitedAt = undefined;
			session.metadata.error = undefined;
			session.metadata.interrupted = false;
			session.metadata.status = "creating";
			session.history = [];
			session.historyBytes = 0;
			session.sequence = 0;
			await this.start(session);
			const result = { ...session.metadata };
			session.restartKeys.set(idempotencyKey, result);
			void this.persist();
			return result;
		});
		session.lifecycle = operation.catch(() => {});
		return operation;
	}

	private async start(session: InternalSession) {
		if (this.closing) throw new Error("Terminal manager is shutting down.");
		try {
			if (!this.ptyProviderPromise) {
				this.ptyProviderPromise = import("bun-pty").catch((error) => {
					this.ptyProviderPromise = undefined;
					throw error;
				});
			}
			const provider = await this.ptyProviderPromise;
			const failures: string[] = [];
			let pty: PtyProcess | undefined;
			if (session.command) {
				try {
					pty = provider.spawn(session.command[0]!, session.command.slice(1), {
						name: "xterm-256color",
						cwd: session.cwd,
						cols: session.metadata.cols,
						rows: session.metadata.rows,
						env: this.hostEnvironment(),
					});
				} catch (error) {
					failures.push(
						`${basename(session.command[0]!)}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			} else {
				for (const candidate of shellCandidates(session.shell)) {
					try {
						pty = provider.spawn(candidate, shellArgs(candidate), {
							name: "xterm-256color",
							cwd: session.cwd,
							cols: session.metadata.cols,
							rows: session.metadata.rows,
							env: this.hostEnvironment(),
						});
						session.shell = candidate;
						break;
					} catch (error) {
						failures.push(
							`${basename(candidate)}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			}
			if (!pty)
				throw new Error(
					`Could not start an interactive shell; tried ${failures.join("; ")}`,
				);
			session.pty = pty;
			session.metadata.status = "running";
			session.ptyDataSubscription = pty.onData((data) =>
				this.handlePtyOutput(session, pty, data),
			);
			session.ptyExitSubscription = pty.onExit((event) =>
				this.handlePtyExit(session, pty, event.exitCode),
			);
			void this.persist();
			this.broadcast(session, {
				type: "ready",
				generation: session.metadata.generation,
			});
		} catch (error) {
			session.metadata.status = "failed";
			session.metadata.error =
				error instanceof Error ? error.message : "Unable to start terminal.";
			void this.persist();
			this.broadcast(session, {
				type: "error",
				message: session.metadata.error,
			});
			throw error;
		}
	}

	private handlePtyOutput(
		session: InternalSession,
		pty: PtyProcess,
		output: string,
	) {
		if (session.pty !== pty || !output) return;
		const bytes = Buffer.from(output, "utf8");
		for (let offset = 0; offset < bytes.length; ) {
			let end = Math.min(offset + 12 * 1024, bytes.length);
			while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
			if (end === offset) end = Math.min(offset + 12 * 1024, bytes.length);
			const chunk = bytes.subarray(offset, end);
			const encoded = chunk.toString("base64");
			const size = chunk.length;
			const item = { sequence: ++session.sequence, data: encoded, bytes: size };
			session.history.push(item);
			session.historyBytes += size;
			while (session.historyBytes > HISTORY_BYTES)
				session.historyBytes -= session.history.shift()!.bytes;
			while (session.history.length) {
				const first = session.history[0]!;
				const historyBytes = Buffer.from(first.data, "base64");
				let offset = 0;
				while (
					offset < historyBytes.length &&
					(historyBytes[offset]! & 0xc0) === 0x80
				)
					offset++;
				if (offset === 0) break;
				if (offset === historyBytes.length) {
					session.history.shift();
					session.historyBytes -= first.bytes;
					continue;
				}
				const normalized = historyBytes.subarray(offset);
				session.history[0] = {
					...first,
					data: normalized.toString("base64"),
					bytes: normalized.length,
				};
				session.historyBytes -= offset;
				break;
			}
			const attachment = session.attachment;
			if (attachment) {
				if (attachment.pendingBytes + size > MAX_PENDING_OUTPUT_BYTES) {
					attachment.close();
					session.attachment = undefined;
				} else {
					attachment.pendingBytes += size;
					attachment.sentBytes.set(item.sequence, size);
					attachment.send({
						type: "output",
						generation: session.metadata.generation,
						sequence: item.sequence,
						data: encoded,
					});
				}
			}
			offset = end;
		}
	}

	private handlePtyExit(
		session: InternalSession,
		pty: PtyProcess,
		exitCode: number,
	) {
		if (session.pty !== pty) return;
		session.ptyDataSubscription?.dispose();
		session.ptyExitSubscription?.dispose();
		session.ptyDataSubscription = undefined;
		session.ptyExitSubscription = undefined;
		session.pty = undefined;
		if (session.metadata.status !== "restarting") {
			session.metadata.status =
				session.metadata.status === "creating" ? "failed" : "exited";
			session.metadata.exitCode = exitCode;
			session.metadata.exitedAt = new Date().toISOString();
			void this.persist();
		}
		session.waitExit?.(exitCode);
		session.waitExit = undefined;
		this.broadcast(session, { type: "session", session: session.metadata });
	}

	private async stopPty(session: InternalSession) {
		const pty = session.pty;
		if (!pty) return true;
		const stopped = new Promise<boolean>((resolve) => {
			const previousWait = session.waitExit;
			session.waitExit = (code) => {
				previousWait?.(code);
				resolve(true);
			};
		});
		try {
			pty.kill("SIGTERM");
		} catch {
			/* The exit callback below confirms process termination. */
		}
		const result = await Promise.race([
			stopped,
			new Promise<boolean>((resolve) =>
				setTimeout(() => resolve(false), 4_000),
			),
		]);
		if (!result && session.pty === pty) {
			try {
				pty.kill("SIGKILL");
			} catch {
				/* Keep the session open if termination cannot be confirmed. */
			}
			return Promise.race([
				stopped,
				new Promise<boolean>((resolve) =>
					setTimeout(() => resolve(false), 1_000),
				),
			]);
		}
		return result;
	}

	private hostEnvironment() {
		const allowed = [
			"PATH",
			"HOME",
			"USER",
			"LOGNAME",
			"SHELL",
			"TERM",
			"LANG",
			"LC_ALL",
			"LC_CTYPE",
			"TMPDIR",
			"TEMP",
			"TMP",
			"SystemRoot",
			"WINDIR",
			"USERPROFILE",
			"HOMEDRIVE",
			"HOMEPATH",
			"APPDATA",
			"LOCALAPPDATA",
			"PATHEXT",
		];
		const environment: Record<string, string> = {};
		for (const key of allowed)
			if (process.env[key]) environment[key] = process.env[key]!;
		environment.TERM = "xterm-256color";
		environment.LOOM_TERMINAL = "1";
		return environment;
	}

	private sendError(session: InternalSession, message: string) {
		session.attachment?.send({ type: "error", message });
	}
	private broadcast(session: InternalSession, message: unknown) {
		session.attachment?.send(message);
	}
	private prune() {
		const exited = [...this.sessions.values()]
			.filter((session) =>
				["exited", "failed"].includes(session.metadata.status),
			)
			.sort((a, b) => a.metadata.createdAt.localeCompare(b.metadata.createdAt));
		let changed = false;
		while (exited.length > RETAINED) {
			const id = exited.shift()!.metadata.id;
			this.sessions.delete(id);
			for (const [key, sessionId] of this.createIdempotency)
				if (sessionId === id) this.createIdempotency.delete(key);
			changed = true;
		}
		if (changed) void this.persist();
	}

	async close() {
		this.closing = true;
		const sessions = [...this.sessions.values()];
		for (const session of sessions) {
			if (session.metadata.status === "creating")
				await session.startPromise?.catch(() => {});
			if (
				session.pty &&
				["creating", "running", "restarting"].includes(session.metadata.status)
			) {
				session.metadata.status = "exited";
				session.metadata.error =
					"Terminal was interrupted when the Loom daemon stopped.";
				session.metadata.exitedAt = new Date().toISOString();
			}
			session.attachment?.close();
		}
		await this.persist();
		const exitWaits = sessions.map((session) => {
			const pty = session.pty;
			if (!pty) return Promise.resolve();
			const exited = new Promise<void>((resolve) => {
				session.waitExit = () => resolve();
			});
			try {
				pty.kill("SIGTERM");
			} catch {
				/* Continue shutting down other sessions. */
			}
			return exited;
		});
		await Promise.race([
			Promise.all(exitWaits),
			new Promise((resolve) => setTimeout(resolve, 4_000)),
		]);
		for (const session of sessions)
			if (session.pty) {
				try {
					session.pty.kill("SIGKILL");
				} catch {
					/* Best-effort daemon shutdown. */
				}
			}
		await this.persist();
	}
}
