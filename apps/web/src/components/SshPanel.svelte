<script lang="ts">
	import {
		ArrowLeft,
		Lock,
		Pencil,
		Plus,
		Search,
		Settings2,
		Trash2,
		X,
	} from "@lucide/svelte";
	import { onMount, tick } from "svelte";
	import { toast } from "svelte-sonner";
	import { Button, buttonVariants } from "$lib/components/ui/button";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Input } from "$lib/components/ui/input";
	import * as Select from "$lib/components/ui/select";
	import { request, websocketUrl } from "$lib/daemon";

	export type SshConnection = {
		id: string;
		label: string;
		host: string;
		port: number;
		username: string;
		auth: "key" | "agent" | "password";
		notes: string;
	};

	type SshSession = {
		id: string;
		projectId: string;
		workspaceId: string;
		label: string;
		generation: number;
		status: "creating" | "running" | "restarting" | "exited" | "failed";
		cols: number;
		rows: number;
		createdAt: string;
		exitedAt?: string;
		exitCode?: number;
		error?: string;
	};

	type Xterm = import("@xterm/xterm").Terminal;
	type FitAddonType = import("@xterm/addon-fit").FitAddon;

	let { onclose }: { onclose?: () => void } = $props();

	const storageKey = "loom.ssh.connections";
	let servers = $state<SshConnection[]>([]);
	let serverSource = $state<"daemon" | "cache" | "">("");
	let search = $state("");
	let formOpen = $state(false);
	let editingId = $state("");
	let formLabel = $state("");
	let formUsername = $state("");
	let formHost = $state("");
	let formPort = $state("22");
	let formAuthValue = $state<string>("agent");
	const formAuth = $derived(
		formAuthValue === "key" || formAuthValue === "password"
			? (formAuthValue as SshConnection["auth"])
			: ("agent" as const),
	);
	let submitting = $state(false);
	let sshAvailable = $state(true);
	let sshUnavailableMessage = $state("");

	// Embedded SSH session state.
	let activeSession = $state<SshSession | null>(null);
	let activeServer = $state<SshConnection | null>(null);
	let sessionStatus = $state<SshSession["status"]>("creating");
	let connectingId = $state("");
	let disconnecting = $state(false);
	const terminalElements: Record<string, HTMLDivElement> = {};
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
	const views = new Map<string, TerminalView>();
	let XtermModule: typeof import("@xterm/xterm");
	let FitModule: typeof import("@xterm/addon-fit");

	const filteredServers = $derived.by(() => {
		const query = search.trim().toLowerCase();
		if (!query) return servers;
		return servers.filter((server) =>
			[server.label, server.host, server.username, server.port]
				.join(" ")
				.toLowerCase()
				.includes(query),
		);
	});

	function normalize(item: Record<string, unknown>): SshConnection | null {
		const label = typeof item.label === "string" ? item.label : "";
		const host = typeof item.host === "string" ? item.host : "";
		if (!label || !host) return null;
		const rawPort = item.port;
		let port = 22;
		if (typeof rawPort === "number" && Number.isInteger(rawPort))
			port = Math.min(65535, Math.max(1, rawPort));
		else if (typeof rawPort === "string") {
			const parsed = Number.parseInt(rawPort, 10);
			if (Number.isInteger(parsed)) port = parsed;
		}
		return {
			id:
				typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
			label,
			host,
			port,
			username:
				typeof item.username === "string" && item.username
					? item.username
					: "root",
			auth:
				item.auth === "key" || item.auth === "password"
					? item.auth
					: ("agent" as const),
			notes: typeof item.notes === "string" ? item.notes : "",
		};
	}

	function persist() {
		try {
			window.localStorage.setItem(storageKey, JSON.stringify(servers));
		} catch {}
	}

	function loadCache() {
		try {
			const value: unknown = JSON.parse(
				window.localStorage.getItem(storageKey) ?? "[]",
			);
			if (!Array.isArray(value)) return;
			const seen = new Set<string>();
			const cached = value
				.filter(
					(item): item is Record<string, unknown> =>
						!!item && typeof item === "object",
				)
				.map((item) => normalize(item))
				.filter((item): item is SshConnection => {
					if (!item || seen.has(item.host)) return false;
					seen.add(item.host);
					return true;
				});
			servers = cached;
		} catch {}
	}

	async function load() {
		try {
			const rows = await request<SshConnection[]>("/api/ssh/connections");
			const seen = new Set<string>();
			servers = rows
				.map((row) => normalize(row as unknown as Record<string, unknown>))
				.filter((row): row is SshConnection => {
					if (!row || seen.has(row.host)) return false;
					seen.add(row.host);
					return true;
				});
			serverSource = "daemon";
			persist();
		} catch (reason) {
			serverSource = "cache";
			loadCache();
			if (reason instanceof Error && reason.message)
				toast.error(reason.message);
			else
				toast.error(
					"Loom daemon is not reachable. Showing saved servers locally.",
				);
		}
		try {
			const check = await request<{ available: boolean; error?: string }>(
				"/api/ssh/check",
			);
			sshAvailable = check.available;
			sshUnavailableMessage = check.error ?? "";
		} catch {}
	}

	function openAddForm() {
		editingId = "";
		formLabel = "";
		formUsername = "";
		formHost = "";
		formPort = "22";
		formAuthValue = "agent";
		formOpen = true;
	}

	function openEditForm(server: SshConnection) {
		editingId = server.id;
		formLabel = server.label;
		formUsername = server.username;
		formHost = server.host;
		formPort = String(server.port);
		formAuthValue = server.auth;
		formOpen = true;
	}

	async function submitForm(event: SubmitEvent) {
		event.preventDefault();
		const label = formLabel.trim();
		const host = formHost.trim();
		const username = formUsername.trim() || "root";
		const portNumber = Number.parseInt(formPort.trim(), 10);
		const port = Number.isInteger(portNumber)
			? Math.min(65535, Math.max(1, portNumber))
			: 22;
		if (!label || !host) return;
		submitting = true;
		try {
			if (editingId) {
				const updated = await request<SshConnection>(
					`/api/ssh/connections/${encodeURIComponent(editingId)}`,
					{
						method: "PATCH",
						body: JSON.stringify({
							label,
							host,
							username,
							port,
							auth: formAuth,
						}),
					},
				);
				const next = normalize(updated as unknown as Record<string, unknown>);
				if (next)
					servers = servers.map((server) =>
						server.id === editingId ? next : server,
					);
				toast.success(`Updated ${label}`);
			} else {
				const created = await request<SshConnection>("/api/ssh/connections", {
					method: "POST",
					body: JSON.stringify({ label, host, username, port, auth: formAuth }),
				});
				const next = normalize(created as unknown as Record<string, unknown>);
				if (next) servers = [...servers, next];
				toast.success(`Saved ${label}`);
			}
			serverSource = "daemon";
			persist();
			formOpen = false;
		} catch (reason) {
			if (reason instanceof Error && reason.message)
				toast.error(reason.message);
			else toast.error("Loom daemon is not reachable. Please try again later.");
		} finally {
			submitting = false;
		}
	}

	async function removeServer(server: SshConnection) {
		servers = servers.filter((item) => item.id !== server.id);
		persist();
		try {
			await request(`/api/ssh/connections/${encodeURIComponent(server.id)}`, {
				method: "DELETE",
			});
			serverSource = "daemon";
		} catch {
			serverSource = "cache";
		}
		toast.success(`Removed ${server.label}`);
	}

	function statusText() {
		const view = activeSession ? views.get(activeSession.id) : undefined;
		if (
			view &&
			!view.connected &&
			["creating", "running", "restarting"].includes(sessionStatus)
		)
			return "disconnected";
		return sessionStatus;
	}

	// ---- Embedded SSH terminal ----

	function currentGeneration() {
		return activeSession?.generation ?? 0;
	}

	function encodeBase64(value: string) {
		const bytes = new TextEncoder().encode(value);
		let binary = "";
		for (let index = 0; index < bytes.length; index += 0x8000)
			binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
		return btoa(binary);
	}

	function send(id: string, value: Record<string, unknown>) {
		const view = views.get(id);
		if (view?.connected && view.socket?.readyState === WebSocket.OPEN)
			view.socket.send(JSON.stringify(value));
	}

	function fitAndResize() {
		const id = activeSession?.id;
		const view = id ? views.get(id) : undefined;
		const element = id ? terminalElements[id] : undefined;
		if (
			!id ||
			!view ||
			!element ||
			element.clientWidth < 10 ||
			element.clientHeight < 10
		)
			return;
		try {
			view.fit.fit();
			if (view.terminal.cols >= 20 && view.terminal.rows >= 5) {
				send(id, {
					type: "resize",
					generation: currentGeneration(),
					cols: view.terminal.cols,
					rows: view.terminal.rows,
				});
			}
		} catch {
			/* The panel may be hidden while its layout settles. */
		}
	}

	async function attachTerminal(session: SshSession) {
		const element = terminalElements[session.id];
		if (!element || views.has(session.id)) return;
		const terminal = new XtermModule.Terminal({
			allowProposedApi: false,
			convertEol: false,
			cursorBlink: true,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 12.5,
			lineHeight: 1.25,
			scrollback: 3000,
			theme: {
				background: "#191b1f",
				foreground: "#d8d8dc",
				cursor: "#e6e6e9",
				selectionBackground: "#565b6680",
				black: "#1b1d22",
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
				generation: currentGeneration(),
				data: encodeBase64(data),
			}),
		);
		view.resizeObserver = new ResizeObserver(() => fitAndResize());
		view.resizeObserver.observe(element);
		await connectSocket(session.id, view);
		fitAndResize();
		terminal.focus();
	}

	async function connectSocket(id: string, view: TerminalView) {
		try {
			const { ticket } = await request<{ ticket: string }>(
				`/api/ssh/sessions/${encodeURIComponent(id)}/ticket`,
				{ method: "POST" },
			);
			if (!views.has(id)) return;
			const url = new URL(websocketUrl());
			url.pathname = `/api/ssh/sessions/${encodeURIComponent(id)}/stream`;
			url.search = new URLSearchParams({ ticket }).toString();
			const socket = new WebSocket(url);
			view.socket = socket;
			socket.onopen = () => {
				view.connected = true;
				view.retries = 0;
				fitAndResize();
			};
			socket.onclose = () => {
				view.connected = false;
				if (!view.closing && views.has(id) && view.retries < 5) {
					const delay = 500 * 2 ** view.retries++;
					setTimeout(() => {
						if (!view.closing && views.has(id)) void connectSocket(id, view);
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
					session?: Partial<SshSession>;
				};
				try {
					message = JSON.parse(String(event.data));
				} catch {
					return;
				}
				if (message.type === "session" && message.session) {
					const next = message.session;
					if (activeSession && next.id === activeSession.id) {
						activeSession = { ...activeSession, ...next };
						if (next.status) sessionStatus = next.status;
						if (next.error && !view.errorShown) {
							view.errorShown = true;
							view.terminal.write(`\r\n\x1b[33m[${next.error}]\x1b[0m\r\n`);
						}
					}
				} else if (message.type === "ready") {
					sessionStatus = "running";
					if (message.generation && activeSession)
						activeSession = {
							...activeSession,
							generation: message.generation,
						};
				} else if (message.type === "output" && message.data) {
					const bytes = Uint8Array.from(atob(message.data), (character) =>
						character.charCodeAt(0),
					);
					view.terminal.write(bytes, () =>
						send(id, {
							type: "ack",
							generation: currentGeneration(),
							sequence: message.sequence,
						}),
					);
				} else if (message.type === "history_replay") {
					view.terminal.write(
						`\r\n\x1b[90m[${message.message ?? "Recent output replayed; screen state may be incomplete."}]\x1b[0m\r\n`,
					);
				} else if (message.type === "history_truncated") {
					view.terminal.write(
						"\r\n\x1b[90m[Earlier output was omitted from the bounded replay buffer.]\x1b[0m\r\n",
					);
				} else if (message.type === "exited") {
					if (activeSession) {
						activeSession = {
							...activeSession,
							status: "exited",
							exitCode: message.exitCode,
							exitedAt: new Date().toISOString(),
						};
						sessionStatus = "exited";
					}
					view.terminal.write(
						`\r\n\x1b[90m[Disconnected${message.exitCode === undefined ? "" : ` (exit code ${message.exitCode})`} — press the back arrow to return.]\x1b[0m\r\n`,
					);
				} else if (message.type === "error") {
					const text = message.message ?? "SSH session error.";
					if (sessionStatus === "creating") sessionStatus = "failed";
					view.errorShown = true;
					view.terminal.write(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
				}
			};
		} catch (reason) {
			const text =
				reason instanceof Error
					? reason.message
					: "Unable to attach to the SSH session.";
			if (sessionStatus === "creating") sessionStatus = "failed";
			view.errorShown = true;
			view.terminal.write(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
		}
	}

	async function connect(server: SshConnection) {
		if (activeSession) {
			toast.info("Disconnect the current SSH session first.");
			return;
		}
		if (connectingId) return;
		if (!sshAvailable) {
			toast.error(sshUnavailableMessage || "OpenSSH client is not installed.");
			return;
		}
		connectingId = server.id;
		try {
			const session = await request<SshSession>("/api/ssh/sessions", {
				method: "POST",
				body: JSON.stringify({
					connectionId: server.id,
					cols: 80,
					rows: 24,
					idempotencyKey: crypto.randomUUID(),
				}),
			});
			activeServer = server;
			activeSession = session;
			sessionStatus = session.status;
			await tick();
			await attachTerminal(session);
		} catch (reason) {
			activeServer = null;
			activeSession = null;
			if (reason instanceof Error && reason.message)
				toast.error(reason.message);
			else toast.error(`Unable to connect to ${server.label}.`);
		} finally {
			connectingId = "";
		}
	}

	async function disconnect() {
		const session = activeSession;
		if (!session || disconnecting) return;
		disconnecting = true;
		const view = views.get(session.id);
		if (view) view.closing = true;
		try {
			await request(`/api/ssh/sessions/${encodeURIComponent(session.id)}`, {
				method: "DELETE",
				body: JSON.stringify({
					expectedGeneration: session.generation,
					approved: true,
				}),
			});
		} catch {
			/* The session may have already exited on the daemon. */
		}
		if (view) {
			view.resizeObserver?.disconnect();
			view.socket?.close();
			view.terminal.dispose();
			views.delete(session.id);
		}
		activeSession = null;
		activeServer = null;
		sessionStatus = "creating";
		disconnecting = false;
	}

	onMount(() => {
		let disposed = false;
		void (async () => {
			try {
				[XtermModule, FitModule] = await Promise.all([
					import("@xterm/xterm"),
					import("@xterm/addon-fit"),
				]);
			} catch {
				/* The connect flow will report this error. */
			}
			if (!disposed) await load();
		})();
		return () => {
			disposed = true;
			for (const view of views.values()) {
				view.resizeObserver?.disconnect();
				view.socket?.close();
				view.terminal.dispose();
			}
			views.clear();
			for (const key of Object.keys(terminalElements))
				delete terminalElements[key];
		};
	});

	const authText: Record<SshConnection["auth"], string> = {
		key: "SSH key",
		agent: "SSH agent",
		password: "Password prompt",
	};
</script>

<div
	class="flex h-full min-h-0 flex-col border-l border-[#e9e9eb] bg-[#fcfcfc] text-[#202124]"
	aria-label="SSH connections"
>
	<header
		class="flex h-14 shrink-0 items-center gap-2 px-4 text-[14px] font-semibold"
	>
		{#if activeSession && activeServer}
			<button
				type="button"
				class="grid size-7 place-items-center rounded-md text-[#68686e] transition hover:bg-black/5 hover:text-[#303036]"
				aria-label="Back to server list"
				title="Back to servers"
				onclick={() => void disconnect()}
			>
				<ArrowLeft size={14} />
			</button>
			<span class="min-w-0 flex-1 truncate">{activeServer.label}</span>
			<span class="text-[11px] font-normal text-[#85858b]"
				>{activeServer.username}@{activeServer.host}</span
			>
		{:else}
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				class="size-4 shrink-0 text-[#68686e]"
				aria-hidden="true"
			>
				<rect x="3" y="4" width="18" height="16" rx="2" />
				<path d="m7 9 3 3-3 3m6 0h4" />
			</svg>
			<span class="min-w-0 flex-1">SSH connections</span>
		{/if}
		<button
			type="button"
			class="grid size-7 place-items-center rounded-md text-[#999] transition hover:bg-black/5 hover:text-[#45454b]"
			aria-label="Close SSH connections panel"
			onclick={() => onclose?.()}
		>
			<X size={14} />
		</button>
	</header>

	{#if activeSession}
		<div class="flex min-h-0 flex-1 flex-col gap-2 p-3">
			<div
				class="flex items-center justify-between gap-2 px-1 text-[10.5px] text-[#83838a]"
			>
				<span class="min-w-0 truncate"
					>{activeSession.label} ·
					<span
						class={statusText() === "running"
							? "text-emerald-600"
							: statusText() === "failed"
								? "text-destructive"
								: "text-[#83838a]"}>{statusText()}</span
					></span
				>
				<button
					type="button"
					class="shrink-0 text-[10.5px] font-semibold text-[#45454b] transition hover:text-black"
					onclick={() => void disconnect()}
				>
					Disconnect
				</button>
			</div>
			<div
				bind:this={terminalElements[activeSession.id]}
				class="terminal-viewport min-h-0 flex-1 overflow-hidden rounded-xl bg-[#191b1f]"
				role="tabpanel"
				aria-label={`SSH session ${activeSession.label}`}
			></div>
		</div>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
			<p class="text-[11.5px] leading-normal text-[#85858b]">
				Manage your servers and connect them to a chat.
			</p>

			{#if serverSource === "cache"}
				<p
					class="rounded-lg border border-[#ece2c6] bg-[#fdf7e4] px-2.5 py-1.5 text-[10.5px] text-[#8a6d2f]"
				>
					Loom daemon is offline — showing servers cached on this device.
					Editing needs the daemon.
				</p>
			{/if}
			{#if !sshAvailable && serverSource !== "cache"}
				<p
					class="rounded-lg border border-[#e3ded0] bg-[#f7f4ec] px-2.5 py-1.5 text-[10.5px] leading-normal text-[#7a6a45]"
					role="alert"
				>
					{sshUnavailableMessage ||
						"OpenSSH client is not installed on this machine."}
				</p>
			{/if}

			<button
				type="button"
				class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[#222] text-[12px] font-medium text-white transition hover:bg-black"
				onclick={openAddForm}
			>
				<Plus size={16} class="font-light" /> Add server
			</button>

			<div
				class="flex h-8 items-center gap-1.5 rounded-lg border border-[#e5e5e7] bg-white px-2.5 text-[#a0a0a5]"
			>
				<Search size={12} class="shrink-0" />
				<input
					class="min-w-0 flex-1 bg-transparent text-[11.5px] text-[#202124] outline-none placeholder:text-[#a0a0a5]"
					type="search"
					placeholder="Search connections"
					aria-label="Search SSH connections"
					bind:value={search}
				/>
			</div>

			<div class="mb-1 flex items-center justify-between">
				<p
					class="text-[10.5px] font-semibold tracking-[0.07em] text-[#97979c] uppercase"
				>
					All servers · {servers.length}
				</p>
			</div>

			{#if !filteredServers.length}
				<p
					class="rounded-lg border border-dashed border-[#e8e8ea] bg-white p-5 text-center text-[11px] text-[#85858b]"
				>
					{search
						? "No servers match your search."
						: "No servers saved yet. Add one to get started."}
				</p>
			{:else}
				<div class="space-y-2">
					{#each filteredServers as server (server.id)}
						<article class="rounded-xl border border-[#e8e8ea] bg-white p-3">
							<div class="flex items-center gap-2">
								<div
									class="grid size-8 shrink-0 place-items-center rounded-lg bg-[#f1f1f2] text-[#626269]"
								>
									<svg
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="1.8"
										class="size-3.5"
										aria-hidden="true"
									>
										<rect x="3" y="4" width="18" height="16" rx="2" />
										<path d="m7 9 3 3-3 3m6 0h4" />
									</svg>
								</div>
								<div class="min-w-0 flex-1">
									<p class="truncate text-[12px] font-semibold text-[#303036]">
										{server.label}
									</p>
									<p
										class="mt-0.5 truncate font-mono text-[10.5px] text-[#88888e]"
									>
										{server.username}@{server.host}
									</p>
								</div>
								<div class="group flex shrink-0 items-center gap-0.5">
									<button
										type="button"
										class="grid size-6 place-items-center rounded text-[#b3b3b7] opacity-0 transition group-hover:opacity-100 hover:text-[#45454b] focus-visible:opacity-100"
										aria-label={`Edit ${server.label}`}
										onclick={() => openEditForm(server)}
									>
										<Pencil size={12} />
									</button>
									<button
										type="button"
										class="grid size-6 place-items-center rounded text-[#b3b3b7] opacity-0 transition group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
										aria-label={`Remove ${server.label}`}
										onclick={() => void removeServer(server)}
									>
										<Trash2 size={12} />
									</button>
								</div>
								<span
									class="size-1.5 shrink-0 rounded-full bg-[#c9a348]"
									aria-label="Not connected"
								></span>
							</div>
							<div
								class="mt-2.5 flex items-center gap-1.5 border-t border-[#f0f0f1] pt-2 text-[10px] text-[#83838a]"
							>
								<span class="shrink-0">◷</span>
								<span class="shrink-0"
									>{connectingId === server.id
										? "Connecting…"
										: "Not connected"}</span
								>
								<span class="text-[#bbb]">·</span>
								<span class="min-w-0 truncate">{authText[server.auth]}</span>
								<button
									type="button"
									class="ml-auto shrink-0 text-[10.5px] font-semibold text-[#45454b] transition hover:text-black disabled:opacity-40"
									disabled={connectingId === server.id || !!activeSession}
									onclick={() => void connect(server)}
								>
									Connect →
								</button>
							</div>
						</article>
					{/each}
				</div>
			{/if}

			<div
				class="mt-auto flex items-start gap-2 rounded-lg border border-[#ececee] bg-white p-2.5 text-[10.5px] leading-normal text-[#88888e]"
			>
				<Lock size={13} class="mt-0.5 shrink-0" />
				<span>
					SSH connections run from this machine with the system OpenSSH client
					and its agent and keys. Passwords and keys are never stored by Loom —
					they are only requested when you connect.
				</span>
			</div>
		</div>

		<footer
			class="flex items-center gap-1.5 border-t border-[#eeeeef] px-4 py-3 text-[10.5px] text-[#99999e]"
		>
			<Settings2 size={12} />
			<span>Connection settings</span>
			<span class="ml-auto">↗</span>
		</footer>
	{/if}
</div>

<Dialog.Root bind:open={formOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{editingId ? "Edit server" : "Add server"}</Dialog.Title>
			<Dialog.Description>
				Save a server so you can connect to it from Loom.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submitForm}>
			<div class="space-y-2">
				<label class="text-xs font-medium" for="ssh-label">Label</label>
				<Input
					id="ssh-label"
					placeholder="Production"
					bind:value={formLabel}
					required
				/>
			</div>
			<div class="grid grid-cols-[1fr_88px] gap-3">
				<div class="space-y-2">
					<label class="text-xs font-medium" for="ssh-host">Host</label>
					<Input
						id="ssh-host"
						placeholder="prod.acme.io"
						spellcheck="false"
						bind:value={formHost}
						required
					/>
				</div>
				<div class="space-y-2">
					<label class="text-xs font-medium" for="ssh-port">Port</label>
					<Input
						id="ssh-port"
						type="number"
						min="1"
						max="65535"
						bind:value={formPort}
					/>
				</div>
			</div>
			<div class="space-y-2">
				<label class="text-xs font-medium" for="ssh-user">Username</label>
				<Input
					id="ssh-user"
					placeholder="deploy"
					spellcheck="false"
					bind:value={formUsername}
				/>
			</div>
			<div class="space-y-2">
				<span class="text-xs font-medium">Authentication</span>
				<Select.Root type="single" bind:value={formAuthValue}>
					<Select.Trigger class="w-full" aria-label="Authentication method"
						>{authText[formAuth]}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="agent">SSH agent</Select.Item>
						<Select.Item value="key">SSH key</Select.Item>
						<Select.Item value="password">Password prompt</Select.Item>
					</Select.Content>
				</Select.Root>
				<p class="text-[11px] text-muted-foreground">
					Passwords and keys are never stored — they are only requested when you
					connect.
				</p>
			</div>
			<Dialog.Footer>
				<Dialog.Close class={buttonVariants({ variant: "outline", size: "sm" })}
					>Cancel</Dialog.Close
				>
				<Button type="submit" size="sm" disabled={submitting}>
					{editingId ? "Save changes" : "Add server"}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<style>
	.terminal-viewport :global(.xterm) {
		height: 100%;
		padding: 6px 8px;
	}
	.terminal-viewport :global(.xterm-viewport) {
		overflow-y: auto !important;
	}
</style>
