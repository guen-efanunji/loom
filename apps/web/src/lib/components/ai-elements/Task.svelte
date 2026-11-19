<script lang="ts">
	let { title = "", status = "pending" } = $props();
</script>

<div class="text-xs text-neutral-300">{title} — {status}</div>
