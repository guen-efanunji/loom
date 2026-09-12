<script lang="ts">
import { Check, ChevronDown, Copy, FileCode, Terminal } from "@lucide/svelte";
import { toast } from "svelte-sonner";
import type { ChatMessage } from "$lib/chat";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import Markdown from "./Markdown.svelte";

let {
	message,
	onfile,
}: { message: ChatMessage; onfile: (path: string) => void } = $props();
let copied = $state(false);
async function copy() {
	try {
		await navigator.clipboard.writeText(
			message.parts
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("\n\n"),
		);
		copied = true;
	} catch {
		toast.error("Unable to copy message");
	}
}
</script>
<article class="group min-w-0" aria-label={message.info.role === "user" ? "Your message" : "OpenCode response"}>
  <div class="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
    <span class="font-medium text-foreground">{message.info.role === "user" ? "You" : "OpenCode"}</span>
    {#if message.info.agent}<span>{message.info.agent}</span>{/if}
    {#if message.info.modelID}<span class="truncate">{message.info.modelID}</span>{/if}
    <time class="ml-auto shrink-0">{new Date(message.info.time.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
  </div>
  <div class={message.info.role === "user" ? "rounded-xl border bg-muted/40 px-4 py-3" : "min-w-0 py-1"}>
    {#each message.parts as part (part.id)}
      {#if part.type === "text" && part.text}<Markdown text={part.text} />
      {:else if part.type === "reasoning" && part.text}
        <details class="my-3 rounded-lg border px-3 py-2 text-xs text-muted-foreground"><summary class="cursor-pointer">Thinking</summary><div class="mt-3"><Markdown text={part.text} /></div></details>
      {:else if part.type === "tool" && part.state}
        {@const file = part.state.input?.filePath ?? part.state.input?.path}
        <div class="my-3 overflow-hidden rounded-lg border bg-card/50">
          <details>
            <summary class="flex cursor-pointer items-center gap-2 p-3 text-xs"><Terminal size={14} /><span class="min-w-0 flex-1 truncate">{part.state.title || part.tool}</span><Badge variant="outline">{part.state.status}</Badge><ChevronDown size={14} /></summary>
            <div class="space-y-2 border-t p-3">
              {#if part.state.input}<pre class="max-h-60 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(part.state.input, null, 2)}</pre>{/if}
              {#if part.state.output}<pre class="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{part.state.output}</pre>{/if}
              {#if part.state.error}<p class="text-sm text-destructive" role="alert">{part.state.error}</p>{/if}
            </div>
          </details>
          {#if typeof file === "string"}<Button variant="ghost" class="w-full justify-start rounded-none border-t text-xs" onclick={() => onfile(file)}><FileCode size={14} /><span class="truncate">{file}</span><span class="ml-auto">Open file / diff</span></Button>{/if}
        </div>
      {:else if part.type === "file" && part.filename}
        <Button variant="outline" size="sm" class="my-2 max-w-full" onclick={() => onfile(part.filename!)}><FileCode size={14} /><span class="truncate">{part.filename}</span></Button>
      {/if}
    {/each}
    {#if message.info.error}<p class="mt-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive" role="alert">{message.info.error.data?.message || message.info.error.name}</p>{/if}
  </div>
  {#if message.info.role === "assistant"}<Button variant="ghost" size="sm" class="mt-1 text-xs text-muted-foreground" onclick={copy}>{#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}{copied ? "Copied" : "Copy response"}</Button>{/if}
</article>
