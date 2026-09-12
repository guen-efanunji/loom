<script lang="ts">
import DOMPurify from "dompurify";
import { marked } from "marked";
import { browser } from "$app/environment";

let { text }: { text: string } = $props();
const html = $derived(
	browser
		? DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }), {
				USE_PROFILES: { html: true },
			})
		: "",
);
</script>
<div class="markdown min-w-0 break-words">{@html html}</div>
<style>
.markdown { font-size: .875rem; line-height: 1.8; }
.markdown :global(p) { margin: .65em 0; }
.markdown :global(p:first-child) { margin-top: 0; }
.markdown :global(pre) { overflow: auto; background: var(--background); border: 1px solid var(--border); border-radius: .6rem; padding: 1rem; margin: .85rem 0; }
.markdown :global(code) { font-family: ui-monospace, monospace; font-size: .85em; background: var(--muted); padding: .12rem .3rem; border-radius: .2rem; }
.markdown :global(pre code) { padding: 0; background: none; }
.markdown :global(h1), .markdown :global(h2), .markdown :global(h3) { font-weight: 600; margin: 1.25em 0 .5em; line-height: 1.4; }
.markdown :global(h1) { font-size: 1.4rem; } .markdown :global(h2) { font-size: 1.15rem; }
.markdown :global(ul) { list-style: disc; padding-left: 1.5rem; } .markdown :global(ol) { list-style: decimal; padding-left: 1.5rem; }
.markdown :global(a) { color: #8ecdc1; text-decoration: underline; overflow-wrap: anywhere; }
.markdown :global(blockquote) { border-left: 2px solid var(--border); padding-left: 1rem; color: var(--muted-foreground); }
.markdown :global(table) { display: block; overflow-x: auto; border-collapse: collapse; margin: 1rem 0; }
.markdown :global(th), .markdown :global(td) { border: 1px solid var(--border); padding: .5rem .75rem; text-align: left; }
</style>
