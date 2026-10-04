<script lang="ts">
import { GripVertical, Pencil, Plus, Trash2 } from "@lucide/svelte";
import { toast } from "svelte-sonner";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import { Textarea } from "$lib/components/ui/textarea";
import { daemon, type Task } from "$lib/daemon";

let {
	projectId,
	tasks = [],
	onChanged,
}: {
	projectId: string;
	tasks?: Task[];
	onChanged?: () => unknown;
} = $props();

const columns = [
	{ key: "queued", label: "Backlog" },
	{ key: "ready", label: "Ready" },
	{ key: "running", label: "In progress" },
	{ key: "review", label: "Review" },
	{ key: "done", label: "Done" },
	{ key: "failed", label: "Failed / cancelled" },
];

function column(task: Task) {
	if (task.status === "queued" || task.status === "blocked") return "queued";
	if (task.status === "ready") return "ready";
	if (["preparing", "running"].includes(task.status)) return "running";
	if (
		["ready_to_merge", "merge_conflict"].includes(task.status) ||
		(task.status === "completed" && task.workspaceId)
	)
		return "review";
	return task.status === "completed" ? "done" : "failed";
}

function orderKey(task: Task) {
	return task.position ?? Number.MAX_SAFE_INTEGER;
}

const ordered = $derived(
	[...tasks].sort(
		(a, b) =>
			orderKey(a) - orderKey(b) || a.createdAt.localeCompare(b.createdAt),
	),
);

let dragId = $state("");
let overId = $state("");
let busy = $state(false);
let addOpen = $state(false);
let addTitle = $state("");
let addPrompt = $state("");
let editTask = $state<Task | null>(null);
let editTitle = $state("");
let editPrompt = $state("");
let deleteTask = $state<Task | null>(null);

async function refresh() {
	await onChanged?.();
}

async function persist(order: Task[]) {
	busy = true;
	try {
		await daemon.reorderTasks(
			projectId,
			order.map((task) => task.id),
		);
		await refresh();
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Reorder failed");
		await refresh();
	} finally {
		busy = false;
	}
}

function move(draggedId: string, targetId: string | null) {
	const dragged = ordered.find((task) => task.id === draggedId);
	if (!dragged) return;
	if (targetId) {
		const target = ordered.find((task) => task.id === targetId);
		if (!target || target.id === draggedId) return;
		if (column(target) !== column(dragged)) {
			toast.info(
				"Drag to reorder within a column. Use Run or Retry to change status.",
			);
			return;
		}
		const next = ordered.filter((task) => task.id !== draggedId);
		next.splice(next.indexOf(target), 0, dragged);
		void persist(next);
		return;
	}
	const next = [...ordered.filter((task) => task.id !== draggedId), dragged];
	void persist(next);
}

function onDragStart(event: DragEvent, id: string) {
	dragId = id;
	overId = "";
	event.dataTransfer?.setData("text/plain", id);
	if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragEnd() {
	dragId = "";
	overId = "";
}

async function doAdd() {
	if (!addTitle.trim() || !addPrompt.trim() || busy) return;
	busy = true;
	try {
		await daemon.createTask({
			projectId,
			title: addTitle.trim(),
			prompt: addPrompt.trim(),
		});
		addTitle = "";
		addPrompt = "";
		addOpen = false;
		toast.success("Task added");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to add task",
		);
	} finally {
		busy = false;
	}
}

function openEdit(task: Task) {
	editTask = task;
	editTitle = task.title;
	editPrompt = task.prompt;
}

async function doEdit() {
	if (!editTask || !editTitle.trim() || busy) return;
	busy = true;
	try {
		await daemon.renameTask(editTask.id, {
			title: editTitle.trim(),
			prompt: editPrompt.trim() || undefined,
		});
		editTask = null;
		toast.success("Task updated");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to update task",
		);
	} finally {
		busy = false;
	}
}

async function doDelete() {
	if (!deleteTask || busy) return;
	busy = true;
	try {
		await daemon.deleteTask(deleteTask.id);
		deleteTask = null;
		toast.success("Task deleted");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to delete task",
		);
	} finally {
		busy = false;
	}
}

async function doRun(task: Task) {
	busy = true;
	try {
		await daemon.startTask(task.id);
		toast.success("Task started");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to start task",
		);
	} finally {
		busy = false;
	}
}

async function doRetry(task: Task) {
	busy = true;
	try {
		await daemon.retryTask(task.id);
		toast.success("Task queued for retry");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to retry task",
		);
	} finally {
		busy = false;
	}
}

async function doCancel(task: Task) {
	busy = true;
	try {
		await daemon.cancelTask(task.id);
		toast.success("Task cancelled");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to cancel task",
		);
	} finally {
		busy = false;
	}
}
</script>

