<script lang="ts">
import * as CodeBlock from "$lib/components/ui/code-block/index.js";
import { useHighlightedCode } from "$lib/hooks/use-highlighted-code.svelte.js";

let {
	code = "",
	language,
	maxHeight = "max-h-80",
	title,
	variant = "default",
	lineNumbers = true,
}: {
	code?: string;
	language?: string;
	maxHeight?: string;
	title?: string;
	variant?: "default" | "destructive";
	lineNumbers?: boolean;
} = $props();

// Syntax highlighting runs through Shiki (the shadcn code-block hook); an
// unknown or missing language falls back to plain text with no WASM cost.
const lines = useHighlightedCode(
	() => code,
	() => language ?? "text",
);
const heading = $derived(title ?? language ?? "Output");
</script>

<CodeBlock.Root {variant} size="sm">
	<CodeBlock.Header>
		<CodeBlock.Title>{heading}</CodeBlock.Title>
		<CodeBlock.Actions>
			<CodeBlock.CopyButton value={code} />
		</CodeBlock.Actions>
	</CodeBlock.Header>
	<CodeBlock.Content {lineNumbers} wrap class={maxHeight}>
		{#each lines.current as line, index (index)}
			<CodeBlock.Line code={line} />
		{/each}
	</CodeBlock.Content>
</CodeBlock.Root>
