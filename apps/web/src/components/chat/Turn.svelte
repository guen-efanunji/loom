<script lang="ts">
import {
	Check,
	Copy,
	FileCode,
	KanbanSquare,
	MessageSquarePlus,
	PanelsTopLeft,
	Pencil,
	RotateCw,
	Sparkles,
	Terminal,
	Wrench,
	X,
} from "@lucide/svelte";
import { toast } from "svelte-sonner";
import {
	type Catalog,
	type ChatChildSession,
	type ChatMessage,
	type ChatPart,
	canonicalProviderID,
	chat,
	type FileDiff,
	providerDisplayName,
	userMessageText,
} from "$lib/chat";
import { childSessionsForUserMessage } from "$lib/chat-utils";
import ChainOfThought from "$lib/components/ai-elements/ChainOfThought.svelte";
import Checkpoint from "$lib/components/ai-elements/Checkpoint.svelte";
import FileTree from "$lib/components/ai-elements/FileTree.svelte";
import Queue from "$lib/components/ai-elements/Queue.svelte";
import Reasoning from "$lib/components/ai-elements/Reasoning.svelte";
import Sources from "$lib/components/ai-elements/Sources.svelte";
import StackTrace from "$lib/components/ai-elements/StackTrace.svelte";
import Subagent from "$lib/components/ai-elements/Subagent.svelte";
import Suggestion from "$lib/components/ai-elements/Suggestion.svelte";
import TerminalActivity from "$lib/components/ai-elements/Terminal.svelte";
import TestResults from "$lib/components/ai-elements/TestResults.svelte";
import Tool from "$lib/components/ai-elements/Tool.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Message from "$lib/components/ui/message";
import { Textarea } from "$lib/components/ui/textarea";
import * as Trace from "$lib/components/ui/trace";
import { type DesignNode, daemon } from "$lib/daemon";
import CodeBlock from "./CodeBlock.svelte";
import Markdown from "./Markdown.svelte";

let {
	messages,
	catalog,
	sessionId,
	childSessions = [],
	conversationMessages = messages,
	onfocuschild,
	projectId,
	onfile,
	onopenfile,
	onbranch,
	onregenerate,
	onedit,
	onaddplan,
	onrestorecheckpoint,
	/** Optional follow-up prompts shown after a completed assistant turn. */
	suggestions = [],
	onsuggest,
	/** True while this turn's run is still going: the action bar (elapsed,
	 * timestamps, Regenerate/Copy) must stay hidden until it really ends. */
	busy = false,
}: {
	messages: ChatMessage[];
	catalog: Catalog;
	sessionId: string;
	childSessions?: ChatChildSession[];
	conversationMessages?: ChatMessage[];
	onfocuschild?: (id: string) => void;
	projectId: string;
	onfile: (path: string) => void;
	onopenfile?: (path: string) => void;
	onbranch?: (answer: string) => void;
	/** Present on the latest completed assistant turn to redo it. */
	onregenerate?: () => void;
	/** Present on user turns to edit the prompt and re-send. */
	onedit?: (messageId: string, text: string) => Promise<void> | void;
	/** Present to turn this message into Kanban tasks. */
	onaddplan?: (messageId: string, text: string, role: string) => void;
	onrestorecheckpoint?: (messageId: string) => void;
	suggestions?: string[];
	onsuggest?: (prompt: string) => void;
	busy?: boolean;
} = $props();

