<script lang="ts">
	let { items = [] } = $props();
</script>

<ul class="text-xs text-neutral-400">
	{#each items as item (item)}
		<li>{item}</li>
	{/each}
</ul>
