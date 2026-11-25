<script lang="ts">
	import { Button } from "$lib/components/ui/button";

	let {
		suggestions = [],
		onselect,
	}: {
		suggestions?: string[];
		onselect?: (prompt: string) => void;
	} = $props<{
		suggestions?: string[];
		onselect?: (prompt: string) => void;
	}>();
</script>

{#if suggestions.length}
	<div
		class="scrollbar-none flex scroll-fade-x gap-2 overflow-x-auto overscroll-x-contain py-1"
	>
		{#each suggestions as suggestion, index (index)}
			<Button
				variant="outline"
				size="sm"
				class="shrink-0"
				onclick={() => onselect?.(suggestion)}
			>
				{suggestion}
			</Button>
		{/each}
	</div>
{/if}
