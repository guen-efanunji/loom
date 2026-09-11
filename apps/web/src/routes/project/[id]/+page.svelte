<script lang="ts">
import { onMount } from "svelte";
import { page } from "$app/state";
import {
	type DaemonEvent,
	daemon,
	formatDuration,
	formatStatus,
	type Project,
	parseDaemonEvent,
	provisionDaemonToken,
	type SchedulerState,
	type Task,
	websocketProtocols,
	websocketUrl,
} from "$lib/daemon";

let project = $state<Project | null>(null);
let tasks = $state<Task[]>([]);
let scheduler = $state<SchedulerState>({ running: [], queued: [] });
let loading = $state(true);
let stale = $state(false);
let unavailable = $state(false);
let error = $state("");
let title = $state("");
let prompt = $state("");
let batch = $state("");
let submitting = $state(false);
let action = $state("");
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const id = $derived(page.params.id ?? "");
const projectTasks = $derived(tasks.filter((task) => task.projectId === id));

async function refresh() {
	try {
		const [data, allTasks, state] = await Promise.all([
			daemon.getProject(id),
			daemon.listTasks(),
			daemon.getScheduler(),
		]);
		project = data;
		tasks = allTasks;
		scheduler = state;
		stale = false;
		unavailable = false;
		error = "";
	} catch (reason: unknown) {
		if (!project) unavailable = true;
		stale = Boolean(project);
		error =
			reason instanceof Error ? reason.message : "Unable to refresh project";
	} finally {
		loading = false;
	}
}

function applyEvent(event: DaemonEvent) {
	if (event.type === "scheduler.changed")
		scheduler = { running: scheduler.running, queued: scheduler.queued };
	if (event.type === "task.created" && event.task.projectId === id)
		tasks = [...tasks, event.task];
	if (event.type === "task.updated" || event.type === "task.created")
		tasks = tasks.map((task) =>
			task.id === event.task.id ? event.task : task,
		);
	if (
		event.type === "task.started" ||
		event.type === "task.completed" ||
		event.type === "task.failed" ||
		event.type === "task.cancelled"
	)
		refresh();
	if (event.type === "task.discarded")
		tasks = tasks.filter((task) => task.id !== event.taskId);
}

function connect() {
	provisionDaemonToken()
		.then(() => {
			socket = new WebSocket(websocketUrl(), websocketProtocols());
			socket.onopen = () => refresh();
			socket.onmessage = (message) => {
				try {
					applyEvent(parseDaemonEvent(JSON.parse(message.data)));
				} catch {}
			};
			socket.onclose = () => {
				reconnectTimer = setTimeout(connect, 2000);
			};
		})
		.catch(() => {
			unavailable = true;
			reconnectTimer = setTimeout(connect, 2000);
		});
}

onMount(() => {
	refresh();
	connect();
	return () => {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		socket?.close();
	};
});

async function runTask(task: Task) {
	action = task.id;
	try {
		await daemon.startTask(task.id);
		await refresh();
	} catch (reason: unknown) {
		error = reason instanceof Error ? reason.message : "Unable to run task";
	} finally {
		action = "";
	}
}

async function createSingle() {
	if (!title.trim() || !prompt.trim()) {
		error = "Title and prompt are required";
		return;
	}
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
	} catch (reason: unknown) {
		error = reason instanceof Error ? reason.message : "Unable to create task";
	} finally {
		submitting = false;
	}
}

async function createBatch() {
	const tasksToCreate = batch
		.split("\n\n")
		.map((item) => {
			const [taskTitle, ...lines] = item.split("\n");
			return {
				title: taskTitle?.trim() ?? "",
				prompt: lines.join("\n").trim(),
			};
		})
		.filter((item) => item.title && item.prompt);
	if (!tasksToCreate.length) {
		error = "Add one title and prompt per block, separated by a blank line";
		return;
	}
	submitting = true;
	try {
		await daemon.createTaskBatch(id, tasksToCreate);
		batch = "";
		await refresh();
	} catch (reason: unknown) {
		error = reason instanceof Error ? reason.message : "Unable to create batch";
	} finally {
		submitting = false;
	}
}
</script>

