<script lang="ts">
	import { CircleAlert, CircleCheck, CircleDot } from "@lucide/svelte";
	import * as Trace from "$lib/components/ui/trace";

	type Step = {
		id: string;
		title: string;
		status?: "running" | "completed" | "error";
	};
	let {
		name = "Subagent",
		status = "completed",
		steps = [],
		summary = "",
		onopen,
	} = $props<{
		name?: string;
		status?: "running" | "completed" | "error";
		steps?: Step[];
		summary?: string;
		onopen?: () => void;
	}>();
</script>

<Trace.Root>
	<Trace.Collapsible open={status === "running" || status === "error"}>
		<Trace.CollapsibleTrigger>
			<Trace.Line
				status={status === "running"
					? "running"
					: status === "error"
						? "error"
						: undefined}
			>
				<Trace.Icon
					>{#if status === "error"}<CircleAlert
							size={14}
						/>{:else if status === "completed"}<CircleCheck
							size={14}
						/>{:else}<CircleDot size={14} />{/if}</Trace.Icon
				>
				<Trace.Title
					>{status === "running"
						? "Running"
						: status === "error"
							? "Failed"
							: "Ran"}
					{name}</Trace.Title
				>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="flex flex-col gap-2">
			{#if steps.length}<Trace.Root>
					{#each steps as step (step.id)}<Trace.Line
							status={step.status === "running"
								? "running"
								: step.status === "error"
									? "error"
									: undefined}
							><Trace.Icon
								>{#if step.status === "completed"}<CircleCheck
										size={14}
									/>{:else if step.status === "error"}<CircleAlert
										size={14}
									/>{:else}<CircleDot size={14} />{/if}</Trace.Icon
							><Trace.Title>{step.title}</Trace.Title></Trace.Line
						>{/each}
				</Trace.Root>{/if}
			{#if summary}<p class="text-xs text-muted-foreground">{summary}</p>{/if}
			{#if onopen}<button
					type="button"
					class="w-fit text-xs text-primary underline-offset-4 hover:underline"
					onclick={onopen}>Open subagent chat</button
				>{/if}
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
