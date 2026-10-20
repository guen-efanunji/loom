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
	type TaskArtifact,
	type TaskDependency,
	type TaskReview,
	websocketProtocols,
	websocketUrl,
} from "$lib/daemon";

let task = $state<Task | null>(null);
let runs = $state<AgentRun[]>([]);
let dependencies = $state<TaskDependency[]>([]);
let reviews = $state<TaskReview[]>([]);
let reviewPolicy = $state<ProjectReviewPolicy | null>(null);
let artifacts = $state<TaskArtifact[]>([]);
let dependencyArtifacts = $state<TaskArtifact[]>([]);
let projectTasks = $state<Task[]>([]);
let dependencyProducerId = $state("");
let dependencyMilestone = $state<TaskDependency["requiredMilestone"]>(
	"implementation_ready",
);
let dependencyArtifactId = $state("");
let artifactKind = $state<
	"contract" | "generated_client" | "schema" | "evidence"
>("contract");
let artifactVersion = $state("v1");
let artifactPath = $state("");
let permissions = $state<PermissionRequest[]>([]);
let diff = $state("");
let output = $state("");
let runActivities = $state<
	Array<{ id: string; tool: string; status: "running" | "completed" | "error" }>
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
		const [
			data,
			taskRuns,
			pendingPermissions,
			taskEdges,
			allTasks,
			taskReviews,
			taskArtifacts,
		] = await Promise.all([
			daemon.getTask(id),
			daemon.getRuns(id),
			daemon.getPermissions(),
			daemon.getTaskDependencies(id),
			daemon.listTasks(),
			daemon.getTaskReviews(id),
			daemon.getTaskArtifacts(id),
		]);
		task = data;
		void daemon
			.getProjectReviewPolicy(data.projectId)
			.then((result) => (reviewPolicy = result.policy))
			.catch(() => (reviewPolicy = null));
		runs = taskRuns;
		dependencies = taskEdges.dependencies;
		reviews = taskReviews.reviews;
		artifacts = taskArtifacts.artifacts;
		projectTasks = allTasks.filter(
			(item) => item.projectId === data.projectId && item.id !== data.id,
		);
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
const addDependency = () =>
	runAction(async () => {
		if (!dependencyProducerId) throw new Error("Select a producer task first");
		await daemon.addTaskDependency(id, {
			dependsOnTaskId: dependencyProducerId,
			requiredMilestone: dependencyMilestone,
			...(dependencyArtifactId ? { artifactId: dependencyArtifactId } : {}),
		});
		dependencyProducerId = "";
		dependencyArtifactId = "";
	});
async function loadDependencyArtifacts(producerId: string) {
	dependencyArtifactId = "";
	dependencyArtifacts = producerId
		? (await daemon.getTaskArtifacts(producerId)).artifacts
		: [];
}
const publishArtifact = () =>
	runAction(async () => {
		await daemon.publishTaskArtifact(id, {
			kind: artifactKind,
			version: artifactVersion,
			relativePath: artifactPath,
		});
		artifactPath = "";
		artifacts = (await daemon.getTaskArtifacts(id)).artifacts;
	});
const removeDependency = (producerId: string) =>
	runAction(() => daemon.removeTaskDependency(id, producerId));
const decide = (requestId: string, decision: "allow_once" | "allow" | "deny") =>
	runAction(async () => {
		await daemon.decidePermission(requestId, decision);
	});
</script>

