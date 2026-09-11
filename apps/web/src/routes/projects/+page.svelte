<script lang="ts">
import { onMount } from "svelte";
import {
	type DaemonEvent,
	daemon,
	formatStatus,
	parseDaemonEvent,
	provisionDaemonToken,
	type Task,
	websocketProtocols,
	websocketUrl,
} from "$lib/daemon";

let projects = $state<Awaited<ReturnType<typeof daemon.listProjects>>>([]);
let tasks = $state<Task[]>([]);
let loading = $state(true);
let error = $state("");
let connected = $state(false);
let reconnecting = $state(false);
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function applyEvent(event: DaemonEvent) {
	if (event.type === "task.created")
		tasks = [event.task, ...tasks.filter((task) => task.id !== event.task.id)];
	if (event.type === "task.updated")
		tasks = tasks.map((task) =>
			task.id === event.task.id ? event.task : task,
		);
	if (event.type === "task.started")
		tasks = tasks.map((task) =>
			task.id === event.taskId ? { ...task, status: "running" } : task,
		);
	if (event.type === "task.completed")
		tasks = tasks.map((task) =>
			task.id === event.taskId ? { ...task, status: "completed" } : task,
		);
	if (event.type === "task.failed")
		tasks = tasks.map((task) =>
			task.id === event.taskId ? { ...task, status: "failed" } : task,
		);
	if (event.type === "task.cancelled")
		tasks = tasks.map((task) =>
			task.id === event.taskId ? { ...task, status: "cancelled" } : task,
		);
}

function connect() {
	reconnecting = true;
	provisionDaemonToken()
		.then(() => {
			socket = new WebSocket(websocketUrl(), websocketProtocols());
			socket.onopen = () => {
				connected = true;
				reconnecting = false;
				Promise.all([daemon.listProjects(), daemon.listTasks()]).then(
					([projectData, taskData]) => {
						projects = projectData;
						tasks = taskData;
					},
				);
			};
			socket.onmessage = (message) => {
				try {
					applyEvent(parseDaemonEvent(JSON.parse(message.data)));
				} catch {}
			};
			socket.onclose = () => {
				connected = false;
				reconnecting = true;
				reconnectTimer = setTimeout(connect, 2000);
			};
		})
		.catch((reason: unknown) => {
			error =
				reason instanceof Error ? reason.message : "Loom daemon is unavailable";
			reconnectTimer = setTimeout(connect, 2000);
		});
}

onMount(() => {
	Promise.all([daemon.listProjects(), daemon.listTasks()])
		.then(([projectData, taskData]) => {
			projects = projectData;
			tasks = taskData;
		})
		.catch((reason: unknown) => {
			error =
				reason instanceof Error ? reason.message : "Unable to load daemon data";
		})
		.finally(() => {
			loading = false;
		});
	connect();
	return () => {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		socket?.close();
	};
});
</script>

<svelte:head><title>Projects · Loom</title></svelte:head>

<div class="mx-auto max-w-6xl px-4 py-8 sm:px-6">
	<div class="mb-8 flex flex-wrap items-end justify-between gap-4">
		<div><p class="text-sm text-neutral-500">Loom</p><h1 class="text-3xl font-semibold tracking-tight">Projects</h1></div>
		<div class="flex items-center gap-2 text-sm text-neutral-400"><span class={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`}></span>{reconnecting ? "Reconnecting" : connected ? "Live" : "Unavailable"}</div>
	</div>
	{#if loading}<div class="rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-neutral-400">Loading projects...</div>
	{:else if error}<div class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200">{error}</div>
	{:else}
		<div class="grid gap-6 lg:grid-cols-[1fr_360px]">
			<section class="space-y-3"><a href="/project/add" class="inline-flex rounded-lg bg-white px-3 py-2 text-sm font-medium text-black">Add project</a>
				{#if projects.length === 0}<div class="rounded-xl border border-dashed border-neutral-700 p-10 text-center text-neutral-400">No projects yet. Add a repository to begin.</div>{/if}
				{#each projects as project}
					{@const projectTasks = tasks.filter((task) => task.projectId === project.id)}
					<a href={`/project/${project.id}`} class="block rounded-xl border border-neutral-800 bg-neutral-900 p-5 transition hover:border-neutral-600"><div class="flex items-start justify-between gap-4"><div><h2 class="font-medium">{project.name}</h2><p class="mt-1 break-all text-sm text-neutral-500">{project.path}</p></div><span class="rounded-full bg-neutral-800 px-2 py-1 text-xs text-neutral-300">{projectTasks.length} tasks</span></div><p class="mt-4 text-xs text-neutral-500">Default branch: {project.defaultBranch}</p></a>
				{/each}
			</section>
			<section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5"><h2 class="mb-4 font-medium">Recent tasks</h2>{#if tasks.length === 0}<p class="text-sm text-neutral-500">No tasks created.</p>{:else}<div class="space-y-3">{#each tasks.slice(0, 8) as task}<a href={`/task/${task.id}`} class="block rounded-lg border border-neutral-800 p-3 hover:border-neutral-600"><div class="flex items-center justify-between gap-3"><span class="truncate text-sm">{task.title}</span><span class="text-xs text-neutral-500">{formatStatus(task.status)}</span></div></a>{/each}</div>{/if}</section>
		</div>
	{/if}
</div>
