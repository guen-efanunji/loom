<script lang="ts">
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";
import { marked } from "marked";
import { browser } from "$app/environment";

let { text }: { text: string } = $props();
let ref = $state<HTMLDivElement>();
const html = $derived(
	browser
		? DOMPurify.sanitize(marked.parse(text, { async: false }), {
				USE_PROFILES: { html: true },
			})
		: "",
);
$effect(() => {
	html;
	const node = ref;
	if (!node) return;
	for (const block of node.querySelectorAll("pre code")) {
		if (block instanceof HTMLElement && !block.dataset.highlighted) {
			try {
				hljs.highlightElement(block);
			} catch {}
		}
	}
});
</script>

<div bind:this={ref} class="markdown min-w-0 break-words">{@html html}</div>

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
	.markdown :global(pre) {
		max-width: 100%;
		margin: 1.1rem 0;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: 0.75rem;
		background: var(--background);
		padding: 1rem 1.1rem;
		font-size: 0.8125rem;
		line-height: 1.7;
	}
	.markdown :global(pre code) {
		border-radius: 0;
		background: transparent;
		padding: 0;
		font-size: inherit;
		font-weight: 400;
		overflow-wrap: normal;
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
