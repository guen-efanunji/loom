<script lang="ts">
import { toast } from "svelte-sonner";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import { daemon } from "$lib/daemon";
let { oncreated }: { oncreated: () => void } = $props();
let path = $state("");
let submitting = $state(false);
let error = $state("");
async function submit() {
	if (!path.trim() || submitting) return;
	error = "";
	submitting = true;
	try {
		await daemon.createProject(path.trim());
		toast.success("Project added");
		oncreated();
	} catch (reason) {
		error = reason instanceof Error ? reason.message : "Unable to add project";
	} finally {
		submitting = false;
	}
}
</script>
<form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
  <label class="block space-y-2 text-sm font-medium" for="project-path"><span>Project folder path</span><Input id="project-path" bind:value={path} placeholder="/home/name/Projects/my-app" required /></label>
  <p class="text-xs text-muted-foreground">Enter the full path to a local Git repository.</p>
  {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
  <div class="flex justify-end"><Button type="submit" disabled={submitting || !path.trim()}>{submitting ? "Validating…" : "Add project"}</Button></div>
</form>
