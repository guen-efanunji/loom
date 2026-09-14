<script lang="ts">
  import { page } from "$app/state";
  import { Search, ArrowUpRight } from "@lucide/svelte";
  import { Input } from "$ui/input";
  import { docs } from "$lib/docs";
  import { sitePath, repository } from "$lib/config";
  const { children } = $props();
  let query = $state("");
  const matches = $derived(docs.filter(doc => `${doc.title} ${doc.description} ${doc.sections.map(s => `${s.title} ${s.paragraphs.join(" ")}`).join(" ")}`.toLowerCase().includes(query.toLowerCase())));
  const groups = [...new Set(docs.map(doc => doc.group))];
</script>
<div class="docs-shell section-width"><aside class="docs-sidebar"><a class="docs-home" href={sitePath("/docs/")}>Loom documentation</a><div class="docs-search"><Search size={15}/><Input bind:value={query} placeholder="Find a topic…" aria-label="Search documentation"/></div><nav aria-label="Documentation topics">{#each groups as group}{#if matches.some(d => d.group === group)}<p class="docs-group">{group}</p>{#each matches.filter(d => d.group === group) as doc}<a href={sitePath(`/docs/${doc.slug}/`)} aria-current={page.url.pathname.endsWith(`/docs/${doc.slug}/`) ? "page" : undefined}>{doc.title}</a>{/each}{/if}{/each}{#if !matches.length}<p class="search-empty" role="status">No topic found. Try “update”, “model”, or “worktree”.</p>{/if}</nav><a class="docs-source" href={`${repository}/issues`}>Something unclear? <ArrowUpRight size={13}/></a></aside><div class="docs-content">{@render children()}</div></div>
