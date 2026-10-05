<script lang="ts">
import {
	Check,
	ChevronDown,
	Copy,
	FileCode,
	Pencil,
	Terminal,
	Wrench,
} from "@lucide/svelte";
import { toast } from "svelte-sonner";
import {
	type ChatMessage,
	type ChatPart,
	chat,
	type FileDiff,
} from "$lib/chat";
import { Button } from "$lib/components/ui/button";
import * as Marker from "$lib/components/ui/marker";
import CodeBlock from "./CodeBlock.svelte";
import Markdown from "./Markdown.svelte";

let {
	messages,
	sessionId,
	projectId,
	onfile,
}: {
	messages: ChatMessage[];
	sessionId: string;
	projectId: string;
	onfile: (path: string) => void;
} = $props();

const role = $derived(messages[0]?.info.role ?? "assistant");
const first = $derived(messages[0]);
const agent = $derived(messages.find((m) => m.info.agent)?.info.agent);
const modelID = $derived(messages.find((m) => m.info.modelID)?.info.modelID);
const time = $derived(first ? first.info.time.created : Date.now());
const error = $derived(messages.find((m) => m.info.error)?.info.error);

let copied = $state(false);

type FilePreview = {
	open: boolean;
	tab: "changes" | "content";
	loading: boolean;
	error: string;
	patch?: string;
	additions: number;
	deletions: number;
	content: string;
};
let previews = $state<Record<string, FilePreview>>({});
let sessionDiffs = $state<FileDiff[] | null>(null);

$effect(() => {
	sessionId;
	previews = {};
	sessionDiffs = null;
});

async function togglePreview(file: string) {
	const existing = previews[file];
	if (existing?.open) {
		previews[file] = { ...existing, open: false };
		return;
	}
	if (!sessionId) {
		toast.error("Open a session to preview files");
		return;
	}
	previews[file] = {
		open: true,
		tab: "changes",
		loading: true,
		error: "",
		additions: 0,
		deletions: 0,
		content: "",
	};
	try {
		if (!sessionDiffs) sessionDiffs = await chat.diff(sessionId);
		const diff = sessionDiffs.find(
			(d) => d.file === file || file.endsWith(`/${d.file}`),
		);
		let content = "";
		try {
			const result = await chat.file(projectId, file);
			content =
				result.encoding === "base64"
					? "Binary file preview is unavailable."
					: result.content;
		} catch {
			content = diff ? "" : "File is no longer available in the project.";
		}
		previews[file] = {
			open: true,
			tab: diff ? "changes" : "content",
			loading: false,
			error: "",
			patch: diff?.patch,
			additions: diff?.additions ?? 0,
			deletions: diff?.deletions ?? 0,
			content,
		};
	} catch (reason) {
		previews[file] = {
			open: true,
			tab: "content",
			loading: false,
			error:
				reason instanceof Error ? reason.message : "Unable to load preview",
			additions: 0,
			deletions: 0,
			content: "",
		};
	}
}

type ToolKind = "shell" | "edit" | "other";
function kindOf(part: ChatPart): ToolKind {
	const name = `${part.tool ?? ""} ${part.state?.title ?? ""}`.toLowerCase();
	if (/shell|bash|command|exec/.test(name)) return "shell";
	if (/edit|write|patch|apply/.test(name)) return "edit";
	return "other";
}
function commandOf(part: ChatPart) {
	const input = part.state?.input as Record<string, unknown> | undefined;
	for (const key of ["command", "cmd", "script"]) {
		if (typeof input?.[key] === "string" && input[key])
			return input[key] as string;
	}
	return part.state?.title || part.tool || "Tool call";
}
function fileOf(part: ChatPart) {
	const input = part.state?.input as Record<string, unknown> | undefined;
	for (const key of ["filePath", "path", "file", "filename"]) {
		if (typeof input?.[key] === "string" && input[key])
			return input[key] as string;
	}
	return "";
}
function diffStats(part: ChatPart) {
	const metadata = part.state?.metadata as
		| {
				filediff?: { additions?: number; deletions?: number };
				files?: Array<{ additions?: number; deletions?: number }>;
		  }
		| undefined;
	const files = metadata?.filediff
		? [metadata.filediff]
		: (metadata?.files ?? []);
	let additions = 0;
	let deletions = 0;
	let found = false;
	for (const file of files) {
		if (typeof file.additions === "number") {
			additions += file.additions;
			found = true;
		}
		if (typeof file.deletions === "number") {
			deletions += file.deletions;
			found = true;
		}
	}
	return found ? { additions, deletions } : null;
}
function statusOf(part: ChatPart) {
	const status = part.state?.status ?? "unknown";
	if (status === "completed") return "completed";
	if (status === "running" || status === "pending") return "running";
	if (status === "error" || status === "failed") return "error";
	return status;
}

async function copy() {
	try {
		await navigator.clipboard.writeText(
			messages
				.flatMap((m) => m.parts)
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("\n\n"),
		);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	} catch {
		toast.error("Unable to copy message");
	}
}
</script>

