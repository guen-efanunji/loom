<script lang="ts">
	import { onMount } from "svelte";
	import { Moon, Sun } from "@lucide/svelte";
	import { Button } from "$ui/button";

	let theme = $state<"light" | "dark">("light");

	onMount(() => {
		const current = document.documentElement.dataset.theme;
		theme = current === "dark" ? "dark" : "light";
	});

	function toggleTheme() {
		theme = theme === "dark" ? "light" : "dark";
		document.documentElement.dataset.theme = theme;
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute("content", theme === "dark" ? "#171a15" : "#f5f6f2");
		try {
			localStorage.setItem("loom-site-theme", theme);
		} catch {
			// The current-page choice still works if storage is unavailable.
		}
	}
</script>

<Button
	variant="ghost"
	size="icon"
	aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
	aria-pressed={theme === "dark"}
	title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
	onclick={toggleTheme}
>
	{#if theme === "dark"}<Sun />{:else}<Moon />{/if}
</Button>