<div class="mx-auto max-w-6xl px-4 py-8 sm:px-6">
	{#if loading}<p class="text-neutral-400">Loading task...</p>{:else if unavailable}<div class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200"><p>{error || "Loom daemon is unavailable"}</p><Button type="submit" class="mt-4 rounded-lg border border-red-800 px-3 py-2" onclick={refresh}>Retry</Button></div>{:else if task}
		<a href={`/?project=${task.projectId}&view=kanban`} class="text-sm text-neutral-500 hover:text-neutral-200">← Project board</a>
<header class="mt-7 rounded-2xl border border-neutral-800 bg-neutral-900/70 p-5 sm:p-7"><div class="flex flex-wrap items-start justify-between gap-6"><div class="min-w-0 flex-1"><h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">{task.title}</h1><div class="mt-4 flex flex-wrap items-center gap-2"><span class={`h-2.5 w-2.5 rounded-full ${task.status === "failed" ? "bg-red-400" : task.status === "completed" ? "bg-emerald-400" : "bg-blue-400"}`}></span><span class="rounded-full border border-neutral-700 bg-neutral-950 px-3 py-1 text-sm font-medium text-neutral-200">{formatStatus(task.status)}</span><span class="text-xs text-neutral-500">{connected ? "Live updates connected" : "Reconnecting to live updates"}</span></div><div class="mt-6 border-t border-neutral-800 pt-4"><h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-500">Task brief</h2><p class="mt-2 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-neutral-300">{task.prompt || "No task brief was provided."}</p></div></div><div class="flex flex-wrap gap-2 sm:max-w-sm sm:justify-end">{#if ["queued", "preparing", "running"].includes(task.status)}<Button type="submit" disabled={!!action} onclick={cancel} class="rounded-lg border border-red-900 px-4 py-2 text-sm text-red-200 disabled:opacity-50">Cancel</Button>{/if}{#if ["failed", "cancelled", "interrupted"].includes(runs.at(-1)?.status ?? task.status)}<Button type="submit" disabled={!!action} onclick={retry} class="rounded-lg border border-blue-800 px-4 py-2 text-sm text-blue-200 disabled:opacity-50">Retry</Button>{/if}{#if task.status === "completed" && task.workspaceId}<Button type="submit" disabled={!!action} onclick={checkpoint} class="rounded-lg border border-blue-800 px-4 py-2 text-sm text-blue-200 disabled:opacity-50">Checkpoint output</Button>{/if}{#if task.status === "ready_to_merge"}<Button type="submit" disabled={!!action} onclick={approveReview} class="rounded-lg border border-emerald-800 px-4 py-2 text-sm text-emerald-200 disabled:opacity-50">{reviewPolicy?.mode === "automatic" ? "Run automated review" : reviewPolicy?.mode === "hybrid" ? "Review, then approve" : "Approve reviewed checkpoint"}</Button>{/if}{#if ["ready_to_merge", "merge_conflict"].includes(task.status) && reviews.some((review) => review.status === "approved" && review.subjectSha === runs.at(0)?.outputSha)}<Button type="submit" disabled={!!action} onclick={merge} class="rounded-lg bg-white px-4 py-2 text-sm text-black disabled:opacity-50">Merge approved SHA</Button><Button type="submit" disabled={!!action} onclick={discard} class="rounded-lg border border-neutral-700 px-4 py-2 text-sm disabled:opacity-50">Discard</Button>{/if}</div></div>
{#if reviews.length}<section class="mt-5 space-y-2 rounded-xl border border-neutral-800 p-4"><h2 class="text-sm font-medium">Review history</h2>{#each reviews as review (review.id)}<div class="rounded-lg bg-neutral-900 p-3"><div class="flex items-center justify-between text-xs"><span>{review.reviewerIdentity} · policy v{review.policyVersion}</span><span class={review.status === "approved" ? "text-emerald-400" : "text-amber-400"}>{review.status.replaceAll("_", " ")}</span></div><pre class="mt-2 whitespace-pre-wrap text-xs text-neutral-400">{review.verdictJson}</pre></div>{/each}</section>{/if}
		{#if stale}<p class="mt-4 rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">Showing stale state. Reconnecting to Loom...</p>{/if}{#if error}<p class="mt-4 text-sm text-red-300">{error}</p>{/if}
		{#if permissions.length}<section class="mt-6 rounded-xl border border-amber-800 bg-amber-950/40 p-5 text-amber-100"><h2 class="font-medium">Permission requests</h2>{#each permissions as request}<div class="mt-4 rounded-lg border border-amber-900 p-4"><p class="font-mono text-sm">{request.command}</p><p class="mt-2 text-sm text-amber-200">{request.reason}</p><div class="mt-3 flex flex-wrap gap-2"><Button type="submit" class="rounded border border-emerald-800 px-3 py-1 text-xs" onclick={() => decide(request.id, "allow_once")}>Allow once</Button><Button type="submit" class="rounded border border-blue-800 px-3 py-1 text-xs" onclick={() => decide(request.id, "allow")}>Always allow</Button><Button type="submit" class="rounded border border-red-800 px-3 py-1 text-xs" onclick={() => decide(request.id, "deny")}>Deny</Button></div></div>{/each}</section>{/if}
		{#if conflictFiles.length}<section class="mt-6 rounded-xl border border-amber-800 bg-amber-950/40 p-5 text-amber-200"><h2 class="font-medium">Merge conflict</h2><p class="mt-2 text-sm">Resolve these files in the task worktree before retrying merge.</p><ul class="mt-3 list-disc pl-5 text-sm">{#each conflictFiles as file}<li>{file}</li>{/each}</ul></section>{/if}
		<section class="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-4 sm:p-5"><h2 class="font-medium">Task dependencies</h2><p class="mt-1 text-sm text-neutral-500">Pin consumers to a producer milestone or an immutable contract/schema artifact.</p>{#if dependencies.length}<div class="mt-4 space-y-2">{#each dependencies as dependency}<div class="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 p-3"><div><p class="text-sm">{dependency.producer?.title ?? dependency.dependsOnTaskId}</p><p class="text-xs text-neutral-500">{dependency.requiredMilestone.replaceAll("_", " ")}{dependency.artifact ? ` · ${dependency.artifact.kind} ${dependency.artifact.version}` : ""}</p></div><Button type="submit" variant="ghost" disabled={!!action} onclick={() => removeDependency(dependency.dependsOnTaskId)}>Remove</Button></div>{/each}</div>{/if}<div class="mt-4 flex flex-wrap gap-2"><select aria-label="Producer task" class="w-full sm:w-auto sm:min-w-52 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm" bind:value={dependencyProducerId} onchange={(event) => void loadDependencyArtifacts(event.currentTarget.value)}><option value="">Select producer task</option>{#each projectTasks as candidate}<option value={candidate.id}>{candidate.title}</option>{/each}</select><select aria-label="Required milestone" class="w-full sm:w-auto rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm" bind:value={dependencyMilestone}><option value="implementation_ready">Implementation ready</option><option value="integrated">Integrated</option><option value="contract_published">Contract published</option><option value="artifact_ready">Artifact ready</option></select>{#if ["contract_published", "artifact_ready"].includes(dependencyMilestone)}<select aria-label="Pinned artifact" class="w-full sm:w-auto sm:min-w-48 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm" bind:value={dependencyArtifactId}><option value="">Select immutable artifact</option>{#each dependencyArtifacts as artifact}<option value={artifact.id}>{artifact.kind} {artifact.version} · {artifact.relativePath}</option>{/each}</select>{/if}<Button type="submit" disabled={!!action || !dependencyProducerId || (["contract_published", "artifact_ready"].includes(dependencyMilestone) && !dependencyArtifactId)} onclick={addDependency}>Add dependency</Button></div></section>
		<section class="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-4 sm:p-5"><h2 class="font-medium">Published artifacts</h2><p class="mt-1 text-sm text-neutral-500">Artifacts reference files in the current clean checkpoint SHA; Loom stores their content hash and immutable Git location.</p>{#if artifacts.length}<div class="mt-3 space-y-2">{#each artifacts as artifact}<div class="rounded-lg border border-neutral-800 p-3"><p class="text-sm">{artifact.kind} {artifact.version}</p><p class="mt-1 font-mono text-xs text-neutral-500">{artifact.relativePath} · {artifact.commitSha.slice(0, 10)}</p></div>{/each}</div>{/if}{#if task.status === "ready_to_merge"}<div class="mt-4 flex flex-wrap gap-2"><select aria-label="Artifact kind" class="w-full sm:w-auto rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm" bind:value={artifactKind}><option value="contract">Contract</option><option value="generated_client">Generated client</option><option value="schema">Schema</option><option value="evidence">Evidence</option></select><input aria-label="Artifact version" class="w-full sm:w-24 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm" bind:value={artifactVersion} placeholder="v1"/><input aria-label="Artifact file path" class="w-full sm:min-w-52 sm:flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm" bind:value={artifactPath} placeholder="docs/api/openapi.yaml"/><Button type="submit" disabled={!!action || !artifactPath.trim() || !artifactVersion.trim()} onclick={publishArtifact}>Publish artifact</Button></div>{/if}</section>
		{#if output || runActivities.length || task.status === "running" || task.status === "preparing"}
			<section class="mt-8 space-y-4">
				<div class="ml-auto max-w-[95%] sm:max-w-[80%] rounded-xl bg-[#3a2920] px-4 py-3 text-sm text-[#dedcd4]">{task.prompt}</div>
				{#if runActivities.length}
					<div class="w-full sm:max-w-[90%] rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3">
						<p class="mb-2 text-xs font-medium text-neutral-400">Agent activity</p>
						<div class="flex flex-wrap gap-2">{#each runActivities as activity (activity.id)}<span class="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300">{activity.tool} · {activity.status}</span>{/each}</div>
					</div>
				{/if}
				<div aria-live="polite" class="w-full sm:max-w-[90%] whitespace-pre-wrap rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-4 text-sm leading-6 text-neutral-300">{output || "Agent is working… waiting for the first progress update."}</div>
			</section>
		{/if}
		<div class="mt-8 grid gap-6 lg:grid-cols-[280px_1fr]"><aside class="space-y-6"><section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5"><h2 class="mb-4 font-medium">Run history</h2>{#if runs.length === 0}<p class="text-sm text-neutral-500">No runs yet.</p>{:else}<div class="space-y-3">{#each runs as run}<div class="rounded-lg border border-neutral-800 p-3"><p class="font-mono text-xs text-neutral-400">{run.id}</p><p class="mt-1 text-sm">{formatStatus(run.status)}</p><p class="mt-1 text-xs text-neutral-500">{formatDuration(run.startedAt, run.completedAt)}{run.retryOfRunId ? ` · retry of ${run.retryOfRunId}` : ""}</p>{#if run.errorMessage}<p class="mt-2 text-xs text-red-300">{run.errorMessage}</p>{/if}</div>{/each}</div>{/if}</section></aside><section class="rounded-xl border border-neutral-800 bg-neutral-900 p-5"><div class="flex flex-wrap items-center justify-between gap-3"><h2 class="font-medium">Independent diff review</h2><Button type="submit" disabled={diffLoading} onclick={reviewDiff} class="rounded border border-neutral-700 px-3 py-1 text-xs disabled:opacity-50">{diffLoading ? "Loading..." : "Refresh diff"}</Button></div><div class="mt-4 flex gap-4 text-sm text-neutral-400"><span>{stats.files.length} files</span><span>+{stats.additions}</span><span>-{stats.deletions}</span></div><pre class="mt-4 max-h-[600px] overflow-auto rounded-lg bg-neutral-950 p-4 text-xs leading-5 text-neutral-300">{diff || "No changes yet."}</pre></section></div>
	{:else}<div class="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200">{error || "Task not found"}</div>{/if}
</div>
