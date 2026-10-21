<script lang="ts">
	import { QueryClientProvider } from "@tanstack/svelte-query";
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import "../app.css";
	import { Sonner } from "$lib/components/ui/sonner/index.js";
	import UpdateNotice from "$lib/components/update-notice.svelte";
	import { queryClient } from "$lib/orpc";
	import { isTrustedDevice } from "$lib/ui-access";

	const { children } = $props();
	let unlocked = $state(typeof window !== "undefined" && isTrustedDevice());

	onMount(() => {
		document.documentElement.classList.add("dark");
		if (page.url.pathname === "/unlock" || isTrustedDevice()) {
			unlocked = true;
			return;
		}
		goto(
			`/unlock?next=${encodeURIComponent(page.url.pathname + page.url.search)}`,
		);
	});
</script>

<Sonner />

{#if page.url.pathname === "/unlock"}
	<main class="min-h-svh overflow-y-auto">
		{@render children()}
	</main>
{:else if unlocked}
	<UpdateNotice />
	<QueryClientProvider client={queryClient}>
		<div class="h-svh">
			<main class="h-full overflow-y-auto">
				{@render children()}
			</main>
		</div>
	</QueryClientProvider>
{:else}
	<div
		class="flex min-h-svh items-center justify-center bg-background text-muted-foreground"
	>
		<div
			class="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent"
		></div>
	</div>
{/if}
