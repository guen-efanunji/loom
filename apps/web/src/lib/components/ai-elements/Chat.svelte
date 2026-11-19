<script lang="ts">
	let { children } = $props();
</script>

<div class="flex flex-col gap-2">{@render children?.()}</div>