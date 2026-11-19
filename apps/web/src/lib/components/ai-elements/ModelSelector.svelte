<script lang="ts">
	let { models = [], value = $bindable("") } = $props();
</script>

<select
	bind:value
	class="h-8 rounded-md border border-white/10 bg-white/[0.03] px-2 text-xs text-neutral-200"
>
	{#each models as m (m.id)}
		<option value={m.id}>{m.name ?? m.id}</option>
	{/each}
</select>