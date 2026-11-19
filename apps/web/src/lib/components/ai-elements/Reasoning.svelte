<script lang="ts">
	let { content = "", open = $bindable(false) } = $props();
</script>

<div class="rounded-lg border border-white/10 bg-white/[0.03]">
	<button
		type="button"
		class="flex w-full items-center justify-between px-3 py-2 text-xs text-neutral-300 hover:bg-white/[0.05]"
		onclick={() => (open = !open)}
		aria-expanded={open}
	>
		<span class="font-medium">Reasoning</span>
		<span class="text-neutral-500">{open ? "Hide" : "Show"}</span>
	</button>
	{#if open}
		<div class="border-t border-white/[0.08] px-3 py-2 text-xs text-neutral-400 whitespace-pre-wrap">
			{content}
		</div>
	{/if}
</div>