<script lang="ts">
	import * as HoverCard from "$lib/components/ui/hover-card";
	import { Button } from "$lib/components/ui/button";

	type Source = {
		url: string;
		title?: string;
		description?: string;
	};

	let { source }: { source: Source } = $props<{ source: Source }>();

	const host = $derived(
		(() => {
			try {
				return new URL(source.url).hostname.replace(/^www\./, "");
			} catch {
				return source.url;
			}
		})(),
	);
</script>

<HoverCard.Root openDelay={10} closeDelay={100}>
	<HoverCard.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="secondary" size="xs" class="max-w-40">
				<span class="truncate">{host}</span>
			</Button>
		{/snippet}
	</HoverCard.Trigger>
	<HoverCard.Content class="flex w-64 flex-col gap-1">
		<div class="font-medium">{source.title ?? host}</div>
		{#if source.description}
			<p class="text-muted-foreground">{source.description}</p>
		{/if}
		<a
			href={source.url}
			target="_blank"
			rel="noreferrer"
			class="text-xs text-muted-foreground underline-offset-4 hover:underline"
		>
			{host}
			<span class="sr-only"> (opens in a new tab)</span>
		</a>
	</HoverCard.Content>
</HoverCard.Root>
