<script lang="ts">
import {
	CircleCheck,
	LoaderCircle,
	OctagonX,
	TriangleAlert,
} from "@lucide/svelte";
import { onDestroy, onMount } from "svelte";
import { toast } from "svelte-sonner";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import {
	type AgentRun,
	daemon,
	type PermissionRequest,
	type Task,
} from "$lib/daemon";

let {
	tasks = [],
	projectId = "",
	onChanged,
}: {
	tasks?: Task[];
	projectId?: string;
	onChanged?: () => unknown;
} = $props();

type PlanProgress = {
	id: string;
	title: string;
	status: string;
	progress: {
		total: number;
		done: number;
		running: number;
		ready: number;
		blocked: number;
		failed: number;
		percent: number;
	};
};
let plans = $state<PlanProgress[]>([]);

let runs = $state<Record<string, AgentRun[]>>({});
let outputs = $state<Record<string, string>>({});
let permissions = $state<PermissionRequest[]>([]);
let now = $state(Date.now());
let loading = $state(true);
let disposed = false;
let timer: ReturnType<typeof setTimeout>;
let clock: ReturnType<typeof setInterval>;

const active = $derived(
	tasks.filter((task) =>
		["queued", "preparing", "running"].includes(task.status),
	),
);
const finished = $derived(
	tasks
		.filter((task) =>
			["completed", "failed", "cancelled"].includes(task.status),
		)
		.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
		.slice(0, 10),
);

function elapsed(startedAt: string | null) {
	if (!startedAt) return "—";
	const seconds = Math.max(
		0,
		Math.floor((now - new Date(startedAt).getTime()) / 1000),
	);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function statusVariant(status: string) {
	if (status === "running" || status === "preparing") return "default";
	if (status === "completed") return "secondary";
	if (status === "queued") return "outline";
	return "destructive";
}

async function load() {
	try {
		const watched = [...active.slice(0, 8), ...finished.slice(0, 6)];
		const [runEntries, outputEntries, pending, planList] = await Promise.all([
			Promise.all(
				watched.map(
					async (task) => [task.id, await daemon.getRuns(task.id)] as const,
				),
			),
			Promise.all(
				active.slice(0, 5).map(async (task) => {
					try {
						return [task.id, (await daemon.getOutput(task.id)).output] as const;
					} catch {
						return [task.id, ""] as const;
					}
				}),
			),
			daemon.getPermissions(),
			projectId ? daemon.listPlans(projectId).catch(() => []) : [],
		]);
		if (disposed) return;
		runs = Object.fromEntries(runEntries);
		outputs = Object.fromEntries(outputEntries);
		permissions = pending;
		plans = planList;
		await onChanged?.();
	} catch (reason) {
		if (!disposed)
			toast.error(
				reason instanceof Error ? reason.message : "Unable to load progress",
			);
	} finally {
		if (!disposed) loading = false;
	}
}

async function decide(id: string, decision: "allow_once" | "allow" | "deny") {
	try {
		await daemon.decidePermission(id, decision);
		toast.success("Permission decided");
		await load();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to decide permission",
		);
	}
}

function schedule() {
	if (disposed) return;
	timer = setTimeout(async () => {
		await load();
		schedule();
	}, 3000);
}

onMount(() => {
	void load();
	schedule();
	clock = setInterval(() => {
		now = Date.now();
	}, 1000);
});