<div class="mx-auto max-w-6xl px-4 py-8 sm:px-6">
	{#if loading}<p class="text-neutral-400">Loading project...</p>{:else if unavailable}<div class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200"><p>{error || "Loom daemon is unavailable"}</p><button class="mt-4 rounded-lg border border-red-800 px-3 py-2" onclick={refresh}>Retry</button></div>{:else if project}
		<a href="/projects" class="text-sm text-neutral-500 hover:text-neutral-200">← Projects</a>
		<div class="mt-8 flex flex-wrap items-start justify-between gap-4"><div><h1 class="text-3xl font-semibold">{project.name}</h1><p class="mt-2 break-all text-sm text-neutral-500">{project.path}</p></div><span class="rounded-full bg-neutral-800 px-3 py-1 text-sm text-neutral-300">{project.defaultBranch}</span></div>
		{#if stale}<p class="mt-4 rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">Showing stale state. Reconnecting to Loom...</p>{/if}
		<div class="mt-6 grid gap-3 sm:grid-cols-2"><div class="rounded-xl border border-neutral-800 bg-neutral-900 p-4"><p class="text-sm text-neutral-500">Running</p><p class="mt-1 text-2xl font-semibold">{scheduler.running.length}</p></div><div class="rounded-xl border border-neutral-800 bg-neutral-900 p-4"><p class="text-sm text-neutral-500">Queued</p><p class="mt-1 text-2xl font-semibold">{scheduler.queued.length}</p></div></div>
		<div class="mt-8 grid gap-6 lg:grid-cols-[1fr_380px]"><section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5"><div class="mb-4 flex items-center justify-between"><h2 class="font-medium">Parallel tasks</h2><button class="text-sm text-neutral-400 hover:text-white" onclick={refresh}>Refresh</button></div>{#if projectTasks.length === 0}<p class="text-sm text-neutral-500">No tasks yet.</p>{:else}<div class="grid gap-3">{#each projectTasks as task}<article class="rounded-lg border border-neutral-800 p-4"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><a href={`/task/${task.id}`} class="font-medium hover:text-blue-300">{task.title}</a><p class="mt-2 line-clamp-2 text-sm text-neutral-400">{task.prompt}</p></div><span class="shrink-0 text-xs text-neutral-500">{formatStatus(task.status)}</span></div><div class="mt-3 grid gap-1 text-xs text-neutral-500 sm:grid-cols-3"><span>Duration: {formatDuration(task.startedAt, task.completedAt)}</span><span>Run: {task.sessionId ?? "Pending"}</span><span>Workspace: {task.workspaceId ?? "Pending"}</span></div><div class="mt-4 flex flex-wrap gap-2">{#if ["queued", "preparing"].includes(task.status)}<button disabled={action === task.id} class="rounded border border-blue-800 px-3 py-1 text-xs text-blue-200 disabled:opacity-50" onclick={() => runTask(task)}>Run</button>{/if}<a href={`/task/${task.id}`} class="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300">Review</a></div></article>{/each}</div>{/if}</section><div class="space-y-6"><form class="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900 p-5" onsubmit={(event) => { event.preventDefault(); createSingle(); }}><h2 class="font-medium">New task</h2><input aria-label="Task title" bind:value={title} placeholder="Title" class="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2" maxlength="200" /><textarea aria-label="Task prompt" bind:value={prompt} placeholder="Prompt" rows="5" class="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2"></textarea><button disabled={submitting} class="rounded-lg bg-white px-4 py-2 text-sm text-black disabled:opacity-50">Create task</button></form><form class="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900 p-5" onsubmit={(event) => { event.preventDefault(); createBatch(); }}><h2 class="font-medium">Batch tasks</h2><p class="text-xs text-neutral-500">Each block uses the first line as the title and the remaining lines as the prompt.</p><textarea aria-label="Batch tasks" bind:value={batch} placeholder="Frontend dashboard\nBuild the dashboard...\n\nBackend API\nBuild the API..." rows="8" class="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2"></textarea><button disabled={submitting} class="rounded-lg border border-neutral-600 px-4 py-2 text-sm disabled:opacity-50">Create batch</button></form></div></div>
	{:else}<div class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200">{error || "Project not found"}</div>{/if}
</div>
