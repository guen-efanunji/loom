<script lang="ts">
import { Input } from "$lib/components/ui/input";
import UpdateNotice from "$lib/components/update-notice.svelte";
import { Button } from "$lib/components/ui/button";
import {
	DEFAULT_UI_PASSWORD,
	getUiPassword,
	setTrustedDevice,
	setUiPassword,
} from "$lib/ui-access";

let currentPassword = $state("");
let newPassword = $state("");
let message = $state("");
let error = $state("");

function changePassword() {
	error = "";
	message = "";
	if (currentPassword !== getUiPassword()) {
		error = "Current password is incorrect";
		return;
	}
	if (newPassword.length < 6) {
		error = "Password must be at least 6 characters";
		return;
	}
	setUiPassword(newPassword);
	setTrustedDevice(false);
	currentPassword = "";
	newPassword = "";
	message = "Password updated";
}
</script>

<svelte:head><title>Settings</title></svelte:head>

<div class="mx-auto w-full max-w-xl space-y-6 p-6">
	<Button href="/" variant="ghost">← Back to workspace</Button>
	<div>
		<h1 class="font-bold text-2xl">Settings</h1>
		<p class="text-muted-foreground text-sm">Manage the local Loom UI password.</p>
	</div>
	<section class="space-y-4 rounded-xl border p-6">
		<div>
			<h2 class="font-semibold">UI password</h2>
			<p class="text-muted-foreground text-sm">Default password: {DEFAULT_UI_PASSWORD}</p>
		</div>
		<form class="space-y-4" onsubmit={(event) => { event.preventDefault(); changePassword(); }}>
			<label class="block space-y-2"><span class="text-sm font-medium">Current password</span><Input class="w-full rounded-md border bg-background px-3 py-2" type="password" bind:value={currentPassword} /></label>
			<label class="block space-y-2"><span class="text-sm font-medium">New password</span><Input class="w-full rounded-md border bg-background px-3 py-2" type="password" bind:value={newPassword} /></label>
			{#if error}<p class="text-sm text-red-500" role="alert">{error}</p>{/if}
			{#if message}<p class="text-sm text-green-600" role="status">{message}</p>{/if}
			<Button class="rounded-md border px-3 py-2" type="submit">Change password</Button>
		</form>
	</section>
	<UpdateNotice expanded />
</div>
