<script lang="ts">
import { Input } from "$lib/components/ui/input";
import { Checkbox } from "$lib/components/ui/checkbox";
import { Button } from "$lib/components/ui/button";
import { page } from "$app/state";
import {
	DEFAULT_UI_PASSWORD,
	getUiPassword,
	isTrustedDevice,
	setTrustedDevice,
} from "$lib/ui-access";

let password = $state("");
let remember = $state(false);
let error = $state("");

function unlock() {
	if (password !== getUiPassword()) {
		error = "Incorrect password";
		return;
	}
	setTrustedDevice(remember);
	sessionStorage.setItem("loom.ui.unlocked", "true");
	const next = page.url.searchParams.get("next") || "/";
	window.location.assign(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}
</script>

<svelte:head><title>Unlock Loom</title></svelte:head>

<div class="mx-auto flex min-h-full w-full max-w-md items-center justify-center p-6">
	<div class="w-full space-y-6 rounded-xl border p-8 shadow-sm">
		<div class="space-y-2 text-center">
			<h1 class="font-bold text-2xl">Unlock Loom</h1>
			<p class="text-muted-foreground text-sm">This session is password-protected.</p>
		</div>
		<form class="space-y-4" onsubmit={(event) => { event.preventDefault(); unlock(); }}>
			<label class="block space-y-2">
				<span class="text-sm font-medium">Password</span>
				<Input class="w-full rounded-md border bg-background px-3 py-2" type="password" bind:value={password} />
			</label>
			{#if error}<p class="text-sm text-red-500" role="alert">{error}</p>{/if}
			<label class="flex items-center gap-2 text-sm">
				<Checkbox bind:checked={remember} />
				<span>Trust this device</span>
			</label>
			<Button class="w-full rounded-md border px-3 py-2" type="submit">Unlock</Button>
		</form>
		<p class="text-center text-muted-foreground text-xs">Default password: {DEFAULT_UI_PASSWORD}</p>
	</div>
</div>
