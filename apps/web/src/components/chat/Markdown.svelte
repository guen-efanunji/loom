<script lang="ts">
import DOMPurify from "dompurify";
import { marked } from "marked";
import { browser } from "$app/environment";
import CodeBlock from "./CodeBlock.svelte";

let { text }: { text: string } = $props();

type Segment = { type: "md" | "code"; value: string; lang?: string };

// Split the message into prose and fenced code so code goes through the
// shadcn CodeBlock (Shiki highlighting, line numbers, copy) while the rest
// stays rendered as sanitized Markdown.
const fence = /```([\w+-]*)\r?\n?([\s\S]*?)```/g;
const segments = $derived.by((): Segment[] => {
	if (!browser) return [];
	const src = text ?? "";
	const out: Segment[] = [];
	let last = 0;
	fence.lastIndex = 0;
	let match = fence.exec(src);
	while (match) {
		if (match.index > last)
			out.push({ type: "md", value: src.slice(last, match.index) });
		out.push({
			type: "code",
			lang: match[1] || undefined,
			value: match[2] ?? "",
		});
		last = match.index + match[0].length;
		match = fence.exec(src);
	}
	if (last < src.length) {
		const rest = src.slice(last);
		// An unterminated fence (still streaming) renders as a code block too.
		const open = rest.match(/```([\w+-]*)\r?\n?([\s\S]*)$/);
		if (open) {
			const before = rest.slice(0, open.index);
			if (before.trim()) out.push({ type: "md", value: before });
			out.push({
				type: "code",
				lang: open[1] || undefined,
				value: open[2] ?? "",
			});
		} else out.push({ type: "md", value: rest });
	}
	return out;
});

function render(value: string) {
	return DOMPurify.sanitize(marked.parse(value, { async: false }), {
		USE_PROFILES: { html: true },
	});
}
</script>

<div class="flex min-w-0 flex-col gap-3 break-words">
	{#each segments as seg, index (index)}
		{#if seg.type === "code"}
			<CodeBlock
				code={seg.value.replace(/\n$/, "")}
				language={seg.lang}
				maxHeight="max-h-[28rem]"
			/>
		{:else if seg.value.trim()}
			<div class="markdown min-w-0 break-words">{@html render(seg.value)}</div>
		{/if}
	{/each}
</div>

<style>
	.markdown {
		max-width: 76ch;
		color: var(--foreground);
		font-size: 0.9375rem;
		line-height: 1.75;
		overflow-wrap: anywhere;
	}
	.markdown :global(p) {
		margin: 0.9em 0;
	}
	.markdown > :global(:first-child) {
		margin-top: 0;
	}
	.markdown > :global(:last-child) {
		margin-bottom: 0;
	}
	.markdown :global(h1),
	.markdown :global(h2),
	.markdown :global(h3),
	.markdown :global(h4) {
		margin: 1.5em 0 0.55em;
		font-weight: 600;
		line-height: 1.35;
		letter-spacing: -0.025em;
		text-wrap: balance;
	}
	.markdown :global(h1) {
		font-size: 1.5rem;
	}
	.markdown :global(h2) {
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.4em;
		font-size: 1.25rem;
	}
	.markdown :global(h3) {
		font-size: 1.1rem;
	}
	.markdown :global(h4) {
		font-size: 1rem;
	}
	.markdown :global(strong) {
		font-weight: 650;
		color: var(--foreground);
	}
	.markdown :global(a) {
		color: var(--primary);
		text-decoration: underline;
		text-decoration-color: color-mix(in oklab, var(--primary) 55%, transparent);
		text-underline-offset: 0.2em;
		overflow-wrap: anywhere;
	}
	.markdown :global(a:hover) {
		text-decoration-color: currentColor;
	}
	.markdown :global(ul),
	.markdown :global(ol) {
		margin: 0.9em 0;
		padding-inline-start: 1.5rem;
	}
	.markdown :global(ul) {
		list-style: disc;
	}
	.markdown :global(ol) {
		list-style: decimal;
	}
	.markdown :global(li) {
		padding-inline-start: 0.2rem;
	}
	.markdown :global(li + li) {
		margin-top: 0.35em;
	}
	.markdown :global(li::marker) {
		color: var(--muted-foreground);
	}
	.markdown :global(li > ul),
	.markdown :global(li > ol) {
		margin: 0.35em 0;
	}
	.markdown :global(blockquote) {
		margin: 1.1em 0;
		border-inline-start: 2px solid var(--border);
		padding-inline-start: 1rem;
		color: var(--muted-foreground);
	}
	.markdown :global(blockquote > :first-child) {
		margin-top: 0;
	}
	.markdown :global(blockquote > :last-child) {
		margin-bottom: 0;
	}
	.markdown :global(code) {
		border-radius: 0.3rem;
		background: var(--muted);
		padding: 0.12rem 0.35rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.86em;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.markdown :global(table) {
		display: block;
		max-width: 100%;
		margin: 1.25rem 0;
		overflow-x: auto;
		border-collapse: collapse;
		font-size: 0.875rem;
	}
	.markdown :global(th),
	.markdown :global(td) {
		border: 1px solid var(--border);
		padding: 0.55rem 0.8rem;
		text-align: start;
		vertical-align: top;
	}
	.markdown :global(th) {
		background: var(--muted);
		font-weight: 600;
	}
	.markdown :global(hr) {
		margin: 1.5rem 0;
		border: 0;
		border-top: 1px solid var(--border);
	}
	.markdown :global(img) {
		max-width: 100%;
		border-radius: 0.75rem;
	}
</style>
