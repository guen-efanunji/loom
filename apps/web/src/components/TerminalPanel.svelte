<script lang="ts">
import { Plus, RotateCw, Terminal as TerminalIcon, X } from "@lucide/svelte";
import { onMount, tick } from "svelte";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
import { Button } from "$lib/components/ui/button";
import { request, websocketUrl } from "$lib/daemon";

type TerminalStatus =
	| "creating"
	| "running"
	| "restarting"
	| "exited"
	| "failed";
type TerminalSession = {
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
type Xterm = import("@xterm/xterm").Terminal;
type FitAddonType = import("@xterm/addon-fit").FitAddon;
type TerminalView = {
	terminal: Xterm;
	fit: FitAddonType;
	socket?: WebSocket;
	resizeObserver?: ResizeObserver;
	connected: boolean;
	retries: number;
	closing?: boolean;
	errorShown?: boolean;
};

let { projectId }: { projectId: string } = $props();
let sessions = $state<TerminalSession[]>([]);
let activeId = $state("");
let loading = $state(true);
let creating = $state(false);
let restarting = $state(false);
let closing = $state(false);
let error = $state("");
let restartOpen = $state(false);
let restartTarget = $state<TerminalSession | null>(null);
let closeOpen = $state(false);
let closeTarget = $state<TerminalSession | null>(null);
let initialized = false;
const views = new Map<string, TerminalView>();
const elements: Record<string, HTMLDivElement> = {};
let XtermModule: typeof import("@xterm/xterm");
let FitModule: typeof import("@xterm/addon-fit");
let destroyed = false;

function setSession(next: TerminalSession) {
	const index = sessions.findIndex((session) => session.id === next.id);
	if (index < 0) sessions = [...sessions, next];
	else
		sessions = sessions.map((session) =>
			session.id === next.id ? next : session,
		);
}

function setStatus(
	id: string,
	status: TerminalStatus,
	details: Partial<TerminalSession> = {},
) {
	const current = sessions.find((session) => session.id === id);
	if (current) setSession({ ...current, ...details, status });
}

function encodeBase64(value: string) {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(binary);
}

async function attach(session: TerminalSession) {
	if (views.has(session.id)) return;
	await tick();
	const element = elements[session.id];
	if (!element) return;
	const terminal = new XtermModule.Terminal({
		allowProposedApi: false,
		convertEol: false,
		cursorBlink: true,
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
		fontSize: 13,
		lineHeight: 1.25,
		scrollback: 3000,
		theme: {
			background: "#111214",
			foreground: "#d4d4d8",
			cursor: "#e4e4e7",
			selectionBackground: "#52525b80",
			black: "#18181b",
			red: "#f87171",
			green: "#4ade80",
			yellow: "#facc15",
			blue: "#60a5fa",
			magenta: "#c084fc",
			cyan: "#22d3ee",
			white: "#e4e4e7",
			brightBlack: "#71717a",
			brightRed: "#fca5a5",
			brightGreen: "#86efac",
			brightYellow: "#fde047",
			brightBlue: "#93c5fd",
			brightMagenta: "#d8b4fe",
			brightCyan: "#67e8f9",
			brightWhite: "#fafafa",
		},
	});
	const fit = new FitModule.FitAddon();
	terminal.loadAddon(fit);
	terminal.open(element);
	const view: TerminalView = { terminal, fit, connected: false, retries: 0 };
	views.set(session.id, view);
	terminal.onData((data) =>
		send(session.id, {
			type: "input",
			generation: currentGeneration(session.id),
			data: encodeBase64(data),
		}),
	);
	view.resizeObserver = new ResizeObserver(() => fitAndResize(session.id));
	view.resizeObserver.observe(element);
	await connect(session.id, view);
	fitAndResize(session.id);
	if (activeId === session.id) terminal.focus();
}

function currentGeneration(id: string) {
	return sessions.find((session) => session.id === id)?.generation ?? 0;
}

function send(id: string, value: Record<string, unknown>) {
	const view = views.get(id);
	if (view?.connected && view.socket?.readyState === WebSocket.OPEN)
		view.socket.send(JSON.stringify(value));
}

function fitAndResize(id: string) {
	const view = views.get(id);
	const element = elements[id];
	if (
		!view ||
		!element ||
		activeId !== id ||
		element.clientWidth < 10 ||
		element.clientHeight < 10
	)
		return;
	try {
		view.fit.fit();
		if (view.terminal.cols >= 20 && view.terminal.rows >= 5) {
			send(id, {
				type: "resize",
				generation: currentGeneration(id),
				cols: view.terminal.cols,
				rows: view.terminal.rows,
			});
		}
	} catch {
		/* The panel may be hidden while its layout settles. */
	}
}

async function connect(id: string, view: TerminalView) {
	try {
		const { ticket } = await request<{ ticket: string }>(
			`/api/terminals/${encodeURIComponent(id)}/ticket?projectId=${encodeURIComponent(projectId)}`,
			{ method: "POST" },
		);
		if (!views.has(id)) return;
		const url = new URL(websocketUrl());
		url.pathname = `/api/terminals/${encodeURIComponent(id)}/stream`;
		url.search = new URLSearchParams({ ticket }).toString();
		const socket = new WebSocket(url);
		view.socket = socket;
		socket.onopen = () => {
			view.connected = true;
			view.retries = 0;
			fitAndResize(id);
		};
		socket.onclose = () => {
			view.connected = false;
			if (!destroyed && !view.closing && views.has(id) && view.retries < 5) {
				const delay = 500 * 2 ** view.retries++;
				setTimeout(() => {
					if (!destroyed && !view.closing && views.has(id))
						void connect(id, view);
				}, delay);
			}
		};
		socket.onerror = () => {
			view.connected = false;
		};
		socket.onmessage = (event) => {
			let message: {
				type: string;
				generation?: number;
				sequence?: number;
				data?: string;
				exitCode?: number;
				error?: string;
				message?: string;
				session?: TerminalSession;
			};
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (message.type === "session" && message.session) {
				setSession(message.session);
				if (message.session.error && !view.errorShown) {
					view.errorShown = true;
					view.terminal.write(
						`\r\n\x1b[33m[${message.session.error} Check shell permissions, then restart this tab.]\x1b[0m\r\n`,
					);
				}
			} else if (message.type === "ready")
				setStatus(id, "running", {
					generation: message.generation ?? currentGeneration(id),
				});
			else if (message.type === "output" && message.data) {
				const bytes = Uint8Array.from(atob(message.data), (character) =>
					character.charCodeAt(0),
				);
				view.terminal.write(bytes, () =>
					send(id, {
						type: "ack",
						generation: currentGeneration(id),
						sequence: message.sequence,
					}),
				);
			} else if (message.type === "history_replay") {
				view.terminal.write(
					`\r\n\x1b[90m[${message.message ?? "Recent terminal output replayed; screen state may be incomplete."}]\x1b[0m\r\n`,
				);
			} else if (message.type === "history_truncated") {
				view.terminal.write(
					"\r\n\x1b[90m[Earlier terminal output was omitted from the bounded replay buffer.]\x1b[0m\r\n",
				);
			} else if (message.type === "exited") {
				setStatus(id, "exited", {
					exitCode: message.exitCode,
					exitedAt: new Date().toISOString(),
				});
				view.terminal.write(
					`\r\n\x1b[90m[Process exited${message.exitCode === undefined ? "" : ` with code ${message.exitCode}`} ]\x1b[0m\r\n`,
				);
			} else if (message.type === "error") {
				const text =
					message.message ?? message.error ?? "Terminal connection failed.";
				if (sessions.find((item) => item.id === id)?.status === "creating")
					setStatus(id, "failed", { error: text });
				view.errorShown = true;
				view.terminal.write(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
			}
		};
	} catch (reason) {
		error =
			reason instanceof Error
				? reason.message
				: "Unable to connect to terminal.";
	}
}

async function load() {
	loading = true;
	error = "";
	try {
		sessions = await request<TerminalSession[]>(
			`/api/projects/${encodeURIComponent(projectId)}/terminals`,
		);
		if (!sessions.length) await createSession();
		else {
			if (!activeId || !sessions.some((session) => session.id === activeId))
				activeId = sessions[0]!.id;
			sessions = await Promise.all(
				sessions.map(async (session) => {
					if (!session.interrupted) return session;
					try {
						return await request<TerminalSession>(
							`/api/terminals/${encodeURIComponent(session.id)}/restart?projectId=${encodeURIComponent(projectId)}`,
							{
								method: "POST",
								body: JSON.stringify({
									expectedGeneration: session.generation,
									approved: true,
									idempotencyKey: crypto.randomUUID(),
								}),
							},
						);
					} catch (reason) {
						return {
							...session,
							status: "failed" as const,
							interrupted: false,
							error:
								reason instanceof Error
									? reason.message
									: "Unable to resume terminal.",
						};
					}
				}),
			);
		}
	} catch (reason) {
		error =
			reason instanceof Error ? reason.message : "Unable to load terminals.";
	} finally {
		loading = false;
	}
	// The terminal viewports are inside the non-loading branch. Mount xterm
	// only after that branch has rendered, otherwise the first session has no
	// element to attach to and remains stuck in `creating` until another tab
	// is opened.
	await tick();
	for (const session of sessions) await attach(session);
}

async function createSession() {
	if (creating) return;
	creating = true;
	error = "";
	try {
		const measure = [...views.values()].find(
			(view) => view.terminal.cols >= 20,
		);
		const session = await request<TerminalSession>(
			`/api/projects/${encodeURIComponent(projectId)}/terminals`,
			{
				method: "POST",
				body: JSON.stringify({
					cols: measure?.terminal.cols ?? 80,
					rows: measure?.terminal.rows ?? 24,
					idempotencyKey: crypto.randomUUID(),
				}),
			},
		);
		sessions = [...sessions, session];
		activeId = session.id;
		await tick();
		if (!loading) await attach(session);
	} catch (reason) {
		error =
			reason instanceof Error ? reason.message : "Unable to create terminal.";
	} finally {
		creating = false;
	}
}

function activate(id: string) {
	activeId = id;
	void tick().then(() => {
		fitAndResize(id);
		views.get(id)?.terminal.focus();
	});
}

function askRestart() {
	restartTarget = sessions.find((session) => session.id === activeId) ?? null;
	restartOpen = !!restartTarget;
}

async function confirmRestart() {
	const target = restartTarget;
	if (!target || restarting) return;
	restarting = true;
	error = "";
	setStatus(target.id, "restarting");
	try {
		const next = await request<TerminalSession>(
			`/api/terminals/${encodeURIComponent(target.id)}/restart?projectId=${encodeURIComponent(projectId)}`,
			{
				method: "POST",
				body: JSON.stringify({
					expectedGeneration: target.generation,
					approved: true,
					idempotencyKey: crypto.randomUUID(),
				}),
			},
		);
		setSession(next);
		const terminal = views.get(target.id)?.terminal;
		terminal?.reset();
		terminal?.write(
			"\x1b[90m[Terminal restarted at the project root.]\x1b[0m\r\n",
		);
	} catch (reason) {
		error =
			reason instanceof Error ? reason.message : "Unable to restart terminal.";
		setStatus(target.id, "failed", { error });
	} finally {
		restarting = false;
		restartOpen = false;
		restartTarget = null;
	}
}

function askClose(session: TerminalSession) {
	closeTarget = session;
	if (["creating", "running", "restarting"].includes(session.status)) {
		closeOpen = true;
		return;
	}
	void closeSession(session);
}

async function closeSession(session: TerminalSession) {
	if (closing) return;
	closing = true;
	error = "";
	const view = views.get(session.id);
	if (view) view.closing = true;
	try {
		await request(
			`/api/terminals/${encodeURIComponent(session.id)}?projectId=${encodeURIComponent(projectId)}`,
			{
				method: "DELETE",
				body: JSON.stringify({
					expectedGeneration: session.generation,
					approved: true,
				}),
			},
		);
		if (view) {
			view.resizeObserver?.disconnect();
			view.socket?.close();
			view.terminal.dispose();
			views.delete(session.id);
		}
		const index = sessions.findIndex((item) => item.id === session.id);
		sessions = sessions.filter((item) => item.id !== session.id);
		if (activeId === session.id) {
			const next = sessions[Math.min(index, sessions.length - 1)];
			activeId = next?.id ?? "";
			if (next)
				await tick().then(() => {
					fitAndResize(next.id);
					views.get(next.id)?.terminal.focus();
				});
		}
	} catch (reason) {
		if (view) view.closing = false;
		error =
			reason instanceof Error
				? reason.message
				: "Unable to close terminal tab.";
	} finally {
		closing = false;
		closeOpen = false;
		closeTarget = null;
	}
}

function statusText(session: TerminalSession) {
	const view = views.get(session.id);
	if (
		view &&
		!view.connected &&
		["creating", "running", "restarting"].includes(session.status)
	)
		return "disconnected";
	return session.status;
}

onMount(() => {
	let disposed = false;
	destroyed = false;
	void (async () => {
		try {
			await import("@xterm/xterm/css/xterm.css");
			[XtermModule, FitModule] = await Promise.all([
				import("@xterm/xterm"),
				import("@xterm/addon-fit"),
			]);
			if (!disposed && !initialized) {
				initialized = true;
				await load();
			}
		} catch (reason) {
			error =
				reason instanceof Error
					? reason.message
					: "Terminal interface failed to load.";
			loading = false;
		}
	})();
	return () => {
		disposed = true;
		destroyed = true;
		for (const view of views.values()) {
			view.resizeObserver?.disconnect();
			view.socket?.close();
			view.terminal.dispose();
		}
		views.clear();
		for (const key of Object.keys(elements)) delete elements[key];
		initialized = false;
	};
});
</script>

<div
	class="flex h-full min-h-0 flex-col bg-[#111214] text-foreground"
	aria-label="Integrated terminal"
>
	<header class="flex min-h-11 shrink-0 items-center gap-2 border-b px-3">
		<div
			class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
			role="tablist"
			aria-label="Terminal sessions"
		>
			{#each sessions as session, index (session.id)}
				<div
					class={`flex h-8 min-w-32 max-w-52 items-center rounded-md border ${activeId === session.id ? "border-border bg-background" : "border-transparent hover:bg-accent/50"}`}
					role="presentation"
				>
					<button
						type="button"
						role="tab"
						aria-selected={activeId === session.id}
						title={session.workspaceId}
						class={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-md px-2.5 text-xs ${activeId === session.id ? "text-foreground" : "text-muted-foreground"}`}
						onclick={() => activate(session.id)}
					>
						<TerminalIcon size={13} class="shrink-0" />
						<span class="truncate">Terminal {index + 1}</span>
						<span
							class={`size-1.5 shrink-0 rounded-full ${statusText(session) === "running" ? "bg-emerald-400" : statusText(session) === "exited" ? "bg-muted-foreground" : statusText(session) === "failed" ? "bg-destructive" : "bg-amber-400"}`}
							aria-label={statusText(session)}
						></span>
					</button>
					<button
						type="button"
						class="flex size-8 min-w-8 shrink-0 items-center justify-center rounded-r-md text-muted-foreground opacity-90 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						aria-label={`Close Terminal ${index + 1}`}
						title="Close terminal tab"
						disabled={closing}
						onpointerdown={(event) => event.stopPropagation()}
						onclick={() => askClose(session)}
						><X size={15} aria-hidden="true" /></button
					>
				</div>
			{/each}
		</div>
		<div class="flex shrink-0 items-center gap-1">
			<Button
				variant="ghost"
				size="icon"
				class="size-8"
				aria-label="New terminal tab"
				title="New tab"
				disabled={creating || loading}
				onclick={() => void createSession()}><Plus size={16} /></Button
			>
			<Button
				variant="ghost"
				size="icon"
				class="size-8"
				aria-label="Restart active terminal"
				title="Restart terminal"
				disabled={!sessions.some((session) => session.id === activeId) ||
					restarting}
				onclick={askRestart}><RotateCw size={15} /></Button
			>
		</div>
	</header>
	{#if error}<div
			class="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
			role="alert"
		>
			{error}
		</div>{/if}
	{#if loading}<div
			class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
		>
			Loading terminal…
		</div>
	{:else if !sessions.length}<div
			class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
		>
			Create a terminal tab to start a shell.
		</div>
	{:else}<div class="relative min-h-0 flex-1 overflow-hidden p-2">
			{#each sessions as session (session.id)}
				<div
					bind:this={elements[session.id]}
					class={`terminal-viewport absolute inset-2 overflow-hidden ${activeId === session.id ? "block" : "hidden"}`}
					aria-label={`Terminal ${session.label}`}
					role="tabpanel"
				></div>
			{/each}
		</div>{/if}
	{#if activeId}<footer
			class="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-3 py-1 text-[10px] text-muted-foreground"
		>
			<span
				class="min-w-0 flex-1 truncate"
				title={sessions.find((session) => session.id === activeId)?.workspaceId}
				>{sessions.find((session) => session.id === activeId)
					?.workspaceId}</span
			>
			<span
				>Shell follows OS permissions; project path is only its starting
				directory.</span
			>
			<span
				>{sessions.find((session) => session.id === activeId)?.exitCode !==
				undefined
					? `Exit ${sessions.find((session) => session.id === activeId)?.exitCode}`
					: statusText(
							sessions.find((session) => session.id === activeId)!,
						)}</span
			>
		</footer>{/if}
</div>

<AlertDialog.Root bind:open={restartOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Restart this terminal?</AlertDialog.Title>
			<AlertDialog.Description
				>This stops the active shell and its foreground jobs. Shell variables,
				directory changes, and in-memory state will be lost. Files on disk are
				unchanged.</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={restarting}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				disabled={restarting}
				onclick={(event) => {
					event.preventDefault();
					void confirmRestart();
				}}>Restart terminal</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={closeOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Close this terminal tab?</AlertDialog.Title>
			<AlertDialog.Description
				>This stops the shell and its foreground jobs. Unsaved in-memory shell
				state will be lost; files already written to disk remain unchanged.</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={closing}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				disabled={closing}
				onclick={(event) => {
					event.preventDefault();
					if (closeTarget) void closeSession(closeTarget);
				}}>Close terminal</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	.terminal-viewport :global(.xterm) {
		height: 100%;
		padding: 4px 2px;
	}
	.terminal-viewport :global(.xterm-viewport) {
		overflow-y: auto !important;
	}
</style>
