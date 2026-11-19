<script lang="ts">
	let { text = "", onclick } = $props();
</script>

<button
	type="button"
	class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-neutral-300 hover:bg-white/[0.08]"
	onclick={onclick}
>
	{text}
</button>