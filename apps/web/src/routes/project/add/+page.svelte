<script lang="ts">
import { goto } from "$app/navigation";
import { daemon } from "$lib/daemon";

let path = $state("");
let submitting = $state(false);
let error = $state("");

async function submit() {
	error = "";
	if (!path.trim()) {
		error = "Repository path is required";
		return;
	}
	submitting = true;
	try {
		const project = await daemon.createProject(path);
		await goto(`/project/${project.id}`);
	} catch (reason: unknown) {
		error = reason instanceof Error ? reason.message : "Unable to add project";
	} finally {
		submitting = false;
	}
}
</script>

<div class="mx-auto max-w-2xl px-4 py-8 sm:px-6"><a href="/projects" class="text-sm text-neutral-500 hover:text-neutral-200">← Projects</a><h1 class="mt-8 text-3xl font-semibold">Add project</h1><p class="mt-2 text-neutral-400">Register a local Git repository with Loom.</p><form class="mt-8 space-y-5 rounded-xl border border-neutral-800 bg-neutral-900 p-6" onsubmit={(event) => { event.preventDefault(); submit(); }}><label class="block text-sm font-medium" for="path">Repository path<input id="path" bind:value={path} class="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 outline-none focus:border-neutral-400" placeholder="/Users/name/Projects/my-app" /></label>{#if error}<p class="text-sm text-red-300">{error}</p>{/if}<button disabled={submitting} class="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50">{submitting ? "Validating..." : "Add project"}</button></form></div>
