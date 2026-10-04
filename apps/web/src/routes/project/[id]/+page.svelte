<script lang="ts">
import { onMount } from "svelte";
import { page } from "$app/state";
import TaskBoard from "$lib/components/TaskBoard.svelte";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import { Textarea } from "$lib/components/ui/textarea";
import { daemon, type Project, type Task } from "$lib/daemon";

let project = $state<Project | null>(null);
let tasks = $state<Task[]>([]);
let loading = $state(true);
let error = $state("");
let title = $state("");
let prompt = $state("");
let submitting = $state(false);
const id = $derived(page.params.id ?? "");
const projectTasks = $derived(tasks.filter((task) => task.projectId === id));
async function refresh() {
	try {
		[project, tasks] = await Promise.all([
			daemon.getProject(id),
			daemon.listTasks(),
		]);
		error = "";
	} catch (reason) {
		error = reason instanceof Error ? reason.message : "Unable to load project";
	} finally {
		loading = false;
	}
}
async function createTask() {
	if (!title.trim() || !prompt.trim()) return;
	submitting = true;
	try {
		await daemon.createTask({
			projectId: id,
			title: title.trim(),
			prompt: prompt.trim(),
		});
		title = "";
		prompt = "";
		await refresh();
	} catch (reason) {
		error = reason instanceof Error ? reason.message : "Unable to create task";
	} finally {
		submitting = false;
	}
}
async function runTask(task: Task) {
	try {
		await daemon.startTask(task.id);
		await refresh();
	} catch (reason) {
		error = reason instanceof Error ? reason.message : "Unable to start task";
	}
}
onMount(() => {
	refresh();
	const timer = setInterval(refresh, 3000);
	return () => clearInterval(timer);
});
</script>
<main class="mx-auto max-w-[1500px] px-4 py-8 sm:px-6"><a href="/" class="text-sm text-neutral-500 hover:text-neutral-200">← Projects</a>{#if loading}<p class="mt-8 text-neutral-400">Loading project...</p>{:else if project}<header class="mt-6 flex flex-wrap items-start justify-between gap-4"><div><h1 class="text-3xl font-semibold">{project.name}</h1><p class="mt-2 text-sm text-neutral-500">{project.path}</p></div><div class="flex gap-2"><span class="rounded-full bg-neutral-800 px-3 py-2 text-sm">{project.defaultBranch}</span></div></header>{#if error}<p class="mt-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>{/if}<section class="mt-8 overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900 p-5"><h2 class="mb-4 text-lg font-medium">Task board</h2><TaskBoard tasks={projectTasks} onRun={runTask} /></section><form class="mt-8 max-w-xl space-y-3 rounded-xl border border-neutral-800 bg-neutral-900 p-5" onsubmit={event => { event.preventDefault(); createTask(); }}><h2 class="font-medium">Quick task</h2><Input bind:value={title} placeholder="Task title" maxlength={200} /><Textarea bind:value={prompt} rows={4} placeholder="Implementation prompt"></Textarea><Button type="submit" disabled={submitting}>Create task</Button></form>{:else}<p class="mt-8 text-red-300">{error || "Project not found"}</p>{/if}</main>
