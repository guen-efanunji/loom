<script lang="ts">
import { ClipboardList, LoaderCircle } from "@lucide/svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";

export type PlanCardState = {
	key: string;
	planId: string;
	projectId: string;
	brief: string;
	status: string;
	title: string;
	summary: string;
	total: number;
	independent: number;
	dependent: number;
	taskIds: string[];
	converted: boolean;
	started: string[];
	error: string;
};

let {
	card,
	onreview,
	onconvert,
}: {
	card: PlanCardState;
	onreview: (card: PlanCardState) => void;
	onconvert: (card: PlanCardState, start: boolean) => void;
} = $props();

const ready = $derived(
	card.status === "validated" || card.status === "approved",
);
</script>

<div class="mt-5 rounded-xl border border-blue-500/30 bg-card p-4" aria-live="polite">
	<div class="flex flex-wrap items-center gap-2">
		<ClipboardList size={16} class="text-blue-300" />
		<p class="min-w-0 flex-1 truncate text-sm font-medium">
			{card.title || "Planning…"}
		</p>
		<Badge variant="outline">{card.status || "creating"}</Badge>
	</div>
	<p class="mt-2 line-clamp-2 text-xs text-muted-foreground">{card.summary || card.brief}</p>
	{#if card.total}
		<p class="mt-2 text-xs text-muted-foreground">
			{card.total} tasks · {card.independent} independent · {card.dependent} dependent
		</p>
	{/if}
	{#if card.converted}
		<p class="mt-2 text-xs text-emerald-300">
			✓ Created {card.taskIds.length} Kanban tasks{#if card.started.length} · {card.started.length} started{/if}
		</p>
	{/if}
	{#if card.error}<p class="mt-2 text-xs text-destructive" role="alert">{card.error}</p>{/if}
	<div class="mt-3 flex flex-wrap gap-2">
		{#if card.status === "planning" || card.status === "creating" || card.status === "draft"}
			<span class="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle size={13} class="animate-spin" />Planner is working…</span>
		{:else if ready && !card.converted}
			<Button size="sm" variant="outline" onclick={() => onreview(card)}>Review plan</Button>
			<Button size="sm" onclick={() => onconvert(card, false)}>Add to Kanban</Button>
			<Button size="sm" variant="secondary" onclick={() => onconvert(card, true)}>Add & Start</Button>
		{:else if card.converted}
			<Button size="sm" variant="outline" onclick={() => onreview(card)}>Open plan</Button>
		{/if}
	</div>
</div>
