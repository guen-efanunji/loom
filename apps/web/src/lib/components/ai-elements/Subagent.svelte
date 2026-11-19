<script lang="ts">
	let { name = "", status = "idle" } = $props();
</script>

<div class="text-xs text-neutral-300">Subagent {name}: {status}</div>