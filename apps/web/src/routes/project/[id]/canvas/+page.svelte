<script lang="ts">
import { Columns3, MessageSquare, Sparkles } from "@lucide/svelte";
import { onMount } from "svelte";
import { page } from "$app/state";
import DesignCanvas from "$lib/../components/DesignCanvas.svelte";
import type { Catalog } from "$lib/chat";
import { chat } from "$lib/chat";
import { Button } from "$lib/components/ui/button";
import { daemon, type Project } from "$lib/daemon";

let project = $state<Project | null>(null);
let catalog = $state<Catalog>({
	models: [],
	defaults: {},
	agents: [],
	commands: [],
});
let loading = $state(true);
let error = $state("");
const id = $derived(page.params.id ?? "");

onMount(() => {
	void load();
});

async function load() {
	loading = true;
	try {
		[project, catalog] = await Promise.all([
			daemon.getProject(id),
			chat.catalog(id),
		]);
		error = "";
	} catch (reason) {
		error = reason instanceof Error ? reason.message : "Unable to load canvas";
	} finally {
		loading = false;
	}
}
</script>

<svelte:head
	><title
		>{project
			? `${project.name} · Canvas · Loom`
			: "Design canvas · Loom"}</title
	></svelte:head
>

{#if loading}
	<main
		class="flex min-h-svh items-center justify-center text-sm text-muted-foreground"
	>
		Loading design canvas…
	</main>
{:else if project}
	<div class="flex h-svh flex-col bg-background text-foreground">
		<header
			class="flex h-[72px] shrink-0 items-center gap-3 border-b border-white/[0.08] px-5 sm:px-8"
		>
			<Button href={`/?project=${project.id}`} variant="ghost" size="sm"
				>← Back to workspace</Button
			>
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-semibold tracking-[-0.01em]">
					{project.name}
				</p>
				<p class="truncate text-[11px] text-white/45">{project.path}</p>
			</div>
			<nav
				aria-label="Workspace views"
				class="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.04] p-1"
			>
				<a
					href={`/?project=${project.id}`}
					class="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-medium text-white/50 transition hover:text-white/80"
					><MessageSquare size={14} />Chat</a
				>
				<a
					href={`/?project=${project.id}&view=kanban`}
					class="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-medium text-white/50 transition hover:text-white/80"
					><Columns3 size={14} />Kanban</a
				>
				<span
					aria-current="page"
					class="inline-flex h-9 items-center gap-2 rounded-lg bg-white/[0.12] px-3 text-xs font-medium text-white shadow-sm"
					><Sparkles size={14} />Canvas</span
				>
			</nav>
		</header>
		{#if error}<p
				role="alert"
				class="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive"
			>
				{error}
			</p>{/if}
		<DesignCanvas projectId={project.id} projectName={project.name} {catalog} />
	</div>
{:else}
	<main
		class="flex min-h-svh flex-col items-center justify-center gap-4 text-sm"
	>
		<p class="text-destructive">{error || "Project not found"}</p>
		<Button href="/">Back to workspace</Button>
	</main>
{/if}
