<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { toast } from "svelte-sonner";
	import { ChevronLeft, CircleHelp, Folder, Globe, MessageSquareText, RefreshCw, ShieldAlert, Terminal } from "@lucide/svelte";
	import SettingsSidebar from "$lib/components/settings/SettingsSidebar.svelte";
	import { Button } from "$lib/components/ui/button";
	import * as Select from "$lib/components/ui/select";
	import { daemon, type McpInventory, type Project } from "$lib/daemon";
	import { settingsHref } from "$lib/settings-navigation";

	let projects = $state<Project[]>([]);
	let projectId = $state("all");
	let inventory = $state<McpInventory | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let search = $state("");
	const visibleServers = $derived((inventory?.servers ?? []).filter((server) =>
		`${server.name} ${server.runtime} ${server.transport} ${server.source}`.toLowerCase().includes(search.toLowerCase()),
	));
	const configuredSources = $derived((inventory?.sources ?? []).filter((source) => source.status === "available").length);
	const sourceIssues = $derived((inventory?.sources ?? []).filter((source) => source.status === "invalid" || source.status === "unavailable").length);

	onMount(() => void loadInventory());

	async function loadInventory(isRefresh = false) {
		if (isRefresh) refreshing = true;
		else loading = true;
		try {
			const [nextProjects, nextInventory] = await Promise.all([
				projects.length ? Promise.resolve(projects) : daemon.listProjects(),
				daemon.getMcpInventory(projectId === "all" ? undefined : projectId),
			]);
			projects = nextProjects;
			inventory = nextInventory;
		} catch (reason) {
			toast.error(reason instanceof Error ? reason.message : "Unable to read MCP configuration");
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	function chooseProject(value: string) {
		projectId = value;
		void loadInventory(true);
	}

	function scopeLabel(scope: string) {
		if (scope === "global") return "User / global";
		if (scope === "workspace-local") return "Workspace entry in user config";
		return "Workspace";
	}

	function sourceStatus(status: string) {
		if (status === "available") return "Read";
		if (status === "not-found") return "Not found";
		if (status === "invalid") return "Invalid";
		return "Unavailable";
	}
</script>

<svelte:head><title>MCP · Loom</title></svelte:head>

<div class="min-h-svh w-full bg-[#090909] text-neutral-100">
	<div class="flex min-h-svh w-full flex-col md:flex-row">
		<SettingsSidebar active="mcp" bind:search />
		<main class="min-w-0 flex-1 px-4 py-6 sm:px-7 lg:px-10 lg:py-8">
			<div class="mx-auto w-full max-w-[1320px]">
				<header class="mb-7 flex flex-wrap items-start justify-between gap-4">
					<div>
						<p class="mb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500">Agents · Integrations</p>
						<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">MCP servers</h1>
						<p class="mt-2 max-w-2xl text-sm text-neutral-500">Review MCP server definitions found in supported Claude, Codex, and OpenCode configuration files.</p>
					</div>
					<Button variant="outline" size="sm" disabled={refreshing} onclick={() => void loadInventory(true)}><RefreshCw class={`size-4 ${refreshing ? "animate-spin" : ""}`} />Refresh</Button>
				</header>

				<div class="mb-5 flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
					<div class="w-full sm:max-w-xs">
						<p class="mb-1.5 text-[10px] uppercase tracking-wide text-neutral-500">Workspace configuration</p>
						<Select.Root type="single" value={projectId} onValueChange={chooseProject}>
							<Select.Trigger class="h-9 w-full text-sm"><Select.Value /></Select.Trigger>
							<Select.Content>
								<Select.Item value="all">User / global configuration</Select.Item>
								{#each projects as project}<Select.Item value={project.id}>{project.name}</Select.Item>{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<p class="text-xs text-neutral-500">Scanned {inventory ? new Date(inventory.generatedAt).toLocaleString() : "—"}</p>
				</div>

				<div class="mb-5 grid gap-3 sm:grid-cols-3">
					<div class="rounded-xl border border-white/10 bg-white/[0.035] p-4"><p class="text-xs text-neutral-500">Configured definitions</p><p class="mt-2 text-2xl font-semibold">{inventory?.servers.length ?? "—"}</p><p class="mt-1 text-xs text-neutral-500">Found in scanned native config</p></div>
					<div class="rounded-xl border border-white/10 bg-white/[0.035] p-4"><p class="text-xs text-neutral-500">Connection state</p><p class="mt-2 text-lg font-semibold">Not observed</p><p class="mt-1 text-xs text-neutral-500">No server process or remote handshake was checked</p></div>
					<div class="rounded-xl border border-white/10 bg-white/[0.035] p-4"><p class="text-xs text-neutral-500">Config sources read</p><p class="mt-2 text-2xl font-semibold">{configuredSources}<span class="text-sm font-normal text-neutral-500"> / {inventory?.sources.length ?? "—"}</span></p><p class="mt-1 text-xs text-neutral-500">{sourceIssues ? `${sourceIssues} source issue${sourceIssues === 1 ? "" : "s"}` : "No invalid or unreadable sources"}</p></div>
				</div>

				<div class="mb-5 flex items-start gap-3 rounded-xl border border-sky-400/15 bg-sky-400/[0.04] p-4 text-sm text-neutral-400">
					<ShieldAlert class="mt-0.5 size-4 shrink-0 text-sky-300" />
					<p>This is a read-only inventory. A config entry does not mean a server is running, connected, authorized, or attached to an agent. Loom does not launch processes or contact remote servers from this page. Secret values are never returned; only environment and header names may be shown.</p>
				</div>

				<section class="mb-7">
					<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
						<div><h2 class="text-sm font-semibold">Discovered definitions</h2><p class="mt-1 text-xs text-neutral-500">Native configuration remains owned by its source runtime.</p></div>
						<input bind:value={search} placeholder="Filter servers…" class="h-9 w-full rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm outline-none placeholder:text-neutral-600 focus:border-white/20 sm:w-56" />
					</div>
					<div class="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
						{#if loading}<p class="p-5 text-sm text-neutral-500">Reading supported configuration files…</p>
						{:else if visibleServers.length === 0}<div class="p-8 text-center"><MessageSquareText class="mx-auto size-6 text-neutral-600" /><p class="mt-3 text-sm font-medium">{search ? "No matching server definitions" : "No server definitions found"}</p><p class="mt-1 text-xs text-neutral-500">Only the documented configuration locations listed below were scanned.</p></div>
						{:else}
							{#each visibleServers as server (server.id)}
								<article class="border-b border-white/[0.08] p-4 last:border-0 sm:p-5">
									<div class="flex flex-wrap items-start gap-3">
										<div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.07] text-neutral-300">{#if server.transport === "stdio"}<Terminal class="size-4" />{:else}<Globe class="size-4" />{/if}</div>
										<div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><h3 class="truncate text-sm font-semibold">{server.name}</h3><span class="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-neutral-400">{server.runtime}</span><span class="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-neutral-400">{server.transport}</span></div><p class="mt-1 text-xs text-neutral-500">{scopeLabel(server.scope)} · {server.source} · {server.ownership}</p></div>
										<span class="rounded-full border border-amber-400/20 bg-amber-400/[0.05] px-2 py-1 text-[10px] text-amber-300">Connection not observed</span>
									</div>
									<div class="mt-4 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
										<p class="text-neutral-500">Enabled in source <span class="ml-1 text-neutral-300">{server.enabled === null ? "Not specified" : server.enabled ? "Yes" : "No"}</span></p>
										{#if server.command}<p class="text-neutral-500">Executable <code class="ml-1 text-neutral-300">{server.command}</code> <span class="text-neutral-600">({server.argumentCount} arguments)</span></p>{/if}
										{#if server.endpointHost}<p class="text-neutral-500">Endpoint host <code class="ml-1 text-neutral-300">{server.endpointHost}</code></p>{/if}
										{#if server.environmentVariableNames.length}<p class="text-neutral-500">Environment keys <span class="ml-1 text-neutral-300">{server.environmentVariableNames.join(", ")}</span></p>{/if}
										{#if server.headerNames.length}<p class="text-neutral-500">Header names <span class="ml-1 text-neutral-300">{server.headerNames.join(", ")}</span></p>{/if}
									</div>
								</article>
							{/each}
						{/if}
					</div>
				</section>

				<section>
					<div class="mb-3"><h2 class="text-sm font-semibold">Scanned configuration sources</h2><p class="mt-1 text-xs text-neutral-500">This scan covers standard file locations only; other runtime or managed configuration may not appear.</p></div>
					<div class="divide-y divide-white/[0.08] rounded-2xl border border-white/10 bg-white/[0.025]">
						{#each inventory?.sources ?? [] as source (source.id)}
							<div class="flex flex-wrap items-center gap-3 p-4"><div class="flex size-8 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-400">{#if source.scope === "global"}<Globe class="size-4" />{:else}<Folder class="size-4" />{/if}</div><div class="min-w-0 flex-1"><p class="truncate text-xs font-medium">{source.file}</p><p class="mt-1 text-[11px] text-neutral-500">{source.runtime} · {scopeLabel(source.scope)}</p>{#if source.issue}<p class="mt-1 text-xs text-amber-300">{source.issue}</p>{/if}</div><span class={`rounded-full border px-2 py-1 text-[10px] ${source.status === "available" ? "border-emerald-400/20 text-emerald-300" : source.status === "invalid" || source.status === "unavailable" ? "border-amber-400/20 text-amber-300" : "border-white/10 text-neutral-500"}`}>{sourceStatus(source.status)}</span></div>
						{:else}<p class="p-4 text-sm text-neutral-500">No sources loaded.</p>{/each}
					</div>
					{#if inventory?.coverage.truncated}<p class="mt-2 text-xs text-amber-300">The inventory reached its safety limit and may be incomplete.</p>{/if}
				</section>

				<div class="mt-6 flex items-start gap-2 text-xs text-neutral-600"><CircleHelp class="mt-0.5 size-3.5 shrink-0" /><p>Managed connections, tool catalogs, attachment policies, and built-in Loom MCP are not available in this inventory phase. They require a maintained MCP SDK and explicit process/network approval.</p></div>
				<div class="mt-8"><Button href={settingsHref("/settings", page.url.searchParams.get("returnTo"))} variant="outline" size="sm"><ChevronLeft class="size-4" />Settings</Button></div>
			</div>
		</main>
	</div>
</div>
