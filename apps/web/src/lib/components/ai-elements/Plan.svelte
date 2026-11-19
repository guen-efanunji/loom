<script lang="ts">
	let { steps = [] } = $props();
</script>

<ol class="list-decimal pl-4 text-xs text-neutral-300">
	{#each steps as step (step)}
		<li>{step}</li>
	{/each}
</ol>
