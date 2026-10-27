<script lang="ts">
import { Questionnaire as QuestionnairePrimitive } from "@shadcn-svelte/primitives/questionnaire";
import {
	type ButtonSize,
	type ButtonVariant,
	buttonVariants,
} from "$lib/components/ui/button/index.js";
import { cn } from "$lib/utils.js";

let {
	ref = $bindable(null),
	class: className,
	size = "default",
	variant = "default",
	...restProps
}: QuestionnairePrimitive.NextProps & {
	size?: ButtonSize;
	variant?: ButtonVariant;
} = $props();
</script>

<QuestionnairePrimitive.Next
	bind:ref
	data-slot="questionnaire-next"
	data-size={size}
	data-variant={variant}
	class={cn(
		buttonVariants({ size, variant }),
		"col-start-3 row-start-1 min-h-11 justify-self-end sm:min-h-0",
		className,
	)}
	{...restProps}
/>
