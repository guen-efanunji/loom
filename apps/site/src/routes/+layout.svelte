<script lang="ts">
	import "../site.css";
	import { ArrowUpRight, Code2 as Github, Menu, X } from "@lucide/svelte";
	import { page } from "$app/state";
	import { repository, sitePath } from "$lib/config";
	import ThemeToggle from "$lib/ThemeToggle.svelte";
	import { Button } from "$ui/button";

	const { children } = $props();
	let menu = $state(false);
</script>

<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header glass">
	<a class="wordmark" href={sitePath()} aria-label="Loom home"
		><img
			class="wordmark-image"
			src={sitePath("/loom-logo.webp")}
			alt=""
			width="720"
			height="251"
		/></a
	>
	<nav class:expanded={menu} aria-label="Main navigation">
		<a href={sitePath("/#features")} onclick={() => (menu = false)}>Features</a
		><a href={sitePath("/#inside")} onclick={() => (menu = false)}
			>Inside Loom</a
		><a
			href={sitePath("/docs/")}
			aria-current={page.url.pathname.includes("/docs") ? "page" : undefined}
			onclick={() => (menu = false)}>Documentation</a
		>
	</nav>
	<div class="nav-actions">
		<ThemeToggle /><Button
			href={repository}
			variant="ghost"
			size="icon"
			aria-label="Loom on GitHub"><Github size={18} /></Button
		><Button href={sitePath("/#install")} class="nav-install"
			>Get Loom <ArrowUpRight size={14} /></Button
		><Button
			class="menu-toggle"
			variant="ghost"
			size="icon"
			aria-label={menu ? "Close menu" : "Open menu"}
			aria-expanded={menu}
			onclick={() => (menu = !menu)}
			>{#if menu}<X />{:else}<Menu />{/if}</Button
		>
	</div>
</header>
{@render children()}
<footer class="site-footer">
	<div>
		<a class="wordmark" href={sitePath()} aria-label="Loom home"
			><img
				class="wordmark-image"
				src={sitePath("/loom-logo.webp")}
				alt=""
				width="720"
				height="251"
			/></a
		>
		<p>A little order for ambitious work.</p>
	</div>
	<nav aria-label="Footer">
		<a href={sitePath("/docs/installation/")}>Install</a><a
			href={sitePath("/docs/privacy/")}>Privacy</a
		><a href={sitePath("/docs/security/")}>Security</a><a href={repository}
			>GitHub <ArrowUpRight size={12} /></a
		>
	</nav>
	<p>Built around OpenCode. Runs on your machine.</p>
</footer>
