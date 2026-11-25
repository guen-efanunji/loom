<script lang="ts">
	import { ArrowUpRight, Globe } from "@lucide/svelte";
	import * as Trace from "$lib/components/ui/trace";

	type Source = { url: string; title?: string };

	let { sources = [] }: { sources?: Source[] } = $props<{
		sources?: Source[];
	}>();

	function hostnameOf(url: string) {
		try {
			return new URL(url).hostname;
		} catch {
			return url;
		}
	}
</script>

<Trace.Root>
	<Trace.Collapsible open>
		<Trace.CollapsibleTrigger class="w-full text-left">
			<Trace.Line>
				<Trace.Icon><Globe size={14} /></Trace.Icon>
				<Trace.Title class="min-w-0 flex-1 truncate"
					>Used {sources.length} source{sources.length === 1
						? ""
						: "s"}</Trace.Title
				>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent>
			<Trace.Root>
				{#each sources as source (source.url)}
					<a href={source.url} target="_blank" rel="noreferrer">
						<Trace.Line>
							<Trace.Title class="min-w-0">
								{source.title ?? hostnameOf(source.url)}
								<span class="sr-only"> (opens in a new tab)</span>
							</Trace.Title>
							<Trace.Icon><ArrowUpRight size={14} /></Trace.Icon>
						</Trace.Line>
					</a>
				{/each}
			</Trace.Root>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
