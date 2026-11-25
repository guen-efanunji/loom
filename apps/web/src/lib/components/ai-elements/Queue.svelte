<script lang="ts">
	import {
		Circle,
		CircleCheck,
		CircleDot,
		ListChecks,
		ListTodo,
	} from "@lucide/svelte";
	import * as Trace from "$lib/components/ui/trace";

	type Item = {
		id: string;
		title: string;
		status: "pending" | "in_progress" | "completed";
	};
	let { items = $bindable<Item[]>([]), running = false } = $props<{
		items?: Item[];
		running?: boolean;
	}>();
	const todo = $derived(
		items.filter((item: Item) => item.status !== "completed"),
	);
	const completed = $derived(
		items.filter((item: Item) => item.status === "completed"),
	);
</script>

<Trace.Root>
	{#if todo.length}<Trace.Collapsible open>
			<Trace.CollapsibleTrigger
				><Trace.Line
					><Trace.Icon><ListTodo size={14} /></Trace.Icon><Trace.Title
						>{todo.length} to do</Trace.Title
					></Trace.Line
				></Trace.CollapsibleTrigger
			>
			<Trace.CollapsibleContent
				><Trace.Root>
					{#each todo as item (item.id)}
						<Trace.Line
							status={item.status === "in_progress" && running
								? "running"
								: undefined}
						>
							<Trace.Icon
								>{#if item.status === "in_progress"}<CircleDot
										size={14}
									/>{:else}<Circle size={14} />{/if}</Trace.Icon
							>
							<Trace.Title>{item.title}</Trace.Title>
						</Trace.Line>
					{/each}
				</Trace.Root></Trace.CollapsibleContent
			>
		</Trace.Collapsible>{/if}
	{#if completed.length}<Trace.Collapsible>
			<Trace.CollapsibleTrigger
				><Trace.Line
					><Trace.Icon><ListChecks size={14} /></Trace.Icon><Trace.Title
						>{completed.length} completed</Trace.Title
					></Trace.Line
				></Trace.CollapsibleTrigger
			>
			<Trace.CollapsibleContent
				><Trace.Root>
					{#each completed as item (item.id)}<Trace.Line
							><Trace.Icon><CircleCheck size={14} /></Trace.Icon><Trace.Title
								>{item.title}</Trace.Title
							></Trace.Line
						>{/each}
				</Trace.Root></Trace.CollapsibleContent
			>
		</Trace.Collapsible>{/if}
</Trace.Root>
