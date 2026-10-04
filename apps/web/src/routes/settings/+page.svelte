<script lang="ts">
import {
	Archive,
	Check,
	ChevronLeft,
	CircleHelp,
	Folder,
	FolderOpen,
	RefreshCw,
	Search,
	Settings2,
	Trash2,
	X,
} from "@lucide/svelte";
import { onMount } from "svelte";
import { toast } from "svelte-sonner";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import UpdateNotice from "$lib/components/update-notice.svelte";
import { daemon, type Project } from "$lib/daemon";
import {
	DEFAULT_UI_PASSWORD,
	getUiPassword,
	setTrustedDevice,
	setUiPassword,
} from "$lib/ui-access";

let projects = $state<Project[]>([]);
let selectedProjectId = $state("");
let project = $state<Project | null>(null);
let workspaceName = $state("");
let workspacePath = $state("");
let notifications = $state(true);
let languageServers = $state(true);
let autoFix = $state(true);
let indexStatus = $state("ready");
let indexFiles = $state(0);
let indexedAt = $state("a few seconds ago");
let indexing = $state(false);
let automationMode = $state<"review" | "auto-create" | "auto-start">("review");
let automationError = $state("");
let loading = $state(true);
let saving = $state(false);
let error = $state("");
let message = $state("");
let currentPassword = $state("");
let newPassword = $state("");
let passwordMessage = $state("");
let passwordError = $state("");
let deleteOpen = $state(false);
let search = $state("");

const filteredProjects = $derived(
	projects.filter((item) =>
		`${item.name} ${item.path}`.toLowerCase().includes(search.toLowerCase()),
	),
);

onMount(async () => {
	try {
		projects = await daemon.listProjects();
		selectedProjectId = projects[0]?.id ?? "";
		const automation = await daemon.getAutomationSettings();
		automationMode = automation.automationMode;
		await loadProject();
	} catch (reason) {
		error =
			reason instanceof Error ? reason.message : "Unable to load workspace";
	} finally {
		loading = false;
	}
});

async function loadProject() {
	if (!selectedProjectId) {
		project = null;
		return;
	}
	project = await daemon.getProject(selectedProjectId);
	workspaceName = project.name;
	workspacePath = project.path;
}

async function selectProject(id: string) {
	selectedProjectId = id;
	error = "";
	message = "";
	try {
		await loadProject();
	} catch (reason) {
		error =
			reason instanceof Error ? reason.message : "Unable to load workspace";
	}
}

async function saveWorkspace() {
	if (!project || saving || !workspaceName.trim() || !workspacePath.trim())
		return;
	saving = true;
	error = "";
	message = "";
	try {
		project = await daemon.updateProject(project.id, {
			name: workspaceName.trim(),
			path: workspacePath.trim(),
		});
		await daemon.saveAutomationSettings(automationMode);
		projects = projects.map((item) =>
			item.id === project?.id ? project : item,
		);
		workspaceName = project.name;
		workspacePath = project.path;
		message = "Workspace settings saved";
		toast.success(message);
	} catch (reason) {
		error =
			reason instanceof Error ? reason.message : "Unable to save workspace";
	} finally {
		saving = false;
	}
}

function changePassword() {
	passwordError = "";
	passwordMessage = "";
	if (currentPassword !== getUiPassword()) {
		passwordError = "Current password is incorrect";
		return;
	}
	if (newPassword.length < 6) {
		passwordError = "Password must be at least 6 characters";
		return;
	}
	setUiPassword(newPassword);
	setTrustedDevice(false);
	currentPassword = "";
	newPassword = "";
	passwordMessage = "Password updated";
}

async function rebuildIndex() {
	if (!project || indexing) return;
	indexing = true;
	try {
		indexStatus = "indexing";
		const result = await daemon.rebuildProjectIndex(project.id);
		indexStatus = result.status;
		indexFiles = result.files;
		indexedAt = "just now";
		toast.success(`Index rebuilt · ${result.files} files`);
	} catch (reason) {
		indexStatus = "failed";
		toast.error(
			reason instanceof Error ? reason.message : "Unable to rebuild index",
		);
	} finally {
		indexing = false;
	}
}

