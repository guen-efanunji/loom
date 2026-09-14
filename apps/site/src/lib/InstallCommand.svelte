<script lang="ts">
  import { onMount } from "svelte";
  import { Copy, Check, Terminal } from "@lucide/svelte";
  import { Button } from "$ui/button";
  import * as Tabs from "$ui/tabs";
  import { installCommands } from "$lib/config";
  let os = $state("unix");
  let copied = $state(false);
  let error = $state("");
  const command = $derived(os === "windows" ? installCommands.windows : installCommands.unix);
  onMount(() => { if (navigator.userAgent.includes("Windows")) os = "windows"; });
  async function copy() {
    try { await navigator.clipboard.writeText(command); copied = true; setTimeout(() => copied = false, 2000); }
    catch { error = "Select the command to copy it manually."; }
  }
</script>
<div class="install-command">
  <Tabs.Root bind:value={os}>
    <div class="install-top"><Tabs.List aria-label="Choose your operating system"><Tabs.Trigger value="unix">macOS / Linux</Tabs.Trigger><Tabs.Trigger value="windows">Windows</Tabs.Trigger></Tabs.List><span><Terminal size={13}/> {os === "windows" ? "PowerShell" : "Terminal"}</span></div>
    <div class="command-line"><code>{command}</code><Button variant="ghost" size="icon" onclick={copy} aria-label={copied ? "Command copied" : "Copy install command"}>{#if copied}<Check size={16}/>{:else}<Copy size={16}/>{/if}</Button></div>
  </Tabs.Root>
  <p class="copy-feedback" aria-live="polite">{error || (copied ? "Copied. Paste it into your terminal." : "Then run loom to open your workspace.")}</p>
</div>
