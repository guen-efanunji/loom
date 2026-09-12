<script lang="ts">
import { Button } from "$lib/components/ui/button";
import { onMount } from "svelte";
import { page } from "$app/state";
import {
	type AgentRun,
	type DaemonEvent,
	daemon,
	diffStats,
	formatDuration,
	formatStatus,
	type PermissionRequest,
	parseDaemonEvent,
	provisionDaemonToken,
	type Task,
	websocketProtocols,
	websocketUrl,
} from "$lib/daemon";

let task = $state<Task | null>(null);
let runs = $state<AgentRun[]>([]);
let permissions = $state<PermissionRequest[]>([]);
let diff = $state("");
let output = $state("");
let loading = $state(true);
let stale = $state(false);
let unavailable = $state(false);
let diffLoading = $state(false);
let error = $state("");
let action = $state("");
let connected = $state(false);
let conflictFiles = $state<string[]>([]);
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const id = $derived(page.params.id ?? "");
const stats = $derived(diffStats(diff));

async function refresh() {
	try {
		const [data, taskRuns, pendingPermissions] = await Promise.all([
			daemon.getTask(id),
			daemon.getRuns(id),
			daemon.getPermissions(),
		]);
		task = data;
		runs = taskRuns;
		permissions = pendingPermissions.filter((request) => request.taskId === id);
		stale = false;
		unavailable = false;
		error = "";
	} catch (reason: unknown) {
		if (!task) unavailable = true;
		stale = Boolean(task);
		error = reason instanceof Error ? reason.message : "Unable to refresh task";
	} finally {
		loading = false;
	}
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

function applyEvent(event: DaemonEvent) {
	if (
		(event.type === "task.updated" && event.task.id === id) ||
		(event.type === "task.created" && event.task.id === id)
	)
		task = { ...task, ...event.task };
	if (event.type === "agent.run.created" && event.run.taskId === id)
		runs = [...runs, event.run];
	if (event.type === "agent.run.updated" && event.run.taskId === id)
		runs = runs.map((run) => (run.id === event.run.id ? event.run : run));
	if (event.type === "permission.requested" && event.request.taskId === id)
		permissions = [
			...permissions.filter((request) => request.id !== event.request.id),
			event.request,
		];
	if (event.type === "permission.updated" && event.request.taskId === id)
		permissions = permissions.map((request) =>
			request.id === event.request.id ? event.request : request,
		);
	if (event.type === "run.output" && event.taskId === id)
		output = `${output}${event.output}`;
	if (
		event.type === "merge_conflict.detected" &&
		event.conflict.taskId === id
	) {
		conflictFiles = event.conflict.files;
		if (task) task = { ...task, status: "merge_conflict" };
	}
	if (
		[
			"task.started",
			"task.completed",
			"task.failed",
			"task.cancelled",
			"task.merged",
			"task.discarded",
		].includes(event.type) &&
		"taskId" in event &&
		event.taskId === id
	)
		refresh();
}

let disposed = false;

function connect() {
	if (disposed) return;
	provisionDaemonToken()
		.then(() => {
			if (disposed) return;
			socket = new WebSocket(websocketUrl(), websocketProtocols());
			socket.onopen = () => {
				connected = true;
				refresh();
			};
			socket.onmessage = (message) => {
				try {
					applyEvent(parseDaemonEvent(JSON.parse(message.data)));
				} catch {}
			};
			socket.onclose = () => {
				connected = false;
				if (!disposed) reconnectTimer = setTimeout(connect, 2000);
			};
		})
		.catch((reason: unknown) => {
			connected = false;
			error =
				reason instanceof Error ? reason.message : "Loom daemon is unavailable";
			unavailable = !task;
			if (!disposed) reconnectTimer = setTimeout(connect, 2000);
		});
}

onMount(() => {
	refresh();
	reviewDiff();
	connect();
	return () => {
		disposed = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		socket?.close();
	};
});

async function runAction(fn: () => Promise<unknown>) {
	action = "Working...";
	try {
		await fn();
		await refresh();
	} catch (reason: unknown) {
		error = reason instanceof Error ? reason.message : "Action failed";
	} finally {
		action = "";
	}
}
const cancel = () => runAction(() => daemon.cancelTask(id));
const retry = () => runAction(() => daemon.retryTask(id));
const merge = () =>
	runAction(async () => {
		const result = await daemon.mergeTask(id);
		if (result.conflict) conflictFiles = result.conflict.files;
	});
const discard = () => runAction(() => daemon.discardTask(id));
const decide = (requestId: string, decision: "allow_once" | "allow" | "deny") =>
	runAction(async () => {
		await daemon.decidePermission(requestId, decision);
	});
</script>

<div class="mx-auto max-w-6xl px-4 py-8 sm:px-6">
	{#if loading}<p class="text-neutral-400">Loading task...</p>{:else if unavailable}<div class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200"><p>{error || "Loom daemon is unavailable"}</p><Button type="submit" class="mt-4 rounded-lg border border-red-800 px-3 py-2" onclick={refresh}>Retry</Button></div>{:else if task}
		<a href={`/project/${task.projectId}`} class="text-sm text-neutral-500 hover:text-neutral-200">← Project</a>
		<div class="mt-8 flex flex-wrap items-start justify-between gap-4"><div><div class="flex items-center gap-2"><span class={`h-2.5 w-2.5 rounded-full ${task.status === "failed" ? "bg-red-400" : task.status === "completed" ? "bg-emerald-400" : "bg-blue-400"}`}></span><span class="text-sm text-neutral-400">{formatStatus(task.status)}</span><span class="text-xs text-neutral-600">{connected ? "Live" : "Reconnecting"}</span></div><h1 class="mt-3 text-3xl font-semibold">{task.title}</h1><p class="mt-3 max-w-3xl whitespace-pre-wrap text-neutral-400">{task.prompt}</p></div><div class="flex flex-wrap gap-2">{#if ["queued", "preparing", "running"].includes(task.status)}<Button type="submit" disabled={!!action} onclick={cancel} class="rounded-lg border border-red-900 px-4 py-2 text-sm text-red-200 disabled:opacity-50">Cancel</Button>{/if}{#if ["failed", "cancelled", "interrupted"].includes(runs.at(-1)?.status ?? task.status)}<Button type="submit" disabled={!!action} onclick={retry} class="rounded-lg border border-blue-800 px-4 py-2 text-sm text-blue-200 disabled:opacity-50">Retry</Button>{/if}{#if task.epicId}<Button href={`/epic/${task.epicId}`} variant="outline">Review Epic</Button>{:else if ["completed", "ready_to_merge", "merge_conflict"].includes(task.status)}<Button type="submit" disabled={!!action} onclick={merge} class="rounded-lg bg-white px-4 py-2 text-sm text-black disabled:opacity-50">Merge</Button><Button type="submit" disabled={!!action} onclick={discard} class="rounded-lg border border-neutral-700 px-4 py-2 text-sm disabled:opacity-50">Discard</Button>{/if}</div></div>
		{#if stale}<p class="mt-4 rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">Showing stale state. Reconnecting to Loom...</p>{/if}{#if error}<p class="mt-4 text-sm text-red-300">{error}</p>{/if}
		{#if permissions.length}<section class="mt-6 rounded-xl border border-amber-800 bg-amber-950/40 p-5 text-amber-100"><h2 class="font-medium">Permission requests</h2>{#each permissions as request}<div class="mt-4 rounded-lg border border-amber-900 p-4"><p class="font-mono text-sm">{request.command}</p><p class="mt-2 text-sm text-amber-200">{request.reason}</p><div class="mt-3 flex gap-2"><Button type="submit" class="rounded border border-emerald-800 px-3 py-1 text-xs" onclick={() => decide(request.id, "allow_once")}>Allow once</Button><Button type="submit" class="rounded border border-blue-800 px-3 py-1 text-xs" onclick={() => decide(request.id, "allow")}>Always allow</Button><Button type="submit" class="rounded border border-red-800 px-3 py-1 text-xs" onclick={() => decide(request.id, "deny")}>Deny</Button></div></div>{/each}</section>{/if}
		{#if conflictFiles.length}<section class="mt-6 rounded-xl border border-amber-800 bg-amber-950/40 p-5 text-amber-200"><h2 class="font-medium">Merge conflict</h2><p class="mt-2 text-sm">Resolve these files in the task worktree before retrying merge.</p><ul class="mt-3 list-disc pl-5 text-sm">{#each conflictFiles as file}<li>{file}</li>{/each}</ul></section>{/if}
		{#if output}<section class="mt-8 space-y-4"><div class="ml-auto max-w-[80%] rounded-xl bg-[#3a2920] px-4 py-3 text-sm text-[#dedcd4]">{task.prompt}</div><div class="max-w-[90%] whitespace-pre-wrap rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-4 text-sm leading-6 text-neutral-300">{output}</div></section>{/if}
		<div class="mt-8 grid gap-6 lg:grid-cols-[280px_1fr]"><aside class="space-y-6"><section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5"><h2 class="mb-4 font-medium">Run history</h2>{#if runs.length === 0}<p class="text-sm text-neutral-500">No runs yet.</p>{:else}<div class="space-y-3">{#each runs as run}<div class="rounded-lg border border-neutral-800 p-3"><p class="font-mono text-xs text-neutral-400">{run.id}</p><p class="mt-1 text-sm">{formatStatus(run.status)}</p><p class="mt-1 text-xs text-neutral-500">{formatDuration(run.startedAt, run.completedAt)}{run.retryOfRunId ? ` · retry of ${run.retryOfRunId}` : ""}</p>{#if run.errorMessage}<p class="mt-2 text-xs text-red-300">{run.errorMessage}</p>{/if}</div>{/each}</div>{/if}</section></aside><section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5"><div class="flex flex-wrap items-center justify-between gap-3"><h2 class="font-medium">Independent diff review</h2><Button type="submit" disabled={diffLoading} onclick={reviewDiff} class="rounded border border-neutral-700 px-3 py-1 text-xs disabled:opacity-50">{diffLoading ? "Loading..." : "Refresh diff"}</Button></div><div class="mt-4 flex gap-4 text-sm text-neutral-400"><span>{stats.files.length} files</span><span>+{stats.additions}</span><span>-{stats.deletions}</span></div><pre class="mt-4 max-h-[600px] overflow-auto rounded-lg bg-neutral-950 p-4 text-xs leading-5 text-neutral-300">{diff || "No changes yet."}</pre></section></div>
	{:else}<div class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200">{error || "Task not found"}</div>{/if}
</div>
