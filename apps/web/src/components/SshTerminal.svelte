<script lang="ts">
	import { ArrowLeft, Search, X } from "@lucide/svelte";
	import { onMount, tick } from "svelte";
	import { toast } from "svelte-sonner";
	import { Button } from "$lib/components/ui/button";
	import { request, websocketUrl } from "$lib/daemon";
	import type { SshConnection } from "./SshPanel.svelte";

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
	let { server, onback }: { server: SshConnection; onback: () => void } =
		$props();
	let terminalElement = $state<HTMLDivElement | null>(null);
	let terminal = $state<Xterm | null>(null);
	let session = $state<SshSession | null>(null);
	let status = $state<SshSession["status"]>("creating");
	let connected = $state(false);
	let error = $state("");
	let disconnecting = $state(false);
	let socket: WebSocket | undefined;
	let fit: FitAddonType | undefined;
	let resizeObserver: ResizeObserver | undefined;
	let disposed = false;
	let closing = false;
	let retries = 0;

	function encodeBase64(value: string) {
		const bytes = new TextEncoder().encode(value);
		let binary = "";
		for (let index = 0; index < bytes.length; index += 0x8000)
			binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
		return btoa(binary);
	}

	function send(value: Record<string, unknown>) {
		if (connected && socket?.readyState === WebSocket.OPEN)
			socket.send(JSON.stringify(value));
	}

	function resizeTerminal() {
		if (
			!fit ||
			!terminal ||
			!terminalElement ||
			terminalElement.clientWidth < 10
		)
			return;
		try {
			fit.fit();
			if (terminal.cols >= 20 && terminal.rows >= 5)
				send({
					type: "resize",
					generation: session?.generation ?? 0,
					cols: terminal.cols,
					rows: terminal.rows,
				});
		} catch {}
	}

	async function attach() {
		if (!session || !terminalElement) return;
		const [{ Terminal }, { FitAddon }] = await Promise.all([
			import("@xterm/xterm"),
			import("@xterm/addon-fit"),
		]);
		if (disposed || !terminalElement) return;
		terminal = new Terminal({
			allowProposedApi: false,
			convertEol: false,
			cursorBlink: true,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 13,
			lineHeight: 1.35,
			scrollback: 5000,
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
		fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(terminalElement);
		terminal.onData((data) =>
			send({
				type: "input",
				generation: session?.generation ?? 0,
				data: encodeBase64(data),
			}),
		);
		resizeObserver = new ResizeObserver(resizeTerminal);
		resizeObserver.observe(terminalElement);
		await openSocket();
		resizeTerminal();
		terminal.focus();
	}

	async function openSocket() {
		if (!session || disposed) return;
		try {
			const { ticket } = await request<{ ticket: string }>(
				`/api/ssh/sessions/${encodeURIComponent(session.id)}/ticket`,
				{ method: "POST" },
			);
			if (disposed) return;
			const url = new URL(websocketUrl());
			url.pathname = `/api/ssh/sessions/${encodeURIComponent(session.id)}/stream`;
			url.search = new URLSearchParams({ ticket }).toString();
			socket = new WebSocket(url);
			socket.onopen = () => {
				connected = true;
				retries = 0;
				resizeTerminal();
			};
			socket.onclose = () => {
				connected = false;
				if (!closing && !disposed && retries < 5) {
					const delay = 500 * 2 ** retries++;
					setTimeout(() => void openSocket(), delay);
				}
			};
			socket.onerror = () => (connected = false);
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
					if (message.session.status) status = message.session.status;
					if (message.session.generation && session)
						session = { ...session, generation: message.session.generation };
				} else if (message.type === "ready") {
					status = "running";
					if (message.generation && session)
						session = { ...session, generation: message.generation };
				} else if (message.type === "output" && message.data) {
					const bytes = Uint8Array.from(atob(message.data), (item) =>
						item.charCodeAt(0),
					);
					terminal?.write(bytes, () =>
						send({
							type: "ack",
							generation: session?.generation ?? 0,
							sequence: message.sequence,
						}),
					);
				} else if (
					message.type === "history_replay" ||
					message.type === "history_truncated"
				) {
					terminal?.write(
						`\r\n\x1b[90m[${message.message ?? "Earlier output omitted from bounded replay buffer."}]\x1b[0m\r\n`,
					);
				} else if (message.type === "exited") {
					status = "exited";
					terminal?.write(
						`\r\n\x1b[90m[Disconnected${message.exitCode === undefined ? "" : ` (exit code ${message.exitCode})`}.]\x1b[0m\r\n`,
					);
				} else if (message.type === "error") {
					status = "failed";
					const text = message.message ?? "SSH session error.";
					error = text;
					terminal?.write(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
				}
			};
		} catch (reason) {
			status = "failed";
			error =
				reason instanceof Error
					? reason.message
					: "Unable to attach to SSH session.";
		}
	}

	async function disconnect() {
		if (!session || disconnecting) return;
		disconnecting = true;
		closing = true;
		try {
			await request(`/api/ssh/sessions/${encodeURIComponent(session.id)}`, {
				method: "DELETE",
				body: JSON.stringify({
					expectedGeneration: session.generation,
					approved: true,
				}),
			});
		} catch {}
		socket?.close();
		terminal?.dispose();
		terminal = null;
		status = "exited";
		disconnecting = false;
		onback();
	}

	onMount(() => {
		let active = true;
		void (async () => {
			try {
				session = await request<SshSession>("/api/ssh/sessions", {
					method: "POST",
					body: JSON.stringify({
						connectionId: server.id,
						cols: 120,
						rows: 36,
						idempotencyKey: crypto.randomUUID(),
					}),
				});
				status = session.status;
				await tick();
				if (active) await attach();
			} catch (reason) {
				status = "failed";
				error =
					reason instanceof Error
						? reason.message
						: `Unable to connect to ${server.label}.`;
				toast.error(error);
			}
		})();
		return () => {
			active = false;
			disposed = true;
			resizeObserver?.disconnect();
			socket?.close();
			terminal?.dispose();
			if (session && !closing)
				void request(`/api/ssh/sessions/${encodeURIComponent(session.id)}`, {
					method: "DELETE",
					body: JSON.stringify({
						expectedGeneration: session.generation,
						approved: true,
					}),
				}).catch(() => {});
		};
	});
</script>

<section class="flex h-full min-h-0 flex-col bg-[#0d0e12] text-[#e2e4ea]">
	<header
		class="flex h-11 shrink-0 items-center gap-3 border-b border-[#232632] bg-[#16181f] px-3"
	>
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<span
				class={`size-2 rounded-full ${connected ? "bg-green-500" : "bg-amber-400"}`}
			></span>
			<span class="truncate text-xs font-semibold">{server.label}</span>
			<span class="truncate font-mono text-[11px] text-[#8b949e]"
				>{server.username}@{server.host}</span
			>
			<span
				class="ml-2 rounded-full border border-[#1f6feb30] bg-[#0d2818] px-2 py-0.5 font-mono text-[10px] text-[#7ee787]"
				>{status}</span
			>
		</div>
		<Button
			variant="ghost"
			size="icon"
			class="size-7 text-[#a0a6b2]"
			aria-label="Find in terminal"
			title="Find in terminal"
			onclick={() => terminal?.focus()}><Search size={14} /></Button
		>
		<Button
			variant="ghost"
			size="icon"
			class="size-7 text-[#a0a6b2]"
			aria-label="Clear terminal"
			title="Clear terminal"
			onclick={() => terminal?.clear()}><span class="text-xs">⌫</span></Button
		>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 text-xs text-red-300"
			disabled={disconnecting}
			onclick={() => void disconnect()}>Disconnect</Button
		>
		<Button
			variant="ghost"
			size="icon"
			class="size-7 text-[#a0a6b2]"
			aria-label="Back to chat"
			title="Back to chat"
			onclick={onback}><ArrowLeft size={14} /></Button
		>
	</header>
	<div
		bind:this={terminalElement}
		class="terminal-viewport min-h-0 flex-1 overflow-hidden px-3 py-2"
		role="tabpanel"
		aria-label={`SSH terminal ${server.label}`}
	></div>
	<footer
		class="flex h-7 shrink-0 items-center gap-4 border-t border-[#1c1e27] bg-[#0d0e12] px-3 font-mono text-[10px] text-[#6e7681]"
	>
		<span class="truncate"
			>{server.label} · {server.username}@{server.host}</span
		><span>Port: {server.port}</span><span
			>{connected ? "Connected" : "Connecting"}</span
		>
		{#if error}<span class="ml-auto truncate text-red-300">{error}</span>{/if}
	</footer>
</section>

<style>
	.terminal-viewport :global(.xterm) {
		height: 100%;
		padding: 8px;
	}
	.terminal-viewport :global(.xterm-viewport) {
		overflow-y: auto !important;
	}
</style>
