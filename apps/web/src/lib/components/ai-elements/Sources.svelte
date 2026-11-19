<script lang="ts">
	let { items = [] } = $props();
</script>

<ul class="text-xs text-neutral-400">
	{#each items as item (item.url ?? item.title)}
		<li>{item.title ?? item.url}</li>
	{/each}
</ul>