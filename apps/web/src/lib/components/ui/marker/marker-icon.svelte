<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";
import { cn, type WithElementRef } from "$lib/utils.js";

let {
	ref = $bindable(null),
	class: className,
	children,
	...restProps
}: WithElementRef<HTMLAttributes<HTMLSpanElement>> = $props();
</script>

<span
	bind:this={ref}
	data-slot="marker-icon"
	aria-hidden="true"
	class={cn(
		"cn-marker-icon size-4 [&_svg:not([class*='size-'])]:size-4",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</span>