const role = $derived(messages[0]?.info.role ?? "assistant");
const first = $derived(messages[0]);
const agent = $derived(messages.find((m) => m.info.agent)?.info.agent);
const reportedProviderID = $derived(
	messages.find((m) => m.info.providerID)?.info.providerID,
);
const modelID = $derived(messages.find((m) => m.info.modelID)?.info.modelID);
const providerID = $derived(
	canonicalProviderID(catalog, reportedProviderID, modelID),
);
const providerLabel = $derived(
	providerDisplayName(catalog, reportedProviderID, modelID),
);
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
const time = $derived(first ? first.info.time.created : Date.now());
const completedAt = $derived(messages.at(-1)?.info.time.completed);
const elapsed = $derived(
	completedAt !== undefined && first
		? Math.max(0, completedAt - first.info.time.created)
		: null,
);
const error = $derived(messages.find((m) => m.info.error)?.info.error);
// The gateway returns tool state errors either as a string or as
// `{name, data: {message}}`; normalize to display text.
function toolStateError(part: ChatPart): string {
	const value = (part as { state?: { error?: unknown } }).state?.error;
	if (typeof value === "string") return value;
	if (!value) return "";
	if (typeof value === "object") {
		const record = value as {
			name?: unknown;
			data?: { message?: unknown };
		};
		if (typeof record.data?.message === "string") return record.data.message;
		if (typeof record.name === "string") return record.name;
	}
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}
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
		messages[messages.length - 1]?.info.time.completed !== undefined &&
		!busy,
);
const canEdit = $derived(
	role === "user" && !!onedit && !!first && first.info.id.startsWith("msg_"),
);
let editing = $state(false);
let editText = $state("");
let savingEdit = $state(false);
function beginEdit() {
	if (!first) return;
	editText = userMessageText(first);
	editing = true;
}
async function saveEdit() {
	if (!first || !onedit || savingEdit) return;
	const text = editText.trim();
	if (!text) return;
	savingEdit = true;
	try {
		await onedit(first.info.id, text);
		editing = false;
	} finally {
		savingEdit = false;
	}
}
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
			return [
				"todowrite",
				"writetodos",
				"updatetodolist",
				"updateplan",
			].includes(name);
		});
	const latest = snapshots.at(-1);
	if (latest?.type !== "tool" || !latest.state) return null;
	const input = latest.state.input as Record<string, unknown> | undefined;
	if (!input) return null;
	const raw = [input.todos, input.tasks, input.plan, input.steps].find(
		Array.isArray,
	);
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
				: state === "in_progress" ||
						state === "in-progress" ||
						state === "active"
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
const queueItems = $derived(
	(nativeTodos ?? []).map((todo) => ({
		id: todo.id,
		title: todo.title,
		status:
			todo.status === "completed"
				? ("completed" as const)
				: todo.status === "in_progress"
					? ("in_progress" as const)
					: ("pending" as const),
	})),
);

let copied = $state(false);
let openTools = $state<Record<string, boolean>>({});

type InlineDiff = Pick<FileDiff, "file" | "patch" | "additions" | "deletions">;
let inlineDiffs = $state<Record<string, InlineDiff | null>>({});
let inlineDiffLoading = $state<Record<string, boolean>>({});
let designPreviews = $state<Record<string, DesignNode>>({});
let sessionDiffs = $state<FileDiff[] | null>(null);
let diffPrefetchSignature = "";
let diffPrefetchRequest = 0;

