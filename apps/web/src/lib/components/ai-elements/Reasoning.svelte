<script lang="ts">
	import { Check, LoaderCircle } from "@lucide/svelte";
	import * as Trace from "$lib/components/ui/trace";
	import Markdown from "../../../components/chat/Markdown.svelte";

	let {
		content = "",
		running = false,
		open = $bindable<boolean | undefined>(undefined),
	} = $props<{
		content?: string;
		running?: boolean;
		open?: boolean;
	}>();
</script>

{#snippet line()}
	<Trace.Line status={running ? "running" : undefined}>
		<Trace.Icon>
			{#if running}
				<LoaderCircle class="animate-spin" />
			{:else}
				<Check />
			{/if}
		</Trace.Icon>
		<Trace.Title>{running ? "Thinking" : "Thought"}</Trace.Title>
	</Trace.Line>
{/snippet}

{#if content.length === 0}
	{@render line()}
{:else}
	<Trace.Collapsible
		open={open ?? running}
		onOpenChange={(value) => (open = value)}
	>
		<Trace.CollapsibleTrigger>{@render line()}</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="whitespace-pre-wrap">
			<Markdown text={content} />
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
{/if}
