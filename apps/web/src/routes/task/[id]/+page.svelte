<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import {
	type DaemonEvent,
	daemon,
	diffStats,
	formatStatus,
	parseDaemonEvent,
	provisionDaemonToken,
	type Task,
	websocketProtocols,
	websocketUrl,
} from "$lib/daemon";

let task = $state<Task | null>(null);
let diff = $state("");
let loading = $state(true);
let diffLoading = $state(false);
let error = $state("");
let action = $state("");
let connected = $state(false);
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const id = $derived(page.params.id ?? "");
const stats = $derived(diffStats(diff));
const activity = $derived(
	task
		? [
				`Task created at ${new Date(task.createdAt).toLocaleString()}`,
				...(task.startedAt
					? [`Task started at ${new Date(task.startedAt).toLocaleString()}`]
					: []),
				...(task.completedAt
					? [`Task finished at ${new Date(task.completedAt).toLocaleString()}`]
					: []),
			]
		: [],
);

function applyEvent(event: DaemonEvent) {
	if (event.type === "task.updated" && event.task.id === id) task = event.task;
	if (event.type === "task.started" && event.taskId === id && task)
		task = { ...task, status: "running" };
	if (event.type === "task.completed" && event.taskId === id && task)
		task = { ...task, status: "completed" };
	if (event.type === "task.failed" && event.taskId === id && task)
		task = { ...task, status: "failed" };
	if (event.type === "task.cancelled" && event.taskId === id && task)
		task = { ...task, status: "cancelled" };
}

function connect() {
	provisionDaemonToken()
		.then(() => {
			socket = new WebSocket(websocketUrl(), websocketProtocols());
			socket.onopen = () => {
				connected = true;
				daemon.getTask(id).then((data) => (task = data));
			};
			socket.onmessage = (message) => {
				try {
					applyEvent(parseDaemonEvent(JSON.parse(message.data)));
				} catch {}
			};
			socket.onclose = () => {
				connected = false;
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
	daemon
		.getTask(id)
		.then((data) => {
			task = data;
			return daemon.getDiff(id);
		})
		.then((data) => {
			diff = data.diff;
		})
		.catch((reason: unknown) => {
			error = reason instanceof Error ? reason.message : "Unable to load task";
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

async function cancel() {
	await runAction(() => daemon.cancelTask(id));
}
async function reviewDiff() {
	diffLoading = true;
	try {
		diff = (await daemon.getDiff(id)).diff;
	} catch (reason: unknown) {
		error = reason instanceof Error ? reason.message : "Unable to load diff";
	} finally {
		diffLoading = false;
	}
}
async function merge() {
	await runAction(() => daemon.mergeTask(id), true);
}
async function discard() {
	await runAction(() => daemon.discardTask(id), true);
}
async function runAction(fn: () => Promise<unknown>, leave = false) {
	action = "Working...";
	error = "";
	try {
		await fn();
		if (leave) await goto("/projects");
	} catch (reason: unknown) {
		error = reason instanceof Error ? reason.message : "Action failed";
	} finally {
		action = "";
	}
}
</script>

<div class="mx-auto max-w-6xl px-4 py-8 sm:px-6">{#if loading}<p class="text-neutral-400">Loading task...</p>{:else if error && !task}<div class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200">{error}</div>{:else if task}<a href={`/project/${task.projectId}`} class="text-sm text-neutral-500 hover:text-neutral-200">← Project</a><div class="mt-8 flex flex-wrap items-start justify-between gap-4"><div><div class="flex items-center gap-2"><span class={`h-2.5 w-2.5 rounded-full ${task.status === "failed" ? "bg-red-400" : task.status === "completed" ? "bg-emerald-400" : "bg-blue-400"}`}></span><span class="text-sm text-neutral-400">{formatStatus(task.status)}</span><span class="text-xs text-neutral-600">{connected ? "Live" : "Reconnecting"}</span></div><h1 class="mt-3 text-3xl font-semibold">{task.title}</h1><p class="mt-3 max-w-3xl whitespace-pre-wrap text-neutral-400">{task.prompt}</p></div>{#if ["queued", "preparing", "running"].includes(task.status)}<button disabled={!!action} onclick={cancel} class="rounded-lg border border-red-900 px-4 py-2 text-sm text-red-200 hover:bg-red-950 disabled:opacity-50">{action || "Cancel"}</button>{/if}</div>{#if error}<p class="mt-4 text-sm text-red-300">{error}</p>{/if}<div class="mt-8 grid gap-6 lg:grid-cols-[280px_1fr]"><section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5"><h2 class="mb-4 font-medium">Agent activity</h2><div class="space-y-4">{#each activity as item}<div class="border-l border-neutral-700 pl-3 text-sm text-neutral-400">{item}</div>{/each}{#if task.status === "running"}<div class="border-l border-blue-500 pl-3 text-sm text-blue-300">Agent is working...</div>{/if}</div></section><section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5"><div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="font-medium">Diff</h2><div class="mt-2 flex gap-3 text-xs"><span class="text-neutral-400">{stats.files.length} files</span><span class="text-emerald-400">+{stats.additions}</span><span class="text-red-400">-{stats.deletions}</span></div></div><button disabled={diffLoading} onclick={reviewDiff} class="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-50">{diffLoading ? "Refreshing..." : "Refresh"}</button></div>{#if stats.files.length > 0}<div class="mt-5 space-y-2">{#each stats.files as file}<div class="rounded-lg bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-300">{file}</div>{/each}</div>{/if}<pre class="mt-5 max-h-[520px] overflow-auto rounded-lg bg-neutral-950 p-4 font-mono text-xs leading-5 text-neutral-300">{diff || "No changes available."}</pre>{#if task.status === "completed" && stats.files.length > 0}<div class="mt-5 flex gap-3"><button disabled={!!action} onclick={merge} class="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black disabled:opacity-50">Merge</button><button disabled={!!action} onclick={discard} class="rounded-lg border border-red-900 px-4 py-2 text-sm text-red-200 hover:bg-red-950 disabled:opacity-50">Discard</button></div>{/if}</section></div>{/if}</div>
