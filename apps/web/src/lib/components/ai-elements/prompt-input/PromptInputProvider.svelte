<script lang="ts">
	import { untrack } from "svelte";
	import {
		PromptInputController,
		setPromptInputProvider,
	} from "./attachments-context.svelte.js";

	interface Props {
		initialInput?: string;
		accept?: string;
		multiple?: boolean;
		children?: import("svelte").Snippet;
	}

	let {
		initialInput = "",
		accept,
		multiple = true,
		children,
	}: Props = $props();

	let controller = untrack(
		() => new PromptInputController(initialInput, accept, multiple),
	);

	setPromptInputProvider(controller);
</script>

{#if children}
	{@render children()}
{/if}
