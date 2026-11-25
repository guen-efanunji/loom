<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as Marker from "$lib/components/ui/marker";

	let {
		label,
		canRestore = false,
		onrestore,
	}: {
		label: string;
		canRestore?: boolean;
		onrestore?: () => void;
	} = $props();
</script>

<Marker.Root variant="separator" class="my-3">
	<Marker.Content
		class="inline-flex items-center gap-2 text-xs text-muted-foreground"
	>
		<span>Checkpoint · {label}</span>
		{#if onrestore}
			<Button
				disabled={!canRestore}
				size="sm"
				variant="outline"
				class="h-7 px-2 text-xs"
				aria-label={`Return conversation to ${label}`}
				onclick={onrestore}>Restore</Button
			>
		{/if}
	</Marker.Content>
</Marker.Root>
