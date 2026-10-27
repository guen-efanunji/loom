<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";
import { cn, type WithElementRef } from "$lib/utils.js";

let {
	ref = $bindable(null),
	class: className,
	children,
	...restProps
}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="attachment-content"
	class={cn(
		"leading-tight group-data-[orientation=vertical]/attachment:px-1 max-w-full min-w-0 flex-1",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
