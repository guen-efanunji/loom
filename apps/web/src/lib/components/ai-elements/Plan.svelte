<script lang="ts">
	import { Circle, CircleCheck, CircleDot, ListTodo } from "@lucide/svelte";
	import * as Trace from "$lib/components/ui/trace";

	type Step = {
		id: string;
		title: string;
		status: "pending" | "running" | "completed";
	};
	let {
		title = "Plan",
		steps = $bindable<Step[]>([]),
		open = $bindable(true),
	} = $props<{
		title?: string;
		steps?: Step[];
		open?: boolean;
	}>();
	const completed = $derived(
		steps.filter((step: Step) => step.status === "completed").length,
	);
	const status = $derived(
		steps.some((step: Step) => step.status === "running")
			? "running"
			: undefined,
	);
</script>

<Trace.Root>
	<Trace.Collapsible {open} onOpenChange={(value) => (open = value)}>
		<Trace.CollapsibleTrigger>
			<Trace.Line {status}>
				<Trace.Icon><ListTodo size={14} /></Trace.Icon>
				<Trace.Title>{title}</Trace.Title>
				<Trace.Description>{completed} of {steps.length} done</Trace.Description
				>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent>
			<Trace.Root>
				{#each steps as step (step.id)}
					<Trace.Line
						status={step.status === "running"
							? "running"
							: step.status === "pending"
								? "pending"
								: undefined}
					>
						<Trace.Icon>
							{#if step.status === "completed"}<CircleCheck
									size={14}
								/>{:else if step.status === "running"}<CircleDot
									size={14}
								/>{:else}<Circle size={14} />{/if}
						</Trace.Icon>
						<Trace.Title>{step.title}</Trace.Title>
					</Trace.Line>
				{/each}
			</Trace.Root>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
