<script lang="ts">
import { QueryClientProvider } from "@tanstack/svelte-query";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import "../app.css";
import { Sonner } from "$lib/components/ui/sonner/index.js";
import UpdateNotice from "$lib/components/update-notice.svelte";
import { queryClient } from "$lib/orpc";
import {
	clearLegacyUiPassword,
	peekLegacyUiPassword,
	type UiLockState,
	uiLock,
} from "$lib/ui-access";

const { children } = $props();
let lock = $state<UiLockState | null>(null);
let legacyChecked = $state(false);

async function refresh() {
	try {
		lock = await uiLock.state();
	} catch {
		// The daemon may still be starting; the workspace surfaces its own
		// connection errors, so the gate stays open rather than blocking.
		lock = { configured: false, notInUse: true, unlocked: true };
	}
}
// The gate resolves server-side lock state once per page load; the unlock
// page performs its own checks, so route changes never re-trigger it.
$effect(() => {
	page.url.pathname;
	if (page.url.pathname === "/unlock") return;
	if (!lock) void refresh();
});
/** Old browsers kept the password in localStorage; migrate it once. */
$effect(() => {
	if (legacyChecked || !lock || lock.configured) return;
	legacyChecked = true;
	const legacy = peekLegacyUiPassword();
	if (!legacy || legacy === "123456") return;
	void uiLock
		.setPassword(legacy)
		.then(() => {
			clearLegacyUiPassword();
			return refresh();
		})
		.catch(() => {});
});

const gated = $derived(
	page.url.pathname !== "/unlock" && !!lock?.configured && !lock.unlocked,
);
onMount(() => {
	document.documentElement.classList.add("dark");
	if (page.url.pathname === "/unlock") return;
	void (async () => {
		await refresh();
		if (gated)
			goto(
				`/unlock?next=${encodeURIComponent(page.url.pathname + page.url.search)}`,
			);
	})();
});
</script>

<Sonner />

{#if page.url.pathname === "/unlock"}
	<main class="min-h-svh overflow-y-auto">
		{@render children()}
	</main>
{:else if gated}
	<div
		class="flex min-h-svh items-center justify-center bg-background text-muted-foreground"
	>
		<div
			class="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent"
		></div>
	</div>
{:else if lock}
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