async function deleteWorkspace() {
	if (!project) return;
	try {
		await daemon.deleteProject(project.id);
		projects = projects.filter((item) => item.id !== project?.id);
		selectedProjectId = projects[0]?.id ?? "";
		project = null;
		deleteOpen = false;
		await loadProject();
		toast.success("Workspace removed");
	} catch (reason) {
		error =
			reason instanceof Error ? reason.message : "Unable to delete workspace";
	}
}
</script>

<svelte:head><title>Settings · Loom</title></svelte:head>

<div class="min-h-svh bg-[#090909] text-neutral-100">
	<div class="mx-auto flex min-h-svh max-w-[1500px]">
		<aside class="hidden w-64 shrink-0 border-r border-white/10 px-3 py-4 md:block">
			<div class="mb-5 flex items-center gap-2 px-2 text-sm font-semibold"><span class="flex size-6 items-center justify-center rounded-md bg-white text-black">L</span> loom</div>
			<label class="relative block"><Search class="absolute left-3 top-2.5 size-4 text-neutral-500" /><Input bind:value={search} placeholder="Search settings…" class="h-9 border-white/10 bg-white/[0.04] pl-9 text-xs" /></label>
			<nav class="mt-6 space-y-6" aria-label="Settings sections">
				<div><p class="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-500">Workspace</p><button class="flex h-9 w-full items-center gap-2 rounded-md bg-white/[0.14] px-3 text-left text-sm"><Settings2 class="size-4" />General</button><button class="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-neutral-400 hover:bg-white/[0.06]" type="button"><CircleHelp class="size-4" />Context</button></div>
				<div><p class="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-500">Agents</p><Button href="/settings/providers" variant="ghost" class="w-full justify-start gap-2 text-neutral-400"><Settings2 class="size-4" />Providers</Button></div><div><p class="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-500">Application</p><Button href="/settings" variant="ghost" class="w-full justify-start gap-2 text-neutral-400"><Settings2 class="size-4" />General</Button><Button href="/" variant="ghost" class="w-full justify-start gap-2 text-neutral-400"><ChevronLeft class="size-4" />Back to workspace</Button></div>
			</nav>
		</aside>

		<main class="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:px-12 lg:py-10">
			<div class="mx-auto max-w-5xl">
				<div class="mb-8 flex flex-wrap items-start justify-between gap-4"><div><p class="mb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500">Workspace</p><h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">General Settings</h1><p class="mt-2 text-sm text-neutral-500">Manage your core Loom workspace preferences and configurations.</p></div><div class="md:hidden"><Button href="/" variant="outline" size="sm"><ChevronLeft class="size-4" />Back</Button></div></div>
				{#if loading}<div class="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-sm text-neutral-400">Loading workspace settings…</div>{:else if !projects.length}<div class="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-10 text-center"><Folder class="mx-auto mb-3 size-8 text-neutral-500" /><h2 class="font-medium">No workspace yet</h2><p class="mt-2 text-sm text-neutral-500">Add a project from the workspace to configure it here.</p><Button href="/" class="mt-5">Open workspace</Button></div>{:else}
					<div class="mb-4 flex items-center gap-2 overflow-x-auto pb-1"><span class="shrink-0 text-xs text-neutral-500">Workspace</span>{#each filteredProjects as item}<button type="button" class={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition ${item.id === selectedProjectId ? "border-white/25 bg-white/[0.12] text-white" : "border-white/10 text-neutral-500 hover:text-white"}`} onclick={() => selectProject(item.id)}>{item.name}</button>{/each}</div>
					{#if project}<section class="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035] shadow-2xl shadow-black/20"><div class="border-b border-white/[0.08] p-5 sm:p-6"><div class="flex items-start justify-between gap-5"><div><h2 class="text-sm font-semibold">Workspace Name</h2><p class="mt-1 max-w-2xl text-sm leading-6 text-neutral-500">The display name shown across the Loom workspace.</p></div><Input bind:value={workspaceName} aria-label="Workspace name" class="w-full max-w-xs border-white/10 bg-white/[0.05]" /></div></div><div class="border-b border-white/[0.08] p-5 sm:p-6"><div><h2 class="text-sm font-semibold">Workspace Path</h2><p class="mt-1 text-sm leading-6 text-neutral-500">The local folder this workspace is linked to on this device. Changing it validates the new Git repository path.</p></div><div class="mt-4 flex flex-col gap-2 sm:flex-row"><div class="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3"><Folder class="size-4 shrink-0 text-neutral-500" /><span class="truncate font-mono text-xs text-neutral-300">{workspacePath}</span></div><Button variant="outline" size="sm" onclick={() => window.open(`file://${workspacePath}`, "_blank")}><FolderOpen class="size-4" />Open</Button><Button variant="outline" size="sm" onclick={() => { const path = window.prompt("Enter the new workspace path", workspacePath); if (path) workspacePath = path; }}>Change…</Button></div></div><div class="border-b border-white/[0.08] p-5 sm:p-6"><div class="flex items-center justify-between gap-4"><div><h2 class="text-sm font-semibold">Notifications</h2><p class="mt-1 text-sm leading-6 text-neutral-500">Get desktop alerts for approvals, agent questions, failures, and completed work.</p></div><button type="button" role="switch" aria-checked={notifications} class={`relative h-6 w-11 shrink-0 rounded-full transition ${notifications ? "bg-emerald-500" : "bg-white/15"}`} onclick={() => notifications = !notifications}><span class={`absolute top-1 size-4 rounded-full bg-white transition ${notifications ? "left-6" : "left-1"}`}></span><span class="sr-only">Toggle notifications</span></button></div></div><div class="border-b border-white/[0.08] p-5 sm:p-6"><div class="flex flex-wrap items-center justify-between gap-4"><div><h2 class="text-sm font-semibold">Code Index Status</h2><p class="mt-1 flex items-center gap-2 text-sm text-neutral-500">{#if indexStatus === "ready"}<Check class="size-4 text-emerald-400" />{:else if indexStatus === "indexing"}<RefreshCw class="size-4 animate-spin text-blue-400" />{:else}<X class="size-4 text-red-400" />{/if}Last indexed: {indexedAt} · {indexFiles ? `${indexFiles} files · ` : ""}status {indexStatus}</p></div><div class="flex gap-2"><Button variant="outline" size="sm" disabled={indexing} onclick={() => void rebuildIndex()}><RefreshCw class={`size-4 ${indexing ? "animate-spin" : ""}`} />{indexing ? "Indexing…" : "Re-index"}</Button><Button variant="destructive" size="sm" onclick={() => toast.info("Index clearing is not available yet")}><Trash2 class="size-4" />Clear Index</Button></div></div></div><div class="border-b border-white/[0.08] p-5 sm:p-6"><div class="flex items-center justify-between gap-4"><div><h2 class="text-sm font-semibold">Language servers (diagnostics)</h2><p class="mt-1 max-w-3xl text-sm leading-6 text-neutral-500">Turns managed language servers for this workspace on or off. Off clears diagnostics from the workspace.</p></div><button type="button" role="switch" aria-checked={languageServers} class={`relative h-6 w-11 shrink-0 rounded-full transition ${languageServers ? "bg-emerald-500" : "bg-white/15"}`} onclick={() => languageServers = !languageServers}><span class={`absolute top-1 size-4 rounded-full bg-white transition ${languageServers ? "left-6" : "left-1"}`}></span><span class="sr-only">Toggle language servers</span></button></div></div><div class="border-b border-white/[0.08] p-5 sm:p-6"><div class="flex items-center justify-between gap-4"><div><h2 class="text-sm font-semibold">Auto-fix diagnostics after a turn</h2><p class="mt-1 max-w-3xl text-sm leading-6 text-neutral-500">When a turn leaves errors in changed files, Loom can ask the agent to fix them in a later run.</p></div><button type="button" role="switch" aria-checked={autoFix} class={`relative h-6 w-11 shrink-0 rounded-full transition ${autoFix ? "bg-emerald-500" : "bg-white/15"}`} onclick={() => autoFix = !autoFix}><span class={`absolute top-1 size-4 rounded-full bg-white transition ${autoFix ? "left-6" : "left-1"}`}></span><span class="sr-only">Toggle auto-fix diagnostics</span></button></div></div><div class="border-b border-white/[0.08] p-5 sm:p-6"><div class="flex flex-wrap items-center justify-between gap-4"><div><h2 class="text-sm font-semibold">Planning automation</h2><p class="mt-1 max-w-3xl text-sm leading-6 text-neutral-500">Choose whether validated plans wait for review, create tasks automatically, or start them automatically.</p></div><select class="h-9 rounded-md border border-white/10 bg-white/[0.05] px-3 text-sm" aria-label="Planning automation mode" bind:value={automationMode}><option value="review">Review first</option><option value="auto-create">Create tasks</option><option value="auto-start">Create and start</option></select></div>{#if automationError}<p class="mt-3 text-sm text-red-400" role="alert">{automationError}</p>{/if}</div><div class="flex flex-wrap justify-end gap-2 p-5 sm:p-6"><Button variant="outline" onclick={() => { void loadProject(); }}>Reset</Button><Button onclick={() => void saveWorkspace()} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button></div></section><section class="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]"><div class="border-b border-white/[0.08] p-5 sm:p-6"><h2 class="text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500">Workspace lifecycle</h2></div><div class="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] p-5 sm:p-6"><div><h2 class="text-sm font-semibold">Archive workspace</h2><p class="mt-1 max-w-3xl text-sm leading-6 text-neutral-500">Hide this workspace from the switcher on this device. The local folder remains untouched.</p></div><Button variant="outline" onclick={() => toast.info("Workspace archive will be available when workspace profiles are added")}><Archive class="size-4" />Archive</Button></div><div class="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6"><div><h2 class="text-sm font-semibold">Delete workspace</h2><p class="mt-1 max-w-3xl text-sm leading-6 text-neutral-500">Permanently remove this workspace from Loom. The local folder is not deleted.</p></div><Button variant="destructive" onclick={() => deleteOpen = true}><Trash2 class="size-4" />Delete</Button></div></section>{/if}{/if}
				{#if error}<p class="mt-4 text-sm text-red-400" role="alert">{error}</p>{/if}{#if message}<p class="mt-4 text-sm text-emerald-400" role="status">{message}</p>{/if}
				<section class="mt-8"><h2 class="mb-3 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500">Security & updates</h2><div class="grid gap-6 lg:grid-cols-2"><section class="rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6"><h2 class="font-semibold">UI password</h2><p class="mt-1 text-sm text-neutral-500">Protect this local Loom interface. Default password: {DEFAULT_UI_PASSWORD}</p><form class="mt-5 space-y-4" onsubmit={(event) => { event.preventDefault(); changePassword(); }}><label class="block space-y-2 text-sm"><span>Current password</span><Input type="password" bind:value={currentPassword} /></label><label class="block space-y-2 text-sm"><span>New password</span><Input type="password" bind:value={newPassword} /></label>{#if passwordError}<p class="text-sm text-red-400" role="alert">{passwordError}</p>{/if}{#if passwordMessage}<p class="text-sm text-emerald-400" role="status">{passwordMessage}</p>{/if}<Button type="submit">Change password</Button></form></section><section class="rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6"><h2 class="font-semibold">Updates</h2><p class="mt-1 mb-5 text-sm text-neutral-500">Manage Loom release channels and update checks.</p><UpdateNotice expanded /></section></div></section>
			</div>
		</main>
	</div>
</div>

<AlertDialog.Root bind:open={deleteOpen}><AlertDialog.Content><AlertDialog.Header><AlertDialog.Title>Delete workspace?</AlertDialog.Title><AlertDialog.Description>This removes the workspace from Loom. The local repository folder will remain untouched.</AlertDialog.Description></AlertDialog.Header><AlertDialog.Footer><AlertDialog.Cancel>Cancel</AlertDialog.Cancel><AlertDialog.Action onclick={() => void deleteWorkspace()}>Delete workspace</AlertDialog.Action></AlertDialog.Footer></AlertDialog.Content></AlertDialog.Root>
