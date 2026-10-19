<script lang="ts">
import { ArrowUp, Folder, FolderPlus, LoaderCircle } from "@lucide/svelte";
import { onMount } from "svelte";
import { toast } from "svelte-sonner";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import * as ScrollArea from "$lib/components/ui/scroll-area";
import { daemon, type DirectoryListing } from "$lib/daemon";

let { oncreated }: { oncreated: () => void } = $props();
let listing = $state<DirectoryListing | null>(null);
let pathInput = $state("");
let showHidden = $state(false);
let loading = $state(false);
let submitting = $state(false);
let error = $state("");

onMount(() => { void navigate(); });

async function navigate(path?: string) {
	loading = true;
	error = "";
	try {
		listing = await daemon.listDirectories(path, showHidden);
		pathInput = listing.path;
	} catch (reason) {
		error = reason instanceof Error ? reason.message : "Unable to read this folder";
	} finally {
		loading = false;
	}
}

async function submit() {
	const path = pathInput.trim();
	if (!path || submitting) return;
	error = "";
	submitting = true;
	try {
		await daemon.createProject(path);
		toast.success("Project added");
		oncreated();
	} catch (reason) {
		error = reason instanceof Error ? reason.message : "Unable to add project";
	} finally {
		submitting = false;
	}
}
</script>

<div class="space-y-3">
	<div class="flex items-center gap-2">
		<form class="flex min-w-0 flex-1 items-center gap-2" onsubmit={(event) => { event.preventDefault(); void navigate(pathInput); }}>
			<FolderPlus size={15} class="shrink-0 text-muted-foreground" />
			<Input aria-label="Current folder path" bind:value={pathInput} spellcheck="false" />
			<Button type="submit" variant="outline" size="sm" disabled={loading}>Go</Button>
		</form>
		<label class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
			<input type="checkbox" bind:checked={showHidden} onchange={() => void navigate(listing?.path)} />
			Show hidden
		</label>
	</div>

	<div class="flex h-9 items-center gap-2 rounded-md border px-2 text-xs text-muted-foreground">
		<Button variant="ghost" size="icon" class="size-7 shrink-0" aria-label="Go to parent folder" disabled={!listing?.parentPath || loading} onclick={() => listing?.parentPath && void navigate(listing.parentPath)}>
			<ArrowUp size={14} />
		</Button>
		<span class="truncate font-mono" title={listing?.path}>{listing?.path ?? "Loading folders…"}</span>
	</div>

	<ScrollArea.Root class="h-[min(42svh,360px)] rounded-md border" orientation="vertical">
		<div class="p-1">
			{#if loading}
				<p class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><LoaderCircle size={15} class="animate-spin" />Reading folders…</p>
			{:else if listing?.entries.length}
				{#each listing.entries as entry (entry.path)}
					<div class="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
						<Folder size={15} class="shrink-0 text-muted-foreground" />
						<button type="button" class="min-w-0 flex-1 truncate text-left text-sm" onclick={() => void navigate(entry.path)}>{entry.name}</button>
						<Button type="button" variant="ghost" size="icon" class="size-7 opacity-60 group-hover:opacity-100" aria-label={`Open ${entry.name}`} onclick={() => void navigate(entry.path)}><ArrowUp size={13} class="rotate-90" /></Button>
					</div>
				{/each}
			{:else}
				<p class="py-8 text-center text-sm text-muted-foreground">No folders found here.</p>
			{/if}
		</div>
	</ScrollArea.Root>

	<p class="text-xs text-muted-foreground">Choose a Git repository folder on the machine running Loom’s local daemon.</p>
	{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
	<div class="flex justify-end">
		<Button type="button" disabled={submitting || !pathInput.trim()} onclick={() => void submit()}>{#if submitting}<LoaderCircle size={14} class="animate-spin" />Validating…{:else}Add this folder{/if}</Button>
	</div>
</div>
