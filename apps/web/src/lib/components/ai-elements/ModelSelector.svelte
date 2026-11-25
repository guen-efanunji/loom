<script lang="ts">
import { ChevronDown, Sparkles } from "@lucide/svelte";
import type { Snippet } from "svelte";
import { Badge } from "$lib/components/ui/badge";
import * as Popover from "$lib/components/ui/popover";
import * as Select from "$lib/components/ui/select";

let {
	models = [],
	value = "default",
	thinkingMode = $bindable("default"),
	thinkingModes = ["low", "medium", "high"],
	modelLabel = "Default model",
	displayLabel,
	ariaLabel,
	title,
	badgeLabel = "",
	badgeTone = "default",
	modelDisabled = false,
	open = $bindable(false),
	onopenchange,
	onvaluechange,
	pickerContent,
}: {
	models?: Array<{ id: string; name?: string }>;
	value?: string;
	thinkingMode?: string;
	thinkingModes?: string[];
	modelLabel?: string;
	displayLabel?: string;
	ariaLabel?: string;
	title?: string;
	badgeLabel?: string;
	badgeTone?: string;
	modelDisabled?: boolean;
	open?: boolean;
	onopenchange?: (open: boolean) => void;
	onvaluechange?: (value: string) => void;
	pickerContent?: Snippet;
} = $props();
function updateValue(next: string | undefined) {
	if (next !== undefined) onvaluechange?.(next);
}
</script>

<div class="flex min-w-0 items-center gap-1">
	{#if pickerContent}
		<Popover.Root bind:open onOpenChange={onopenchange}>
			<Popover.Trigger
				role="combobox"
				aria-expanded={open}
				aria-label={ariaLabel ?? `Selected model: ${modelLabel}`}
				title={title ?? modelLabel}
				disabled={modelDisabled}
				class="flex h-8 max-w-48 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs text-white/70 transition hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:max-w-72"
			>
				<span class="truncate">{displayLabel ?? modelLabel}</span>
				{#if badgeLabel}
					<Badge
						variant="outline"
						class={`model-badge model-badge--${badgeTone} max-w-24 shrink-0 truncate px-1 text-[9px] uppercase tracking-wide`}
						>{badgeLabel}</Badge
					>
				{/if}
				<ChevronDown size={12} class="shrink-0 opacity-70" />
			</Popover.Trigger>
			<Popover.Content class="w-96 max-w-[calc(100vw-2rem)] p-0" align="end">
				{@render pickerContent()}
			</Popover.Content>
		</Popover.Root>
	{:else}
		<Select.Root type="single" {value} onValueChange={updateValue}>
			<Select.Trigger
				size="sm"
				class="h-8 max-w-36 min-w-0 justify-start gap-1 rounded-lg border-0 bg-transparent px-2 text-xs text-white/70 shadow-none hover:bg-white/[0.06] hover:text-white dark:bg-transparent dark:hover:bg-white/[0.06] sm:max-w-48"
				aria-label={ariaLabel ?? `Selected model: ${modelLabel}`}
				title={title ?? modelLabel}
				disabled={modelDisabled}
			>
				<span class="truncate">{displayLabel ?? modelLabel}</span>
			</Select.Trigger>
			<Select.Content>
				{#each models as item (item.id)}
					<Select.Item value={item.id} label={item.name ?? item.id}
						>{item.name ?? item.id}</Select.Item
					>
				{/each}
			</Select.Content>
		</Select.Root>
	{/if}

	<Select.Root type="single" bind:value={thinkingMode}>
		<Select.Trigger
			size="sm"
			class={`h-8 w-8 justify-center gap-0 rounded-lg border-0 bg-transparent p-0 shadow-none transition hover:bg-white/[0.06] dark:bg-transparent dark:hover:bg-white/[0.06] data-[state=open]:bg-white/[0.06] [&>svg:last-child]:hidden ${thinkingMode !== "default" ? "text-cyan-300 hover:text-cyan-200" : "text-white/65 hover:text-white"}`}
			aria-label={`Thinking mode: ${thinkingMode}`}
			title={`Thinking mode: ${thinkingMode}`}
			><Sparkles size={15} /><span class="sr-only">{thinkingMode}</span
			></Select.Trigger
		>
		<Select.Content>
			<Select.Group>
				<Select.Label>Thinking</Select.Label>
				<Select.Item value="default">Default</Select.Item>
				{#each thinkingModes as mode (mode)}
					<Select.Item value={mode}
						>{mode[0]!.toUpperCase() + mode.slice(1)}</Select.Item
					>
				{/each}
			</Select.Group>
		</Select.Content>
	</Select.Root>
</div>