<article class="group min-w-0" aria-label={role === "user" ? "Your message" : "OpenCode response"}>
	<div class="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
		<span class="font-medium text-foreground">{role === "user" ? "You" : "OpenCode"}</span>
		{#if agent}<span>{agent}</span>{/if}
		{#if modelID}<span class="truncate">{modelID}</span>{/if}
		<time class="ml-auto shrink-0">{new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
	</div>
	{#if role === "user"}
		{#each messages as message (message.info.id)}
			<div class="rounded-xl border bg-muted/40 px-4 py-3">
				{#each message.parts as part (part.id)}
					{#if part.type === "text" && part.text}<Markdown text={part.text} />
					{:else if part.type === "file" && part.filename}
						<Button variant="outline" size="sm" class="my-2 max-w-full" onclick={() => onfile(part.filename!)}><FileCode size={14} /><span class="truncate">{part.filename}</span></Button>
					{/if}
				{/each}
			</div>
		{/each}
	{:else}
		<div class="min-w-0 py-1">
			{#each messages as message (message.info.id)}
				{#each message.parts as part (part.id)}
					{#if part.type === "text" && part.text}<Markdown text={part.text} />
					{:else if part.type === "reasoning" && part.text}
						<details class="my-3 rounded-lg border px-3 py-2 text-xs text-muted-foreground"><summary class="cursor-pointer">Thinking</summary><div class="mt-3"><Markdown text={part.text} /></div></details>
					{:else if part.type === "tool" && part.state}
						{@const kind = kindOf(part)}
						{@const stats = kind === "edit" ? diffStats(part) : null}
						{@const file = fileOf(part)}
						<div class="my-2 overflow-hidden rounded-lg border bg-card/50">
							<details>
								<summary class="flex cursor-pointer list-none items-center gap-2 p-3 text-xs [&::-webkit-details-marker]:hidden">
									{#if kind === "shell"}<Terminal size={14} class="shrink-0 text-muted-foreground" />
									{:else if kind === "edit"}<Pencil size={14} class="shrink-0 text-muted-foreground" />
									{:else}<Wrench size={14} class="shrink-0 text-muted-foreground" />{/if}
									<span class="shrink-0 font-medium">{kind === "shell" ? "Shell Command" : kind === "edit" ? "Edit File" : (part.state.title || part.tool || "Tool")}</span>
									<span class="min-w-0 flex-1 truncate text-muted-foreground">{kind === "edit" && file ? file : commandOf(part)}</span>
									{#if stats}<span class="shrink-0 font-mono text-[11px]"><span class="text-emerald-400">+{stats.additions}</span><span class="text-red-400">−{stats.deletions}</span></span>{/if}
									<Marker.Root class="shrink-0 text-[11px]"><Marker.Content>{statusOf(part)}</Marker.Content></Marker.Root>
									<ChevronDown size={14} class="shrink-0 text-muted-foreground" />
								</summary>
								<div class="space-y-2 border-t p-3">
									{#if kind !== "edit" && part.state.input}<CodeBlock code={JSON.stringify(part.state.input, null, 2)} language="json" maxHeight="max-h-60" />{/if}
									{#if part.state.output}<CodeBlock code={part.state.output} maxHeight="max-h-80" />{/if}
									{#if part.state.error}<p class="text-sm text-destructive" role="alert">{part.state.error}</p>{/if}
								</div>
							</details>
							{#if file}
								{@const preview = previews[file]}
								<Button variant="ghost" class="w-full justify-start rounded-none border-t text-xs" onclick={() => void togglePreview(file)} aria-expanded={!!preview?.open}><FileCode size={14} /><span class="truncate">{file}</span><span class="ml-auto flex items-center gap-1">{preview?.open ? "Hide preview" : "Open file / diff"}<ChevronDown size={13} class={preview?.open ? "rotate-180" : ""} /></span></Button>
								{#if preview?.open}
									<div class="border-t p-3">
										{#if preview.loading}
											<p class="py-3 text-center text-xs text-muted-foreground">Loading preview…</p>
										{:else if preview.error}
											<p class="text-xs text-destructive" role="alert">{preview.error}</p>
										{:else}
											<div class="mb-2 flex gap-1 text-xs">
												<Button variant={preview.tab === "changes" ? "secondary" : "ghost"} size="sm" class="h-7" onclick={() => (previews[file] = { ...preview, tab: "changes" })}>Changes{#if preview.additions || preview.deletions}<span class="ml-1 font-mono"><span class="text-emerald-400">+{preview.additions}</span><span class="text-red-400">−{preview.deletions}</span></span>{/if}</Button>
												<Button variant={preview.tab === "content" ? "secondary" : "ghost"} size="sm" class="h-7" onclick={() => (previews[file] = { ...preview, tab: "content" })}>File content</Button>
											</div>
											{#if preview.tab === "changes"}
												{#if preview.patch}
													<div class="nice-scroll max-h-80 overflow-auto rounded-lg border bg-background"><pre class="min-w-fit py-2 text-xs leading-6">{#each preview.patch.split("\n") as line}<div class={`min-h-6 px-3 ${line.startsWith("+") ? "bg-emerald-500/10 text-emerald-300" : line.startsWith("-") ? "bg-red-500/10 text-red-300" : line.startsWith("@@") ? "bg-blue-500/10 text-blue-300" : "text-muted-foreground"}`}>{line || " "}</div>{/each}</pre></div>
												{:else}<p class="py-2 text-xs text-muted-foreground">No recorded changes for this file yet.</p>{/if}
											{:else}
												<CodeBlock code={preview.content || "(empty file)"} language={file} maxHeight="max-h-80" />
											{/if}
										{/if}
									</div>
								{/if}
							{/if}
						</div>
					{:else if part.type === "file" && part.filename}
						<Button variant="outline" size="sm" class="my-2 max-w-full" onclick={() => onfile(part.filename!)}><FileCode size={14} /><span class="truncate">{part.filename}</span></Button>
					{/if}
				{/each}
			{/each}
			{#if error}<p class="mt-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive" role="alert">{error.data?.message || error.name}</p>{/if}
		</div>
		<Button variant="ghost" size="sm" class="mt-1 text-xs text-muted-foreground" onclick={copy}>{#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}{copied ? "Copied" : "Copy response"}</Button>
	{/if}
</article>
