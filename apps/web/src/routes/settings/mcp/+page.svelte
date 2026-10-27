<script lang="ts">
import {
	CircleHelp,
	Cloud,
	Folder,
	Globe,
	MessageSquareText,
	RefreshCw,
	ShieldAlert,
	Terminal,
} from "@lucide/svelte";
import { onMount } from "svelte";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import SettingsSidebar from "$lib/components/settings/SettingsSidebar.svelte";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import * as Tabs from "$lib/components/ui/tabs";
import { Textarea } from "$lib/components/ui/textarea";
import {
	daemon,
	type ManagedMcpConnection,
	type ManagedMcpConnectionInput,
	type McpInventory,
	type Project,
} from "$lib/daemon";

let projects = $state<Project[]>([]);
let projectId = $state("all");
let inventory = $state<McpInventory | null>(null);
let loading = $state(true);
let refreshing = $state(false);
let search = $state("");
let activeTab = $state("discovered");
let loadError = $state("");
let managedConnections = $state<ManagedMcpConnection[]>([]);
let connectionDialogOpen = $state(false);
let connectionSaving = $state(false);
let connectionError = $state("");
let connectionName = $state("");
let connectionTransport = $state<"stdio" | "streamable-http">("stdio");
let connectionEndpoint = $state("");
let connectionCommand = $state("");
let connectionArgs = $state("[]");
let connectionCwd = $state("");
let connectionEnvRefs = $state("{}");
let connectionHeaderRefs = $state("{}");
let allowPrivateNetwork = $state(false);
let connectionActionId = $state("");
let connectionConfirmOpen = $state(false);
let pendingConnectionAction = $state<{
	connection: ManagedMcpConnection;
	action: "test" | "connect" | "remove";
} | null>(null);

const visibleServers = $derived(
	(inventory?.servers ?? []).filter((server) =>
		`${server.name} ${server.runtime} ${server.transport} ${server.source}`
			.toLowerCase()
			.includes(search.toLowerCase()),
	),
);
const configuredSources = $derived(
	(inventory?.sources ?? []).filter((source) => source.status === "available")
		.length,
);
const sourceIssues = $derived(
	(inventory?.sources ?? []).filter(
		(source) => source.status === "invalid" || source.status === "unavailable",
	).length,
);

const runtimeSupport = [
	{
		name: "OpenCode",
		discovery: "Supported",
		status: "Not observed",
		binding: "Not available",
		note: "Global and workspace config files are scanned read-only.",
	},
	{
		name: "Claude Code",
		discovery: "Supported",
		status: "Not observed",
		binding: "Not available",
		note: "Global and workspace config files are scanned read-only.",
	},
	{
		name: "Codex",
		discovery: "Supported",
		status: "Not observed",
		binding: "Not available",
		note: "Global and workspace TOML config is scanned read-only.",
	},
	{
		name: "Custom model",
		discovery: "Host runtime",
		status: "Not observed",
		binding: "Not available",
		note: "Tool support follows its actual host runtime; Loom cannot bind tools to arbitrary completion APIs.",
	},
	{
		name: "Agy",
		discovery: "Not verified",
		status: "Unsupported",
		binding: "Not available",
		note: "No Agy MCP discovery or injection adapter has been verified yet.",
	},
];

onMount(() => {
	// MCP settings is a global route. Strip legacy returnTo and any other
	// inherited query parameters so navigation always lands on the clean URL.
	if (window.location.search) {
		void goto("/settings/mcp", {
			replaceState: true,
			keepFocus: true,
			noScroll: true,
		});
	}
	void loadInventory();
});

async function loadInventory(isRefresh = false) {
	if (isRefresh) refreshing = true;
	else loading = true;
	loadError = "";
	try {
		const [nextProjects, nextInventory] = await Promise.all([
			projects.length ? Promise.resolve(projects) : daemon.listProjects(),
			daemon.getMcpInventory(projectId === "all" ? undefined : projectId),
		]);
		projects = nextProjects;
		inventory = nextInventory;
		await refreshConnections();
	} catch (reason) {
		loadError =
			reason instanceof Error
				? reason.message
				: "Unable to read MCP configuration";
		toast.error(loadError);
	} finally {
		loading = false;
		refreshing = false;
	}
}

