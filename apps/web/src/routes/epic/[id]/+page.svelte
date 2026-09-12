<script lang="ts">
import type { ProjectContext, TaskPlan } from "@loom/protocol";
import { onMount } from "svelte";
import { page } from "$app/state";
import TaskBoard from "$lib/components/TaskBoard.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import { Input } from "$lib/components/ui/input";
import { Textarea } from "$lib/components/ui/textarea";
import { daemon, type EpicDetail, formatStatus, type Task } from "$lib/daemon";

let epic = $state<EpicDetail | null>(null);
let draft = $state<TaskPlan>({ tasks: [] });
let context = $state<ProjectContext>({ summary: "", commands: {} });
let error = $state("");
let busy = $state("");
let saved = $state("");
let initialized = false;
let disposed = false;
let refreshing = false;
let reviewed = $state(false);
const id = $derived(page.params.id ?? "");
const editable = $derived(
	epic && !epic.approvedAt && ["ready", "failed"].includes(epic.status),
);
const latest = $derived(epic?.integrations[0]);
const completed = $derived(
	epic?.tasks.filter((m) => m.task?.status === "completed").length ?? 0,
);
async function refresh() {
	if (refreshing || disposed) return;
	refreshing = true;
	try {
		const next = await daemon.getEpicDetail(id);
		if (disposed) return;
		if (next.integrations[0]?.head !== epic?.integrations[0]?.head)
			reviewed = false;
		epic = next;
		if (!initialized && next.plan) {
			draft = structuredClone(next.plan);
			context = structuredClone(next.context ?? { summary: "", commands: {} });
			initialized = true;
		}
	} catch (e) {
		if (!disposed)
			error = e instanceof Error ? e.message : "Unable to load Epic";
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
	await daemon.saveEpicPlan(id, draft, context);
	saved = "Plan saved";
}
function add() {
	let n = draft.tasks.length + 1;
	while (draft.tasks.some((t) => t.key === `task_${n}`)) n++;
	draft.tasks.push({ key: `task_${n}`, title: "", prompt: "", dependsOn: [] });
}
function remove(key: string) {
	draft.tasks = draft.tasks
		.filter((t) => t.key !== key)
		.map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== key) }));
}
async function retry(task: Task) {
	await action("retry", () => daemon.retryTask(task.id));
}
onMount(() => {
	refresh();
	const timer = setInterval(refresh, 2000);
	return () => {
		disposed = true;
		clearInterval(timer);
	};
});
</script>

