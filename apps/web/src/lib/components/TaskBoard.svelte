<script lang="ts">
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import type { Task } from "$lib/daemon";

type BoardTask = Task & { blockedBy?: string[] };
let {
	tasks = [],
	onRun,
	onRetry,
	onCancel,
}: {
	tasks?: BoardTask[];
	onRun?: (task: Task) => unknown;
	onRetry?: (task: Task) => unknown;
	onCancel?: (task: Task) => unknown;
} = $props();
const columns = [
	{ key: "queued", label: "Backlog" },
	{ key: "blocked", label: "Blocked" },
	{ key: "running", label: "In progress" },
	{ key: "review", label: "Review" },
	{ key: "done", label: "Done" },
	{ key: "failed", label: "Failed / cancelled" },
];
function column(task: BoardTask) {
	if (task.integrated) return "done";
	if (task.status === "queued")
		return task.blockedBy?.length ? "blocked" : "queued";
	if (["preparing", "running"].includes(task.status)) return "running";
	if (
		["ready_to_merge", "merge_conflict"].includes(task.status) ||
		(task.status === "completed" && task.workspaceId)
	)
		return "review";
	return task.status === "completed" ? "done" : "failed";
}
</script>
<div class="grid min-w-[1100px] grid-cols-6 gap-3">{#each columns as item}<section class="min-h-44 rounded-xl border bg-muted/20 p-3"><div class="mb-3 flex justify-between gap-2"><h3 class="text-sm font-medium">{item.label}</h3><Badge variant="secondary">{tasks.filter(t => column(t) === item.key).length}</Badge></div>{#each tasks.filter(t => column(t) === item.key) as task (task.id)}<article class="mb-2 space-y-2 rounded-lg border bg-card p-3 shadow-sm"><a href={`/task/${task.id}`} class="line-clamp-2 text-sm font-medium hover:underline">{task.title}</a><p class="line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>{#if task.blockedBy?.length && task.status === "queued"}<p class="text-xs text-amber-300">Waiting for: {task.blockedBy.join(", ")}</p>{/if}<div class="flex flex-wrap gap-1">{#if item.key === "queued" && onRun}<Button size="sm" variant="outline" onclick={() => onRun?.(task)}>Run</Button>{/if}{#if item.key === "failed" && onRetry}<Button size="sm" variant="outline" onclick={() => onRetry?.(task)}>Retry</Button>{/if}{#if ["queued", "preparing", "running"].includes(task.status) && onCancel}<Button size="sm" variant="ghost" onclick={() => onCancel?.(task)}>Cancel</Button>{/if}<Button size="sm" variant="ghost" href={`/task/${task.id}`}>Open</Button></div></article>{/each}</section>{/each}</div>
