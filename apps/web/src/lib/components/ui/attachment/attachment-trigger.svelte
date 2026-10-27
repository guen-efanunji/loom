<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";
import { cn, type WithElementRef } from "$lib/utils.js";

let {
	ref = $bindable(null),
	class: className,
	type = "button",
	child,
	...restProps
}: WithElementRef<HTMLButtonAttributes> & {
	child?: Snippet<[{ props: Record<string, unknown> }]>;
} = $props();

const mergedProps = $derived({
	class: cn("absolute inset-0 z-10 outline-none", className),
	"data-slot": "attachment-trigger",
	...restProps,
});
</script>

{#if child}
	{@render child({ props: mergedProps })}
{:else}
	<button bind:this={ref} {type} {...mergedProps}>
		{@render mergedProps.children?.()}
	</button>
{/if}
