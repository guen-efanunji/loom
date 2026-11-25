<script lang="ts">
	import { ShieldCheck } from "@lucide/svelte";
	import { Button } from "$lib/components/ui/button";

	let {
		message = "Allow this action?",
		description = "",
		approveLabel = "Approve",
		denyLabel = "Deny",
		busy = false,
		onConfirm,
		onCancel,
	} = $props<{
		message?: string;
		description?: string;
		approveLabel?: string;
		denyLabel?: string;
		busy?: boolean;
		onConfirm?: () => void;
		onCancel?: () => void;
	}>();
</script>

<div
	class="flex items-start gap-3 rounded-lg border bg-card p-3"
	role="group"
	aria-label="Confirmation required"
>
	<ShieldCheck class="mt-0.5 shrink-0 text-amber-400" size={17} />
	<div class="min-w-0 flex-1">
		<p class="text-sm font-medium">{message}</p>
		{#if description}<p class="mt-1 text-xs text-muted-foreground">
				{description}
			</p>{/if}
		<div class="mt-3 flex flex-wrap gap-2">
			<Button size="sm" variant="outline" disabled={busy} onclick={onCancel}
				>{denyLabel}</Button
			>
			<Button size="sm" disabled={busy} onclick={onConfirm}
				>{approveLabel}</Button
			>
		</div>
	</div>
</div>
