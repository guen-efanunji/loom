<script lang="ts">
  import { ArrowRight, BookOpen, Terminal, GitBranch } from "@lucide/svelte";
  import { docs } from "$lib/docs";
  import { sitePath } from "$lib/config";
</script>
<svelte:head><title>Documentation — Loom</title><meta name="description" content="Learn to install Loom, set up OpenCode, plan parallel work, review integrations, and maintain your local workspace."/></svelte:head>
<main id="main" class="docs-index"><p class="eyebrow">THE WORKSPACE MANUAL</p><h1>A good place<br/>to get your bearings.</h1><p class="docs-lead">From your first install to a reviewed integration. Short guides for the things you actually need to do.</p><div class="docs-start glass"><Terminal size={25}/><div><h2>New to Loom?</h2><p>Install the app, connect OpenCode, and add your first repository.</p></div><a class="text-link" href={sitePath("/docs/installation/")}>Start here <ArrowRight size={16}/></a></div><h2 class="docs-section-title">Find your next step</h2><div class="docs-card-grid">{#each docs as doc}<a class="doc-card glass" href={sitePath(`/docs/${doc.slug}/`)}><p>{doc.group} <span>{doc.minutes} min</span></p><h3>{doc.title}<ArrowRight size={15}/></h3><div>{doc.description}</div></a>{/each}</div></main>
