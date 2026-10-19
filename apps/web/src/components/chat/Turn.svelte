<script lang="ts">
import {
	Check,
	Copy,
	FileCode,
	MessageSquarePlus,
	PanelsTopLeft,
	Pencil,
	Sparkles,
	Terminal,
	Wrench,
} from "@lucide/svelte";
import { toast } from "svelte-sonner";
import {
	type ChatMessage,
	type ChatPart,
	type Catalog,
	chat,
	type FileDiff,
	providerDisplayName,
} from "$lib/chat";
import { Button } from "$lib/components/ui/button";
import { Badge } from "$lib/components/ui/badge";
import * as Trace from "$lib/components/ui/trace";
import { type DesignNode, daemon } from "$lib/daemon";
import CodeBlock from "./CodeBlock.svelte";
import Markdown from "./Markdown.svelte";

let {
	messages,
	catalog,
	sessionId,
	projectId,
	onfile,
	onopenfile,
	onbranch,
}: {
	messages: ChatMessage[];
	catalog: Catalog;
	sessionId: string;
	projectId: string;
	onfile: (path: string) => void;
	onopenfile?: (path: string) => void;
	onbranch?: (answer: string) => void;
} = $props();

const role = $derived(messages[0]?.info.role ?? "assistant");
const first = $derived(messages[0]);
const agent = $derived(messages.find((m) => m.info.agent)?.info.agent);
const providerID = $derived(
	messages.find((m) => m.info.providerID)?.info.providerID,
);
const providerLabel = $derived(providerDisplayName(catalog, providerID));
const modelTone = $derived(
	providerID === "agy" || providerID === "antigravity"
		? "agy"
		: providerID === "claude" || providerID === "anthropic"
			? "claude"
			: providerID === "codex" || providerID === "openai"
				? "codex"
				: providerID === "opencode"
					? "opencode"
					: "default",
);
const modelID = $derived(messages.find((m) => m.info.modelID)?.info.modelID);
const time = $derived(first ? first.info.time.created : Date.now());
const completedAt = $derived(messages.at(-1)?.info.time.completed);
const elapsed = $derived(
	completedAt !== undefined && first
		? Math.max(0, completedAt - first.info.time.created)
		: null,
);
const error = $derived(messages.find((m) => m.info.error)?.info.error);
const responseText = $derived(
	messages
		.flatMap((message) => message.parts)
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.filter(Boolean)
		.join("\n\n"),
);
const canCopyResponse = $derived(
	role === "assistant" &&
		!!responseText.trim() &&
		messages[messages.length - 1]?.info.time.completed !== undefined,
);
type NativeTodo = {
	id: string;
	title: string;
	status: "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
};
function nativeTodoSnapshot(messages: ChatMessage[]): NativeTodo[] | null {
	const snapshots = messages
		.flatMap((message) => message.parts)
		.filter((part) => {
			if (part.type !== "tool" || !part.state) return false;
			const name = (part.tool ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
			return ["todowrite", "writetodos", "updatetodolist", "updateplan"].includes(name);
		});
	const latest = snapshots.at(-1);
	if (!latest || latest.type !== "tool" || !latest.state) return null;
	const input = latest.state.input as Record<string, unknown> | undefined;
	if (!input) return null;
	const raw = [input.todos, input.tasks, input.plan, input.steps].find(Array.isArray);
	if (!Array.isArray(raw)) return null;
	const todos = raw.flatMap((value, index) => {
		if (!value || typeof value !== "object") return [];
		const item = value as Record<string, unknown>;
		const title = [item.content, item.title, item.step, item.description].find(
			(value): value is string => typeof value === "string" && !!value.trim(),
		);
		if (!title) return [];
		const state = String(item.status ?? item.state ?? "pending").toLowerCase();
		const status: NativeTodo["status"] =
			state === "completed" || state === "complete" || state === "done"
				? "completed"
				: state === "in_progress" || state === "in-progress" || state === "active"
					? "in_progress"
					: state === "blocked"
						? "blocked"
						: state === "cancelled" || state === "canceled"
							? "cancelled"
							: "pending";
		return [{ id: String(item.id ?? `${latest.id}-${index}`), title, status }];
	});
	return todos.length ? todos : null;
}
const nativeTodos = $derived(nativeTodoSnapshot(messages));

let copied = $state(false);
let openTools = $state<Record<string, boolean>>({});

type InlineDiff = Pick<FileDiff, "file" | "patch" | "additions" | "deletions">;
let inlineDiffs = $state<Record<string, InlineDiff | null>>({});
let inlineDiffLoading = $state<Record<string, boolean>>({});
let designPreviews = $state<Record<string, DesignNode>>({});
let sessionDiffs = $state<FileDiff[] | null>(null);
let diffPrefetchSession = "";

$effect(() => {
	sessionId;
	inlineDiffs = {};
	inlineDiffLoading = {};
	sessionDiffs = null;
	diffPrefetchSession = "";
});

function designIdOf(part: ChatPart) {
	if (part.designId) return part.designId;
	const legacyId = part.id.match(/-design-(.+)$/)?.[1];
	if (part.type === "design" && legacyId) return legacyId;
	return part.filename?.match(/^canvas-design:(.+)\.html$/)?.[1] ?? "";
}

function visibleText(part: ChatPart) {
	const text = part.text ?? "";
	if (!text.startsWith("IMPLEMENTATION PRIORITY:")) return text;
	return (
		text.match(
			/\n\nUser request:\n([\s\S]*?)(?=\n\nAttached Canvas nodes:|$)/,
		)?.[1] ?? ""
	);
}

function thumbnailStyle(node: DesignNode, boxWidth: number, boxHeight: number) {
	const frame =
		node.viewport === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 };
	const scale = Math.min(boxWidth / frame.width, boxHeight / frame.height);
	const left = (boxWidth - frame.width * scale) / 2;
	const top = (boxHeight - frame.height * scale) / 2;
	return `width:${frame.width}px;height:${frame.height}px;left:${left}px;top:${top}px;transform:scale(${scale})`;
}

