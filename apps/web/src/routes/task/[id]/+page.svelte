<script lang="ts">
import { onMount } from "svelte";
import { page } from "$app/state";
import { Button } from "$lib/components/ui/button";
import {
	type AgentRun,
	type DaemonEvent,
	daemon,
	diffStats,
	formatDuration,
	formatStatus,
	latestDaemonEventCursor,
	type PermissionRequest,
	type ProjectReviewPolicy,
	parseDaemonEvent,
	provisionDaemonToken,
	replayDaemonEvents,
	type Task,
	type TaskReview,
	websocketProtocols,
	websocketUrl,
} from "$lib/daemon";
import TaskRunChat from "../../../components/chat/TaskRunChat.svelte";

let task = $state<Task | null>(null);
let runs = $state<AgentRun[]>([]);
let reviews = $state<TaskReview[]>([]);
let reviewPolicy = $state<ProjectReviewPolicy | null>(null);
let permissions = $state<PermissionRequest[]>([]);
let diff = $state("");
let output = $state("");
let runActivities = $state<
	Array<{
		id: string;
		tool: string;
		status: "running" | "completed" | "error";
		input?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
	}>
>([]);
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
		const [data, taskRuns, pendingPermissions, taskReviews] = await Promise.all(
			[
				daemon.getTask(id),
				daemon.getRuns(id),
				daemon.getPermissions(),
				daemon.getTaskReviews(id),
			],
		);
		task = data;
		void daemon
			.getProjectReviewPolicy(data.projectId)
			.then((result) => (reviewPolicy = result.policy))
			.catch(() => (reviewPolicy = null));
		runs = taskRuns;
		reviews = taskReviews.reviews;
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
		task = {
			...task,
			...event.task,
			position: event.task.position ?? task?.position ?? null,
		};
	if (event.type === "agent.run.created" && event.run.taskId === id)
		runs = [...runs, event.run];
	if (event.type === "agent.run.updated" && event.run.taskId === id)
		runs = runs.map((run) => (run.id === event.run.id ? event.run : run));
	if (event.type === "run.started" && event.taskId === id) {
		output = "";
		runActivities = [];
	}
	if (event.type === "permission.requested" && event.request.taskId === id)
		permissions = [
			...permissions.filter((request) => request.id !== event.request.id),
			event.request,
		];
	if (event.type === "permission.updated" && event.request.taskId === id)
		permissions = permissions.map((request) =>
			request.id === event.request.id ? event.request : request,
		);
	if (event.type === "run.output" && event.taskId === id) {
		output = `${output}${event.output}`;
		if (event.activities) runActivities = event.activities;
	}
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
let replayCursor = 0;

async function recoverEvents() {
	const baseline = replayCursor || (await latestDaemonEventCursor());
	if (!replayCursor) replayCursor = baseline;
	await refresh();
	let after = baseline;
	for (let pageCount = 0; pageCount < 20; pageCount++) {
		const page = await replayDaemonEvents(after, 500);
		for (const item of page.events) {
			applyEvent(item.event);
			replayCursor = Math.max(replayCursor, item.cursor);
		}
		after = page.cursor;
		if (after >= page.highWaterCursor || page.events.length === 0) break;
	}
}

