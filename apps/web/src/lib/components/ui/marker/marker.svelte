<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";

	export const markerVariants = tv({
		base: "cn-marker text-muted-foreground gap-2 text-sm [a]:hover:text-foreground [a]:underline-offset-3 [a]:underline [&_svg:not([class*='size-'])]:size-4 min-h-4 text-left",
		variants: {
			variant: {
				default: "",
				border: "border-border border-b pb-2",
				separator:
					"before:bg-border after:bg-border before:mr-1 after:ml-1 before:h-px after:h-px before:min-w-0 after:min-w-0 before:flex-1 after:flex-1",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	});

	export type MarkerVariant = VariantProps<typeof markerVariants>["variant"];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		variant = "default",
		child,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		variant?: MarkerVariant;
		child?: Snippet<[{ props: HTMLAttributes<HTMLDivElement> }]>;
	} = $props();

	const classValue = () => cn(markerVariants({ variant }), className);
</script>

{#if child}
	{@render child({
		props: {
			...restProps,
			"data-slot": "marker",
			"data-variant": variant,
			class: classValue(),
		},
	})}
{:else}
	<div bind:this={ref} data-slot="marker" data-variant={variant} class={classValue()} {...restProps}>
		{@render children?.()}
	</div>
{/if}