$effect(() => {
	sessionId;
	inlineDiffs = {};
	inlineDiffLoading = {};
	sessionDiffs = null;
	diffPrefetchSignature = "";
	diffPrefetchRequest++;
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
	if (
		/edit|write|patch|apply|file_change|create|delete|replace|sed_file/.test(
			name,
		)
	)
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
	for (const key of [
		"CommandLine",
		"commandLine",
		"command",
		"cmd",
		"script",
	]) {
		if (typeof input?.[key] === "string" && input[key])
			return input[key] as string;
	}
	return part.state?.title || part.tool || "Tool call";
}
function fileOf(part: ChatPart) {
	const input = part.state?.input as Record<string, unknown> | undefined;
	for (const key of [
		"Path",
		"filePath",
		"fileName",
		"file_name",
		"TargetFile",
		"targetFile",
		"target_file",
		"targetPath",
		"target_path",
		"file_path",
		"absolute_path",
		"AbsolutePath",
		"DirectoryPath",
		"notebook_path",
		"path",
		"file",
		"filename",
	]) {
		if (typeof input?.[key] === "string" && input[key])
			return input[key] as string;
	}
	return "";
}
function fileNameOf(path: string) {
	return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || path;
}
function toolSubject(part: ChatPart, kind: ToolKind, file: string) {
	if ((kind === "read" || kind === "edit") && file) return fileNameOf(file);
	if (kind === "read") return "file";
	return commandOf(part);
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
function normalizeDiffPath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
function sameDiffPath(a: string, b: string): boolean {
	const left = normalizeDiffPath(a);
	const right = normalizeDiffPath(b);
	if (!left || !right) return false;
	return (
		left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
	);
}
function toolFileDiff(part: ChatPart, file: string): InlineDiff | null {
	const metadata = part.state?.metadata as
		| {
				filediff?: InlineDiff & {
					diff?: string;
					filePath?: string;
					relativePath?: string;
				};
				files?: Array<
					InlineDiff & {
						diff?: string;
						filePath?: string;
						relativePath?: string;
					}
				>;
		  }
		| undefined;
	const files = metadata?.filediff
		? [metadata.filediff]
		: (metadata?.files ?? []);
	const matching =
		files.find((item) => {
			const path = item.file ?? item.filePath ?? item.relativePath;
			return typeof path === "string" && sameDiffPath(path, file);
		}) ?? (!file && files.length === 1 ? files[0] : undefined);
	if (!matching) return null;
	const patch = matching.patch ?? matching.diff;
	return typeof patch === "string"
		? {
				file:
					matching.file ?? matching.filePath ?? matching.relativePath ?? file,
				patch,
				additions: matching.additions ?? 0,
				deletions: matching.deletions ?? 0,
			}
		: null;
}
function patchStats(
	patch: string,
): { additions: number; deletions: number } | null {
	if (!patch.trim()) return null;
	let additions = 0;
	let deletions = 0;
	for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	}
	return additions || deletions ? { additions, deletions } : null;
}
function fallbackToolDiff(part: ChatPart): string {
	const input = part.state?.input as Record<string, unknown> | undefined;
	if (!input) return "";
	const patch = [input.patch, input.diff].find(
		(value): value is string => typeof value === "string" && !!value.trim(),
	);
	if (patch) return patch;
	const chunkLists = [input.edits, input.ReplacementChunks].filter(
		Array.isArray,
	);
	for (const list of chunkLists) {
		const sections: string[] = [];
		for (const entry of list) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
			const item = entry as Record<string, unknown>;
			const before = [
				item.old_string,
				item.oldString,
				item.oldText,
				item.TargetContent,
				item.Target,
			].find((value): value is string => typeof value === "string");
			const after = [
				item.new_string,
				item.newString,
				item.newText,
				item.ReplacementContent,
				item.Replacement,
			].find((value): value is string => typeof value === "string");
			if (before !== undefined || after !== undefined) {
				const removed = (before ?? "").split("\n").map((line) => `-${line}`);
				const added = (after ?? "").split("\n").map((line) => `+${line}`);
				sections.push(
					[
						...(before ? removed : []),
						...(after !== undefined ? added : []),
					].join("\n"),
				);
			}
		}
		if (sections.length) return sections.join("\n");
	}
	const before = [
		input.old_string,
		input.oldString,
		input.oldText,
		input.TargetContent,
		input.Target,
	].find((value): value is string => typeof value === "string");
	const after = [
		input.new_string,
		input.newString,
		input.newText,
		input.ReplacementContent,
		input.Replacement,
	].find((value): value is string => typeof value === "string");
	if (before !== undefined || after !== undefined) {
		const removed = (before ?? "").split("\n").map((line) => `-${line}`);
		const added = (after ?? "").split("\n").map((line) => `+${line}`);
		return [
			...(before ? removed : []),
			...(after !== undefined ? added : []),
		].join("\n");
	}
	const content = [
		input.content,
		input.Content,
		input.CodeContent,
		input.new_source,
	].find(
		(value): value is string => typeof value === "string" && !!value.trim(),
	);
	if (content !== undefined) {
		const lines = content.split("\n");
		const preview = lines.slice(0, 120).map((line) => `+${line}`);
		if (lines.length > 120) preview.push(` ${lines.length - 120} more lines…`);
		return preview.join("\n");
	}
	return "";
}
async function setToolDiffOpen(
	key: string,
	part: ChatPart,
	file: string,
	open: boolean,
) {
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
		if (!sessionDiffs?.length) sessionDiffs = await chat.diff(sessionId);
		inlineDiffs[key] =
			sessionDiffs.find((diff) => sameDiffPath(diff.file, file)) ?? null;
	} catch (reason) {
		inlineDiffs[key] = null;
		toast.error(
			reason instanceof Error ? reason.message : "Unable to load file changes",
		);
	} finally {
		inlineDiffLoading[key] = false;
	}
}

