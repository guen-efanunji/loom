<script lang="ts">
import {
	Check,
	ChevronLeft,
	Copy,
	ExternalLink,
	RefreshCw,
	Terminal,
	X,
} from "@lucide/svelte";
import { onMount } from "svelte";
import { toast } from "svelte-sonner";
import SettingsSidebar from "$lib/components/settings/SettingsSidebar.svelte";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import { daemon } from "$lib/daemon";

type Provider = Awaited<ReturnType<typeof daemon.listProviders>>[number];
let providers = $state<Provider[]>([]);
let loading = $state(true);
let checking = $state(false);
let autoCheck = $state(true);
let search = $state("");
const filtered = $derived(
	providers.filter((provider) =>
		provider.name.toLowerCase().includes(search.toLowerCase()),
	),
);

onMount(() => void checkProviders());

async function checkProviders() {
	checking = true;
	try {
		providers = await daemon.listProviders();
	} catch (reason) {
		toast.error(
			reason instanceof Error
				? reason.message
				: "Unable to detect provider CLIs",
		);
	} finally {
		loading = false;
		checking = false;
	}
}

async function connect(provider: Provider) {
	const result = await daemon.connectProvider(provider.id);
	if (result.connected) {
		await checkProviders();
		toast.success(
			result.configured === false
				? `${provider.name} connected; add a model provider to continue`
				: `${provider.name} is connected`,
		);
		return;
	}
	if (result.launched) {
		toast.success(`${provider.name} connection started`);
		return;
	}
	if (result.command) {
		const command = Array.isArray(result.command)
			? result.command.join(" ")
			: result.command;
		await copyCommand(command);
		toast.info(`Run ${command} in a terminal`);
		return;
	}
	if (provider.install)
		window.open(provider.install, "_blank", "noopener,noreferrer");
	toast.info(`Install ${provider.name}, then return here and re-check`);
}

async function disconnect(provider: Provider) {
	try {
		await daemon.disconnectProvider(provider.id);
		await checkProviders();
		toast.success(`${provider.name} disconnected`);
	} catch (reason) {
		toast.error(
			reason instanceof Error
				? reason.message
				: "Unable to disconnect provider",
		);
	}
}

async function copyCommand(command: string) {
	await navigator.clipboard.writeText(command);
	toast.success("Command copied");
}
</script>

<svelte:head><title>Providers · Loom</title></svelte:head>
<div class="min-h-svh bg-[#090909] text-neutral-100"><div class="mx-auto flex min-h-svh max-w-[1500px]"><SettingsSidebar active="providers" bind:search /><main class="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:px-12 lg:py-10"><div class="mx-auto max-w-5xl"><div class="mb-8 flex items-start justify-between gap-4"><div><p class="mb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500">Agents</p><h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Providers</h1><p class="mt-2 text-sm text-neutral-500">Manage your local agent CLIs — connections, installation, and authentication.</p></div><Button href="/settings" variant="outline" size="sm"><ChevronLeft class="size-4" />Settings</Button></div><section class="mb-8"><p class="mb-3 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500">Automatic CLI checks</p><div class="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.035] p-5"><div><h2 class="text-sm font-semibold">Check for CLI updates automatically</h2><p class="mt-1 text-sm text-neutral-500">Last checked: {loading ? "checking…" : "just now"}</p></div><div class="flex items-center gap-3"><Button variant="outline" size="sm" disabled={checking} onclick={() => void checkProviders()}><RefreshCw class={`size-4 ${checking ? "animate-spin" : ""}`} />Check now</Button><button type="button" role="switch" aria-checked={autoCheck} class={`relative h-6 w-11 rounded-full ${autoCheck ? "bg-emerald-500" : "bg-white/15"}`} onclick={() => autoCheck = !autoCheck}><span class={`absolute top-1 size-4 rounded-full bg-white transition ${autoCheck ? "left-6" : "left-1"}`}></span><span class="sr-only">Toggle automatic CLI checks</span></button></div></div></section><section class="mb-8"><p class="mb-3 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500">Local CLI</p><div class="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035]">{#each filtered as provider}<div class="flex flex-wrap items-center gap-4 border-b border-white/[0.08] p-5 last:border-0"><div class="flex min-w-0 flex-1 items-center gap-3"><div class="flex size-9 items-center justify-center rounded-lg bg-white/[0.08] text-neutral-300"><Terminal class="size-5" /></div><div class="min-w-0"><p class="font-medium">{provider.name} <span class="ml-1 font-mono text-xs text-neutral-500">{provider.version ?? provider.command}</span></p><p class={`mt-1 flex items-center gap-1 text-xs ${provider.installed ? "text-emerald-400" : "text-neutral-500"}`}>{#if provider.installed}<Check class="size-3" />Available{:else}<X class="size-3" />Not installed{/if}</p></div></div>{#if provider.status === "connected" || provider.authenticated}<Button variant="outline" size="sm" onclick={() => void disconnect(provider)}>Disconnect</Button>{:else if provider.installed}<Button variant="outline" size="sm" onclick={() => void connect(provider)}>Connect</Button>{:else}<Button variant="outline" size="sm" onclick={() => void connect(provider)}><ExternalLink class="size-4" />Install</Button>{/if}</div>{/each}</div></section><section><p class="mb-3 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500">Connection details</p><div class="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 class="text-sm font-semibold">OpenCode authentication</h2><p class="mt-1 text-sm text-neutral-500">Loom uses the installed OpenCode CLI and its local provider configuration. Run authentication in a terminal if the browser cannot launch it.</p><div class="mt-4 flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2"><code class="truncate text-xs text-neutral-400">opencode auth login</code><Button variant="ghost" size="icon-sm" aria-label="Copy OpenCode auth command" onclick={() => void copyCommand("opencode auth login")}><Copy class="size-4" /></Button></div></div></section></div></main></div></div>
