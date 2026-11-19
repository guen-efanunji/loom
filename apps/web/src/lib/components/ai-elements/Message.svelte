<script lang="ts">
	let { role = "assistant", content = "" } = $props();
</script>

<div class={`rounded-lg px-3 py-2 text-sm ${role === "user" ? "bg-white/[0.08] text-white" : "bg-white/[0.03] text-neutral-200"}`}>
	<p class="whitespace-pre-wrap">{content}</p>
</div>