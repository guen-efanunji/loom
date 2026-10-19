<script lang="ts">
	import {
		BookOpen,
		Brain,
		Check,
		CircleAlert,
		FileText,
		Globe2,
		History,
		Lightbulb,
		Plus,
		RefreshCw,
		Search,
		ShieldAlert,
		Sparkles,
		Trash2,
	} from "@lucide/svelte";
	import { onMount } from "svelte";
	import SettingsSidebar from "$lib/components/settings/SettingsSidebar.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import * as Checkbox from "$lib/components/ui/checkbox";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Input } from "$lib/components/ui/input";
	import * as Select from "$lib/components/ui/select";
	import * as Tabs from "$lib/components/ui/tabs";
	import { Textarea } from "$lib/components/ui/textarea";
	import { toast } from "svelte-sonner";
	import {
		daemon,
		type ContextEntry,
		type ContextMemoryHistory,
		type ContextSkillDiscovery,
		type Project,
	} from "$lib/daemon";

	type Kind = ContextEntry["kind"];
	type Scope = "global" | "project";
	const tabs: Array<{ id: Kind; label: string; icon: typeof BookOpen; description: string }> = [
		{ id: "knowledge", label: "Knowledge Base", icon: BookOpen, description: "Reference material for your projects." },
		{ id: "rule", label: "Rules", icon: ShieldAlert, description: "Scoped instructions and path guidance." },
		{ id: "skill", label: "Skills", icon: Sparkles, description: "Reusable procedures and verified native discoveries." },
		{ id: "memory", label: "Memory", icon: Brain, description: "Sourced decisions that require approval before reuse." },
	];

	let projects = $state<Project[]>([]);
	let projectId = $state("all");
	let entries = $state<ContextEntry[]>([]);
	let discovery = $state<ContextSkillDiscovery | null>(null);
	let selectedNative = $state<ContextSkillDiscovery["skills"][number] | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state("");
	let activeTab = $state<Kind>("knowledge");
	let search = $state("");
	let formOpen = $state(false);
	let detailsOpen = $state(false);
	let editing = $state<ContextEntry | null>(null);
	let selectedEntry = $state<ContextEntry | null>(null);
	let versions = $state<Array<{ id: string; version: number; content: string; contentHash: string; metadata: string; createdAt: string }>>([]);
	let memoryHistory = $state<ContextMemoryHistory | null>(null);
	let saving = $state(false);
	let sidebarSearch = $state("");
	let draftScope = $state<Scope>("project");
	let draftTitle = $state("");
	let draftDescription = $state("");
	let draftContent = $state("");
	let draftSourceRef = $state("");
	let draftTags = $state("");
	let draftPaths = $state("");
	let draftSurfaces = $state<string[]>(["chat", "kanban"]);
	let draftStatus = $state("active");

	const projectLabel = $derived(projectId === "all" ? "All workspaces" : (projects.find((item) => item.id === projectId)?.name ?? "Workspace"));
	const visibleEntries = $derived(entries.filter((entry) =>
		entry.kind === activeTab &&
		`${entry.title} ${entry.description} ${entry.tags.join(" ")}`.toLowerCase().includes(search.trim().toLowerCase())
	));
	const visibleNativeSkills = $derived((discovery?.skills ?? []).filter((skill) =>
		`${skill.name} ${skill.description} ${skill.origins.map((origin) => origin.runtimeId).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase())
	));

	async function loadContext() {
		const scopeProjectId = projectId === "all" ? undefined : projectId;
		const [nextEntries, nextDiscovery] = await Promise.all([
			daemon.listContextEntries(scopeProjectId),
			daemon.discoverContextSkills(scopeProjectId),
		]);
		entries = nextEntries;
		discovery = nextDiscovery;
	}

	async function refresh() {
		refreshing = true;
		error = "";
		try {
			await loadContext();
		} catch (reason) {
			error = reason instanceof Error ? reason.message : "Unable to refresh context sources";
		} finally {
			refreshing = false;
			loading = false;
		}
	}

	onMount(() => {
		void (async () => {
			try {
				projects = await daemon.listProjects();
				const requestedProject = new URLSearchParams(window.location.search).get("projectId");
				if (requestedProject && projects.some((project) => project.id === requestedProject)) projectId = requestedProject;
				await loadContext();
			} catch (reason) {
				error = reason instanceof Error ? reason.message : "Unable to load context";
			} finally {
				loading = false;
			}
		})();
	});

	function beginCreate() {
		editing = null;
		draftScope = projectId === "all" ? "global" : "project";
		draftTitle = "";
		draftDescription = "";
		draftContent = "";
		draftSourceRef = "";
		draftTags = "";
		draftPaths = "";
		draftSurfaces = activeTab === "skill" ? ["chat", "kanban"] : ["chat"];
		draftStatus = activeTab === "memory" ? "proposed" : "active";
		formOpen = true;
	}

	function beginEdit(entry: ContextEntry) {
		editing = entry;
		draftScope = entry.scope;
		draftTitle = entry.title;
		draftDescription = entry.description;
		draftContent = entry.content;
		draftSourceRef = entry.sourceRef ?? "";
		draftTags = entry.tags.join(", ");
		draftPaths = entry.pathGlobs.join(", ");
		draftSurfaces = [...entry.surfaces];
		draftStatus = entry.status;
		formOpen = true;
	}

	function payload(status = draftStatus, enabledInLoom = activeTab === "memory" ? status === "approved" : true) {
		return {
			kind: editing?.kind ?? activeTab,
			projectId: draftScope === "project" ? projectId === "all" ? null : projectId : null,
			scope: draftScope,
			title: draftTitle.trim(),
			description: draftDescription.trim(),
			content: draftContent,
			sourceRef: draftSourceRef.trim() || null,
			tags: draftTags.split(",").map((item) => item.trim()).filter(Boolean),
			surfaces: draftSurfaces,
			pathGlobs: draftPaths.split(",").map((item) => item.trim()).filter(Boolean),
			status,
			enabledInLoom,
		};
	}

	async function saveEntry() {
		if (!draftTitle.trim() || !draftContent.trim() || (draftScope === "project" && projectId === "all") || saving) return;
		saving = true;
		error = "";
		try {
			if (editing) await daemon.updateContextEntry(editing.id, { ...payload(), expectedVersion: editing.currentVersion });
			else await daemon.createContextEntry(payload(activeTab === "memory" ? "proposed" : "active", activeTab !== "memory"));
			formOpen = false;
			await loadContext();
			toast.success(editing ? "Context entry saved" : "Context entry created");
		} catch (reason) {
			error = reason instanceof Error ? reason.message : "Unable to save context entry";
		} finally {
			saving = false;
		}
	}

	async function setMemoryStatus(entry: ContextEntry, status: "approved" | "rejected" | "archived") {
		try {
			await daemon.updateContextEntry(entry.id, {
				kind: entry.kind,
				projectId: entry.projectId,
				scope: entry.scope,
				title: entry.title,
				description: entry.description,
				content: entry.content,
				sourceRef: entry.sourceRef,
				tags: entry.tags,
				surfaces: entry.surfaces,
				pathGlobs: entry.pathGlobs,
				status,
				enabledInLoom: status === "approved",
				expectedVersion: entry.currentVersion,
			});
			await loadContext();
			toast.success(`Memory ${status}`);
		} catch (reason) {
			toast.error(reason instanceof Error ? reason.message : "Unable to update memory");
		}
	}

	async function toggleEntry(entry: ContextEntry) {
		try {
			await daemon.updateContextEntry(entry.id, {
				kind: entry.kind,
				projectId: entry.projectId,
				scope: entry.scope,
				title: entry.title,
				description: entry.description,
				content: entry.content,
				sourceRef: entry.sourceRef,
				tags: entry.tags,
				surfaces: entry.surfaces,
				pathGlobs: entry.pathGlobs,
				status: entry.status === "disabled" ? "active" : "disabled",
				enabledInLoom: entry.status === "disabled",
				expectedVersion: entry.currentVersion,
			});
			await loadContext();
		} catch (reason) {
			toast.error(reason instanceof Error ? reason.message : "Unable to update entry");
		}
	}

	async function removeEntry(entry: ContextEntry) {
		if (!confirm(`Delete “${entry.title}” and its saved versions?`)) return;
		try {
			await daemon.deleteContextEntry(entry.id);
			await loadContext();
			toast.success("Context entry deleted");
		} catch (reason) {
			toast.error(reason instanceof Error ? reason.message : "Unable to delete context entry");
		}
	}

	async function showDetails(entry: ContextEntry) {
		selectedEntry = entry;
		selectedNative = null;
		memoryHistory = null;
		detailsOpen = true;
		const [nextVersions, nextMemoryHistory] = await Promise.all([
			daemon.listContextVersions(entry.id).catch(() => []),
			entry.kind === "memory" ? daemon.getContextMemoryHistory(entry.id).catch(() => null) : Promise.resolve(null),
		]);
		versions = nextVersions;
		memoryHistory = nextMemoryHistory;
	}

	function showNativeSkill(skill: ContextSkillDiscovery["skills"][number]) {
		selectedEntry = null;
		versions = [];
		memoryHistory = null;
		selectedNative = skill;
		detailsOpen = true;
	}

	function toggleSurface(surface: string) {
		draftSurfaces = draftSurfaces.includes(surface)
			? draftSurfaces.filter((item) => item !== surface)
			: [...draftSurfaces, surface];
	}
</script>

<svelte:head><title>Context Hub · Settings · Loom</title></svelte:head>

<div class="min-h-svh w-full bg-[#090909] text-neutral-100">
	<div class="flex min-h-svh w-full flex-col md:flex-row">
		<SettingsSidebar active="context" bind:search={sidebarSearch} />
		<main class="min-w-0 flex-1 px-4 py-6 sm:px-7 lg:px-10 lg:py-8">
			<div class="mx-auto flex w-full max-w-[1320px] flex-col gap-6">
				<header class="flex flex-wrap items-start justify-between gap-4">
					<div class="flex items-start gap-3">
						<div class="mt-1 flex size-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><Brain size={19} /></div>
						<div><p class="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">Workspace · Context</p><h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Context Hub</h1><p class="mt-1 max-w-2xl text-sm text-neutral-400">Manage project knowledge, rules, skills, and approved memory with clear sources and scope.</p></div>
					</div>
					<div class="flex w-full flex-wrap items-center gap-2 sm:w-auto">
						<Select.Root type="single" value={projectId} onValueChange={(value) => { projectId = value; void refresh(); }}>
							<Select.Trigger class="w-full sm:w-[210px]" aria-label="Context workspace"><Select.Value /></Select.Trigger>
							<Select.Content><Select.Item value="all">All workspaces</Select.Item>{#each projects as project}<Select.Item value={project.id}>{project.name}</Select.Item>{/each}</Select.Content>
						</Select.Root>
						<Button variant="outline" size="sm" class="flex-1 sm:flex-initial" disabled={refreshing} onclick={() => void refresh()}><RefreshCw class={`size-4 ${refreshing ? "animate-spin" : ""}`} />Refresh sources</Button>
						<Button size="sm" class="flex-1 sm:flex-initial" onclick={beginCreate}><Plus class="size-4" />Add {tabs.find((tab) => tab.id === activeTab)?.label}</Button>
					</div>
				</header>

				<div class="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-sky-500/15 bg-sky-500/[0.035] p-3 text-xs leading-5 text-neutral-400"><div class="flex gap-2"><Sparkles class="mt-0.5 size-4 shrink-0 text-sky-300" /><p>Library entries are versioned and scoped, but are not yet automatically injected into runs. Native skill discovery is read-only: “Discovered” means a file was found, not that a runtime loaded it.</p></div><Badge variant="outline" class="shrink-0 border-sky-500/20 text-sky-200">{projectLabel}</Badge></div>
				{#if error}<div class="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3 text-sm text-red-200" role="alert"><CircleAlert class="mt-0.5 size-4 shrink-0" />{error}</div>{/if}

				<section class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10">
					<div class="w-full overflow-x-auto sm:w-auto">
						<Tabs.Root bind:value={activeTab}>
							<Tabs.List class="h-10 bg-transparent p-0">
								{#each tabs as tab}{@const Icon = tab.icon}<Tabs.Trigger value={tab.id} class="gap-2 rounded-t-lg border-b-2 border-transparent px-3 data-[state=active]:border-primary sm:px-4"><Icon class="size-4" />{tab.label}</Tabs.Trigger>{/each}
							</Tabs.List>
						</Tabs.Root>
					</div>
					<label class="relative mb-2 block w-full sm:w-64"><Search class="absolute left-3 top-2.5 size-4 text-neutral-500" /><Input bind:value={search} placeholder={`Search ${tabs.find((tab) => tab.id === activeTab)?.label.toLowerCase()}…`} class="h-9 border-white/10 bg-white/[0.04] pl-9 text-xs" /></label>
				</section>

				{#if activeTab === "skill"}
					<section class="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
						<div class="flex flex-wrap items-start justify-between gap-3"><div><h2 class="font-medium">Native skills discovered</h2><p class="mt-1 text-xs text-neutral-500">Read-only scan of supported Claude, Codex, and OpenCode skill roots. Found files are not imported into Loom or automatically sent to agents; no scripts or plugin hooks are executed.</p></div><Badge variant="outline" class="border-white/10 text-neutral-400">{discovery?.skills.length ?? 0} found</Badge></div>
						{#if discovery}<div class="mt-4 flex flex-wrap gap-2">{#each discovery.sources as source}<Badge variant="outline" class={source.status === "available" ? "border-emerald-500/20 text-emerald-200" : "border-white/10 text-neutral-500"} title={source.issue ?? source.status}>{source.runtimeId} · {source.scope} · {source.status}{source.truncated ? " · limited" : ""}</Badge>{/each}</div>{#if discovery.coverage.truncatedSources}<p class="mt-2 text-[11px] text-amber-200">Some skill sources reached the scan limit; discovery results are partial.</p>{/if}{/if}
						{#if loading}<p class="py-8 text-center text-sm text-neutral-500">Discovering configured skill sources…</p>{:else if !visibleNativeSkills.length}<p class="rounded-lg border border-dashed border-white/10 p-6 text-center text-sm text-neutral-500">No native skills found in the configured roots.</p>{:else}<div class="mt-4 grid gap-3 xl:grid-cols-2">{#each visibleNativeSkills as skill (skill.id)}<article class="rounded-lg border border-white/10 bg-black/20 p-4"><div class="flex items-start gap-3"><Sparkles class="mt-0.5 size-4 shrink-0 text-sky-300" /><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><h3 class="font-medium">{skill.name}</h3><Badge variant="outline" class={skill.valid ? "border-emerald-500/20 text-emerald-200" : "border-amber-500/20 text-amber-200"}>{skill.valid ? "Valid metadata" : "Invalid metadata"}</Badge></div><p class="mt-1 text-xs leading-5 text-neutral-400">{skill.description || "No description provided"}</p><div class="mt-3 flex flex-wrap gap-1.5">{#each skill.origins as origin}<Badge variant="outline" class="border-white/10 text-neutral-500">{origin.runtimeId} · {origin.source}</Badge>{/each}</div>{#if skill.issues.length}<ul class="mt-2 list-inside list-disc text-[11px] text-amber-200">{#each skill.issues as issue}<li>{issue}</li>{/each}</ul>{/if}<div class="mt-3 flex justify-end"><Button size="sm" variant="ghost" onclick={() => showNativeSkill(skill)}><FileText class="size-4" />View instructions</Button></div></div></div></article>{/each}</div>{/if}
						{#if discovery}<p class="mt-3 text-[11px] text-neutral-500">Scan bounds: {discovery.coverage.maxDirectoriesPerSource} folders per source, {discovery.coverage.maxDiscoveredSkills} skills total, and {Math.round(discovery.coverage.maxSkillBytes / 1024)} KB per file.</p>{/if}
					</section>
				{/if}

				<section class="rounded-xl border border-white/10 bg-white/[0.02]">
					<div class="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 p-4 sm:p-5"><div><h2 class="font-medium">{tabs.find((tab) => tab.id === activeTab)?.label}</h2><p class="mt-1 text-xs text-neutral-500">{tabs.find((tab) => tab.id === activeTab)?.description} Scope: {projectLabel}.</p></div><span class="text-xs text-neutral-500">{visibleEntries.length} entries</span></div>
					{#if loading}<p class="p-8 text-center text-sm text-neutral-500">Loading context library…</p>{:else if !visibleEntries.length}<div class="p-10 text-center"><Lightbulb class="mx-auto size-6 text-neutral-500" /><p class="mt-3 text-sm font-medium">No {tabs.find((tab) => tab.id === activeTab)?.label.toLowerCase()} entries yet</p><p class="mt-1 text-xs text-neutral-500">Create a scoped entry to start building this library.</p><Button class="mt-4" variant="outline" size="sm" onclick={beginCreate}><Plus class="size-4" />Create entry</Button></div>{:else}
						<div class="divide-y divide-white/5">{#each visibleEntries as entry (entry.id)}<article class="flex flex-wrap items-start gap-3 p-4 sm:p-5"><div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-300">{#if entry.kind === "knowledge"}<BookOpen class="size-4" />{:else if entry.kind === "rule"}<ShieldAlert class="size-4" />{:else if entry.kind === "skill"}<Sparkles class="size-4" />{:else}<Brain class="size-4" />{/if}</div><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><h3 class="font-medium">{entry.title}</h3><Badge variant="outline" class="border-white/10 text-neutral-400">{entry.scope === "global" ? "Global" : projects.find((item) => item.id === entry.projectId)?.name ?? "Workspace"}</Badge><Badge variant="outline" class={entry.kind === "memory" ? entry.status === "approved" ? "border-emerald-500/20 text-emerald-200" : "border-amber-500/20 text-amber-200" : entry.status === "disabled" ? "border-white/10 text-neutral-500" : "border-sky-500/20 text-sky-200"}>{entry.kind === "memory" ? entry.status : entry.status === "disabled" ? "Disabled in Loom" : "Enabled in library"}</Badge>{#if entry.kind === "skill"}<Badge variant="outline" class="border-white/10 text-neutral-500">{entry.compatibility}</Badge>{/if}</div>{#if entry.description}<p class="mt-1 text-sm text-neutral-400">{entry.description}</p>{/if}<p class="mt-2 line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-neutral-500">{entry.content}</p><div class="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-neutral-500"><span>v{entry.currentVersion}</span><span>·</span><span>{entry.sourceKind}</span>{#if entry.tags.length}<span>·</span>{#each entry.tags as tag}<Badge variant="outline" class="h-5 border-white/10 px-1.5 text-[10px]">{tag}</Badge>{/each}{/if}{#if entry.kind === "rule" && entry.pathGlobs.length}<span>·</span><span>Paths: {entry.pathGlobs.join(", ")}</span>{/if}{#if entry.kind === "rule" || entry.kind === "skill"}<span>·</span><span>Surfaces: {entry.surfaces.join(", ") || "not limited"}</span>{/if}</div></div><div class="mt-2 flex w-full shrink-0 flex-wrap items-center justify-end gap-1 sm:mt-0 sm:w-auto">{#if entry.kind === "memory" && entry.status === "proposed"}<Button variant="outline" size="sm" onclick={() => void setMemoryStatus(entry, "approved")}><Check class="size-4" />Approve</Button><Button variant="ghost" size="sm" onclick={() => void setMemoryStatus(entry, "rejected")}>Reject</Button>{:else if entry.kind === "memory" && entry.status === "approved"}<Button variant="ghost" size="sm" onclick={() => void setMemoryStatus(entry, "archived")}>Archive</Button>{:else if entry.kind !== "memory"}<Button variant="ghost" size="sm" onclick={() => void toggleEntry(entry)}>{entry.status === "disabled" ? "Enable" : "Disable"}</Button>{/if}<Button variant="ghost" size="icon" aria-label={`Details for ${entry.title}`} onclick={() => void showDetails(entry)}><History class="size-4" /></Button><Button variant="ghost" size="icon" aria-label={`Edit ${entry.title}`} onclick={() => beginEdit(entry)}><FileText class="size-4" /></Button><Button variant="ghost" size="icon" class="text-red-300" aria-label={`Delete ${entry.title}`} onclick={() => void removeEntry(entry)}><Trash2 class="size-4" /></Button></div></article>{/each}</div>
					{/if}
				</section>
			</div>
		</main>
	</div>
</div>

<Dialog.Root bind:open={formOpen}>
	<Dialog.Content class="max-h-[90svh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-2xl">
		<Dialog.Header><Dialog.Title>{editing ? "Edit context entry" : `Add ${tabs.find((tab) => tab.id === activeTab)?.label}`}</Dialog.Title><Dialog.Description>Store sourced project context with an explicit scope. Saving creates a version when its content changes.</Dialog.Description></Dialog.Header>
		<div class="grid gap-4 sm:grid-cols-2">
			<label class="flex flex-col gap-2 text-sm">Title<Input bind:value={draftTitle} maxlength={160} placeholder="Entry title" /></label>
			<label class="flex flex-col gap-2 text-sm">Scope<Select.Root type="single" bind:value={draftScope}><Select.Trigger class="w-full"><Select.Value /></Select.Trigger><Select.Content><Select.Item value="project">Workspace · {projectId === "all" ? "select a workspace" : projectLabel}</Select.Item><Select.Item value="global">Global</Select.Item></Select.Content></Select.Root></label>
			<label class="flex flex-col gap-2 text-sm sm:col-span-2">Description<Input bind:value={draftDescription} maxlength={2000} placeholder="What is this context useful for?" /></label>
			{#if activeTab === "memory" || activeTab === "knowledge"}<label class="flex flex-col gap-2 text-sm sm:col-span-2">{activeTab === "memory" ? "Evidence reference" : "Source reference"}<Input bind:value={draftSourceRef} maxlength={1000} placeholder="Document, decision, approved task, or relative file reference" /><span class="text-xs text-neutral-500">This reference is recorded as unverified provenance; Loom does not inspect or validate it automatically.</span></label>{/if}
			{#if activeTab === "rule"}<label class="flex flex-col gap-2 text-sm sm:col-span-2">Path globs <span class="text-xs text-neutral-500">Comma-separated, for example apps/server/**</span><Input bind:value={draftPaths} placeholder="apps/server/**, packages/api/**" /></label>{/if}
			{#if activeTab === "rule" || activeTab === "skill"}<fieldset class="sm:col-span-2"><legend class="mb-2 text-sm">Supported surfaces</legend><div class="flex flex-wrap gap-2">{#each ["chat", "kanban", "canvas", "review", "walkthrough"] as surface}<label class="flex cursor-pointer items-center gap-2 rounded-md border border-white/10 px-2.5 py-1.5 text-xs text-neutral-300"><Checkbox.Root checked={draftSurfaces.includes(surface)} onCheckedChange={() => toggleSurface(surface)} aria-label={`Available on ${surface}`} />{surface}</label>{/each}</div></fieldset>{/if}
			<label class="flex flex-col gap-2 text-sm sm:col-span-2">{activeTab === "memory" ? "Memory statement and evidence" : activeTab === "rule" ? "Instruction" : activeTab === "skill" ? "Skill instructions" : "Reference content"}<Textarea bind:value={draftContent} rows={activeTab === "skill" ? 12 : 8} maxlength={256000} placeholder={activeTab === "memory" ? "State one durable decision and include its evidence/source reference." : "Write the context content…"} /></label>
			<label class="flex flex-col gap-2 text-sm sm:col-span-2">Tags <span class="text-xs text-neutral-500">Comma-separated</span><Input bind:value={draftTags} placeholder="api, validation, onboarding" /></label>
			{#if activeTab === "memory"}<p class="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 text-xs leading-5 text-amber-100 sm:col-span-2">New memories start as Proposed and are not selected for future retrieval. Approval records your decision; automatic memory retrieval is not enabled yet.</p>{/if}
			{#if draftScope === "project" && projectId === "all"}<p class="text-xs text-amber-200 sm:col-span-2" role="alert">Choose one workspace in the header before creating a workspace-scoped entry.</p>{/if}
		</div>
		<Dialog.Footer class="flex-wrap gap-2"><Button variant="ghost" onclick={() => formOpen = false}>Cancel</Button><Button disabled={saving || !draftTitle.trim() || !draftContent.trim() || (draftScope === "project" && projectId === "all")} onclick={() => void saveEntry()}>{saving ? "Saving…" : "Save entry"}</Button></Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={detailsOpen}>
	<Dialog.Content class="max-h-[90svh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-3xl">
		{#if selectedEntry}<Dialog.Header><Dialog.Title>{selectedEntry.title}</Dialog.Title><Dialog.Description>{selectedEntry.scope === "global" ? "Global context" : projectLabel} · {selectedEntry.kind} · version {selectedEntry.currentVersion}</Dialog.Description></Dialog.Header><div class="grid gap-4">{#if selectedEntry.sourceRef}<p class="break-all rounded-lg border border-white/10 p-3 text-xs text-neutral-400">Source reference · {selectedEntry.sourceRef}{#if selectedEntry.kind === "memory"}<span class="ml-2 text-amber-200">unverified</span>{/if}</p>{/if}<section class="rounded-lg border border-white/10 p-3"><h3 class="text-xs font-medium">Current content</h3><pre class="mt-2 max-h-[40svh] overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-neutral-300">{selectedEntry.content}</pre><div class="mt-3 break-all font-mono text-[10px] text-neutral-500">SHA-256 · {selectedEntry.contentHash}</div></section>{#if selectedEntry.kind === "memory"}<section class="rounded-lg border border-white/10 p-3"><h3 class="text-xs font-medium">Decision and evidence history</h3>{#if memoryHistory}<div class="mt-3 space-y-3">{#if memoryHistory.decisions.length}<div class="space-y-2">{#each memoryHistory.decisions as decision}<div class="rounded-md bg-white/[0.03] p-2 text-xs"><div class="flex flex-wrap items-center justify-between gap-2"><Badge variant="outline" class="border-white/10">{decision.decision}</Badge><span class="text-[10px] text-neutral-500">v{decision.version} · {new Date(decision.createdAt).toLocaleString()}</span></div><p class="mt-1 text-[10px] text-neutral-500">Proposed by {decision.proposedBy}{decision.decidedBy ? ` · decided by ${decision.decidedBy}` : " · awaiting decision"}</p></div>{/each}</div>{:else}<p class="text-xs text-neutral-500">No decision history recorded.</p>{/if}{#if memoryHistory.evidence.length}<div class="space-y-2"><h4 class="text-[11px] font-medium text-neutral-400">Evidence references</h4>{#each memoryHistory.evidence as evidence}<div class="break-all rounded-md bg-white/[0.03] p-2 text-xs text-neutral-400">{evidence.sourceId}<Badge variant="outline" class="ml-2 border-amber-500/20 text-amber-200">{evidence.verificationStatus}</Badge><p class="mt-1 text-[10px] text-neutral-500">{evidence.sourceType} · {new Date(evidence.createdAt).toLocaleString()}</p></div>{/each}</div>{/if}</div>{:else}<p class="mt-2 text-xs text-neutral-500">Memory history could not be loaded.</p>{/if}</section>{/if}<section class="rounded-lg border border-white/10 p-3"><h3 class="flex items-center gap-2 text-xs font-medium"><History class="size-4" />Version history</h3>{#if versions.length}<div class="mt-2 divide-y divide-white/5">{#each versions as version}<details class="py-2"><summary class="cursor-pointer text-xs text-neutral-400">Version {version.version} · {new Date(version.createdAt).toLocaleString()}</summary><pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-neutral-500">{version.content}</pre></details>{/each}</div>{:else}<p class="mt-2 text-xs text-neutral-500">No saved versions available.</p>{/if}</section><p class="text-[11px] leading-5 text-neutral-500">This library entry has not been delivered to a run. The version history records saved authored content, not runtime activation.</p></div>{/if}
		{#if selectedNative}<Dialog.Header><Dialog.Title>{selectedNative.name}</Dialog.Title><Dialog.Description>Native skill file · {selectedNative.origins.map((origin) => `${origin.runtimeId} (${origin.source})`).join(" · ")}</Dialog.Description></Dialog.Header><section class="rounded-lg border border-white/10 p-3"><p class="mb-2 text-xs text-neutral-400">{selectedNative.description || "No description provided"}</p><pre class="max-h-[65svh] overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-neutral-300">{selectedNative.content}</pre></section><p class="text-[11px] leading-5 text-neutral-500">Discovered means the source file was found and read. It does not prove that a runtime loaded this skill for a session.</p>{/if}
	</Dialog.Content>
</Dialog.Root>