async function refreshConnections() {
	const result = await daemon.listManagedMcpConnections();
	managedConnections = result.connections;
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

function resetConnectionForm() {
	connectionName = "";
	connectionTransport = "stdio";
	connectionEndpoint = "";
	connectionCommand = "";
	connectionArgs = "[]";
	connectionCwd = "";
	connectionEnvRefs = "{}";
	connectionHeaderRefs = "{}";
	allowPrivateNetwork = false;
	connectionError = "";
}

function parseObjectJson(
	value: string,
	fieldName: string,
): Record<string, string> {
	const parsed = JSON.parse(value) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`${fieldName} must be a JSON object.`);
	return parsed as Record<string, string>;
}

function connectionInput(): ManagedMcpConnectionInput {
	const args = JSON.parse(connectionArgs) as unknown;
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
		throw new Error("Arguments must be a JSON array of text values.");
	const input: ManagedMcpConnectionInput = {
		label: connectionName,
		transport: connectionTransport,
		args,
		envRefs: parseObjectJson(connectionEnvRefs, "Environment references"),
		headerEnvRefs: parseObjectJson(
			connectionHeaderRefs,
			"HTTP header references",
		),
	};
	if (connectionTransport === "stdio") {
		input.command = connectionCommand;
		if (connectionCwd.trim()) input.cwd = connectionCwd.trim();
	} else {
		input.endpoint = connectionEndpoint.trim();
	}
	return input;
}

async function saveConnection(event: SubmitEvent) {
	event.preventDefault();
	connectionError = "";
	connectionSaving = true;
	try {
		await daemon.createManagedMcpConnection(connectionInput());
		await refreshConnections();
		connectionDialogOpen = false;
		resetConnectionForm();
		toast.success("Connection saved. Loom has not started it.");
	} catch (reason) {
		connectionError =
			reason instanceof Error
				? reason.message
				: "Unable to save the connection.";
	} finally {
		connectionSaving = false;
	}
}

async function runConnectionAction(
	connection: ManagedMcpConnection,
	action: "test" | "connect",
) {
	connectionActionId = connection.id;
	try {
		if (action === "test") {
			const result = await daemon.testManagedMcpConnection(connection.id, {
				approved: true,
				allowPrivateNetwork,
			});
			toast.success(
				`Handshake succeeded · ${result.toolCount} tools discovered`,
			);
		} else {
			await daemon.connectManagedMcpConnection(connection.id, {
				approved: true,
				allowPrivateNetwork,
			});
			toast.success(
				"Loom connection is active. It is not yet bound to an agent.",
			);
		}
		await refreshConnections();
	} catch (reason) {
		toast.error(
			reason instanceof Error
				? reason.message
				: `Unable to ${action} connection.`,
		);
		await refreshConnections().catch(() => undefined);
	} finally {
		connectionActionId = "";
		allowPrivateNetwork = false;
	}
}

function requestConnectionConfirmation(
	connection: ManagedMcpConnection,
	action: "test" | "connect" | "remove",
) {
	pendingConnectionAction = { connection, action };
	connectionConfirmOpen = true;
}

async function confirmConnectionAction() {
	const pending = pendingConnectionAction;
	connectionConfirmOpen = false;
	pendingConnectionAction = null;
	if (!pending) return;
	if (pending.action === "remove") await removeConnection(pending.connection);
	else await runConnectionAction(pending.connection, pending.action);
}

async function disconnectConnection(connection: ManagedMcpConnection) {
	connectionActionId = connection.id;
	try {
		await daemon.disconnectManagedMcpConnection(connection.id);
		await refreshConnections();
		toast.success("Loom-owned session disconnected.");
	} catch (reason) {
		toast.error(
			reason instanceof Error
				? reason.message
				: "Unable to disconnect this connection.",
		);
	} finally {
		connectionActionId = "";
	}
}

