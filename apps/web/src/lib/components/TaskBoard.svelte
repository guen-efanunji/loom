<script lang="ts">
 import type { Task } from "$lib/daemon";
 import { Button } from "$lib/components/ui/button";
 export let tasks: Task[] = [];
 export let onRun: (task: Task) => void = () => {};
 const columns = [{key:"queued",label:"Backlog"},{key:"preparing",label:"Preparing"},{key:"running",label:"In progress"},{key:"ready_to_merge",label:"Review"},{key:"completed",label:"Done"},{key:"failed",label:"Failed"}] as const;
</script>
<div class="grid min-w-[900px] grid-cols-6 gap-3">{#each columns as column}<section class="min-h-40 rounded-xl border border-neutral-800 bg-neutral-950/50 p-3"><div class="mb-3 flex justify-between"><h3 class="text-sm font-medium">{column.label}</h3><span class="text-xs text-neutral-500">{tasks.filter(t => t.status === column.key).length}</span></div>{#each tasks.filter(t => t.status === column.key) as task}<article class="mb-2 rounded-lg border border-neutral-800 bg-neutral-900 p-3"><a href={`/task/${task.id}`} class="line-clamp-2 text-sm font-medium hover:text-blue-300">{task.title}</a><p class="mt-1 line-clamp-2 text-xs text-neutral-500">{task.prompt}</p>{#if column.key === "queued"}<Button class="mt-2 h-7 px-2 text-xs" onclick={() => onRun(task)}>Run</Button>{/if}</article>{/each}</section>{/each}</div>
