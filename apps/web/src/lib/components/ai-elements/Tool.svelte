<script lang="ts">
	let { name = "", status = "idle" } = $props();
</script>

<div class="rounded-md border border-white/10 bg-white/[0.02] px-2 py-1 text-xs text-neutral-300">
	<span class="font-medium">{name}</span>
	<span class="ml-2 text-neutral-500">{status}</span>
</div>