function connect() {
	if (disposed) return;
	provisionDaemonToken()
		.then(() => {
			if (disposed) return;
			socket = new WebSocket(websocketUrl(), websocketProtocols());
			socket.onopen = () => {
				connected = true;
				void recoverEvents().catch(() => refresh());
			};
			socket.onmessage = (message) => {
				try {
					const envelope = JSON.parse(message.data) as {
						replayCursor?: number;
					};
					applyEvent(parseDaemonEvent(envelope));
					if (typeof envelope.replayCursor === "number")
						replayCursor = Math.max(replayCursor, envelope.replayCursor);
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
const checkpoint = () =>
	runAction(async () => {
		const result = await daemon.checkpointTask(id);
		await reviewDiff();
		return result;
	});
const merge = () =>
	runAction(async () => {
		const result = await daemon.mergeTask(id);
		if (result.conflict) conflictFiles = result.conflict.files;
	});
const approveReview = () =>
	runAction(async () => {
		await daemon.approveTaskReview(id);
		reviews = (await daemon.getTaskReviews(id)).reviews;
	});
const discard = () => runAction(() => daemon.discardTask(id));
const decide = (requestId: string, decision: "allow_once" | "allow" | "deny") =>
	runAction(async () => {
		await daemon.decidePermission(requestId, decision);
	});
</script>

<main class="mx-auto w-full max-w-6xl min-w-0 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
	{#if loading}
		<div role="status" class="rounded-xl border bg-card/40 px-5 py-8 text-sm text-muted-foreground">Loading task details…</div>
	{:else if unavailable}
		<section class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200" aria-live="polite">
			<h1 class="text-base font-semibold">Task details are unavailable</h1>
			<p class="mt-2 text-sm leading-6">{error || "Loom daemon is unavailable."}</p>
			<Button type="submit" class="mt-4" onclick={refresh}>Retry</Button>
		</section>
	{:else if task}
		<a href={`/?project=${task.projectId}&view=kanban`} class="inline-flex min-h-8 items-center text-sm text-muted-foreground transition hover:text-foreground">← Back to project board</a>

		<header class="mt-4 rounded-2xl border bg-card/30 p-5 sm:p-6">
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
				<span class={`size-2.5 shrink-0 rounded-full ${task.status === "failed" ? "bg-red-400" : task.status === "completed" ? "bg-emerald-400" : "bg-blue-400"}`} aria-hidden="true"></span>
				<span class="text-sm font-medium">{formatStatus(task.status)}</span>
				<span class={`rounded-full border px-2 py-0.5 text-xs ${connected ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-200"}`}>{connected ? "Live updates" : "Reconnecting…"}</span>
			</div>
			<h1 class="mt-4 break-words text-2xl font-semibold tracking-tight sm:text-3xl">{task.title}</h1>
			<div class="mt-4 max-w-4xl">
				<p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Task brief</p>
				<p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{task.prompt}</p>
			</div>
			<div class="mt-5 flex flex-wrap gap-2 border-t pt-4">
				{#if ["queued", "preparing", "running"].includes(task.status)}
					<Button type="submit" variant="outline" disabled={!!action} onclick={cancel} class="border-red-900 text-red-200 hover:bg-red-950/40">{action ? "Working…" : "Cancel task"}</Button>
				{/if}
				{#if ["failed", "cancelled", "interrupted"].includes(runs.at(-1)?.status ?? task.status)}
					<Button type="submit" variant="outline" disabled={!!action} onclick={retry}>{action ? "Working…" : "Retry task"}</Button>
				{/if}
				{#if task.status === "completed" && task.workspaceId}
					<Button type="submit" variant="outline" disabled={!!action} onclick={checkpoint}>{action ? "Working…" : "Checkpoint output"}</Button>
				{/if}
				{#if task.status === "ready_to_merge"}
					<Button type="submit" variant="outline" disabled={!!action} onclick={approveReview}>{action ? "Working…" : reviewPolicy?.mode === "automatic" ? "Run automated review" : reviewPolicy?.mode === "hybrid" ? "Review, then approve" : "Approve reviewed checkpoint"}</Button>
				{/if}
				{#if ["ready_to_merge", "merge_conflict"].includes(task.status) && reviews.some((review) => review.status === "approved" && review.subjectSha === runs.at(0)?.outputSha)}
					<Button type="submit" disabled={!!action} onclick={merge}>{action ? "Working…" : "Merge approved SHA"}</Button>
					<Button type="submit" variant="outline" disabled={!!action} onclick={discard}>Discard</Button>
				{/if}
			</div>
		</header>

		{#if stale || error}
			<div class="mt-5 space-y-2" aria-live="polite">
				{#if stale}<p class="rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm leading-5 text-amber-200">Showing the latest saved task state while Loom reconnects.</p>{/if}
				{#if error}<p class="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm leading-5 text-red-200">{error}</p>{/if}
			</div>
		{/if}

		{#if permissions.length}
			<section class="mt-6 rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-amber-100 sm:p-5" aria-labelledby="task-permissions-heading">
				<div>
					<h2 id="task-permissions-heading" class="font-semibold">Permission needed</h2>
					<p class="mt-1 text-sm leading-5 text-amber-100/70">The agent is waiting for approval before it can continue.</p>
				</div>
				{#each permissions as request (request.id)}
					<div class="mt-4 rounded-xl border border-amber-900/80 bg-background/20 p-4">
						<p class="text-sm leading-5">{request.reason}</p>
						<p class="mt-2 text-xs text-amber-100/70">Working directory</p>
						<p class="mt-1 break-all font-mono text-xs">{request.cwd}</p>
						<details class="mt-3">
							<summary class="cursor-pointer text-xs text-amber-100/80">View exact command</summary>
							<pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-amber-900/70 bg-background/40 p-3 font-mono text-xs">{request.command}</pre>
						</details>
						<div class="mt-4 flex flex-wrap gap-2">
							<Button type="submit" variant="outline" class="border-emerald-800 text-emerald-200" onclick={() => decide(request.id, "allow_once")}>Allow once</Button>
							<Button type="submit" variant="outline" class="border-blue-800 text-blue-200" onclick={() => decide(request.id, "allow")}>Always allow</Button>
							<Button type="submit" variant="outline" class="border-red-800 text-red-200" onclick={() => decide(request.id, "deny")}>Deny</Button>
						</div>
					</div>
				{/each}
			</section>
		{/if}

		{#if conflictFiles.length}
			<section class="mt-6 rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-amber-200 sm:p-5" aria-labelledby="merge-conflict-heading">
				<h2 id="merge-conflict-heading" class="font-semibold">Merge conflict</h2>
				<p class="mt-2 text-sm leading-5">Resolve these files in the task worktree before retrying the merge.</p>
				<ul class="mt-3 list-disc space-y-1 pl-5 text-sm">{#each conflictFiles as file}<li class="break-all font-mono">{file}</li>{/each}</ul>
			</section>
		{/if}

		<section class="mt-8 rounded-2xl border bg-card/20 p-3 sm:p-5" aria-label="Task progress and agent activity">
			<TaskRunChat task={task} output={output} activities={runActivities} oncancel={() => cancel()} showTaskHeader={false} showTaskBrief={false} wide compact />
		</section>

		{#if reviews.length}
			<section class="mt-8 space-y-3" aria-labelledby="review-history-heading">
				<div>
					<h2 id="review-history-heading" class="text-lg font-semibold">Review history</h2>
					<p class="mt-1 text-sm text-muted-foreground">Results from automated and manual reviews for this task.</p>
				</div>
				{#each reviews as review (review.id)}
					<article class="rounded-xl border bg-card/30 p-4">
						<div class="flex flex-wrap items-center justify-between gap-2 text-sm">
							<span class="font-medium">{review.reviewerIdentity} <span class="font-normal text-muted-foreground">· Policy v{review.policyVersion}</span></span>
							<span class={`rounded-full border px-2 py-0.5 text-xs ${review.status === "approved" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-200"}`}>{review.status.replaceAll("_", " ")}</span>
						</div>
						<details class="mt-3">
							<summary class="cursor-pointer text-xs text-muted-foreground">View review details</summary>
							<pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/60 p-3 text-xs leading-5 text-muted-foreground">{review.verdictJson}</pre>
						</details>
					</article>
				{/each}
			</section>
		{/if}

		<section class="mt-8 space-y-3" aria-labelledby="run-history-heading">
			<div>
				<h2 id="run-history-heading" class="text-lg font-semibold">Run history</h2>
				<p class="mt-1 text-sm text-muted-foreground">Each attempt to complete this task appears here.</p>
			</div>
			{#if runs.length === 0}
				<p class="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No runs have been recorded yet.</p>
			{:else}
				<div class="space-y-2">
					{#each runs as run (run.id)}
						<article class="rounded-xl border bg-card/30 p-4">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<p class="font-mono text-xs text-muted-foreground">Run {run.id}</p>
								<span class="rounded-full border px-2 py-0.5 text-xs">{formatStatus(run.status)}</span>
							</div>
							<p class="mt-2 text-sm text-muted-foreground">Duration: {formatDuration(run.startedAt, run.completedAt)}{run.retryOfRunId ? ` · Retry of ${run.retryOfRunId}` : ""}</p>
							{#if run.errorMessage}<p class="mt-2 rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm leading-5 text-red-200">{run.errorMessage}</p>{/if}
						</article>
					{/each}
				</div>
			{/if}
		</section>

		<section class="mt-8 space-y-3" aria-labelledby="diff-review-heading">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 id="diff-review-heading" class="text-lg font-semibold">Independent diff review</h2>
					<p class="mt-1 text-sm text-muted-foreground">Review the task’s current workspace changes.</p>
				</div>
				<Button type="submit" variant="outline" disabled={diffLoading} onclick={reviewDiff}>{diffLoading ? "Loading diff…" : "Refresh diff"}</Button>
			</div>
			<div class="flex flex-wrap gap-x-5 gap-y-2 rounded-xl border bg-card/30 p-4 text-sm text-muted-foreground" aria-label="Diff summary">
				<span>{stats.files.length} {stats.files.length === 1 ? "file" : "files"}</span>
				<span><span class="text-emerald-400">+{stats.additions}</span> additions</span>
				<span><span class="text-red-400">−{stats.deletions}</span> deletions</span>
			</div>
			<pre class="max-h-[600px] overflow-auto rounded-xl border bg-background/70 p-4 text-xs leading-5 text-muted-foreground">{diff || "No changes yet."}</pre>
		</section>
	{:else}
		<section class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200" role="status">{error || "Task not found."}</section>
	{/if}
</main>
