<script lang="ts">
import { onMount } from "svelte";
import { page } from "$app/state";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import { Input } from "$lib/components/ui/input";
import { Textarea } from "$lib/components/ui/textarea";
import {
	type AutomationPlanDetail,
	daemon,
	formatStatus,
	type PlanTaskDraft,
	type Task,
} from "$lib/daemon";

let detail = $state<AutomationPlanDetail | null>(null);
let draft = $state<PlanTaskDraft[]>([]);
let title = $state("");
let summary = $state("");
let error = $state("");
let busy = $state("");
let saved = $state("");
let initialized = false;
let disposed = false;
let refreshing = false;
const id = $derived(page.params.id ?? "");
const editable = $derived(
	detail !== null &&
		["draft", "validated", "failed"].includes(detail.plan.status),
);
const approved = $derived(
	detail !== null &&
		["approved", "executing", "completed"].includes(detail.plan.status),
);

async function refresh() {
	if (refreshing || disposed) return;
	refreshing = true;
	try {
		const next = await daemon.getPlanDetail(id);
		if (disposed) return;
		detail = next;
		if (!initialized) {
			draft = structuredClone(next.draft);
			title = next.plan.title;
			summary = next.plan.summary;
			initialized = true;
		}
	} catch (e) {
		if (!disposed)
			error = e instanceof Error ? e.message : "Unable to load plan";
	} finally {
		refreshing = false;
	}
}

async function action(name: string, work: () => Promise<unknown>) {
	if (busy) return;
	busy = name;
	error = "";
	saved = "";
	try {
		await work();
		await refresh();
	} catch (e) {
		error = e instanceof Error ? e.message : "Operation failed";
	} finally {
		busy = "";
	}
}

async function save() {
	await daemon.savePlan(id, { title, summary, tasks: draft });
	saved = "Plan saved and revalidated";
}

function add() {
	let n = draft.length + 1;
	while (draft.some((t) => t.key === `task_${n}`)) n++;
	draft.push({
		key: `task_${n}`,
		title: "",
		description: "",
		priority: "medium",
		dependencies: [],
		acceptanceCriteria: [""],
		suggestedFiles: [],
	});
}

function remove(key: string) {
	draft = draft
		.filter((t) => t.key !== key)
		.map((t) => ({
			...t,
			dependencies: t.dependencies.filter((d) => d !== key),
		}));
}

async function retry(task: Task) {
	await action("retry", () => daemon.retryTask(task.id));
}

onMount(() => {
	refresh();
	const timer = setInterval(refresh, 3000);
	return () => {
		disposed = true;
		clearInterval(timer);
	};
});
</script>

