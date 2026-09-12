<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import { Textarea } from "$lib/components/ui/textarea";
import { daemon } from "$lib/daemon";

let title = $state("");
let goal = $state("");
let planning = $state(false);
let error = $state("");
const projectId = $derived(page.url.searchParams.get("project") ?? "");
async function plan() {
	if (!projectId || !title.trim() || !goal.trim()) return;
	planning = true;
	error = "";
	try {
		const epic = await daemon.createEpic({
			projectId,
			title: title.trim(),
			goal: goal.trim(),
		});
		await goto(`/epic/${epic.id}`);
	} catch (reason) {
		error = reason instanceof Error ? reason.message : "Planner failed";
	} finally {
		planning = false;
	}
}
</script>
<main class="mx-auto max-w-3xl px-4 py-10"><a href={`/project/${projectId}`} class="text-sm text-neutral-500">← Project</a><h1 class="mt-6 text-3xl font-semibold">New work</h1><p class="mt-2 text-neutral-500">Describe the outcome. Loom proposes an editable DAG before any agent starts.</p><form class="mt-8 space-y-4 rounded-xl border border-neutral-800 bg-neutral-900 p-6" onsubmit={event => { event.preventDefault(); plan(); }}><Input bind:value={title} maxlength={200} placeholder="Epic title" /><Textarea bind:value={goal} rows={10} placeholder="Implement notification system: realtime backend, notification center UI, and integration tests" />{#if error}<p class="text-sm text-red-300">{error}</p>{/if}<Button type="submit" disabled={planning}>{planning ? "Planning with OpenCode…" : "Plan tasks"}</Button></form></main>
