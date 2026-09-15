<script lang="ts">
import { onMount } from "svelte";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import UpdateNotice from "$lib/components/update-notice.svelte";
import { daemon } from "$lib/daemon";
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
let automationMode = $state<"review" | "auto-create" | "auto-start">("review");
let automationMessage = $state("");
let automationError = $state("");
let automationSaving = $state(false);

onMount(() => {
	daemon
		.getAutomationSettings()
		.then((settings) => {
			automationMode = settings.automationMode;
		})
		.catch((reason) => {
			automationError =
				reason instanceof Error ? reason.message : "Unable to load settings";
		});
});

async function saveAutomation() {
	automationSaving = true;
	automationError = "";
	automationMessage = "";
	try {
		await daemon.saveAutomationSettings(automationMode);
		automationMessage = "Planning automation updated";
	} catch (reason) {
		automationError =
			reason instanceof Error ? reason.message : "Unable to save settings";
	} finally {
		automationSaving = false;
	}
}

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
		<p class="text-muted-foreground text-sm">Manage the local Loom UI password and planning automation.</p>
	</div>
	<section class="space-y-4 rounded-xl border p-6">
		<div>
			<h2 class="font-semibold">Planning automation</h2>
			<p class="text-muted-foreground text-sm">Decide what happens after the planner produces a validated plan. Review is recommended.</p>
		</div>
		<div class="space-y-2" role="radiogroup" aria-label="Planning automation mode">
			<label class="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
				<input type="radio" name="automation-mode" value="review" bind:group={automationMode} class="mt-1" />
				<span><span class="block text-sm font-medium">Review before creating tasks</span><span class="text-muted-foreground block text-xs">Plans wait for your review. Nothing is created automatically.</span></span>
			</label>
			<label class="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
				<input type="radio" name="automation-mode" value="auto-create" aria-label="Automatically create Kanban tasks" bind:group={automationMode} class="mt-1" />
				<span><span class="block text-sm font-medium">Automatically create Kanban tasks</span><span class="text-muted-foreground block text-xs">Validated plans become Kanban tasks without starting agents.</span></span>
			</label>
			<label class="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
				<input type="radio" name="automation-mode" value="auto-start" aria-label="Automatically create and start" bind:group={automationMode} class="mt-1" />
				<span><span class="block text-sm font-medium">Automatically create and start</span><span class="text-muted-foreground block text-xs">Ready tasks are dispatched to the scheduler within concurrency limits.</span></span>
			</label>
		</div>
		{#if automationError}<p class="text-sm text-red-500" role="alert">{automationError}</p>{/if}
		{#if automationMessage}<p class="text-sm text-green-600" role="status">{automationMessage}</p>{/if}
		<Button onclick={saveAutomation} disabled={automationSaving}>{automationSaving ? "Saving…" : "Save automation mode"}</Button>
	</section>
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