<main class="mx-auto max-w-[1500px] px-4 py-8 sm:px-6">
 {#if error}<p role="alert" class="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-4 text-red-200">{error}</p>{/if}
 {#if !epic}<p class="text-muted-foreground">Loading Epic…</p><Button variant="outline" onclick={refresh}>Refresh</Button>
 {:else}
  <a href={`/project/${epic.projectId}`} class="text-sm text-muted-foreground">← Project board</a>
  <header class="my-6 flex flex-wrap items-center justify-between gap-4"><div><h1 class="text-3xl font-semibold">{epic.title}</h1><p class="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-muted-foreground">{epic.prompt}</p></div><Badge variant="outline">{formatStatus(epic.status)}</Badge></header>
  {#if epic.errorMessage}<p class="mb-4 rounded-lg border border-amber-800 p-3 text-sm text-amber-200">{epic.errorMessage}</p>{/if}
  {#if epic.status === "planning"}<p class="rounded-xl border p-6">OpenCode is preparing the plan. This page updates automatically; you can return later.</p>{/if}
  {#if editable}
   <section class="space-y-4 rounded-xl border bg-card p-5">
    <div class="flex flex-wrap items-center justify-between gap-2"><div><h2 class="text-xl font-medium">Review proposed plan</h2><p class="text-sm text-muted-foreground">Edit scope and dependencies before starting agents.</p></div><Button variant="outline" disabled={!!busy} onclick={() => action("replan", async () => { await daemon.replanEpic(id); initialized = false; })}>Regenerate plan</Button></div>
    {#each draft.tasks as task, index (task.key)}
     <article class="space-y-3 rounded-lg border bg-background p-4">
      <div class="flex items-center gap-3"><Badge variant="outline">{task.key}</Badge><Input aria-label={`Task ${index + 1} title`} bind:value={task.title} placeholder="Task title" maxlength={200} /><Button variant="ghost" disabled={!!busy} onclick={() => remove(task.key)}>Remove</Button></div>
      <Textarea aria-label={`Task ${index + 1} prompt`} bind:value={task.prompt} rows={3} placeholder="Deliverables, scope, and acceptance checks" />
      <div class="flex flex-wrap items-center gap-3 text-sm"><span class="text-muted-foreground">Depends on:</span>{#each draft.tasks.filter(t => t.key !== task.key) as other}<label class="flex items-center gap-2"><Checkbox checked={task.dependsOn.includes(other.key)} onCheckedChange={checked => { task.dependsOn = checked ? [...task.dependsOn, other.key] : task.dependsOn.filter(k => k !== other.key); }} />{other.title || other.key}</label>{/each}{#if draft.tasks.length === 1}<span class="text-muted-foreground">Independent</span>{/if}</div>
     </article>
    {/each}
    <Button variant="outline" onclick={add} disabled={!!busy}>Add task</Button>
    <details class="rounded-lg border p-4"><summary class="cursor-pointer font-medium">Project context and validation commands</summary><div class="mt-4 space-y-3"><Textarea aria-label="Project context" bind:value={context.summary} rows={5} />{#each ["install", "lint", "test", "build"] as name}<label class="block text-sm">{name}<Input aria-label={`${name} command`} value={context.commands[name as keyof ProjectContext["commands"]] ?? ""} oninput={event => { context.commands[name as keyof ProjectContext["commands"]] = event.currentTarget.value; }} placeholder={`Optional ${name} command`} /></label>{/each}<p class="text-xs text-muted-foreground">Starting approves these commands in the integration workspace. Empty commands are skipped.</p></div></details>
    <div class="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={!!busy} onclick={() => action("save", save)}>Save plan</Button><Button disabled={!!busy || !draft.tasks.length} onclick={() => action("start", async () => { await save(); await daemon.startEpic(id); })}>{busy === "start" ? "Starting…" : "Approve plan & start"}</Button><span class="text-sm text-muted-foreground">{saved}</span></div>
   </section>
  {/if}
  {#if epic.approvedAt}
   <section class="my-6"><div class="mb-3 flex justify-between"><h2 class="text-xl font-medium">Tasks</h2><span class="text-muted-foreground">{completed} / {epic.tasks.length} completed</span></div>
    <div class="overflow-x-auto"><TaskBoard tasks={epic.tasks.flatMap(m => m.task ? [{ ...m.task, blockedBy: m.blockedBy }] : [])} onRetry={retry} onCancel={task => action("cancel", () => daemon.cancelTask(task.id))} /></div>
    <details class="mt-3 rounded-lg border p-4"><summary class="cursor-pointer">Dependency graph</summary><ul class="mt-3 space-y-2 text-sm">{#each epic.plan?.tasks ?? [] as task}<li><span class="font-medium">{task.title}</span> ← {task.dependsOn.join(", ") || "Independent"}</li>{/each}</ul></details>
   </section>
   <section class="my-6 space-y-4 rounded-xl border p-5">
    <div class="flex flex-wrap justify-between gap-3"><div><h2 class="text-xl font-medium">Integration review</h2><p class="text-sm text-muted-foreground">Combined changes and checks are preserved for review.</p></div>{#if epic.status !== "completed"}<Button variant="outline" disabled={!!busy || completed !== epic.tasks.length || ["merging", "checking", "resolving"].includes(latest?.status ?? "")} onclick={() => action("integrate", () => daemon.integrateEpic(id))}>Run integration again</Button>{/if}</div>
    {#if !latest}<p class="text-sm text-muted-foreground">Integration starts automatically when all tasks complete.</p>
    {:else}
     <Badge variant="outline">{formatStatus(latest.status)}</Badge>
     {#if latest.errorMessage}<p class="text-sm text-red-300">{latest.errorMessage}</p>{/if}
     {#if latest.workspacePath}<p class="break-all text-xs text-muted-foreground">{latest.workspacePath}</p>{/if}
     {#if latest.sessionId}<Button variant="outline" href={`/?session=${latest.sessionId}`}>Open repair conversation / permissions</Button><p class="text-xs text-muted-foreground">Review the proposed changes below before approving.</p>{/if}
     {#each latest.checks as check}<details class="rounded-lg border p-3"><summary class="cursor-pointer text-sm">{check.exitCode === 0 ? "✓" : "✗"} {check.name} · {check.command} · exit {check.exitCode}</summary><pre class="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{check.output || "No output"}</pre></details>{/each}
     {#if latest.status === "review" && !latest.checks.length}<p class="text-sm text-amber-200">No validation commands were configured in the approved plan.</p>{/if}
     <details open class="rounded-lg border p-3"><summary class="cursor-pointer font-medium">Combined diff</summary><pre class="mt-3 max-h-[600px] overflow-auto text-xs">{latest.diff || "No diff available yet"}</pre></details>
     {#if latest.status === "review"}<label class="flex items-center gap-2 text-sm"><Checkbox bind:checked={reviewed} />I reviewed the combined diff, checks, and any AI resolution.</label><Button disabled={!reviewed || !!busy || !latest.head} onclick={() => action("approve", () => daemon.approveIntegration(latest!.id, latest!.head!))}>{busy === "approve" ? "Merging…" : "Approve & merge"}</Button>{/if}
    {/if}
   </section>
  {/if}
  {#if epic.artifacts.length}<section class="my-6 rounded-xl border p-5"><h2 class="mb-3 text-xl font-medium">Handoff artifacts</h2>{#each epic.artifacts as artifact}<article class="mb-3 text-sm"><Badge variant="outline">{artifact.type}</Badge> <code>{artifact.path}</code><p class="mt-1 text-muted-foreground">{artifact.summary}</p></article>{/each}</section>{/if}
  <details class="rounded-xl border p-5"><summary class="cursor-pointer font-medium">Audit history ({epic.events.length})</summary><ol class="mt-4 space-y-3">{#each epic.events as event}<li class="text-sm"><span class="font-medium">{event.type}</span> <span class="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</span><pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{event.detail}</pre></li>{/each}</ol></details>
 {/if}
</main>
