<script lang="ts">
	let { results = [] } = $props();
</script>

<div class="text-xs text-neutral-400">
	{#each results as r (r)}
		<div>{r}</div>
	{/each}
</div>
