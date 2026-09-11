<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { daemon, formatStatus, type Project, type Task } from "$lib/daemon";

let project = $state<Project | null>(null);
let tasks = $state<Task[]>([]);
let loading = $state(true);
let error = $state("");
let title = $state("");
let prompt = $state("");
let submitting = $state(false);
const id = $derived(page.params.id ?? "");

onMount(() => {
	Promise.all([daemon.getProject(id), daemon.listTasks()])
		.then(([data, allTasks]) => {
			project = data;
			tasks = allTasks.filter((task) => task.projectId === id);
		})
		.catch((reason: unknown) => {
			error =
				reason instanceof Error ? reason.message : "Unable to load project";
		})
		.finally(() => {
			loading = false;
		});
});

async function createTask() {
	error = "";
	if (!title.trim() || !prompt.trim()) {
		error = "Title and prompt are required";
		return;
	}
	submitting = true;
	try {
		const task = await daemon.createTask({ projectId: id, title, prompt });
		await daemon.startTask(task.id);
		await goto(`/task/${task.id}`);
	} catch (reason: unknown) {
		error = reason instanceof Error ? reason.message : "Unable to create task";
	} finally {
		submitting = false;
	}
}
</script>


<div class="mx-auto max-w-5xl px-4 py-8 sm:px-6">{#if loading}<p class="text-neutral-400">Loading project...</p>{:else if error}<div class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200">{error}</div>{:else if project}<a href="/projects" class="text-sm text-neutral-500 hover:text-neutral-200">← Projects</a><div class="mt-8 flex flex-wrap items-start justify-between gap-4"><div><h1 class="text-3xl font-semibold">{project.name}</h1><p class="mt-2 break-all text-sm text-neutral-500">{project.path}</p></div><span class="rounded-full bg-neutral-800 px-3 py-1 text-sm text-neutral-300">{project.defaultBranch}</span></div><div class="mt-8 grid gap-6 lg:grid-cols-[1fr_380px]"><section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5"><h2 class="mb-4 font-medium">Tasks</h2>{#if tasks.length === 0}<p class="text-sm text-neutral-500">No tasks yet.</p>{:else}<div class="space-y-3">{#each tasks as task}<a href={`/task/${task.id}`} class="block rounded-lg border border-neutral-800 p-4 hover:border-neutral-600"><div class="flex items-center justify-between gap-3"><h3 class="truncate">{task.title}</h3><span class="text-xs text-neutral-500">{formatStatus(task.status)}</span></div><p class="mt-2 line-clamp-2 text-sm text-neutral-400">{task.prompt}</p></a>{/each}</div>{/if}</section><form class="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900 p-5" onsubmit={(event) => { event.preventDefault(); createTask(); }}><h2 class="font-medium">New task</h2><label class="block text-sm" for="title">Title<input id="title" bind:value={title} class="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2" maxlength="200" /></label><label class="block text-sm" for="prompt">Prompt<textarea id="prompt" bind:value={prompt} rows="7" class="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2"></textarea></label>{#if error}<p class="text-sm text-red-300">{error}</p>{/if}<button disabled={submitting} class="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50">{submitting ? "Starting..." : "Create and start"}</button></form></div>{/if}</div>