$effect(() => {
	const currentSession = sessionId;
	const isBusy = busy;
	const editTools = messages.flatMap((message) =>
		message.parts.flatMap((part) => {
			if (part.type !== "tool" || kindOf(part) !== "edit") return [];
			const file = fileOf(part);
			if (!file || diffStats(part)) return [];
			return [
				{
					key: `${message.info.id}-${part.id}`,
					file,
					status: statusOf(part),
				},
			];
		}),
	);
	if (!currentSession || !editTools.length) return;
	const signature = `${currentSession}:${isBusy ? "busy" : "idle"}:${editTools
		.map((tool) => `${tool.key}:${tool.file}:${tool.status}`)
		.join("|")}`;
	if (signature === diffPrefetchSignature) return;
	diffPrefetchSignature = signature;
	const request = ++diffPrefetchRequest;
	void chat
		.diff(currentSession)
		.then((diffs) => {
			if (sessionId !== currentSession || request !== diffPrefetchRequest)
				return;
			sessionDiffs = diffs;
			const next = { ...inlineDiffs };
			for (const tool of editTools) {
				const diff = diffs.find((item) => sameDiffPath(item.file, tool.file));
				if (!diff) continue;
				next[tool.key] = {
					file: diff.file,
					patch: diff.patch,
					additions: diff.additions,
					deletions: diff.deletions,
				};
			}
			inlineDiffs = next;
		})
		.catch(() => {});
});

function statusOf(part: ChatPart): "running" | "completed" | "error" {
	const status = part.state?.status ?? "unknown";
	if (status === "completed") return "completed";
	if (status === "running" || status === "pending") return "running";
	if (status === "error" || status === "failed") return "error";
	return "completed";
}

// ---- Tahap 4 derivations: only real provider data feeds these ----

type SourceItem = { url: string; title?: string };
/** Source-url parts, deduped by url. Absent until a provider emits them. */
const sources = $derived(
	messages
		.flatMap((message) => message.parts)
		.filter((part) => part.type === "source-url" && part.url)
		.map((part) => ({ url: part.url!, title: part.text }))
		.filter(
			(source, index, all) =>
				all.findIndex((other) => other.url === source.url) === index,
		),
);

/** File paths the agent edited this turn, from tool metadata or diffs. */
const changedFiles = $derived.by(() => {
	const paths: string[] = [];
	for (const message of messages) {
		for (const part of message.parts) {
			if (part.type !== "tool" || kindOf(part) !== "edit") continue;
			const file = fileOf(part);
			if (file && !paths.includes(file)) paths.push(file);
		}
	}
	return paths;
});

