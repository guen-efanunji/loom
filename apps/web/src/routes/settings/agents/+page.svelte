<script lang="ts">
import { Bot, Check, ChevronDown, Plus, Save, Trash2, X } from "@lucide/svelte";
import { onMount } from "svelte";
import { toast } from "svelte-sonner";
import SettingsSidebar from "$lib/components/settings/SettingsSidebar.svelte";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
import { Button } from "$lib/components/ui/button";
import * as Command from "$lib/components/ui/command/index.js";
import { Input } from "$lib/components/ui/input";
import * as Popover from "$lib/components/ui/popover/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { daemon } from "$lib/daemon";

type Skill = {
	id?: string;
	name: string;
	source: "custom" | "builtin";
	instructions: string;
	enabled: boolean;
	allowChat: boolean;
	allowCanvas: boolean;
	allowKanban: boolean;
	canReadFiles: boolean;
	canWriteFiles: boolean;
	canRunTests: boolean;
	canUseNetwork: boolean;
};
type Agent = {
	id: string;
	label: string;
	role: string;
	roleDescription?: string | null;
	provider: string;
	modelId: string | null;
	status: string;
	projectId?: string | null;
	systemInstructions?: string;
	allowChat: boolean;
	allowCanvas: boolean;
	allowKanban: boolean;
	approvalPolicy?: string;
	executionMode?: string;
	maxRunDurationMinutes?: number;
	maxRetries?: number;
	maxTaskHops?: number;
	fallbackEnabled?: boolean;
	fallbackProvider?: string | null;
	fallbackModelId?: string | null;
	effort?: string | null;
	skills: Skill[];
};
const builtinRoles = ["uiux", "frontend", "backend", "fullstack", "qa", "pm"];
const roleNames: Record<string, string> = {
	uiux: "UI/UX Designer",
	frontend: "Frontend Developer",
	backend: "Backend Developer",
	fullstack: "Fullstack Developer",
	qa: "QA Engineer",
	pm: "Project Manager",
	custom: "Custom Role",
};
const effortNames: Record<string, string> = {
	"": "Default",
	low: "Low",
	medium: "Medium",
	high: "High",
	max: "Maximum",
};
const presets: Record<string, string[]> = {
	uiux: [
		"design-screen",
		"design-refine",
		"design-system-fidelity",
		"responsive-layout",
		"accessibility-review",
	],
	frontend: [
		"inspect-frontend",
		"implement-ui",
		"responsive-implementation",
		"component-testing",
		"accessibility-check",
	],
	backend: [
		"inspect-backend",
		"implement-api",
		"database-change",
		"auth-and-validation",
		"backend-testing",
	],
	fullstack: [
		"inspect-project",
		"implement-frontend",
		"implement-backend",
		"integration-testing",
		"migration-review",
	],
	qa: [
		"inspect-test-suite",
		"write-tests",
		"run-tests",
		"analyze-failures",
		"regression-report",
	],
	pm: [
		"requirement-analysis",
		"task-breakdown",
		"acceptance-criteria",
		"dependency-planning",
		"kanban-planning",
	],
};
let agents = $state<Agent[]>([]);
let runHistory = $state<Array<{ agentId: string; createdAt: string | number }>>(
	[],
);
let providers = $state<Awaited<ReturnType<typeof daemon.listProviders>>>([]);
let models = $state<Awaited<ReturnType<typeof daemon.listModels>>>([]);
let projects = $state<Awaited<ReturnType<typeof daemon.listProjects>>>([]);
let promptPresets = $state<Record<string, string>>({});
let projectId = $state("");
let selectedProvider = $state("");
let selectedModel = $state("");
let search = $state("");
let loading = $state(true);
let saving = $state(false);
let editingId = $state("");
let label = $state("");
let role = $state("frontend");
let roleDescription = $state("");
let instructions = $state("");
let approvalPolicy = $state("ask_before_write");
let executionMode = $state("on_demand");
let allowChat = $state(true);
let allowCanvas = $state(false);
let allowKanban = $state(true);
let maxRunDurationMinutes = $state("30");
let maxRetries = $state("1");
let maxTaskHops = $state("3");
let skills = $state<Skill[]>([]);
let showForm = $state(false);
let fallbackEnabled = $state(false);
let fallbackProvider = $state("");
let fallbackModelId = $state("");
let effort = $state("");
let error = $state("");
let sidebarSearch = $state("");
let roleOpen = $state(false);
let roleQuery = $state("");
let modelOpen = $state(false);
let modelQuery = $state("");
let fallbackAgentId = $state("");
let userRoles = $state<string[]>([]);