onDestroy(() => {
	disposed = true;
	clearTimeout(timer);
	clearInterval(clock);
});
</script>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
	{#if loading}
		<div role="status" class="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><LoaderCircle size={17} class="animate-spin" />Loading progress…</div>
	{:else}
			{#if plans.length}
			<section aria-label="Plan progress">
				<h2 class="mb-3 text-sm font-medium">Plans</h2>
				<div class="space-y-2">
					{#each plans as plan}
						<a href={`/plans/${plan.id}`} class="block rounded-xl border bg-card p-4 hover:border-muted-foreground">
							<div class="flex flex-wrap items-center gap-2">
								<p class="min-w-0 flex-1 truncate text-sm font-medium">{plan.title}</p>
								<Badge variant="outline">{plan.status}</Badge>
								<span class="text-xs text-muted-foreground">{plan.progress.done} / {plan.progress.total} done · {plan.progress.percent}%</span>
							</div>
							<div class="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={plan.progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${plan.title} progress`}>
								<div class="h-full rounded-full bg-emerald-400" style={`width: ${plan.progress.percent}%`}></div>
							</div>
							<p class="mt-2 text-xs text-muted-foreground">{plan.progress.running} running · {plan.progress.ready} ready · {plan.progress.blocked} blocked · {plan.progress.failed} failed</p>
						</a>
					{/each}
				</div>
			</section>
		{/if}
		{#if permissions.length}
			<section aria-label="Waiting for you">
				<h2 class="mb-3 flex items-center gap-2 text-sm font-medium"><TriangleAlert size={15} class="text-amber-400" />Waiting for you<Badge variant="secondary">{permissions.length}</Badge></h2>
				<div class="space-y-2">
					{#each permissions as request}
						<div class="rounded-xl border border-amber-500/30 bg-card p-4">
							<p class="font-mono text-xs break-all">{request.command}</p>
							<p class="mt-1 text-xs text-muted-foreground">{request.reason}</p>
							<div class="mt-3 flex flex-wrap gap-2">
								<Button size="sm" onclick={() => decide(request.id, "allow_once")}>Allow once</Button>
								<Button variant="outline" size="sm" onclick={() => decide(request.id, "allow")}>Always allow</Button>
								<Button variant="ghost" size="sm" onclick={() => decide(request.id, "deny")}>Deny</Button>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}
		<section aria-label="Now running">
			<h2 class="mb-3 flex items-center gap-2 text-sm font-medium"><LoaderCircle size={15} class="text-sky-400" />Now running<Badge variant="secondary">{active.length}</Badge></h2>
			{#if !active.length}
				<p class="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Nothing running. Start a task from the Kanban board or send a chat.</p>
			{:else}
				<div class="space-y-3">
					{#each active as task (task.id)}
						{@const output = outputs[task.id] ?? ""}
						{@const tail = output.slice(-800)}
						{@const taskRuns = runs[task.id] ?? []}
						<article class="rounded-xl border bg-card p-4">
							<div class="flex flex-wrap items-center gap-2">
								<Badge variant={statusVariant(task.status)}>{task.status}</Badge>
								<p class="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</p>
								<span class="text-xs text-muted-foreground">⏱ {elapsed(task.startedAt)}</span>
								<Button size="sm" variant="ghost" href={task.sessionId ? `/?session=${encodeURIComponent(task.sessionId)}` : `/task/${task.id}`}>Open</Button>
							</div>
							{#if taskRuns.length}
								<p class="mt-2 text-xs text-muted-foreground">Run {taskRuns.length} · {taskRuns[taskRuns.length - 1]?.status}{taskRuns[taskRuns.length - 1]?.errorMessage ? ` · ${taskRuns[taskRuns.length - 1]?.errorMessage}` : ""}</p>
							{/if}
							{#if tail}
								<pre class="mt-3 max-h-40 overflow-auto rounded-lg bg-background p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">{tail}</pre>
							{:else}
								<p class="mt-3 text-xs text-muted-foreground">{task.status === "queued" ? "Waiting for a free runner…" : "Preparing workspace…"}</p>
							{/if}
						</article>
					{/each}
				</div>
			{/if}
		</section>
		<section aria-label="Recently finished">
			<h2 class="mb-3 flex items-center gap-2 text-sm font-medium"><CircleCheck size={15} class="text-emerald-400" />Recently finished</h2>
			{#if !finished.length}
				<p class="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No finished tasks yet.</p>
			{:else}
				<div class="space-y-2">
					{#each finished as task (task.id)}
						<div class="flex items-center gap-2 rounded-xl border bg-card px-4 py-3">
							{#if task.status === "completed"}<CircleCheck size={15} class="shrink-0 text-emerald-400" />{:else}<OctagonX size={15} class="shrink-0 text-red-400" />{/if}
							<p class="min-w-0 flex-1 truncate text-sm">{task.title}</p>
							<span class="hidden text-xs text-muted-foreground sm:inline">⏱ {elapsed(task.startedAt)}</span>
							<Button size="sm" variant="ghost" href={`/task/${task.id}`}>Review</Button>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</div>