/** Build a nested tree from flat workspace-relative paths. */
function fileTreeFromPaths(paths: string[]): Array<{
	type: "folder" | "file";
	name: string;
	path: string;
	children?: unknown[];
}> {
	const root: {
		type: "folder";
		name: string;
		path: string;
		children: unknown[];
	} = { type: "folder", name: "", path: "", children: [] };
	for (const rawPath of paths) {
		const segments = rawPath.replaceAll("\\", "/").split("/").filter(Boolean);
		if (!segments.length) continue;
		let node = root;
		for (let index = 0; index < segments.length; index += 1) {
			const isFile = index === segments.length - 1;
			const path = segments.slice(0, index + 1).join("/");
			type TreeNode = {
				type: "folder" | "file";
				name: string;
				path: string;
				children?: unknown[];
			};
			let child = (node.children as TreeNode[]).find(
				(entry) => entry.path === path,
			);
			if (!child) {
				child = {
					type: isFile ? "file" : "folder",
					name: segments[index],
					path,
					...(isFile ? {} : { children: [] }),
				};
				(node.children as TreeNode[]).push(child);
			}
			if (!isFile) node = child as typeof node;
		}
	}
	const collapse = (node: {
		children?: unknown[];
	}): Array<Record<string, unknown>> =>
		(node.children ?? []).map((child) => {
			const entry = child as {
				type: string;
				name: string;
				path: string;
				children?: unknown[];
			};
			if (entry.type === "folder") {
				const children = collapse(entry);
				// Collapse a chain of single-child folders into one node so
				// `src/app/…` shows as one expandable line, not two.
				if (children.length === 1) {
					const only = children[0] as {
						type: string;
						name: string;
						children?: unknown[];
					};
					if (only.type === "folder") {
						return {
							...only,
							name: `${entry.name}/${only.name}`,
						};
					}
				}
				return { ...entry, children };
			}
			return entry as Record<string, unknown>;
		});
	return collapse(root) as Array<{
		type: "folder" | "file";
		name: string;
		path: string;
		children?: unknown[];
	}>;
}

/** First stack-like error text among the turn's tool failures. */
const toolStack = $derived.by(() => {
	for (const message of messages) {
		for (const part of message.parts) {
			if (part.type !== "tool") continue;
			const text = toolStateError(part);
			// Only treat it as a stack when frames are actually present.
			if (/^\s*at .+ .+:\d+:\d+\)?$/m.test(text)) return text;
		}
	}
	return "";
});

/** True while this turn's run is streaming tools before any answer text. */
const researching = $derived(
	busy &&
		messages.some((message) =>
			message.parts.some((part) => part.type === "tool"),
		) &&
		!responseText.trim(),
);

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

<article
	class="group min-w-0"
	aria-label={role === "user" ? "Your message" : `${providerLabel} response`}