<div class="flex h-full flex-col gap-4">
	<div class="flex items-center justify-between gap-2">
		<p class="text-sm text-muted-foreground">{tasks.length} tasks · drag cards to reorder</p>
		<Button size="sm" onclick={() => { addTitle = ""; addPrompt = ""; addOpen = true; }} disabled={busy}><Plus size={15} />Add task</Button>
	</div>
	<div class="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-x-auto md:grid-cols-3 xl:grid-cols-6">
		{#each columns as item}
			{@const cards = ordered.filter((task) => column(task) === item.key)}
			<section
				aria-label={`${item.label} column`}
				class="flex min-h-44 flex-col rounded-xl border bg-muted/20 p-3"
				ondragover={(event) => event.preventDefault()}
				ondrop={(event) => {
					event.preventDefault();
					if (dragId) move(dragId, null);
					onDragEnd();
				}}
			>
				<div class="mb-3 flex items-center justify-between gap-2">
					<h3 class="text-sm font-medium">{item.label}</h3>
					<Badge variant="secondary">{cards.length}</Badge>
				</div>
				<div class="min-h-10 flex-1 space-y-2">
					{#each cards as task (task.id)}
						<article
							draggable="true"
							aria-label={`Task ${task.title}`}
							class={`space-y-2 rounded-lg border bg-card p-3 shadow-sm transition ${dragId === task.id ? "opacity-40" : ""} ${overId === task.id ? "border-primary ring-1 ring-primary" : ""}`}
							ondragstart={(event) => onDragStart(event, task.id)}
							ondragend={onDragEnd}
							ondragover={(event) => {
								event.preventDefault();
								event.stopPropagation();
								if (task.id !== dragId) overId = task.id;
							}}
							ondrop={(event) => {
								event.preventDefault();
								event.stopPropagation();
								if (dragId) move(dragId, task.id);
								onDragEnd();
							}}
						>
							<div class="flex items-start gap-1">
								<span class="mt-0.5 cursor-grab text-muted-foreground" title="Drag to reorder" aria-hidden="true"><GripVertical size={14} /></span>
								<p class="min-w-0 flex-1 text-sm font-medium break-words">{task.title}</p>
								<Button variant="ghost" size="icon" class="size-7 shrink-0" title="Edit task" aria-label={`Edit ${task.title}`} onclick={() => openEdit(task)}><Pencil size={13} /></Button>
								<Button variant="ghost" size="icon" class="size-7 shrink-0 text-destructive" title="Delete task" aria-label={`Delete ${task.title}`} onclick={() => (deleteTask = task)}><Trash2 size={13} /></Button>
							</div>
							<p class="line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>
							<div class="flex flex-wrap items-center gap-1">
								{#if task.source === "planner"}<Badge variant="outline" class="text-[10px]">AI Planned</Badge>{/if}
								{#if task.status === "blocked"}<Badge variant="secondary" class="text-[10px] text-amber-300">Blocked</Badge>{/if}
								{#if task.acceptanceCriteria.length}<span class="text-[10px] text-muted-foreground">✓ {task.acceptanceCriteria.length} checks</span>{/if}
							</div>
							{#if task.planId}<a class="text-[11px] text-muted-foreground hover:underline" href={`/plans/${task.planId}`}>Generated from plan →</a>{/if}
							<div class="flex flex-wrap gap-1">
								{#if ["queued", "ready"].includes(task.status)}<Button size="sm" variant="outline" disabled={busy} onclick={() => doRun(task)}>Run</Button>{/if}
								{#if ["failed", "cancelled"].includes(task.status)}<Button size="sm" variant="outline" disabled={busy} onclick={() => doRetry(task)}>Retry</Button>{/if}
								{#if ["queued", "preparing", "running"].includes(task.status)}<Button size="sm" variant="ghost" disabled={busy} onclick={() => doCancel(task)}>Cancel</Button>{/if}
								<Button size="sm" variant="ghost" href={`/task/${task.id}`}>Open</Button>
							</div>
						</article>
					{/each}
					{#if !cards.length}<p class="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">Drop here</p>{/if}
				</div>
			</section>
		{/each}
	</div>
</div>

<AlertDialog.Root bind:open={addOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Add task</AlertDialog.Title>
			<AlertDialog.Description>Create a queued task for this project.</AlertDialog.Description>
		</AlertDialog.Header>
		<div class="space-y-3">
			<Input aria-label="Task title" bind:value={addTitle} maxlength={200} placeholder="Task title" />
			<Textarea aria-label="Task prompt" bind:value={addPrompt} rows={4} placeholder="What should the agent do?" />
		</div>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<Button onclick={() => void doAdd()} disabled={!addTitle.trim() || !addPrompt.trim() || busy}>{busy ? "Adding…" : "Add task"}</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root open={!!editTask} onOpenChange={(open) => { if (!open) editTask = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Edit task</AlertDialog.Title>
			<AlertDialog.Description>Update the title or instructions. Prompt edits are blocked while running.</AlertDialog.Description>
		</AlertDialog.Header>
		<div class="space-y-3">
			<Input aria-label="Task title" bind:value={editTitle} maxlength={200} placeholder="Task title" />
			<Textarea aria-label="Task prompt" bind:value={editPrompt} rows={5} placeholder="Task instructions" />
		</div>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<Button onclick={() => void doEdit()} disabled={!editTitle.trim() || busy}>{busy ? "Saving…" : "Save changes"}</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root open={!!deleteTask} onOpenChange={(open) => { if (!open) deleteTask = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete task?</AlertDialog.Title>
			<AlertDialog.Description>“{deleteTask?.title}” and its workspace will be removed permanently. Active runs are cancelled first.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => void doDelete()} disabled={busy}>{busy ? "Deleting…" : "Delete task"}</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
