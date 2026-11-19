<script lang="ts">
	let { message = "", onConfirm, onCancel } = $props();
</script>

<div
	class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200"
>
	<p>{message}</p>
	<div class="mt-2 flex gap-2">
		<button
			type="button"
			class="rounded-md bg-amber-500/20 px-2 py-1"
			onclick={onConfirm}>Confirm</button
		>
		<button
			type="button"
			class="rounded-md bg-white/10 px-2 py-1"
			onclick={onCancel}>Cancel</button
		>
	</div>
</div>
