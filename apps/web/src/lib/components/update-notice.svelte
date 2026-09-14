<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowUpCircle, RefreshCw, ArrowUpRight, Check } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { request } from "$lib/daemon";
  let { expanded = false }: { expanded?: boolean } = $props();
  type Status = { current: string; channel: "stable" | "beta"; available: boolean; supported: boolean; enabled: boolean; error?: string; checkedAt: string | null; latest: { version: string; protocolVersion: number } | null; lastResult?: { status: string; error?: string; rolledBack?: boolean } | null };
  let status = $state<Status | null>(null);
  let open = $state(false);
  let dismissed = $state("");
  let busy = $state(false);
  let message = $state("");
  let error = $state("");
  let channel = $state("stable");
  let enabled = $state(true);
  let alive = true;
  async function refresh() {
    try { status = await request<Status>("/api/updates"); channel = status.channel; enabled = status.enabled; }
    catch (e) { if (expanded) error = e instanceof Error ? e.message : "Unable to read update status"; }
  }
  onMount(() => { alive = true; void refresh(); const timer = setInterval(refresh, 30 * 60_000); return () => { alive = false; clearInterval(timer); }; });
  async function check() {
    busy = true; error = ""; message = "";
    try { const next = await request<Partial<Status>>("/api/updates/check", { method: "POST" }); if (status) status = { ...status, ...next }; if (next.error) error = next.error; else if (!next.available) message = "You are using the latest available release."; }
    catch (e) { error = e instanceof Error ? e.message : "Release check failed"; }
    finally { busy = false; }
  }
  async function save() {
    busy = true; error = "";
    try { await request("/api/updates/settings", { method: "PUT", body: JSON.stringify({ releaseChannel: channel, updateChecks: enabled }) }); await refresh(); message = "Update preferences saved."; }
    catch (e) { error = e instanceof Error ? e.message : "Could not save preferences"; }
    finally { busy = false; }
  }
  async function install() {
    busy = true; error = ""; message = "Downloading and verifying the release…";
    try {
      const result = await request<{ updating: boolean; version: string }>("/api/updates/install", { method: "POST" });
      if (!result.updating) { message = "You are up to date."; return; }
      message = "Restarting Loom. This page will reconnect automatically.";
      for (let i = 0; i < 100 && alive; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const meta = await request<{ version: string }>("/api/meta");
          if (meta.version === result.version) { window.location.reload(); return; }
          const next = await request<Status>("/api/updates");
          if (next.lastResult?.status === "failed") throw new Error(next.lastResult.error || "Update failed; the previous version was restored.");
        } catch (e) { if (e instanceof Error && !/fetch|network|connect|unavailable/i.test(e.message)) throw e; }
      }
      throw new Error("Loom has not reconnected yet. Run loom doctor and loom logs to check the update.");
    } catch (e) { error = e instanceof Error ? e.message : "Update failed"; message = ""; }
    finally { busy = false; }
  }
</script>
{#if expanded}<section class="rounded-xl border border-border bg-card p-5"><div class="flex items-center justify-between gap-4"><div><h2 class="text-sm font-semibold">Loom updates</h2><p class="mt-1 text-xs text-muted-foreground">{status ? `Version ${status.current} · ${status.channel} channel` : "Checking local version…"}</p></div><Button variant="outline" onclick={() => open = true}>Manage updates</Button></div>{#if status?.lastResult?.status === "failed"}<p class="mt-3 text-xs text-destructive">Last update failed{status.lastResult.rolledBack ? "; previous version restored" : ""}. {status.lastResult.error}</p>{/if}</section>
{:else if status?.available && dismissed !== status.latest?.version}<aside class="fixed bottom-5 right-5 z-40 flex max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-xl border border-border bg-background/95 p-3 shadow-lg backdrop-blur" aria-label="Loom update available"><ArrowUpCircle class="size-4 text-primary"/><span class="text-xs">Loom {status.latest?.version} is available</span><Button size="sm" onclick={() => open = true}>Review</Button><Button variant="ghost" size="sm" onclick={() => dismissed = status?.latest?.version || ""}>Later</Button></aside>{/if}
<Dialog.Root bind:open><Dialog.Content class="sm:max-w-lg"><Dialog.Header><Dialog.Title>Keep Loom up to date</Dialog.Title><Dialog.Description>{status ? `Current version: ${status.current}` : "Manage your installed Loom release."}</Dialog.Description></Dialog.Header>{#if status?.available}<div class="rounded-lg border p-4"><p class="text-sm font-medium">Loom {status.latest?.version} is available</p><a class="mt-2 inline-flex items-center gap-1 text-xs text-primary underline" href={`https://github.com/MrPinguiiin/loom/releases/tag/v${status.latest?.version}`} target="_blank" rel="noreferrer">Release notes <ArrowUpRight class="size-3"/></a><p class="mt-3 text-xs leading-relaxed text-muted-foreground">Finish active tasks and chats first. Loom verifies the download, restarts, and restores the previous version if the startup check fails.</p><Button class="mt-4" disabled={busy || !status.supported} onclick={install}><ArrowUpCircle class="size-4"/>Update & Restart</Button></div>{/if}{#if status && !status.supported}<p class="text-xs text-muted-foreground">Updating the executable is available in installed release builds.</p>{/if}<div class="space-y-3"><p class="text-xs font-medium">Release channel</p><Tabs.Root bind:value={channel}><Tabs.List aria-label="Release channel"><Tabs.Trigger value="stable" disabled={busy}>Stable</Tabs.Trigger><Tabs.Trigger value="beta" disabled={busy}>Beta</Tabs.Trigger></Tabs.List></Tabs.Root><label class="flex items-center gap-2 text-xs"><Checkbox bind:checked={enabled} disabled={busy}/>Check for updates automatically</label><p class="text-xs text-muted-foreground">Checks contact GitHub at most once every six hours. Beta releases may be less stable.</p></div>{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}{#if message}<p role="status" class="text-xs text-muted-foreground">{message}</p>{/if}<Dialog.Footer><Button variant="outline" disabled={busy} onclick={check}><RefreshCw class="size-3"/>Check now</Button><Button disabled={busy} onclick={save}><Check class="size-3"/>Save preferences</Button></Dialog.Footer></Dialog.Content></Dialog.Root>