const connected = $derived(
	providers.filter((p) => p.status === "connected" && p.authenticated),
);
const providerModels = $derived(
	models.filter((m) => m.providerId === selectedProvider),
);
const roleOptions = $derived(
	[
		...new Set([
			...builtinRoles,
			...userRoles,
			...agents.map((agent) => agent.role),
		]),
	].sort(
		(a, b) =>
			(builtinRoles.includes(b) ? 0 : 1) - (builtinRoles.includes(a) ? 0 : 1) ||
			a.localeCompare(b),
	),
);
const selectedRoleLabel = $derived(roleNames[role] ?? role);
const rolePrompt = (value: string) =>
	promptPresets[value.toLowerCase()] ?? promptPresets.custom ?? "";
const selectedModelLabel = $derived(
	selectedModel
		? (providerModels.find(
				(model) =>
					String(model.metadata?.modelId ?? model.name) === selectedModel,
			)?.displayName ?? selectedModel)
		: "Use provider default",
);
const selectedSupportsEffort = $derived(
	providerModels
		.find((m) => String(m.metadata?.modelId ?? m.name) === selectedModel)
		?.capabilities.includes("reasoning") ?? false,
);
const visibleAgents = $derived(
	agents.filter((a) =>
		`${a.label} ${a.role} ${a.provider}`
			.toLowerCase()
			.includes(search.toLowerCase()),
	),
);

onMount(async () => {
	try {
		[providers, models, projects] = await Promise.all([
			daemon.listProviders(),
			daemon.listModels(),
			daemon.listProjects(),
		]);
		try {
			promptPresets = await daemon.getAgentPromptPresets();
		} catch {
			// Keep the prompt field editable if bundled prompt files are unavailable.
		}
		projectId = new URLSearchParams(location.search).get("projectId") ?? "";
		selectedProvider = connected[0]?.providerId ?? "";
		await reload();
	} catch (e) {
		error = e instanceof Error ? e.message : "Unable to load custom agents";
	} finally {
		loading = false;
	}
});