<main class="mx-auto max-w-[1100px] px-4 py-8 sm:px-6">
	{#if error}<p role="alert" class="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-4 text-red-200">{error}</p>{/if}
	{#if !detail}
		<p class="text-muted-foreground">Loading plan…</p>
		<Button variant="outline" onclick={refresh}>Refresh</Button>
	{:else}
		<a href={`/project/${detail.plan.projectId}`} class="text-sm text-muted-foreground">← Project board</a>
		<header class="my-6 flex flex-wrap items-center justify-between gap-4">
			<div>
				<h1 class="text-3xl font-semibold">{detail.plan.title}</h1>
				<p class="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-muted-foreground">{detail.plan.summary || "Planner is still working on this plan."}</p>
			</div>
			<div class="flex items-center gap-2">
				<Badge variant="outline">{formatStatus(detail.plan.status)}</Badge>
				<Badge variant="secondary">{detail.progress.done} / {detail.progress.total} done</Badge>
			</div>
		</header>
		{#if detail.plan.errorMessage}<p class="mb-4 rounded-lg border border-amber-800 p-3 text-sm text-amber-200">{detail.plan.errorMessage}</p>{/if}
		{#if detail.plan.status === "draft" && !detail.draft.length}<p class="rounded-xl border p-6">OpenCode is preparing the plan. This page updates automatically.</p>{/if}
		{#if editable}
			<section class="space-y-4 rounded-xl border bg-card p-5">
				<div><h2 class="text-xl font-medium">Review proposed plan</h2><p class="text-sm text-muted-foreground">Rename tasks, edit descriptions and acceptance criteria, change priority and dependencies.</p></div>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="block text-sm">Plan title<Input aria-label="Plan title" bind:value={title} maxlength={200} /></label>
				</div>
				<label class="block text-sm">Summary<Textarea aria-label="Plan summary" bind:value={summary} rows={3} /></label>
				{#each draft as task, index (task.key)}
					<article class="space-y-3 rounded-lg border bg-background p-4">
						<div class="flex items-center gap-3">
							<Badge variant="outline">{task.key}</Badge>
							<Input aria-label={`Task ${index + 1} title`} bind:value={task.title} placeholder="Task title" maxlength={200} />
							<Button variant="ghost" disabled={!!busy} onclick={() => remove(task.key)}>Remove</Button>
						</div>
						<Textarea aria-label={`Task ${index + 1} description`} bind:value={task.description} rows={3} placeholder="Scope, deliverables, and context" />
						<div class="grid gap-3 sm:grid-cols-2">
							<label class="block text-sm">Priority
								<select aria-label={`Task ${index + 1} priority`} bind:value={task.priority} class="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm">
									<option value="low">Low</option>
									<option value="medium">Medium</option>
									<option value="high">High</option>
								</select>
							</label>
							<label class="block text-sm">Suggested files (comma separated)
								<Input aria-label={`Task ${index + 1} suggested files`} value={task.suggestedFiles.join(", ")} oninput={(event) => { task.suggestedFiles = event.currentTarget.value.split(",").map((s) => s.trim()).filter(Boolean); }} placeholder="index.html, styles.css" />
							</label>
						</div>
						<div class="space-y-2">
							<span class="text-sm text-muted-foreground">Acceptance criteria</span>
							{#each task.acceptanceCriteria as criterion, ci}
								<div class="flex items-center gap-2">
									<Input aria-label={`Task ${index + 1} criterion ${ci + 1}`} value={criterion} oninput={(event) => { task.acceptanceCriteria[ci] = event.currentTarget.value; }} placeholder="Measurable check" />
									<Button variant="ghost" size="sm" onclick={() => { task.acceptanceCriteria = task.acceptanceCriteria.filter((_, i) => i !== ci); }}>Remove</Button>
								</div>
							{/each}
							<Button variant="ghost" size="sm" onclick={() => { task.acceptanceCriteria = [...task.acceptanceCriteria, ""]; }}>Add criterion</Button>
						</div>
						<div class="flex flex-wrap items-center gap-3 text-sm">
							<span class="text-muted-foreground">Depends on:</span>
							{#each draft.filter((t) => t.key !== task.key) as other}
								<label class="flex items-center gap-2">
									<Checkbox
										checked={task.dependencies.includes(other.key)}
										onCheckedChange={(checked) => {
											task.dependencies = checked
												? [...task.dependencies, other.key]
												: task.dependencies.filter((k) => k !== other.key);
										}}
									/>{other.title || other.key}
								</label>
							{/each}
							{#if draft.length === 1}<span class="text-muted-foreground">Independent</span>{/if}
						</div>
					</article>
				{/each}
				<Button variant="outline" onclick={add} disabled={!!busy}>Add task</Button>
				<div class="flex flex-wrap items-center gap-3">
					<Button variant="outline" disabled={!!busy} onclick={() => action("save", save)}>Save plan</Button>
					<Button disabled={!!busy} onclick={() => action("approve", () => daemon.approvePlan(id))}>{busy === "approve" ? "Approving…" : "Approve plan"}</Button>
					<span class="text-sm text-muted-foreground">{saved}</span>
				</div>
			</section>
		{/if}
		{#if approved}
			<section class="my-6 space-y-4 rounded-xl border p-5">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div><h2 class="text-xl font-medium">Kanban tasks</h2><p class="text-sm text-muted-foreground">{detail.progress.done} of {detail.progress.total} done · {detail.progress.running} running · {detail.progress.ready} ready · {detail.progress.blocked} blocked</p></div>
					<div class="flex flex-wrap gap-2">
						{#if !detail.plan.convertedAt}
							<Button disabled={!!busy} onclick={() => action("convert", () => daemon.convertPlan(id))}>{busy === "convert" ? "Converting…" : "Add to Kanban"}</Button>
						{:else}
							<Button disabled={!!busy} onclick={() => action("start", () => daemon.startPlan(id))}>{busy === "start" ? "Starting…" : "Start ready tasks"}</Button>
						{/if}
					</div>
				</div>
				<ul class="space-y-2 text-sm">
					{#each detail.tasks as task}
						<li class="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2">
							<Badge variant="outline">{formatStatus(task.status)}</Badge>
							<span class="min-w-0 flex-1 font-medium">{task.title}</span>
							{#if task.blockedBy.length}<span class="text-xs text-amber-300">Blocked by: {task.blockedBy.join(", ")}</span>{/if}
							<Button size="sm" variant="ghost" href={`/task/${task.id}`}>Open</Button>
							{#if ["failed", "cancelled"].includes(task.status)}<Button size="sm" variant="outline" onclick={() => retry(task)}>Retry</Button>{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</main>