$effect(() => {
	const project = projectId;
	const ids = [
		...new Set(
			messages
				.flatMap((message) => message.parts)
				.filter(
					(part) =>
						part.type === "design" ||
						(part.type === "file" &&
							part.filename?.startsWith("canvas-design:")),
				)
				.map(designIdOf)
				.filter(Boolean),
		),
	];
	let cancelled = false;
	if (!project || !ids.length) {
		designPreviews = {};
		return;
	}
	void Promise.all(
		ids.map(async (id) => {
			try {
				const node = await daemon.getDesign(id);
				return node.projectId === project ? ([id, node] as const) : null;
			} catch {
				return null;
			}
		}),
	).then((nodes) => {
		if (cancelled) return;
		designPreviews = Object.fromEntries(nodes.filter((node) => node !== null));
	});
	return () => {
		cancelled = true;
	};
});

type ToolKind = "shell" | "read" | "search" | "edit" | "other";
function kindOf(part: ChatPart): ToolKind {
	const name = `${part.tool ?? ""} ${part.state?.title ?? ""}`.toLowerCase();
	if (/shell|bash|command|exec/.test(name)) return "shell";
	if (/search|grep|glob|find|list/.test(name)) return "search";
	const metadata = part.state?.metadata as
		| { filediff?: unknown; files?: unknown[] }
		| undefined;
	if (metadata?.filediff || metadata?.files?.length) return "edit";
	if (/edit|write|patch|apply|file_change|create|delete|replace/.test(name))
		return "edit";
	if (/read|view|open|cat/.test(name)) return "read";
	return "other";
}
function formatDuration(milliseconds: number | null) {
	if (milliseconds === null) return "";
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
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
	for (const key of [
		"filePath",
		"TargetFile",
		"target_file",
		"file_path",
		"AbsolutePath",
		"DirectoryPath",
		"path",
		"file",
		"filename",
	]) {
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
function toolFileDiff(part: ChatPart, file: string): InlineDiff | null {
	const metadata = part.state?.metadata as
		| {
				filediff?: InlineDiff & { diff?: string; filePath?: string; relativePath?: string };
				files?: Array<InlineDiff & { diff?: string; filePath?: string; relativePath?: string }>;
	  }
		| undefined;
	const files = metadata?.filediff
		? [metadata.filediff]
		: (metadata?.files ?? []);
	const matching = files.find((item) => {
		const path = item.file ?? item.filePath ?? item.relativePath;
		return typeof path === "string" && (path === file || file.endsWith(`/${path}`));
	});
	if (!matching) return null;
	const patch = matching.patch ?? matching.diff;
	return typeof patch === "string"
		? {
				file: matching.file ?? matching.filePath ?? matching.relativePath ?? file,
				patch,
				additions: matching.additions ?? 0,
				deletions: matching.deletions ?? 0,
			}
		: null;
}
async function setToolDiffOpen(key: string, part: ChatPart, file: string, open: boolean) {
	if (!open || inlineDiffs[key] !== undefined || inlineDiffLoading[key]) return;
	const metadataDiff = toolFileDiff(part, file);
	if (metadataDiff) {
		inlineDiffs[key] = metadataDiff;
		return;
	}
	if (!sessionId) {
		inlineDiffs[key] = null;
		return;
	}
	inlineDiffLoading[key] = true;
	try {
		if (!sessionDiffs) sessionDiffs = await chat.diff(sessionId);
		inlineDiffs[key] =
			sessionDiffs.find(
				(diff) => diff.file === file || file.endsWith(`/${diff.file}`),
			) ?? null;
	} catch (reason) {
		inlineDiffs[key] = null;
		toast.error(reason instanceof Error ? reason.message : "Unable to load file changes");
	} finally {
		inlineDiffLoading[key] = false;
	}
}

$effect(() => {
	const currentSession = sessionId;
	const editTools = messages.flatMap((message) =>
		message.parts.flatMap((part) => {
			if (part.type !== "tool" || kindOf(part) !== "edit" || diffStats(part))
				return [];
			const file = fileOf(part);
			return file
				? [{ key: `${message.info.id}-${part.id}`, file }]
				: [];
		}),
	);
	if (
		!currentSession ||
		!editTools.length
	)
		return;
	if (sessionDiffs) {
		const next = { ...inlineDiffs };
		let changed = false;
		for (const tool of editTools) {
			if (next[tool.key]) continue;
			const diff = sessionDiffs.find(
				(item) =>
					item.file === tool.file || tool.file.endsWith(`/${item.file}`),
			);
			if (!diff) continue;
			next[tool.key] = {
				file: diff.file,
				patch: diff.patch,
				additions: diff.additions,
				deletions: diff.deletions,
			};
			changed = true;
		}
		if (changed) inlineDiffs = next;
		return;
	}
	if (diffPrefetchSession === currentSession) return;

	diffPrefetchSession = currentSession;
	void chat
		.diff(currentSession)
		.then((diffs) => {
			if (sessionId !== currentSession) return;
			sessionDiffs = diffs;
		})
		.catch(() => {
			if (diffPrefetchSession === currentSession)
				diffPrefetchSession = "";
		});
});

function statusOf(part: ChatPart) {
	const status = part.state?.status ?? "unknown";
	if (status === "completed") return "completed";
	if (status === "running" || status === "pending") return "running";
	if (status === "error" || status === "failed") return "error";
	return status;
}

async function copy() {
	try {
		await navigator.clipboard.writeText(responseText);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	} catch {
		toast.error("Unable to copy message");
	}
}
</script>

<article class="group min-w-0" aria-label={role === "user" ? "Your message" : `${providerLabel} response`}>
	<div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<span class="font-medium text-foreground">{role === "user" ? "You" : providerLabel}</span>
		{#if agent}<span>{agent}</span>{/if}
		{#if modelID}<Badge variant="outline" class={`model-badge model-badge--${modelTone} max-w-64 truncate`}>{modelID}</Badge>{/if}
		{#if role === "user"}<time class="ml-auto shrink-0">{new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{/if}
	</div>
	{#if role === "user"}
		{#each messages as message (message.info.id)}
			<div class="rounded-xl border bg-muted/40 px-4 py-3">
				{#each message.parts as part (part.id)}
					{#if part.type === "text" && visibleText(part)}<Markdown text={visibleText(part)} />
					{:else if part.type === "design" || (part.type === "file" && part.filename?.startsWith("canvas-design:"))}
						{@const designId = designIdOf(part)}
						{@const design = designPreviews[designId]}
						<div class="my-2 flex max-w-full flex-col sm:flex-row items-start sm:items-center gap-3 rounded-lg border bg-background/60 p-2 text-xs">
							<div class="relative h-[84px] w-[126px] shrink-0 overflow-hidden rounded border bg-background">
								{#if design?.html}<iframe title={`Preview of ${design.title}`} srcdoc={design.html} sandbox="" tabindex="-1" aria-hidden="true" style={thumbnailStyle(design, 126, 84)} class="pointer-events-none absolute origin-top-left border-0"></iframe>{:else}<div class="flex h-full items-center justify-center text-muted-foreground"><PanelsTopLeft size={18} /></div>{/if}
							</div>
							<span class="min-w-0"><span class="block font-medium">Canvas design · {design?.title ?? part.text ?? "Attached design"}</span><span class="block truncate text-muted-foreground">{design ? `${design.viewport} · ${design.brief}` : part.filename ?? part.brief ?? "Loading preview…"}</span></span>
						</div>
					{:else if part.type === "file" && part.filename}
						<Button variant="outline" size="sm" class="my-2 max-w-full" onclick={() => onfile(part.filename!)}><FileCode size={14} /><span class="truncate">{part.filename}</span></Button>
					{/if}
				{/each}
			</div>
		{/each}
	{:else}
		<div class="min-w-0 py-1">
			{#if nativeTodos}
				<section class="mb-4 rounded-lg border bg-muted/20 p-3" aria-label="Runtime todo progress">
					<div class="mb-2 flex items-center justify-between gap-3">
						<p class="text-xs font-medium">Todo progress</p>
						<span class="text-[10px] text-muted-foreground">Reported by runtime</span>
					</div>
					<ul class="space-y-1.5">
						{#each nativeTodos as todo (todo.id)}
							<li class="flex min-w-0 items-start gap-2 text-xs">
								<span class={`mt-1 size-1.5 shrink-0 rounded-full ${todo.status === "completed" ? "bg-emerald-400" : todo.status === "in_progress" ? "animate-pulse bg-sky-400" : todo.status === "blocked" ? "bg-amber-400" : todo.status === "cancelled" ? "bg-muted-foreground" : "bg-muted-foreground/50"}`} aria-hidden="true"></span>
								<span class={`min-w-0 flex-1 ${todo.status === "completed" ? "text-muted-foreground line-through" : ""}`}>{todo.title}</span>
								<span class="shrink-0 text-[10px] text-muted-foreground">{todo.status.replace("_", " ")}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
			{#each messages as message (message.info.id)}
				{#each message.parts as part (part.id)}
					{#if part.type === "text" && part.text}<Markdown text={part.text} />
					{:else if part.type === "reasoning" && part.text}
						<Trace.Root class="my-2 gap-0">
							<Trace.Collapsible>
								<Trace.CollapsibleTrigger class="w-full text-left"><Trace.Line class="w-full"><Trace.Icon><Sparkles size={14} /></Trace.Icon><Trace.Title>Thought</Trace.Title></Trace.Line></Trace.CollapsibleTrigger>
								<Trace.CollapsibleContent class="whitespace-pre-wrap py-2 text-xs text-muted-foreground"><Markdown text={part.text} /></Trace.CollapsibleContent>
							</Trace.Collapsible>
						</Trace.Root>
					{:else if part.type === "tool" && part.state}
						{@const kind = kindOf(part)}
						{@const file = fileOf(part)}
						{@const toolStatus = statusOf(part)}
						{@const traceStatus = toolStatus === "running" ? "running" : toolStatus === "error" ? "error" : undefined}
						{@const toolKey = `${message.info.id}-${part.id}`}
						{@const stats = kind === "edit" ? (diffStats(part) ?? inlineDiffs[toolKey]) : null}
						{@const inlineDiff = inlineDiffs[toolKey]}
						<div class="my-0.5 min-w-0">
							{#if kind === "read" && file}
								<button type="button" class="w-full text-left" onclick={() => (onopenfile ?? onfile)(file)} title={`Open ${file} in the project editor`}>
									<Trace.Line class="w-full">
										<Trace.Icon><FileCode size={14} /></Trace.Icon>
										<Trace.Title class="min-w-0 flex-1 truncate">Read {file}</Trace.Title>
										<Trace.Description class="shrink-0">Open file</Trace.Description>
									</Trace.Line>
								</button>
							{:else if kind === "edit" && file}
								<Trace.Root class="gap-0">
									<Trace.Collapsible
										open={openTools[toolKey] ?? false}
										onOpenChange={(open) => {
											openTools[toolKey] = open;
											if (open) void setToolDiffOpen(toolKey, part, file, open);
										}}
									>
										<Trace.CollapsibleTrigger class="w-full text-left">
											<Trace.Line status={traceStatus} class="w-full">
												<Trace.Icon><Pencil size={14} /></Trace.Icon>
												<Trace.Title class="min-w-0 flex-1 truncate">
													{toolStatus === "running" ? "Editing" : toolStatus === "error" ? "Failed to edit" : "Edited"} {file}
												</Trace.Title>
												{#if stats}<Trace.Description class="shrink-0 font-mono text-[11px]"><span class="text-emerald-400">+{stats.additions}</span> <span class="text-red-400">−{stats.deletions}</span></Trace.Description>{/if}
											</Trace.Line>
										</Trace.CollapsibleTrigger>
										<Trace.CollapsibleContent class="space-y-2 pt-2">
											{#if inlineDiffLoading[toolKey]}
												<p class="py-3 text-xs text-muted-foreground">Loading file changes…</p>
											{:else if inlineDiff?.patch}
												<div class="nice-scroll max-h-80 overflow-auto rounded-lg border bg-background"><pre class="min-w-fit py-2 text-xs leading-6">{#each inlineDiff.patch.split("\n") as line}<div class={`min-h-6 px-3 ${line.startsWith("+") ? "bg-emerald-500/10 text-emerald-300" : line.startsWith("-") ? "bg-red-500/10 text-red-300" : line.startsWith("@@") ? "bg-blue-500/10 text-blue-300" : "text-muted-foreground"}`}>{line || " "}</div>{/each}</pre></div>
												<Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground" onclick={() => (onopenfile ?? onfile)(file)}><FileCode size={13} />Open in editor</Button>
											{:else}
												<p class="py-2 text-xs text-muted-foreground">No recorded diff for this file.</p>
												<Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground" onclick={() => (onopenfile ?? onfile)(file)}><FileCode size={13} />Open in editor</Button>
											{/if}
											{#if part.state.error}<p class="text-sm text-destructive" role="alert">{part.state.error}</p>{/if}
										</Trace.CollapsibleContent>
									</Trace.Collapsible>
								</Trace.Root>
							{:else}
								<Trace.Root class="gap-0">
									<Trace.Collapsible>
										<Trace.CollapsibleTrigger class="w-full text-left">
											<Trace.Line status={traceStatus} class="w-full">
												<Trace.Icon>{#if kind === "shell"}<Terminal size={14} />{:else if kind === "read" || kind === "search"}<FileCode size={14} />{:else if kind === "edit"}<Pencil size={14} />{:else}<Wrench size={14} />{/if}</Trace.Icon>
												<Trace.Title class="min-w-0 flex-1 truncate">
													{toolStatus === "running" ? "Running" : toolStatus === "error" ? "Failed" : kind === "edit" ? "Edited" : kind === "read" ? "Read" : kind === "search" ? "Searched" : "Ran"}
													{kind === "shell" ? commandOf(part) : (kind === "edit" || kind === "read") && file ? file : commandOf(part)}
												</Trace.Title>
										</Trace.Line>
									</Trace.CollapsibleTrigger>
									<Trace.CollapsibleContent class="space-y-2 pt-2">
										{#if kind === "shell"}<CodeBlock code={commandOf(part)} language="bash" maxHeight="max-h-40" />{/if}
										{#if part.state.input && kind !== "shell"}<CodeBlock code={JSON.stringify(part.state.input, null, 2)} language="json" maxHeight="max-h-60" />{/if}
										{#if part.state.output}<CodeBlock code={part.state.output} maxHeight="max-h-80" />{/if}
										{#if part.state.error}<p class="text-sm text-destructive" role="alert">{part.state.error}</p>{/if}
										{#if kind === "read" && file}<Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground" onclick={() => onfile(file)}><FileCode size={13} />Open in editor</Button>{/if}
									</Trace.CollapsibleContent>
								</Trace.Collapsible>
								</Trace.Root>
							{/if}
						</div>
					{:else if part.type === "file" && part.filename}
						<Button variant="outline" size="sm" class="my-2 max-w-full" onclick={() => onfile(part.filename!)}><FileCode size={14} /><span class="truncate">{part.filename}</span></Button>
					{/if}
				{/each}
			{/each}
			{#if error}<p class="mt-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive" role="alert">{error.data?.message || error.name}</p>{/if}
		</div>
		{#if canCopyResponse}
			<div class="mt-3 flex flex-wrap items-center gap-1 border-t border-white/[0.07] pt-2 text-xs text-muted-foreground">
				<time class="mr-auto tabular-nums">{formatDuration(elapsed)}{elapsed !== null ? " · " : ""}{new Date(completedAt ?? time).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
				{#if onbranch}<Button variant="ghost" size="sm" class="h-7 gap-1.5 text-xs" onclick={() => onbranch(responseText)} title="Start a new chat from this answer"><MessageSquarePlus size={13} />New session from answer</Button>{/if}
				<Button variant="ghost" size="sm" class="h-7 gap-1.5 text-xs" onclick={copy}>{#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}{copied ? "Copied" : "Copy response"}</Button>
			</div>
		{/if}
	{/if}
</article>