async function reload() {
	[agents, runHistory] = await Promise.all([
		daemon.listCustomAgents(projectId || undefined) as Promise<Agent[]>,
		daemon.listCustomAgentRuns(projectId || undefined),
	]);
}
function resetForm() {
	editingId = "";
	label = "";
	role = "frontend";
	roleDescription = "";
	instructions = rolePrompt(role);
	approvalPolicy = "ask_before_write";
	executionMode = "on_demand";
	allowChat = true;
	allowCanvas = false;
	allowKanban = true;
	maxRunDurationMinutes = "30";
	maxRetries = "1";
	maxTaskHops = "3";
	skills = [];
	fallbackEnabled = false;
	fallbackProvider = "";
	fallbackModelId = "";
	fallbackAgentId = "";
	effort = "";
	selectedProvider = connected[0]?.providerId ?? "";
	selectedModel = "";
	roleQuery = "";
	modelQuery = "";
	showForm = true;
	error = "";
	applyRolePreset();
}
function editAgent(agent: Agent) {
	editingId = agent.id;
	label = agent.label;
	role = agent.role;
	if (!builtinRoles.includes(agent.role) && !userRoles.includes(agent.role))
		userRoles = [...userRoles, agent.role];
	roleDescription = agent.roleDescription ?? "";
	instructions = agent.systemInstructions || rolePrompt(agent.role);
	approvalPolicy = agent.approvalPolicy ?? "ask_before_write";
	executionMode = agent.executionMode ?? "on_demand";
	allowChat = agent.allowChat;
	allowCanvas = agent.allowCanvas;
	allowKanban = agent.allowKanban;
	maxRunDurationMinutes = String(agent.maxRunDurationMinutes ?? 30);
	maxRetries = String(agent.maxRetries ?? 1);
	maxTaskHops = String(agent.maxTaskHops ?? 3);
	skills = (agent.skills ?? []).map((s) => ({ ...s }));
	fallbackEnabled = agent.fallbackEnabled ?? false;
	fallbackProvider = agent.fallbackProvider ?? "";
	fallbackModelId = agent.fallbackModelId ?? "";
	fallbackAgentId =
		agents.find(
			(candidate) =>
				candidate.id !== agent.id &&
				candidate.provider === agent.fallbackProvider &&
				candidate.modelId === agent.fallbackModelId,
		)?.id ?? "";
	effort = agent.effort ?? "";
	selectedProvider = agent.provider;
	selectedModel = agent.modelId ?? "";
	showForm = true;
	error = "";
}
function applyRolePreset() {
	if (role === "uiux") {
		allowChat = true;
		allowCanvas = true;
		allowKanban = true;
		approvalPolicy = "read_only";
	}
	if (["frontend", "backend", "fullstack", "qa", "pm"].includes(role)) {
		allowChat = true;
		allowCanvas = false;
		allowKanban = true;
	}
	if (role === "pm") approvalPolicy = "read_only";
	const customSkills = skills.filter((skill) => skill.source === "custom");
	skills = [
		...(presets[role] ?? []).map((name) => ({
			name,
			source: "builtin" as const,
			instructions: `Follow the ${name} procedure for relevant tasks.`,
			enabled: true,
			allowChat,
			allowCanvas: role === "uiux",
			allowKanban,
			canReadFiles: !["uiux", "pm"].includes(role),
			canWriteFiles: ["frontend", "backend", "fullstack"].includes(role),
			canRunTests: ["frontend", "backend", "fullstack", "qa"].includes(role),
			canUseNetwork: false,
		})),
		...(presets[role]
			? customSkills
			: [
					{
						name: `${role} assistant`,
						source: "builtin" as const,
						instructions: `Act as a ${role} specialist. Follow the user's requested scope and explain your work clearly.`,
						enabled: true,
						allowChat: true,
						allowCanvas: false,
						allowKanban: true,
						canReadFiles: true,
						canWriteFiles: false,
						canRunTests: false,
						canUseNetwork: false,
					},
				]),
	];
}
function chooseRole(value: string) {
	const next = value.trim();
	if (next.length < 2 || next.length > 60) return;
	role = next;
	if (!builtinRoles.includes(next) && !userRoles.includes(next))
		userRoles = [...userRoles, next];
	instructions = rolePrompt(next);
	roleDescription = "";
	roleQuery = "";
	roleOpen = false;
	applyRolePreset();
}
function addTypedRole(event: KeyboardEvent) {
	if (event.key !== "Enter") return;
	const next = roleQuery.trim();
	if (!next) return;
	event.preventDefault();
	chooseRole(next);
}
function chooseModel(value: string) {
	selectedModel = value === "__default" ? "" : value;
	modelQuery = "";
	modelOpen = false;
}
function addTypedModel(event: KeyboardEvent) {
	if (event.key !== "Enter") return;
	const next = modelQuery.trim();
	if (!next) return;
	event.preventDefault();
	chooseModel(next);
}
function chooseFallbackAgent(id: string) {
	fallbackAgentId = id;
	const agent = agents.find((item) => item.id === id);
	fallbackEnabled = !!agent;
	fallbackProvider = agent?.provider ?? "";
	fallbackModelId = agent?.modelId ?? "";
}
async function saveAgent() {
	if (
		!label.trim() ||
		label.trim().length < 2 ||
		!selectedProvider ||
		(!allowChat && !allowCanvas && !allowKanban) ||
		!skills.some((s) => s.enabled)
	) {
		error =
			"Isi label, provider, minimal satu surface, dan aktifkan minimal satu skill.";
		return;
	}
	if (
		skills.length > 20 ||
		skills.reduce((n, s) => n + s.instructions.length, instructions.length) >
			24000
	) {
		error = "Maksimum 20 skill dan 24 KB instruksi per agent.";
		return;
	}
	if (
		allowCanvas &&
		skills.some((s) => s.enabled && s.allowCanvas && s.canWriteFiles)
	) {
		error = "Skill Canvas tidak boleh menulis file project.";
		return;
	}
	saving = true;
	error = "";
	const input = {
		projectId: projectId || null,
		label: label.trim(),
		role,
		roleDescription: roleDescription.trim() || undefined,
		provider: selectedProvider,
		modelId: selectedModel || null,
		effort: selectedSupportsEffort ? effort || null : null,
		systemInstructions: instructions,
		status: "active",
		executionMode,
		allowChat,
		allowCanvas,
		allowKanban,
		approvalPolicy,
		maxRunDurationMinutes: Number(maxRunDurationMinutes),
		maxRetries: Number(maxRetries),
		maxTaskHops: Number(maxTaskHops),
		fallbackEnabled,
		fallbackProvider: fallbackProvider || undefined,
		fallbackModelId: fallbackModelId || undefined,
		skills,
	};
	try {
		if (editingId) await daemon.updateCustomAgent(editingId, input);
		else await daemon.createCustomAgent(input);
		await reload();
		showForm = false;
		toast.success(editingId ? "Agent updated" : "Agent created");
	} catch (e) {
		error = e instanceof Error ? e.message : "Unable to save agent";
	} finally {
		saving = false;
	}
}
async function toggleAgent(agent: Agent) {
	try {
		await daemon.updateCustomAgent(agent.id, {
			...agent,
			status: agent.status === "active" ? "disabled" : "active",
			skills: agent.skills.map((s) => ({ ...s })),
		});
		await reload();
	} catch (e) {
		toast.error(e instanceof Error ? e.message : "Unable to update agent");
	}
}
async function deleteAgent(agent: Agent) {
	if (
		!confirm(
			`Delete ${agent.label}? Run history for this agent will also be removed.`,
		)
	)
		return;
	try {
		await daemon.deleteCustomAgent(agent.id);
		await reload();
		toast.success("Agent deleted");
	} catch (e) {
		toast.error(e instanceof Error ? e.message : "Unable to delete agent");
	}
}
function duplicateAgent(agent: Agent) {
	editAgent(agent);
	editingId = "";
	label = `${agent.label} copy`.slice(0, 60);
}
function lastUsed(agentId: string) {
	const run = runHistory.find((item) => item.agentId === agentId);
	if (!run) return "Never used";
	const time = new Date(run.createdAt).getTime();
	if (!Number.isFinite(time)) return "Recently used";
	const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
	return minutes < 1 ? "Used just now" : `Used ${minutes}m ago`;
}
</script>

