<script lang="ts">
	import { CircleCheck, CircleDot } from "@lucide/svelte";
	import * as Trace from "$lib/components/ui/trace";

	type Step = { id: string; title: string; href?: string };
	let {
		title = "Task activity",
		status = "completed",
		steps = [],
	} = $props<{
		title?: string;
		status?: "pending" | "running" | "completed" | "error";
		steps?: Step[];
	}>();
</script>

<Trace.Root>
	<Trace.Collapsible
		open={status === "running" || status === "error" || status === "pending"}
	>
		<Trace.CollapsibleTrigger>
			<Trace.Line
				status={status === "running"
					? "running"
					: status === "error"
						? "error"
						: undefined}
			>
				<Trace.Icon
					>{#if status === "completed"}<CircleCheck
							size={14}
						/>{:else}<CircleDot size={14} />{/if}</Trace.Icon
				>
				<Trace.Title>{title}</Trace.Title>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent>
			<Trace.Root>
				{#each steps as step (step.id)}
					{#if step.href}<a href={step.href}>
							<Trace.Line><Trace.Title>{step.title}</Trace.Title></Trace.Line>
						</a>{:else}<Trace.Line
							><Trace.Title>{step.title}</Trace.Title></Trace.Line
						>{/if}
				{/each}
			</Trace.Root>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
