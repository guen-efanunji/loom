<script lang="ts">
import {
	ArrowUp,
	Bot,
	ChevronDown,
	File,
	LoaderCircle,
	Paperclip,
	Square,
	X,
} from "@lucide/svelte";
import { tick } from "svelte";
import { type Catalog, chat } from "$lib/chat";
import { Button } from "$lib/components/ui/button";
import * as Command from "$lib/components/ui/command";
import * as Popover from "$lib/components/ui/popover";
import * as Select from "$lib/components/ui/select";
import { Textarea } from "$lib/components/ui/textarea";

let {
	projectId,
	catalog,
	busy,
	disabled,
	onsend,
	onstop,
	draft = $bindable(""),
	model = $bindable(""),
	agent = $bindable("build"),
	mode = $bindable("chat"),
}: {
	projectId: string;
	catalog: Catalog;
	busy: boolean;
	disabled: boolean;
	onsend: (input: {
		text: string;
		files: string[];
		agents: string[];
		agent?: string;
		model?: { providerID: string; modelID: string };
		mode: "chat" | "plan" | "build";
	}) => Promise<boolean>;
	onstop: () => void;
	draft?: string;
	model?: string;
	agent?: string;
	mode?: "chat" | "plan" | "build";
} = $props();
let textarea = $state<HTMLTextAreaElement | null>(null);
let files = $state<string[]>([]);
let agents = $state<string[]>([]);
let modelOpen = $state(false);
let query = $state<string | null>(null);
let results = $state<string[]>([]);
let searching = $state(false);
let searchError = $state("");
let active = $state(0);
let mentionStart = 0;
let cursor = 0;
let previousProject = "";
let sending = $state(false);
const choices = $derived([
	...catalog.agents
		.filter(
			(a) =>
				a.mode !== "primary" &&
				a.name.toLowerCase().includes((query ?? "").toLowerCase()),
		)
		.map((a) => ({ value: a.name, type: "agent" })),
	...results.map((value) => ({ value, type: "file" })),
]);
const selectedModel = $derived(
	catalog.models.find((m) => `${m.providerID}/${m.modelID}` === model),
);
$effect(() => {
	if (projectId !== previousProject) {
		previousProject = projectId;
		files = [];
		agents = [];
		query = null;
	}
});
$effect(() => {
	const value = query;
	const project = projectId;
	if (value === null || !project) return;
	let cancelled = false;
	searching = true;
	active = 0;
	searchError = "";
	const timer = setTimeout(async () => {
		try {
			const found = await chat.files(project, value);
			if (!cancelled) results = found;
		} catch (error) {
			if (!cancelled) {
				results = [];
				searchError =
					error instanceof Error ? error.message : "File search failed";
			}
		} finally {
			if (!cancelled) searching = false;
		}
	}, 150);
	return () => {
		cancelled = true;
		clearTimeout(timer);
	};
});
function input() {
	if (!textarea) return;
	cursor = textarea.selectionStart;
	const match = draft.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/);
	query = match ? match[1] : null;
	if (match) mentionStart = cursor - match[1].length - 1;
}
async function choose(item: { value: string; type: string }) {
	if (item.type === "file") files = [...new Set([...files, item.value])];
	else agents = [...new Set([...agents, item.value])];
	draft = `${draft.slice(0, mentionStart)}${draft.slice(cursor)}`;
	query = null;
	await tick();
	textarea?.focus();
	textarea?.setSelectionRange(mentionStart, mentionStart);
}
async function attach() {
	if (!textarea) return;
	textarea.focus();
	const pos = textarea.selectionStart ?? draft.length;
	draft = `${draft.slice(0, pos)}${pos && !/\s$/.test(draft.slice(0, pos)) ? " " : ""}@${draft.slice(pos)}`;
	await tick();
	textarea.setSelectionRange(
		pos + (draft[pos] === " " ? 2 : 1),
		pos + (draft[pos] === " " ? 2 : 1),
	);
	input();
}
async function send() {
	if (sending || busy || disabled || (!draft.trim() && !files.length)) return;
	sending = true;
	query = null;
	try {
		const ok = await onsend({
			text: draft.trim(),
			files,
			agents,
			agent,
			mode,
			model: selectedModel
				? {
						providerID: selectedModel.providerID,
						modelID: selectedModel.modelID,
					}
				: undefined,
		});
		if (ok) {
			draft = "";
			files = [];
			agents = [];
		}
	} finally {
		sending = false;
	}
}
function keydown(event: KeyboardEvent) {
	if (event.isComposing) return;
	if (query !== null) {
		if (event.key === "Escape") {
			event.preventDefault();
			query = null;
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			active = Math.max(
				0,
				Math.min(
					choices.length - 1,
					active + (event.key === "ArrowDown" ? 1 : -1),
				),
			);
			document
				.getElementById(`mention-${active}`)
				?.scrollIntoView({ block: "nearest" });
			return;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			if (choices[active]) void choose(choices[active]);
			return;
		}
	}
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		void send();
	}
}
</script>
<form onsubmit={(event) => { event.preventDefault(); void send(); }} class="relative rounded-2xl border bg-card shadow-lg shadow-black/10">
  {#if query !== null}
    <div class="absolute bottom-full left-0 z-30 mb-2 w-full overflow-hidden rounded-xl border bg-popover shadow-xl">
      <div class="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground"><span>Files & agents · {choices.length} results</span><span>↑ ↓ select · Enter attach · Esc close</span></div>
      <div class="max-h-64 overflow-y-auto p-1" role="listbox" aria-label="Files and agents" id="mention-list">
        {#if searching}<p class="p-3 text-xs text-muted-foreground">Searching project files…</p>{:else if searchError}<p role="alert" class="p-3 text-xs text-destructive">{searchError}</p>{:else if !choices.length}<p class="p-3 text-xs text-muted-foreground">No matching files or agents.</p>{/if}
        {#each choices as item, index}
          <Button id={`mention-${index}`} type="button" role="option" aria-selected={active === index} variant="ghost" class={`h-auto w-full justify-start py-2 text-left text-xs ${active === index ? "bg-accent" : ""}`} onclick={() => choose(item)}>
            {#if item.type === "agent"}<Bot size={15} />{:else}<File size={15} />{/if}<span class="min-w-0 truncate">{item.value}</span><span class="ml-auto text-muted-foreground">{item.type}</span>
          </Button>
        {/each}
      </div>
    </div>
  {/if}
  {#if files.length || agents.length}<div class="flex flex-wrap gap-1 px-3 pt-3">
    {#each files as file}<Button variant="secondary" size="sm" class="max-w-full text-xs" onclick={() => files = files.filter((f) => f !== file)} title={`Remove ${file}`} aria-label={`Remove ${file}`}><File size={12} /><span class="truncate">{file}</span><X size={12} /></Button>{/each}
    {#each agents as name}<Button variant="secondary" size="sm" class="text-xs" onclick={() => agents = agents.filter((a) => a !== name)} title={`Remove ${name}`}><Bot size={12} />{name}<X size={12} /></Button>{/each}
  </div>{/if}
  <Textarea bind:ref={textarea} bind:value={draft} oninput={input} onclick={input} onkeydown={keydown} aria-label="Message OpenCode" aria-controls={query !== null ? "mention-list" : undefined} aria-activedescendant={query !== null ? `mention-${active}` : undefined} placeholder="Ask anything… @ for files and agents" rows={3} class="max-h-56 min-h-24 resize-none border-0 bg-transparent p-4 text-sm shadow-none focus-visible:ring-0" disabled={disabled || sending} />
  <div class="flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
    <Button variant="ghost" size="icon" title="Attach project file" aria-label="Attach project file" disabled={!projectId || sending} onclick={attach}><Paperclip size={16} /></Button>
    <div class="flex min-w-0 items-center gap-1">
      <Popover.Root bind:open={modelOpen}><Popover.Trigger class="flex max-w-44 items-center gap-1 rounded-md px-2 py-1.5 text-xs hover:bg-accent" aria-label="Select model"><span class="truncate">{selectedModel?.name ?? "Default model"}</span><ChevronDown size={12} /></Popover.Trigger>
        <Popover.Content class="w-80 p-0" align="end"><Command.Root><Command.Input placeholder="Search models…" /><Command.List><Command.Empty>No configured models found.</Command.Empty><Command.Group heading="Models"><Command.Item value="default" onSelect={() => { model = ""; modelOpen = false; }}>Default model</Command.Item>{#each catalog.models as item}<Command.Item value={`${item.providerID}/${item.modelID} ${item.name}`} onSelect={() => { model = `${item.providerID}/${item.modelID}`; modelOpen = false; }}><div><p>{item.name}</p><p class="text-xs text-muted-foreground">{item.provider}</p></div></Command.Item>{/each}</Command.Group></Command.List></Command.Root></Popover.Content>
      </Popover.Root>
      <Select.Root type="single" bind:value={mode}><Select.Trigger class="h-8 w-auto border-0 text-xs shadow-none" aria-label="Select composer mode">{mode === "chat" ? "Chat" : mode === "plan" ? "Plan" : "Build"}</Select.Trigger><Select.Content><Select.Item value="chat">Chat · normal conversation</Select.Item><Select.Item value="plan">Plan · brief to Kanban plan</Select.Item><Select.Item value="build">Build · plan, create, and start</Select.Item></Select.Content></Select.Root>
      <Select.Root type="single" bind:value={agent}><Select.Trigger class="h-8 w-auto border-0 text-xs shadow-none" aria-label="Select agent">{agent}</Select.Trigger><Select.Content>{#each catalog.agents.filter((a) => a.mode !== "subagent") as item}<Select.Item value={item.name}>{item.name}</Select.Item>{/each}</Select.Content></Select.Root>
      {#if busy}<Button type="button" size="icon" variant="secondary" aria-label="Stop response" title="Stop response" onclick={onstop}><Square size={14} /></Button>{:else}<Button type="submit" size="icon" class="rounded-full" aria-label="Send message" title="Send message" disabled={disabled || sending || (!draft.trim() && !files.length)}>{#if sending}<LoaderCircle size={16} class="animate-spin" />{:else}<ArrowUp size={17} />{/if}</Button>{/if}
    </div>
  </div>
</form>
<p class="mt-2 text-center text-[11px] text-muted-foreground">Enter to send · Shift + Enter for a new line · Files attach from your project</p>