<svelte:head><title>Agents · Loom</title></svelte:head>
<div class="min-h-svh bg-[#090909] text-neutral-100"><div class="mx-auto flex min-h-svh max-w-[1600px]"><SettingsSidebar active="agents" bind:search={sidebarSearch} /><main class="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:px-12 lg:py-10"><div class="mx-auto max-w-5xl">
	<div class="mb-8 flex flex-wrap items-start justify-between gap-4"><div><p class="mb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500">Settings · Agents</p><h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Agents</h1><p class="mt-2 max-w-2xl text-sm text-neutral-500">Create reusable workers for design, coding, planning, and testing. Agents only run when you explicitly call them.</p></div><Button onclick={resetForm}><Plus class="size-4" />Create agent</Button></div>
	{#if showForm}
	<AlertDialog.Root bind:open={showForm}>
		<AlertDialog.Content class="max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto rounded-xl border border-border bg-background p-0 text-foreground">
			<AlertDialog.Header class="relative border-b px-6 py-5 pr-14 text-left">
				<div class="space-y-1">
					<AlertDialog.Title>{editingId ? "Edit Agent" : "Add Agent"}</AlertDialog.Title>
					<AlertDialog.Description>Configure an AI agent for your workspace</AlertDialog.Description>
				</div>
				<Button variant="ghost" size="icon" class="absolute right-4 top-4 size-8 shrink-0 rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:ring-2" aria-label="Close dialog" onclick={() => showForm = false}><X class="size-4" /></Button>
			</AlertDialog.Header>
			<div class="space-y-4 px-6 py-5">
				<label class="block space-y-2 text-sm">
					<span>Agent Name</span>
					<Input bind:value={label} maxlength={60} placeholder="e.g., Code Reviewer Bot" />
				</label>
				<label class="block space-y-2 text-sm">
					<span>Role</span>
					<Popover.Root bind:open={roleOpen}>
						<Popover.Trigger class="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-left">
							<span class="truncate">{selectedRoleLabel || "Select a role…"}</span><ChevronDown class="size-4 opacity-60" />
						</Popover.Trigger>
						<Popover.Content class="w-[var(--bits-popover-anchor-width)] p-0" align="start">
							<Command.Root>
								<Command.Input bind:value={roleQuery} onkeydown={addTypedRole} placeholder="Search or type a role…" />
								<Command.List>
									<Command.Empty>Type a role and press Enter to add it.</Command.Empty>
									<Command.Group heading="Roles">
										{#each roleOptions.filter((value) => `${roleNames[value] ?? value} ${value}`.toLowerCase().includes(roleQuery.toLowerCase())) as value}
											<Command.Item value={`${roleNames[value] ?? value} ${value}`} onSelect={() => chooseRole(value)}>
												<span>{roleNames[value] ?? value}</span>{#if role === value}<Check class="ml-auto size-4" />{/if}
											</Command.Item>
										{/each}
										{#if roleQuery.trim().length >= 2 && !roleOptions.some((value) => value.toLowerCase() === roleQuery.trim().toLowerCase())}
											<Command.Item value={`add role ${roleQuery}`} onSelect={() => chooseRole(roleQuery)}>Add “{roleQuery.trim()}” role <span class="ml-auto text-xs text-muted-foreground">Enter</span></Command.Item>
										{/if}
									</Command.Group>
								</Command.List>
							</Command.Root>
						</Popover.Content>
					</Popover.Root>
				</label>
				<label class="block space-y-2 text-sm">
					<span>Provider</span>
					<Select.Root type="single" value={selectedProvider || "__none"} onValueChange={(value) => { selectedProvider = value === "__none" ? "" : value; selectedModel = ""; modelQuery = ""; }}>
						<Select.Trigger class="w-full">{connected.find((provider) => provider.providerId === selectedProvider)?.name ?? "Select a provider…"}</Select.Trigger>
						<Select.Content>
							<Select.Item value="__none">Select a provider…</Select.Item>
							{#each connected as provider}<Select.Item value={provider.providerId}>{provider.name}</Select.Item>{/each}
						</Select.Content>
					</Select.Root>
				</label>
				<label class="block space-y-2 text-sm">
					<span>Model</span>
					<Popover.Root bind:open={modelOpen}>
						<Popover.Trigger class="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-left" disabled={!selectedProvider}>
							<span class="truncate">{selectedProvider ? selectedModelLabel : "Select a provider first"}</span><ChevronDown class="size-4 opacity-60" />
						</Popover.Trigger>
						<Popover.Content class="w-[var(--bits-popover-anchor-width)] p-0" align="start">
							<Command.Root>
								<Command.Input bind:value={modelQuery} onkeydown={addTypedModel} placeholder="Search models or enter an alias…" />
								<Command.List>
									<Command.Empty>Enter a model alias and press Enter to use it.</Command.Empty>
									<Command.Group heading="Models">
										<Command.Item value="__default" onSelect={() => chooseModel("__default")}>Use provider default</Command.Item>
										{#each providerModels.filter((model) => `${model.displayName} ${model.metadata?.modelId ?? model.name}`.toLowerCase().includes(modelQuery.toLowerCase())) as model}
											<Command.Item value={`${model.displayName} ${String(model.metadata?.modelId ?? model.name)}`} onSelect={() => chooseModel(String(model.metadata?.modelId ?? model.name))}>
												<span>{model.displayName}<span class="ml-2 text-xs text-muted-foreground">{String(model.metadata?.modelId ?? model.name)}</span></span>
												{#if selectedModel === String(model.metadata?.modelId ?? model.name)}<Check class="ml-auto size-4" />{/if}
											</Command.Item>
										{/each}
										{#if modelQuery.trim() && !providerModels.some((model) => String(model.metadata?.modelId ?? model.name).toLowerCase() === modelQuery.trim().toLowerCase())}
											<Command.Item value={`alias ${modelQuery}`} onSelect={() => chooseModel(modelQuery)}>Use alias “{modelQuery.trim()}” <span class="ml-auto text-xs text-muted-foreground">Enter</span></Command.Item>
										{/if}
									</Command.Group>
								</Command.List>
							</Command.Root>
						</Popover.Content>
					</Popover.Root>
				</label>
				{#if selectedSupportsEffort}
					<label class="block space-y-2 text-sm">
						<span>Reasoning effort</span>
						<Select.Root type="single" value={effort || "__default"} onValueChange={(value) => effort = value === "__default" ? "" : value}>
						<Select.Trigger class="w-full">{effortNames[effort] ?? "Default"}</Select.Trigger>
							<Select.Content><Select.Item value="__default">Default</Select.Item><Select.Item value="low">Low</Select.Item><Select.Item value="medium">Medium</Select.Item><Select.Item value="high">High</Select.Item><Select.Item value="max">Maximum</Select.Item></Select.Content>
						</Select.Root>
					</label>
				{/if}
				{#if !connected.length}<p class="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">Connect a provider in <a class="underline" href="/settings/providers">Provider settings</a> before saving an agent.</p>{/if}
				<label class="block space-y-2 text-sm">
					<span class="font-medium">System Prompt <span class="font-normal text-muted-foreground">(Optional)</span></span>
					<textarea class="min-h-28 w-full rounded-md border border-input bg-background p-3 text-sm" bind:value={instructions} maxlength="24000" placeholder="Act as a code reviewer. Focus on…"></textarea>
					<span class="block text-xs text-muted-foreground">A built-in {roleNames[role] ?? role} starter prompt is prefilled. Edit or clear it to customize this agent.</span>
				</label>
				<label class="block space-y-2 text-sm">
					<span>Fallback Agent <span class="font-normal text-muted-foreground">(Optional)</span></span>
					<Select.Root type="single" value={fallbackAgentId || "__none"} onValueChange={(value) => chooseFallbackAgent(value === "__none" ? "" : value)}>
						<Select.Trigger class="w-full">{agents.find((agent) => agent.id === fallbackAgentId)?.label ?? "No fallback agent"}</Select.Trigger>
						<Select.Content>
							<Select.Item value="__none">No fallback agent</Select.Item>
							{#each agents.filter((agent) => agent.id !== editingId && agent.status === "active" && agent.provider !== selectedProvider) as agent}<Select.Item value={agent.id}>{agent.label} · {agent.provider} / {agent.modelId ?? "default"}</Select.Item>{/each}
						</Select.Content>
					</Select.Root>
					<p class="text-xs text-muted-foreground">If the primary provider reaches a limit, this agent can be used as a fallback.</p>
				</label>
				{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			</div>
			<AlertDialog.Footer class="border-t px-6 py-4">
				<Button variant="ghost" onclick={() => showForm = false}>Cancel</Button>
				<Button disabled={saving || !connected.length} onclick={() => void saveAgent()}><Save class="size-4" />{saving ? "Saving…" : editingId ? "Save changes" : "Create Agent"}</Button>
			</AlertDialog.Footer>
		</AlertDialog.Content>
	</AlertDialog.Root>
	{:else if loading}<p class="rounded-xl border border-white/10 p-6 text-sm text-neutral-500">Loading agents…</p>
	{:else if !visibleAgents.length}<section class="rounded-2xl border border-dashed border-white/15 px-6 py-14 text-center"><Bot class="mx-auto size-8 text-neutral-500" /><h2 class="mt-4 font-semibold">No agents yet</h2><p class="mx-auto mt-2 max-w-lg text-sm text-neutral-500">Create a reusable agent for UI/UX, frontend, backend, QA, project planning, or a workflow unique to your project.</p><Button class="mt-5" onclick={resetForm}><Plus class="size-4" />Create your first agent</Button></section>
	{:else}<div class="mb-4 flex flex-wrap items-center justify-between gap-3"><Input class="max-w-sm" bind:value={search} placeholder="Search agents…" /><Select.Root type="single" value={projectId || "__all_projects"} onValueChange={(value) => { projectId = value === "__all_projects" ? "" : value; void reload(); }}><Select.Trigger class="w-auto min-w-48">{projects.find((project) => project.id === projectId)?.name ?? "All project agents"}</Select.Trigger><Select.Content><Select.Item value="__all_projects">All project agents</Select.Item>{#each projects as project}<Select.Item value={project.id}>{project.name}</Select.Item>{/each}</Select.Content></Select.Root></div><div class="grid gap-4 lg:grid-cols-2">{#each visibleAgents as agent}<article class="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div class="flex items-start gap-3"><span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10"><Bot class="size-5" /></span><div class="min-w-0 flex-1"><h2 class="truncate font-semibold">{agent.label}</h2><p class="mt-1 text-sm text-neutral-400">{roleNames[agent.role] ?? agent.role} · {agent.provider} / {agent.modelId ?? "provider default"}</p><p class="mt-3 text-sm text-neutral-500">Skills: {agent.skills?.filter((s) => s.enabled).map((s) => s.name).join(", ") || "None"}</p><p class="mt-1 text-xs text-neutral-500">Available in: {[agent.allowChat && "Chat", agent.allowCanvas && "Canvas", agent.allowKanban && "Kanban"].filter(Boolean).join(" · ") || "No surfaces"}</p><p class="mt-1 text-xs text-neutral-500">{lastUsed(agent.id)}</p><span class={`mt-3 inline-flex rounded-full px-2.5 py-1 text-xs ${agent.status === "active" ? "bg-emerald-500/10 text-emerald-300" : agent.status === "needs_attention" ? "bg-amber-500/10 text-amber-300" : "bg-white/10 text-neutral-400"}`}>{agent.status === "active" ? "Active" : agent.status === "needs_attention" ? "Needs attention" : "Disabled"}</span></div></div><div class="mt-5 flex justify-end gap-2"><Button variant="ghost" size="sm" onclick={() => void toggleAgent(agent)}>{agent.status === "active" ? "Disable" : "Enable"}</Button><Button variant="outline" size="sm" onclick={() => duplicateAgent(agent)}>Duplicate</Button><Button variant="outline" size="sm" onclick={() => editAgent(agent)}>Edit</Button><Button variant="ghost" size="icon-sm" aria-label={`Delete ${agent.label}`} onclick={() => void deleteAgent(agent)}><Trash2 class="size-4" /></Button></div></article>{/each}</div>{/if}
	{#if error && !showForm}<p class="mt-4 text-sm text-red-400" role="alert">{error}</p>{/if}
	</div></main></div></div>
