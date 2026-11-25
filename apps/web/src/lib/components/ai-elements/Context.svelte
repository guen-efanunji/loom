<script lang="ts">
	import { Button } from "$lib/components/ui/button";

	let {
		usedTokens,
		windowTokens,
		estimated = false,
		label = "Context usage",
	}: {
		usedTokens: number | null;
		windowTokens: number | null;
		estimated?: boolean;
		label?: string;
	} = $props();

	const percent = $derived(
		usedTokens !== null && windowTokens !== null && windowTokens > 0
			? Math.min(100, (usedTokens / windowTokens) * 100)
			: null,
	);
</script>

<section class="rounded-lg border bg-card/50 p-3" aria-label={label}>
	<div class="mb-3 flex items-center justify-between gap-2">
		<p class="text-xs font-medium">{label}</p>
		<Button variant="outline" size="sm" aria-label={label}>
			{percent === null ? "Usage" : `${Math.round(percent)}%`}
		</Button>
	</div>
	<div class="flex flex-col gap-3">
		<div class="flex items-center justify-between gap-3 text-sm">
			<span class="font-medium">Usage</span>
			<span class="text-muted-foreground">
				{usedTokens === null
					? "Usage unavailable"
					: usedTokens.toLocaleString()}
				{#if windowTokens !== null}
					/ {windowTokens.toLocaleString()}{/if}
			</span>
		</div>
		{#if percent !== null}
			<div
				class="h-2 overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-label="Context used"
				aria-valuemin="0"
				aria-valuemax="100"
				aria-valuenow={Math.round(percent)}
			>
				<div
					class="h-full rounded-full bg-primary"
					style={`width: ${percent}%`}
				></div>
			</div>
			<p class="text-xs text-muted-foreground">
				{percent.toFixed(1)}% of the model context window
				{estimated
					? " · Loom estimate (characters ÷ 4; tokenizer variance applies)"
					: " · Provider-reported input/cache usage"}
			</p>
		{:else if usedTokens !== null && estimated}
			<p class="text-xs text-muted-foreground">
				Loom-estimated request size; tokenizer variance applies. Model context
				window unavailable.
			</p>
		{:else if usedTokens !== null}
			<p class="text-xs text-muted-foreground">
				Provider reported usage; context window size is unavailable.
			</p>
		{:else}
			<p class="text-xs text-muted-foreground">
				No token usage has been reported by the provider for this conversation
				yet.
			</p>
		{/if}
	</div>
</section>