async function removeConnection(connection: ManagedMcpConnection) {
	connectionActionId = connection.id;
	try {
		await daemon.deleteManagedMcpConnection(connection.id);
		await refreshConnections();
		toast.success("Loom connection removed.");
	} catch (reason) {
		toast.error(
			reason instanceof Error
				? reason.message
				: "Unable to remove this connection.",
		);
	} finally {
		connectionActionId = "";
	}
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
						<p
							class="mb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500"
						>
							Agents · Integrations
						</p>
						<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">
							MCP hub
						</h1>
						<p class="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">
							See which MCP definitions Loom can find, what is verified, and
							where runtime access is still unavailable.
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						disabled={refreshing}
						onclick={() => void loadInventory(true)}
					>
						<RefreshCw
							class={`size-4 ${refreshing ? "animate-spin" : ""}`}
						/>Refresh inventory
					</Button>
				</header>

				<div class="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
					<div class="rounded-xl border border-white/10 bg-white/[0.035] p-4">
						<p class="text-xs text-neutral-500">Discovered definitions</p>
						<p class="mt-2 text-2xl font-semibold">
							{loading ? "—" : (inventory?.servers.length ?? 0)}
						</p>
						<p class="mt-1 text-xs text-neutral-500">
							Native config entries found
						</p>
					</div>
					<div class="rounded-xl border border-white/10 bg-white/[0.035] p-4">
						<p class="text-xs text-neutral-500">Loom connections</p>
						<p class="mt-2 text-2xl font-semibold">
							{managedConnections.length}
						</p>
						<p class="mt-1 text-xs text-neutral-500">Saved by Loom</p>
					</div>
					<div class="rounded-xl border border-white/10 bg-white/[0.035] p-4">
						<p class="text-xs text-neutral-500">Observed sessions</p>
						<p class="mt-2 text-2xl font-semibold">
							{managedConnections.filter(
								(connection) => connection.status === "connected",
							).length}
						</p>
						<p class="mt-1 text-xs text-neutral-500">
							Live Loom-owned sessions only
						</p>
					</div>
					<div class="rounded-xl border border-white/10 bg-white/[0.035] p-4">
						<p class="text-xs text-neutral-500">Available agent bindings</p>
						<p class="mt-2 text-2xl font-semibold">0</p>
						<p class="mt-1 text-xs text-neutral-500">
							No verified runtime injection adapter
						</p>
					</div>
				</div>

				<div
					class="mb-5 flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4"
				>
					<div class="w-full sm:max-w-xs">
						<p
							class="mb-1.5 text-[10px] uppercase tracking-wide text-neutral-500"
						>
							Workspace configuration
						</p>
						<Select.Root
							type="single"
							value={projectId}
							onValueChange={chooseProject}
						>
							<Select.Trigger class="h-9 w-full text-sm"
								><Select.Value /></Select.Trigger
							>
							<Select.Content>
								<Select.Item value="all"
									>User / global configuration</Select.Item
								>
								{#each projects as project}<Select.Item value={project.id}
										>{project.name}</Select.Item
									>{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="text-right text-xs text-neutral-500">
						<p>
							{configuredSources} of {inventory?.sources.length ?? "—"} config sources
							read
						</p>
						<p class="mt-1">
							Last scan {inventory
								? new Date(inventory.generatedAt).toLocaleString()
								: "—"}
						</p>
					</div>
				</div>

				{#if sourceIssues > 0}
					<div
						class="mb-5 flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-4 text-sm text-neutral-300"
					>
						<ShieldAlert class="mt-0.5 size-4 shrink-0 text-amber-300" />
						<p>
							{sourceIssues} configuration source{sourceIssues === 1
								? " has"
								: "s have"} an issue. Loom keeps the source visible and does not treat
							a failed read as an empty configuration.
						</p>
					</div>
				{/if}
				{#if loadError}
					<div
						class="mb-5 flex items-start gap-3 rounded-xl border border-red-400/20 bg-red-400/[0.04] p-4 text-sm text-red-200"
					>
						<ShieldAlert class="mt-0.5 size-4 shrink-0" />
						<p>{loadError}</p>
					</div>
				{/if}

				<Tabs.Root bind:value={activeTab}>
					<Tabs.List
						class="mb-5 h-auto w-full justify-start gap-1 rounded-xl border border-white/10 bg-white/[0.025] p-1 sm:w-fit"
					>
						<Tabs.Trigger
							value="connections"
							class="rounded-lg px-3 py-2 text-xs data-[state=active]:bg-white/[0.1] data-[state=active]:text-white"
							>Connections</Tabs.Trigger
						>
						<Tabs.Trigger
							value="discovered"
							class="rounded-lg px-3 py-2 text-xs data-[state=active]:bg-white/[0.1] data-[state=active]:text-white"
							>Discovered</Tabs.Trigger
						>
						<Tabs.Trigger
							value="access"
							class="rounded-lg px-3 py-2 text-xs data-[state=active]:bg-white/[0.1] data-[state=active]:text-white"
							>Access &amp; routing</Tabs.Trigger
						>
					</Tabs.List>

					<Tabs.Content
						value="connections"
						class="mt-0 focus-visible:outline-none"
					>
						<section
							class="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]"
						>
							<div
								class="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 p-5 sm:p-6"
							>
								<div class="flex items-start gap-3">
									<div
										class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-neutral-300"
									>
										<Cloud class="size-5" />
									</div>
									<div>
										<h2 class="text-sm font-semibold">Managed by Loom</h2>
										<p
											class="mt-1 max-w-2xl text-sm leading-6 text-neutral-500"
										>
											Connections here are owned by Loom and kept separate from
											native runtime configuration.
										</p>
									</div>
								</div>
								<Button
									size="sm"
									onclick={() => {
										resetConnectionForm();
										connectionDialogOpen = true;
									}}>Add server</Button
								>
							</div>
							<div
								class="flex items-start gap-3 border-b border-white/10 bg-sky-400/[0.035] p-4 text-xs leading-5 text-neutral-400"
							>
								<ShieldAlert class="mt-0.5 size-4 shrink-0 text-sky-300" />
								<p>
									Saving a definition does not start it. Test and Connect are
									separate actions and require confirmation. Environment secrets
									are referenced by variable name; Loom never stores or returns
									their values. Connected tools are not yet available to agents
									or through a Loom gateway.
								</p>
							</div>
							<div
								class="flex items-start gap-3 border-b border-white/10 p-4 text-xs leading-5 text-amber-200"
							>
								<input
									id="mcp-private-network"
									type="checkbox"
									bind:checked={allowPrivateNetwork}
									class="mt-1 size-4 accent-amber-400"
								/>
								<label for="mcp-private-network"
									>Allow connections to private or local network addresses.
									Enable only for a server you trust; this applies to the next
									Test or Connect action.</label
								>
							</div>
							{#if managedConnections.length === 0}
								<div class="p-8 text-center">
									<Cloud class="mx-auto size-6 text-neutral-600" />
									<p class="mt-3 text-sm font-medium">
										No Loom connections yet
									</p>
									<p class="mt-1 text-xs text-neutral-500">
										Add a stdio or Streamable HTTP server. Native definitions
										stay in the Discovered tab.
									</p>
									<Button
										class="mt-4"
										size="sm"
										onclick={() => {
											resetConnectionForm();
											connectionDialogOpen = true;
										}}>Add your first server</Button
									>
								</div>
							{:else}
								<div class="divide-y divide-white/[0.08]">
									{#each managedConnections as connection (connection.id)}
										<article class="p-4 sm:p-5">
											<div class="flex flex-wrap items-start gap-3">
												<div
													class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.07] text-neutral-300"
												>
													{#if connection.transport === "stdio"}<Terminal
															class="size-4"
														/>{:else}<Globe class="size-4" />{/if}
												</div>
												<div class="min-w-0 flex-1">
													<div class="flex flex-wrap items-center gap-2">
														<h3 class="text-sm font-semibold">
															{connection.label}
														</h3>
														<span
															class="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-neutral-400"
															>{connection.transport}</span
														><span
															class={`rounded-full border px-2 py-0.5 text-[10px] ${connection.status === "connected" ? "border-emerald-400/20 text-emerald-300" : connection.status === "error" ? "border-red-400/20 text-red-300" : "border-white/10 text-neutral-400"}`}
															>{connection.status.replaceAll("_", " ")}</span
														>
													</div>
													<p class="mt-1 text-xs text-neutral-500">
														{connection.transport === "stdio"
															? `Executable · ${connection.command ?? "unknown"} · ${connection.argumentCount} arguments`
															: `Endpoint host · ${connection.endpointHost ?? "unknown"}`}
													</p>
													{#if connection.environmentReferenceNames.length || connection.headerReferences.length}<p
															class="mt-1 text-xs text-neutral-500"
														>
															Credential references · {connection
																.environmentReferenceNames.length +
																connection.headerReferences.length} environment variable
															name(s)
														</p>{/if}{#if connection.lastError}<p
															class="mt-2 text-xs text-red-300"
														>
															{connection.lastError}
														</p>{/if}
												</div>
												<div class="flex flex-wrap gap-2">
													<Button
														variant="outline"
														size="sm"
														disabled={!!connectionActionId}
														onclick={() =>
															requestConnectionConfirmation(connection, "test")}
														>Test</Button
													>
													{#if connection.status === "connected"}<Button
															variant="outline"
															size="sm"
															disabled={!!connectionActionId}
															onclick={() =>
																void disconnectConnection(connection)}
															>Disconnect</Button
														>{:else}<Button
															size="sm"
															disabled={!!connectionActionId}
															onclick={() =>
																requestConnectionConfirmation(
																	connection,
																	"connect",
																)}>Connect</Button
														>{/if}
													<Button
														variant="ghost"
														size="sm"
														class="text-red-300 hover:text-red-200"
														disabled={!!connectionActionId}
														onclick={() =>
															requestConnectionConfirmation(
																connection,
																"remove",
															)}>Remove</Button
													>
												</div>
											</div>
											{#if connection.toolCount > 0}<details
													class="mt-4 rounded-lg border border-white/10 bg-black/20"
												>
													<summary
														class="cursor-pointer px-3 py-2 text-xs text-neutral-300"
														>Verified tool catalog · {connection.toolCount} tools</summary
													>
													<ul class="divide-y divide-white/5">
														{#each connection.tools as tool (tool.name)}<li
																class="px-3 py-2"
															>
																<p class="font-mono text-xs text-neutral-200">
																	{tool.name}
																</p>
																{#if tool.description}<p
																		class="mt-1 text-xs leading-5 text-neutral-500"
																	>
																		{tool.description}
																	</p>{/if}
															</li>{/each}
													</ul>
												</details>{:else if connection.lastTestedAt}<p
													class="mt-3 text-xs text-neutral-500"
												>
													Tested {new Date(
														connection.lastTestedAt,
													).toLocaleString()} · no tools were returned
												</p>{/if}
										</article>
									{/each}
								</div>
							{/if}
						</section>
					</Tabs.Content>

					<Tabs.Content
						value="discovered"
						class="mt-0 focus-visible:outline-none"
					>
						<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
							<div>
								<h2 class="text-sm font-semibold">Native definitions</h2>
								<p class="mt-1 text-xs text-neutral-500">
									Found in runtime configuration; this does not imply a live
									connection.
								</p>
							</div>
							<input
								bind:value={search}
								placeholder="Filter definitions…"
								aria-label="Filter definitions"
								class="h-9 w-full rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm outline-none placeholder:text-neutral-600 focus:border-white/20 sm:w-56"
							/>
						</div>
						<div
							class="mb-4 flex items-start gap-3 rounded-xl border border-sky-400/15 bg-sky-400/[0.04] p-4 text-sm text-neutral-400"
						>
							<ShieldAlert class="mt-0.5 size-4 shrink-0 text-sky-300" />
							<p>
								Refresh inventory is read-only. It does not launch processes,
								contact servers, adopt definitions, or read secret values.
								Native configuration remains owned by its source runtime.
							</p>
						</div>
						<div
							class="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]"
						>
							{#if loading}
								<p class="p-5 text-sm text-neutral-500">
									Reading supported configuration files…
								</p>
							{:else if visibleServers.length === 0}
								<div class="p-8 text-center">
									<MessageSquareText class="mx-auto size-6 text-neutral-600" />
									<p class="mt-3 text-sm font-medium">
										{search
											? "No matching definitions"
											: "No definitions found"}
									</p>
									<p class="mt-1 text-xs text-neutral-500">
										Only the documented configuration locations listed below
										were scanned.
									</p>
								</div>
							{:else}
								{#each visibleServers as server (server.id)}
									<article
										class="border-b border-white/[0.08] p-4 last:border-0 sm:p-5"
									>
										<div class="flex flex-wrap items-start gap-3">
											<div
												class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.07] text-neutral-300"
											>
												{#if server.transport === "stdio"}<Terminal
														class="size-4"
													/>{:else}<Globe class="size-4" />{/if}
											</div>
											<div class="min-w-0 flex-1">
												<div class="flex flex-wrap items-center gap-2">
													<h3 class="truncate text-sm font-semibold">
														{server.name}
													</h3>
													<span
														class="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-neutral-400"
														>{server.runtime}</span
													><span
														class="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-neutral-400"
														>{server.transport}</span
													>
												</div>
												<p class="mt-1 text-xs text-neutral-500">
													{scopeLabel(server.scope)} · {server.source} · native /
													externally managed
												</p>
											</div>
											<span
												class="rounded-full border border-amber-400/20 bg-amber-400/[0.05] px-2 py-1 text-[10px] text-amber-300"
												>Not observed</span
											>
										</div>
										<div
											class="mt-4 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2"
										>
											<p class="text-neutral-500">
												Enabled in source <span class="ml-1 text-neutral-300"
													>{server.enabled === null
														? "Not specified"
														: server.enabled
															? "Yes"
															: "No"}</span
												>
											</p>
											{#if server.command}<p class="text-neutral-500">
													Executable <code class="ml-1 text-neutral-300"
														>{server.command}</code
													>
													<span class="text-neutral-600"
														>({server.argumentCount} arguments; values hidden)</span
													>
												</p>{/if}
											{#if server.endpointHost}<p class="text-neutral-500">
													Endpoint host <code class="ml-1 text-neutral-300"
														>{server.endpointHost}</code
													>
												</p>{/if}
											{#if server.environmentVariableNames.length}<p
													class="text-neutral-500"
												>
													Environment keys <span class="ml-1 text-neutral-300"
														>{server.environmentVariableNames.join(", ")}</span
													>
												</p>{/if}
											{#if server.headerNames.length}<p
													class="text-neutral-500"
												>
													Header names <span class="ml-1 text-neutral-300"
														>{server.headerNames.join(", ")}</span
													>
												</p>{/if}
										</div>
									</article>
								{/each}
							{/if}
						</div>

						<section class="mt-6">
							<div class="mb-3">
								<h2 class="text-sm font-semibold">Configuration sources</h2>
								<p class="mt-1 text-xs text-neutral-500">
									This scan covers standard file locations only; other runtime
									or managed configuration may not appear.
								</p>
							</div>
							<div
								class="divide-y divide-white/[0.08] rounded-2xl border border-white/10 bg-white/[0.025]"
							>
								{#each inventory?.sources ?? [] as source (source.id)}
									<div class="flex flex-wrap items-center gap-3 p-4">
										<div
											class="flex size-8 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-400"
										>
											{#if source.scope === "global"}<Globe
													class="size-4"
												/>{:else}<Folder class="size-4" />{/if}
										</div>
										<div class="min-w-0 flex-1">
											<p class="truncate text-xs font-medium">{source.file}</p>
											<p class="mt-1 text-[11px] text-neutral-500">
												{source.runtime} · {scopeLabel(source.scope)}
											</p>
											{#if source.issue}<p class="mt-1 text-xs text-amber-300">
													{source.issue}
												</p>{/if}
										</div>
										<span
											class={`rounded-full border px-2 py-1 text-[10px] ${source.status === "available" ? "border-emerald-400/20 text-emerald-300" : source.status === "invalid" || source.status === "unavailable" ? "border-amber-400/20 text-amber-300" : "border-white/10 text-neutral-500"}`}
											>{sourceStatus(source.status)}</span
										>
									</div>
								{:else}<p class="p-4 text-sm text-neutral-500">
										No sources loaded.
									</p>{/each}
							</div>
							{#if inventory?.coverage.truncated}<p
									class="mt-2 text-xs text-amber-300"
								>
									The inventory reached its safety limit and may be incomplete.
								</p>{/if}
						</section>
					</Tabs.Content>

					<Tabs.Content value="access" class="mt-0 focus-visible:outline-none">
						<section
							class="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]"
						>
							<div class="border-b border-white/10 p-5">
								<h2 class="text-sm font-semibold">Runtime capability status</h2>
								<p class="mt-1 text-xs leading-5 text-neutral-500">
									A runtime is listed as supported only for capabilities
									verified in Loom. Discovery, live status, and tool access are
									separate capabilities.
								</p>
							</div>
							<div class="overflow-x-auto">
								<table class="w-full min-w-[760px] text-left text-xs">
									<thead
										class="border-b border-white/5 bg-white/[0.02] text-[10px] uppercase tracking-wide text-neutral-500"
										><tr
											><th class="px-5 py-3 font-medium">Runtime</th><th
												class="px-5 py-3 font-medium">Definition discovery</th
											><th class="px-5 py-3 font-medium">Native status</th><th
												class="px-5 py-3 font-medium">Runtime binding</th
											></tr
										></thead
									>
									<tbody
										>{#each runtimeSupport as runtime}<tr
												class="border-b border-white/5 last:border-0"
												><td class="px-5 py-4 font-medium text-neutral-200"
													>{runtime.name}
													<p class="mt-1 font-normal text-neutral-500">
														{runtime.note}
													</p></td
												><td class="px-5 py-4 text-neutral-300"
													>{runtime.discovery}</td
												><td class="px-5 py-4 text-neutral-300"
													>{runtime.status}</td
												><td class="px-5 py-4 text-neutral-300"
													>{runtime.binding}</td
												></tr
											>{/each}</tbody
									>
								</table>
							</div>
							<div
								class="flex items-start gap-3 border-t border-white/10 p-5 text-xs leading-5 text-neutral-500"
							>
								<CircleHelp class="mt-0.5 size-4 shrink-0" />
								<p>
									Agent-specific access, native-versus-Loom routing, and a
									downstream MCP gateway are not active in this build. A
									discovered definition is never treated as authorization.
								</p>
							</div>
						</section>
					</Tabs.Content>
				</Tabs.Root>

				<div class="mt-8">
					<Button href="/settings" variant="outline" size="sm"
						><Folder class="size-4" />Settings</Button
					>
				</div>
			</div>
		</main>
	</div>
</div>

<Dialog.Root bind:open={connectionDialogOpen}>
	<Dialog.Content class="max-h-[90svh] max-w-2xl overflow-y-auto">
		<Dialog.Header>
			<Dialog.Title>Add an MCP server</Dialog.Title>
			<Dialog.Description
				>Save configuration first. Loom starts or contacts the server only after
				you choose Test or Connect.</Dialog.Description
			>
		</Dialog.Header>
		<form class="mt-5 flex flex-col gap-4" onsubmit={saveConnection}>
			<label class="flex flex-col gap-1.5 text-sm"
				><span class="font-medium">Connection name</span><Input
					bind:value={connectionName}
					maxlength={120}
					required
					placeholder="e.g. Context7"
				/></label
			>
			<div class="flex flex-col gap-1.5 text-sm">
				<span class="font-medium">Transport</span><Select.Root
					type="single"
					value={connectionTransport}
					onValueChange={(value) => {
						if (value === "stdio" || value === "streamable-http")
							connectionTransport = value;
					}}
					><Select.Trigger><Select.Value /></Select.Trigger><Select.Content
						><Select.Item value="stdio">stdio · local process</Select.Item
						><Select.Item value="streamable-http"
							>Streamable HTTP · remote or local endpoint</Select.Item
						></Select.Content
					></Select.Root
				>
			</div>
			{#if connectionTransport === "stdio"}
				<label class="flex flex-col gap-1.5 text-sm"
					><span class="font-medium">Executable</span><Input
						bind:value={connectionCommand}
						required
						placeholder="npx"
					/></label
				>
				<label class="flex flex-col gap-1.5 text-sm"
					><span class="font-medium">Arguments · JSON array</span><Textarea
						bind:value={connectionArgs}
						rows={3}
						class="font-mono text-xs"
						placeholder={'["-y", "@example/mcp-server"]'}
					/><span class="text-xs leading-5 text-neutral-500"
						>Do not put credentials in arguments. Use the environment mapping
						below so secret values stay out of Loom’s saved configuration.</span
					></label
				>
				<label class="flex flex-col gap-1.5 text-sm"
					><span class="font-medium"
						>Working directory · optional absolute path</span
					><Input
						bind:value={connectionCwd}
						placeholder="/path/to/project"
					/></label
				>
				<label class="flex flex-col gap-1.5 text-sm"
					><span class="font-medium"
						>Environment mapping · child variable name to Loom environment
						variable name</span
					><Textarea
						bind:value={connectionEnvRefs}
						rows={3}
						class="font-mono text-xs"
						placeholder={JSON.stringify({ API_TOKEN: "CONTEXT7_API_KEY" })}
					/></label
				>
			{:else}
				<label class="flex flex-col gap-1.5 text-sm"
					><span class="font-medium">Server URL</span><Input
						bind:value={connectionEndpoint}
						type="url"
						required
						placeholder="https://mcp.example.com/mcp"
					/></label
				>
				<label class="flex flex-col gap-1.5 text-sm"
					><span class="font-medium"
						>HTTP header mapping · header name to Loom environment variable name</span
					><Textarea
						bind:value={connectionHeaderRefs}
						rows={3}
						class="font-mono text-xs"
						placeholder={JSON.stringify({ Authorization: "CONTEXT7_API_KEY" })}
					/></label
				>
				<p class="text-xs leading-5 text-neutral-500">
					Use environment variables already available to the Loom daemon. Loom
					stores only their names. Embedded URL credentials, query parameters,
					and redirects are rejected.
				</p>
			{/if}
			{#if connectionError}<p
					role="alert"
					class="rounded-lg border border-red-400/20 bg-red-400/[0.04] p-3 text-sm text-red-200"
				>
					{connectionError}
				</p>{/if}
			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					onclick={() => {
						connectionDialogOpen = false;
					}}>Cancel</Button
				>
				<Button type="submit" disabled={connectionSaving}
					>{connectionSaving ? "Saving…" : "Save connection"}</Button
				>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={connectionConfirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{pendingConnectionAction?.action === "remove"
					? "Remove MCP connection?"
					: pendingConnectionAction?.action === "test"
						? "Test MCP connection?"
						: "Connect MCP server?"}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{#if pendingConnectionAction?.action === "remove"}
					Remove “{pendingConnectionAction.connection.label}” from Loom and stop
					its Loom-owned session if active. Native runtime configuration will
					not change.
				{:else}
					Loom will {pendingConnectionAction?.connection.transport === "stdio"
						? `start ${pendingConnectionAction.connection.command ?? "the configured executable"}`
						: `contact ${pendingConnectionAction?.connection.endpointHost ?? "the configured server"}`}
					to {pendingConnectionAction?.action === "test"
						? "test the handshake and list tools, then disconnect"
						: "start a Loom-owned session"}.{allowPrivateNetwork
						? " This may access private or local network addresses."
						: ""}
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				variant={pendingConnectionAction?.action === "remove"
					? "destructive"
					: "default"}
				onclick={() => void confirmConnectionAction()}
			>
				{pendingConnectionAction?.action === "remove"
					? "Remove connection"
					: pendingConnectionAction?.action === "test"
						? "Test connection"
						: "Start connection"}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
