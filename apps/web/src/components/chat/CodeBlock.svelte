<script lang="ts">
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";
import { Check, Copy } from "@lucide/svelte";
import { toast } from "svelte-sonner";
import { Button } from "$lib/components/ui/button";

let {
	code,
	language,
	maxHeight = "max-h-80",
}: {
	code: string;
	language?: string;
	maxHeight?: string;
} = $props();

let copied = $state(false);

const highlighted = $derived.by(() => {
	const text = code || "";
	const candidates = [language, guessLanguage(language), undefined].filter(
		Boolean,
	) as string[];
	for (const candidate of candidates) {
		try {
			if (candidate && hljs.getLanguage(candidate))
				return hljs.highlight(text, { language: candidate }).value;
		} catch {}
	}
	try {
		return hljs.highlightAuto(text).value;
	} catch {
		return hljs.highlight(text, { language: "plaintext" }).value;
	}
});

function guessLanguage(hint?: string) {
	if (!hint) return undefined;
	const map: Record<string, string> = {
		html: "xml",
		vue: "xml",
		svelte: "xml",
		css: "css",
		scss: "scss",
		js: "javascript",
		jsx: "javascript",
		ts: "typescript",
		tsx: "typescript",
		json: "json",
		go: "go",
		py: "python",
		rb: "ruby",
		rs: "rust",
		sh: "bash",
		yml: "yaml",
		yaml: "yaml",
		md: "markdown",
		sql: "sql",
		java: "java",
		kt: "kotlin",
		c: "c",
		cpp: "cpp",
		cs: "csharp",
		php: "php",
	};
	const ext = hint.split(".").pop()?.toLowerCase() ?? "";
	if (map[ext]) return map[ext];
	return hljs.getLanguage(hint) ? hint : undefined;
}

async function copy() {
	try {
		await navigator.clipboard.writeText(code);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	} catch {
		toast.error("Unable to copy code");
	}
}

const safe = $derived(DOMPurify.sanitize(highlighted));
const lines = $derived(safe.split("\n"));
</script>

<div class="overflow-hidden rounded-lg border bg-background">
	<div class="flex items-center justify-between border-b px-3 py-1.5">
		<span class="text-[11px] text-muted-foreground">{language ?? "code"}</span>
		<Button variant="ghost" size="icon" class="size-6" title="Copy code" aria-label="Copy code" onclick={copy}>
			{#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
		</Button>
	</div>
	<pre class={`nice-scroll overflow-auto p-0 text-xs leading-6 ${maxHeight}`}><code class="hljs block bg-transparent p-3">{#each lines as line, i}<span class="code-line" data-line={i + 1}>{@html line || " "}</span>{/each}</code></pre>
</div>

<style>
	.code-line {
		display: block;
		padding-left: 3rem;
		position: relative;
		min-height: 1.5rem;
	}
	.code-line::before {
		content: attr(data-line);
		position: absolute;
		left: 0;
		width: 2.25rem;
		text-align: right;
		color: var(--muted-foreground);
		opacity: 0.55;
		user-select: none;
	}
</style>