>
	<div
		class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
	>
		<span class="font-medium text-foreground"
			>{role === "user" ? "You" : providerLabel}</span
		>
		{#if agent}<span>{agent}</span>{/if}
		{#if modelID}<Badge
				variant="outline"
				class={`model-badge model-badge--${modelTone} max-w-64 truncate`}
				>{modelID}</Badge
			>{/if}
		{#if role === "user"}<time class="ml-auto shrink-0"
				>{new Date(time).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
				})}</time
			>{/if}
	</div>
	{#if role === "user"}
		{#each messages as message (message.info.id)}
			<Message.Root align="end">
				<Message.Content>
					<div
						class="ml-auto w-fit max-w-full rounded-xl border bg-muted/40 px-4 py-3"
					>
						{#each message.parts as part (part.id)}
							{#if part.type === "text" && visibleText(part)}<Markdown
									text={visibleText(part)}
								/>
							{:else if part.type === "design" || (part.type === "file" && part.filename?.startsWith("canvas-design:"))}
								{@const designId = designIdOf(part)}
								{@const design = designPreviews[designId]}
								<div
									class="my-2 flex max-w-full flex-col sm:flex-row items-start sm:items-center gap-3 rounded-lg border bg-background/60 p-2 text-xs"
								>
									<div
										class="relative h-[84px] w-[126px] shrink-0 overflow-hidden rounded border bg-background"
									>
										{#if design?.html}<iframe
												title={`Preview of ${design.title}`}
												srcdoc={design.html}
												sandbox=""
												tabindex="-1"
												aria-hidden="true"
												style={thumbnailStyle(design, 126, 84)}
												class="pointer-events-none absolute origin-top-left border-0"
											></iframe>{:else}<div
												class="flex h-full items-center justify-center text-muted-foreground"
											>
												<PanelsTopLeft size={18} />
											</div>{/if}
									</div>
									<span class="min-w-0"
										><span class="block font-medium"
											>Canvas design · {design?.title ??
												part.text ??
												"Attached design"}</span
										><span class="block truncate text-muted-foreground"
											>{design
												? `${design.viewport} · ${design.brief}`
												: (part.filename ??
													part.brief ??
													"Loading preview…")}</span
										></span
									>
								</div>
							{:else if part.type === "file" && part.filename}
								<Button
									variant="outline"
									size="sm"
									class="my-2 max-w-full"
									onclick={() => onfile(part.filename!)}
									><FileCode size={14} /><span class="truncate"
										>{part.filename}</span
									></Button
								>
							{/if}
						{/each}
					</div>
				</Message.Content>
			</Message.Root>
		{/each}
		{@const relatedChildren = messages.flatMap((message) =>
			childSessionsForUserMessage(message, conversationMessages, childSessions),
		)}
		{#if relatedChildren.length}
			<section
				class="mt-2 rounded-lg border bg-muted/20 p-2"
				aria-label="Subagents"
			>
				<Trace.Root>
					{#each relatedChildren as child (child.id)}
						<Subagent
							name={child.title || "Untitled subagent"}
							status={child.status.type === "busy" ||
							child.status.type === "running" ||
							child.status.type === "retry"
								? "running"
								: child.status.type === "error"
									? "error"
									: "completed"}
							summary={child.status.message ?? child.status.type}
							onopen={() => onfocuschild?.(child.id)}
						/>
					{/each}
				</Trace.Root>
			</section>
		{/if}
		{#if canEdit}
			<div class="mt-1.5 flex justify-end gap-1">
				{#if editing}<div class="w-full space-y-2">
						<Textarea
							bind:value={editText}
							rows={3}
							aria-label="Edit message"
							class="min-h-20 resize-y text-sm"
						/>
						<div class="flex justify-end gap-1">
							<Button
								variant="ghost"
								size="sm"
								class="h-7 gap-1.5 text-xs"
								onclick={() => (editing = false)}><X size={13} />Cancel</Button
							>
							<Button
								size="sm"
								class="h-7 gap-1.5 text-xs"
								disabled={savingEdit || !editText.trim()}
								onclick={() => void saveEdit()}
								><Check size={13} />{#if savingEdit}
									Saving…
								{:else}
									Save & resend
								{/if}</Button
							>
						</div>
					</div>
				{:else}{#if onaddplan && first}<Button
							variant="ghost"
							size="sm"
							class="h-7 gap-1.5 text-xs opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
							onclick={() =>
								onaddplan(first.info.id, userMessageText(first), "user")}
							title="Turn this message into Kanban tasks"
							><KanbanSquare size={13} />Add to Kanban</Button
						>{/if}<Button
						variant="ghost"
						size="sm"
						class="h-7 gap-1.5 text-xs opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
						onclick={beginEdit}><Pencil size={13} />Edit</Button
					>{/if}
			</div>
		{/if}
	{:else}
		<Message.Root>
			<Message.Content class="min-w-0 py-1">
				<div class="min-w-0 py-1">
					{#if nativeTodos}
						<section
							class="mb-4 rounded-lg border bg-muted/20 p-3"
							aria-label="Runtime todo progress"
						>
							<div class="mb-2 flex items-center justify-between gap-3">
								<p class="text-xs font-medium">Todo progress</p>
								<span class="text-[10px] text-muted-foreground"
									>Reported by runtime</span
								>
							</div>
							<Queue items={queueItems} running={busy} />
						</section>
					{/if}
					{#if !researching}
						{@const researchSteps = messages.flatMap((message) =>
							message.parts.flatMap((part) => {
								if (part.type !== "tool" || !part.state) return [];
								const kind = kindOf(part);
								if (kind !== "read" && kind !== "search") return [];
								const label =
									kind === "read"
										? `Read ${fileNameOf(fileOf(part) || "file")}`
										: `Searched ${commandOf(part)}`;
								return [
									{
										title: label,
										status:
											statusOf(part) === "error"
												? ("error" as const)
												: undefined,
									},
								];
							}),
						)}
						{#if researchSteps.length >= 2}
							<div class="mb-3">
								<ChainOfThought steps={researchSteps} />
							</div>
						{/if}
					{/if}
					{#each messages as message (message.info.id)}
						{@const isRunning = busy && message === messages.at(-1)}
						{#each message.parts as part (part.id)}
							{#if part.type === "text" && part.text}<Markdown
									text={part.text}
								/>
							{:else if part.type === "reasoning"}
								<Trace.Root class="my-1">
									<Reasoning content={part.text ?? ""} running={isRunning} />
								</Trace.Root>
							{:else if part.type === "tool" && part.state}
								{@const kind = kindOf(part)}
								{@const file = fileOf(part)}
								{@const toolStatus = statusOf(part)}
								{@const traceStatus =
									toolStatus === "running"
										? "running"
										: toolStatus === "error"
											? "error"
											: undefined}
								{@const toolKey = `${message.info.id}-${part.id}`}
								{@const inlineDiff = inlineDiffs[toolKey]}
								{@const matchingDiff =
									kind === "edit"
										? inlineDiff?.patch
											? inlineDiff
											: toolFileDiff(part, file)
										: null}
								{@const diffPatch =
									kind === "edit"
										? matchingDiff?.patch || fallbackToolDiff(part)
										: ""}
								{@const stats =
									kind === "edit"
										? (diffStats(part) ??
											(inlineDiff &&
											(inlineDiff.patch ||
												inlineDiff.additions ||
												inlineDiff.deletions)
												? inlineDiff
												: null) ??
											patchStats(diffPatch))
										: null}
								<div class="my-0.5 min-w-0">
									{#if kind === "read" && file}
										<button
											type="button"
											class="w-full text-left"
											onclick={() => (onopenfile ?? onfile)(file)}
											title={`Open ${file} in the project editor`}
										>
											<Trace.Line class="w-full">
												<Trace.Icon><FileCode size={14} /></Trace.Icon>
												<Trace.Title class="min-w-0 flex-1 truncate"
													>Read {fileNameOf(file)}</Trace.Title
												>
												<Trace.Description class="shrink-0"
													>Open file</Trace.Description
												>
											</Trace.Line>
										</button>
									{:else if kind === "edit" && file}
										<Tool
											name={`${toolStatus === "running" ? "Editing" : toolStatus === "error" ? "Failed to edit" : "Edited"} ${file}`}
											status={toolStatus === "running"
												? "running"
												: toolStatus === "error"
													? "error"
													: "completed"}
											open={openTools[toolKey] ??
												(toolStatus === "running" || toolStatus === "error")}
											onopenchange={(open) => {
												openTools[toolKey] = open;
												if (open) void setToolDiffOpen(toolKey, part, file, open);
											}}
											loading={inlineDiffLoading[toolKey] ?? false}
											input={part.state.input}
											output={part.state.output ?? ""}
											error={toolStateError(part)}
											diff={diffPatch}
											diffFile={matchingDiff?.file ?? file}
											additions={stats?.additions}
											deletions={stats?.deletions}
											openFile={file}
											onopenfile={(path) => (onopenfile ?? onfile)(path)}
										/>
									{:else if kind === "shell"}
										<TerminalActivity
											command={commandOf(part)}
											output={part.state.output ?? ""}
											status={toolStatus}
											error={toolStateError(part)}
										/>
									{:else}
										<Tool
											name={`${toolStatus === "running" ? "Running" : toolStatus === "error" ? "Failed" : kind === "edit" ? "Edited" : kind === "read" ? "Read" : kind === "search" ? "Searched" : "Ran"} ${toolSubject(part, kind, file)}`}
											status={toolStatus === "running"
												? "running"
												: toolStatus === "error"
													? "error"
													: "completed"}
											open={openTools[toolKey] ??
												(toolStatus === "running" || toolStatus === "error")}
											onopenchange={(open) => {
												openTools[toolKey] = open;
												if (open && kind === "edit" && file)
													void setToolDiffOpen(toolKey, part, file, open);
											}}
											loading={inlineDiffLoading[toolKey] ?? false}
											input={part.state.input}
											output={part.state.output ?? ""}
											error={toolStateError(part)}
											diff={diffPatch}
											diffFile={matchingDiff?.file ?? file}
											additions={stats?.additions}
											deletions={stats?.deletions}
											onopenfile={(path) => (onopenfile ?? onfile)(path)}
										/>
									{/if}
								</div>
							{:else if part.type === "file" && part.filename}
								<Button
									variant="outline"
									size="sm"
									class="my-2 max-w-full"
									onclick={() => onfile(part.filename!)}
									><FileCode size={14} /><span class="truncate"
										>{part.filename}</span
									></Button
								>
							{/if}
						{/each}
					{/each}
					{#if changedFiles.length && !busy}
						{@const tree = fileTreeFromPaths(
							changedFiles,
						) as import("$lib/components/ai-elements/FileTree.svelte").FileNode[]}
						{#if tree.length}
							<section
								class="mt-3 rounded-lg border bg-muted/20 p-3"
								aria-label="Files changed in this turn"
							>
								<p class="mb-2 text-xs font-medium">Changed files</p>
								{#each tree as node (node.path)}
									<FileTree
										{node}
										onselect={(path) => (onopenfile ?? onfile)(path)}
									/>
								{/each}
							</section>
						{/if}
					{/if}
					{#if sources.length}
						<div class="mt-3">
							<Sources {sources} />
						</div>
					{/if}
					{#if toolStack && !busy}
						<div class="mt-3">
							<StackTrace stack={toolStack} />
						</div>
					{/if}
					{#if suggestions.length && !busy && onsuggest}
						<div class="mt-3">
							<Suggestion {suggestions} onselect={onsuggest} />
						</div>
					{/if}
					{#if error}<p
							class="mt-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
							role="alert"
						>
							{error.data?.message || error.name}
						</p>{/if}
				</div>
			</Message.Content>
		</Message.Root>
		{#if onrestorecheckpoint && role === "assistant" && first}
			<Checkpoint
				label={new Date(time).toLocaleString([], {
					month: "short",
					day: "numeric",
					hour: "numeric",
					minute: "2-digit",
				})}
				canRestore={!busy &&
					conversationMessages.at(-1)?.info.id !== first.info.id}
				onrestore={() => onrestorecheckpoint?.(first.info.id)}
			/>
		{/if}
		{#if !busy && (canCopyResponse || onregenerate || error || (onaddplan && responseText))}
			<div
				class="mt-3 flex flex-wrap items-center gap-1 border-t border-white/[0.07] pt-2 text-xs text-muted-foreground"
			>
				{#if canCopyResponse}<time class="mr-auto tabular-nums"
						>{formatDuration(elapsed)}{elapsed !== null ? " · " : ""}{new Date(
							completedAt ?? time,
						).toLocaleString([], {
							month: "short",
							day: "numeric",
							hour: "numeric",
							minute: "2-digit",
						})}</time
					>{/if}
				{#if onregenerate}<Button
						variant="ghost"
						size="sm"
						class="h-7 gap-1.5 text-xs"
						onclick={onregenerate}
						title={error
							? "Retry this request"
							: "Generate another answer for the same prompt"}
						><RotateCw size={13} />{error ? "Retry" : "Regenerate"}</Button
					>{/if}
				{#if onbranch}<Button
						variant="ghost"
						size="sm"
						class="h-7 gap-1.5 text-xs"
						onclick={() => onbranch(responseText)}
						title="Start a new chat from this answer"
						><MessageSquarePlus size={13} />New session from answer</Button
					>{/if}
				{#if onaddplan && responseText && first}<Button
						variant="ghost"
						size="sm"
						class="h-7 gap-1.5 text-xs"
						onclick={() => onaddplan(first.info.id, responseText, "assistant")}
						title="Turn this answer into Kanban tasks"
						><KanbanSquare size={13} />Add to Kanban</Button
					>{/if}
				{#if canCopyResponse}<Button
						variant="ghost"
						size="sm"
						class="h-7 gap-1.5 text-xs"
						onclick={copy}
						>{#if copied}<Check size={13} />{:else}<Copy
								size={13}
							/>{/if}{copied ? "Copied" : "Copy response"}</Button
					>{/if}
			</div>
		{/if}
	{/if}
</article>
