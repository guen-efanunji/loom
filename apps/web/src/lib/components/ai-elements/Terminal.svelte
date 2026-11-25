<script lang="ts">
	import { Terminal as TerminalIcon } from "@lucide/svelte";
	import * as CodeBlock from "$lib/components/ui/code-block";
	import * as Trace from "$lib/components/ui/trace";

	let {
		command = "Command",
		output = "",
		status = "completed",
		error = "",
	} = $props<{
		command?: string;
		output?: string;
		status?: "running" | "completed" | "error";
		error?: string;
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
				<Trace.Icon><TerminalIcon size={14} /></Trace.Icon>
				<Trace.Title
					>{status === "running"
						? "Running"
						: status === "error"
							? "Failed"
							: "Ran"}
					{command}</Trace.Title
				>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="space-y-2 pt-2">
			{#if output}<CodeBlock.Root size="sm"
					><CodeBlock.Content
						wrap
						class="max-h-64"
						code={output}
					/></CodeBlock.Root
				>{/if}
			{#if error}<p class="text-sm text-destructive" role="alert">
					{error}
				</p>{/if}
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
