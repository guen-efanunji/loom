<script lang="ts">
	let { steps = [] } = $props();
</script>

<div class="text-xs text-neutral-400">
	{#each steps as step, i (i)}
		<div>{i + 1}. {step}</div>
	{/each}
</div>
