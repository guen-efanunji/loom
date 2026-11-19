<script lang="ts">
	let { files = [] } = $props();
</script>

<ul class="text-xs text-neutral-400">
	{#each files as file (file)}
		<li>{file}</li>
	{/each}
</ul>
