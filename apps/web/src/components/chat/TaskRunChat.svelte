<script lang="ts">
import {
	Activity,
	Bot,
	Check,
	CircleAlert,
	Clock3,
	LoaderCircle,
} from "@lucide/svelte";
import Confirmation from "$lib/components/ai-elements/Confirmation.svelte";
import TerminalActivity from "$lib/components/ai-elements/Terminal.svelte";
import Tool from "$lib/components/ai-elements/Tool.svelte";
import { Button } from "$lib/components/ui/button";
import * as Trace from "$lib/components/ui/trace";
import { daemon, type PermissionRequest, type Task } from "$lib/daemon";

let {
	task,
	output: streamedOutput = "",
	activities = [],
	progress = [],
	oncancel,
	showTaskHeader = true,
	showTaskBrief = true,
	wide = false,
	compact = false,
	permissions = [],
	onpermission,
	onopenfile,
}: {
	task: Task;
	output?: string;
	activities?: Array<{
		id: string;
		tool: string;
		status: "running" | "completed" | "error";
		input?: Record<string, unknown>;
		output?: string;
		error?: string;
		metadata?: Record<string, unknown>;
	}>;
	progress?: Array<{
		id: string;
		stage: string;
		message: string;
		timestamp: string;
	}>;
	oncancel?: (taskId: string) => unknown;
	showTaskHeader?: boolean;
	showTaskBrief?: boolean;
	wide?: boolean;
	compact?: boolean;
	permissions?: PermissionRequest[];
	onpermission?: (
		requestId: string,
		decision: "allow_once" | "allow" | "deny",
	) => unknown;
	onopenfile?: (path: string) => unknown;
} = $props();

let output = $state("");
let outputError = $state("");
let cancelling = $state(false);
let replyingToPermission = $state("");
let now = $state(Date.now());
const active = $derived(
	task.status === "running" || task.status === "preparing",
);
const visiblePermissions = $derived(
	permissions.filter((request) => request.taskId === task.id),
);
const permissionPending = $derived(
	visiblePermissions.some((request) => request.status === "pending"),
);
const canCancel = $derived(
	active || task.status === "queued" || task.status === "ready",
);
const statusLabel = $derived(
	(task.status ?? "")
		.replaceAll("_", " ")
		.replace(/^./, (letter) => letter.toUpperCase()),
);
const executorLabel = $derived(
	task.executor?.kind === "agent"
		? task.executor.agentId
		: task.executor
			? `${task.executor.providerId}${task.executor.modelId ? ` · ${task.executor.modelId}` : ""}`
			: "Default executor",
);
type ActivityItem = NonNullable<typeof activities>[number];
let snapshotActivities = $state<ActivityItem[]>([]);
const allActivities = $derived.by(() => {
	const merged = new Map<string, ActivityItem>();
	for (const item of snapshotActivities) merged.set(item.id, item);
	for (const item of activities) merged.set(item.id, item);
	return [...merged.values()];
});
function inputString(item: ActivityItem, keys: string[]) {
	for (const key of keys) {
		const value = item.input?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}
function filePath(item: ActivityItem) {
	const direct = inputString(item, [
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
	]);
	if (direct) return direct;
	const metadata = item.metadata?.filediff;
	if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
		const diff = metadata as Record<string, unknown>;
		for (const key of ["file", "filePath", "relativePath"]) {
			if (typeof diff[key] === "string" && diff[key])
				return diff[key] as string;
		}
	}
	return "";
}
function fileName(path: string) {
	return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || path;
}
function activityKind(item: ActivityItem) {
	const tool = item.tool.toLowerCase();
	if (/shell|bash|command|exec|terminal/.test(tool)) return "command";
	if (/search|grep|glob|find|list/.test(tool)) return "search";
	if (
		item.metadata?.filediff ||
		/edit|write|patch|apply|file_change|create|delete|replace|sed_file/.test(
			tool,
		)
	)
		return "edit";
	if (/read|view|open|cat/.test(tool)) return "read";
	return "other";
}
function activityLabel(item: ActivityItem) {
	const kind = activityKind(item);
	const path = filePath(item);
	if (kind === "command") return `Ran ${command(item) || "command"}`;
	if (kind === "read") return `Read ${path ? fileName(path) : "file"}`;
	if (kind === "edit") return `Edited ${path || "file"}`;
	if (kind === "search") {
		const query = inputString(item, [
			"query",
			"pattern",
			"glob",
			"directory",
			"DirectoryPath",
			"path",
		]);
		const subject = query && query !== "." ? query : item.tool;
		return `Searched ${subject}`;
	}
	return (item.tool ?? "Tool activity")
		.replaceAll("_", " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/^./, (letter) => letter.toUpperCase());
}
function diffStats(item: ActivityItem) {
	const raw = item.metadata?.filediff;
	const files = Array.isArray(item.metadata?.files)
		? item.metadata.files
		: raw && typeof raw === "object" && !Array.isArray(raw)
			? [raw]
			: [];
	let additions = 0;
	let deletions = 0;
	let found = false;
	for (const file of files) {
		if (!file || typeof file !== "object" || Array.isArray(file)) continue;
		const value = file as Record<string, unknown>;
		if (typeof value.additions === "number") {
			additions += value.additions;
			found = true;
		}
		if (typeof value.deletions === "number") {
			deletions += value.deletions;
			found = true;
		}
	}
	return !found ? null : { additions, deletions };
}
function command(item: ActivityItem) {
	const direct = inputString(item, [
		"CommandLine",
		"commandLine",
		"command",
		"cmd",
		"script",
		"prompt",
	]);
	if (direct) return direct;
	const attrs = item.input?.attributes;
	if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
		const attrText = inputString(
			{ input: attrs as Record<string, unknown> } as ActivityItem,
			["CommandLine", "commandLine", "command", "cmd", "script"],
		);
		if (attrText) return attrText;
	}
	const args = item.input?.args;
	if (typeof args === "string" && args.trim()) return args.trim();
	if (Array.isArray(args) && args.length)
		return args.map((entry) => String(entry ?? "")).join(" ");
	return "";
}
function patchText(item: ActivityItem, path: string) {
	const raw = item.metadata?.filediff;
	const files = Array.isArray(item.metadata?.files)
		? item.metadata.files
		: raw && typeof raw === "object" && !Array.isArray(raw)
			? [raw]
			: [];
	for (const file of files) {
		if (!file || typeof file !== "object" || Array.isArray(file)) continue;
		const value = file as Record<string, unknown>;
		const target = value.file ?? value.filePath ?? value.relativePath;
		if (
			path &&
			typeof target === "string" &&
			target !== path &&
			!path.endsWith(`/${target}`)
		)
			continue;
		const patch = value.patch ?? value.diff;
		if (typeof patch === "string" && patch) return patch;
	}
	return "";
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
function fallbackToolDiff(item: ActivityItem): string {
	const input = item.input;
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
			const record = entry as Record<string, unknown>;
			const before = [
				record.old_string,
				record.oldString,
				record.oldText,
				record.TargetContent,
				record.Target,
			].find((value): value is string => typeof value === "string");
			const after = [
				record.new_string,
				record.newString,
				record.newText,
				record.ReplacementContent,
				record.Replacement,
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

function permissionAction(request: PermissionRequest) {
	const raw = request.command.trim();
	const separator = raw.indexOf(":");
	const tool = separator > 0 ? raw.slice(0, separator).trim() : raw;
	let args: Record<string, unknown> = {};
	if (separator > 0) {
		try {
			const parsed: unknown = JSON.parse(raw.slice(separator + 1).trim());
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
				args = parsed as Record<string, unknown>;
		} catch {
			// Keep the provider tool name when its argument format is not JSON.
		}
	}
	const path = [
		args.Path,
		args.path,
		args.TargetFile,
		args.filePath,
		args.file_path,
		args.target_file,
		args.notebook_path,
	].find(
		(value): value is string => typeof value === "string" && !!value.trim(),
	);
	const normalizedTool = tool.toLowerCase();
	const action = /read|view|open/.test(normalizedTool)
		? "Read file"
		: /edit|write|patch|create|delete|replace/.test(normalizedTool)
			? "Edit file"
			: /shell|bash|command|exec/.test(normalizedTool)
				? "Run command"
				: tool.replaceAll("_", " ");
	return path ? `${action} · ${path}` : action;
}

async function decidePermission(
	request: PermissionRequest,
	decision: "allow_once" | "allow" | "deny",
) {
	if (!onpermission || replyingToPermission) return;
	replyingToPermission = request.id;
	try {
		await onpermission(request.id, decision);
	} finally {
		replyingToPermission = "";
	}
}

$effect(() => {
	if (streamedOutput.length >= output.length) output = streamedOutput;
});

$effect(() => {
	const taskId = task.id;
	void refreshOutput(taskId);
	if (!active) return;
	const timer = window.setInterval(() => void refreshOutput(taskId), 2500);
	return () => window.clearInterval(timer);
});

$effect(() => {
	if (!active) return;
	const timer = window.setInterval(() => (now = Date.now()), 1000);
	return () => window.clearInterval(timer);
});

const elapsed = $derived.by(() => {
	if (!task.startedAt) return "Starting";
	const started = Date.parse(task.startedAt);
	if (!Number.isFinite(started)) return "Running";
	const seconds = Math.max(0, Math.floor((now - started) / 1000));
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
});

async function refreshOutput(taskId = task.id) {
	try {
		const result = await daemon.getOutput(taskId);
		if (task.id !== taskId) return;
		const outputText = typeof result?.output === "string" ? result.output : "";
		if (outputText.length >= output.length) {
			output = outputText.slice(-12000);
			outputError = "";
		}
		if (result.activities?.length) snapshotActivities = result.activities;
	} catch (reason) {
		outputError =
			reason instanceof Error ? reason.message : "Output is not available yet.";
	}
}

async function cancel() {
	if (!canCancel || cancelling) return;
	cancelling = true;
	try {
		await oncancel?.(task.id);
	} finally {
		cancelling = false;
	}
}
</script>

<section
	class="nice-scroll min-h-0 flex-1 overflow-y-auto"
	aria-label={`Task run: ${task.title}`}
>
	<div
		class={`mx-auto flex min-h-full w-full flex-col ${compact ? "gap-3 px-0 py-0" : "gap-6 px-5 py-8"} ${wide ? "max-w-full" : "max-w-5xl"}`}
	>
		{#if showTaskHeader}<header
				class="flex flex-wrap items-start gap-3 rounded-xl border bg-card/60 p-4"
			>
				<div
					class="grid size-9 shrink-0 place-items-center rounded-lg border bg-background text-primary"
				>
					{#if active}<LoaderCircle
							size={17}
							class="animate-spin"
						/>{:else if task.status === "completed"}<Check
							size={17}
						/>{:else if task.status === "failed"}<CircleAlert
							size={17}
						/>{:else}<Activity size={17} />{/if}
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center gap-2">
						<h1 class="min-w-0 break-words text-base font-semibold">
							{task.title}
						</h1>
						<span
							class={`rounded-full border px-2 py-0.5 text-[11px] ${active ? "border-sky-400/30 bg-sky-400/10 text-sky-200" : task.status === "completed" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : task.status === "failed" ? "border-red-400/30 bg-red-400/10 text-red-200" : "text-muted-foreground"}`}
							>{active ? "Live · " : ""}{statusLabel}</span
						>
					</div>
					<p
						class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
					>
						<Bot size={13} />{executorLabel}<span class="px-1 text-white/20"
							>·</span
						><Clock3 size={12} />Task run
					</p>
				</div>
				{#if canCancel}<Button
						variant="outline"
						size="sm"
						class="shrink-0"
						disabled={cancelling}
						onclick={() => void cancel()}
						>{cancelling ? "Cancelling…" : "Cancel task"}</Button
					>{/if}
			</header>{/if}

		{#if showTaskBrief}<div class="flex flex-col items-end gap-1">
				<span
					class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
					>You · Task brief</span
				>
				<div
					class="max-w-[88%] rounded-2xl rounded-br-md border border-white/10 bg-accent px-4 py-3 text-sm leading-6 text-accent-foreground"
				>
					<p class="whitespace-pre-wrap text-[15px]">{task.prompt}</p>
				</div>
			</div>{/if}

		<section class="space-y-3" aria-label="Agent progress" aria-live="polite">
			<h2 class="flex items-center gap-2 text-sm font-semibold">
				<Activity size={15} class="text-primary" />Agent progress
			</h2>
			{#if progress.length}
				<ol class="space-y-2" aria-label="Task progress log">
					{#each progress as item (item.id)}
						<li
							class="flex items-start gap-3 rounded-lg border bg-card/40 px-3 py-2.5 text-sm"
						>
							<span
								class={`mt-1.5 size-2 shrink-0 rounded-full ${item.stage === "review_passed" ? "bg-emerald-400" : item.stage === "review_blocked" || item.stage === "review_changes_requested" ? "bg-amber-400" : "bg-sky-400"}`}
							></span>
							<span class="min-w-0 flex-1"
								>{item.message}<span
									class="mt-1 block text-[11px] text-muted-foreground"
									>{new Date(item.timestamp).toLocaleTimeString()}</span
								></span
							>
						</li>
					{/each}
				</ol>
			{/if}
			{#if visiblePermissions.some((request) => request.status === "pending")}
				<section class="space-y-2" aria-label="Task permission requests">
					{#each visiblePermissions.filter((request) => request.status === "pending") as request (request.id)}
						<div class="space-y-2">
							<Confirmation
								message={`Permission needed to continue · ${permissionAction(request)}`}
								description={`${request.reason} Working directory: ${request.cwd}`}
								busy={replyingToPermission === request.id}
								approveLabel={replyingToPermission === request.id
									? "Saving…"
									: "Allow once"}
								denyLabel="Deny"
								onConfirm={() => void decidePermission(request, "allow_once")}
								onCancel={() => void decidePermission(request, "deny")}
							/>
							<details>
								<summary
									class="cursor-pointer text-[11px] text-muted-foreground"
									>Show exact request</summary
								>
								<pre
									class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background/70 p-2 font-mono text-xs">{request.command}</pre>
							</details>
							<Button
								variant="outline"
								size="sm"
								disabled={replyingToPermission === request.id}
								onclick={() => void decidePermission(request, "allow")}
								>Always allow</Button
							>
						</div>
					{/each}
				</section>
			{/if}
			{#if allActivities.length}
				<h3
					class="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
				>
					Activity
				</h3>
				<ol class="space-y-1" aria-label="Agent tool activity">
					{#each allActivities as item (item.id)}
						{@const path = filePath(item)}
						{@const kind = activityKind(item)}
						{@const patch =
							kind === "edit"
								? patchText(item, path) || fallbackToolDiff(item)
								: patchText(item, path)}
						{@const stats =
							diffStats(item) ?? (kind === "edit" ? patchStats(patch) : null)}
						{@const cmd = command(item)}
						<li class="min-w-0">
							<Trace.Root class="gap-0">
								{#if kind === "read" && path}
									<Tool
										name={activityLabel(item)}
										status={item.status}
										input={item.input}
										output={item.output ?? ""}
										error={item.error ?? ""}
										openFile={path}
										onopenfile={onopenfile
											? (target) => void onopenfile(target)
											: undefined}
									/>
								{:else if kind === "command"}
									<TerminalActivity
										command={cmd || activityLabel(item)}
										output={item.output ?? ""}
										status={item.status}
										error={item.error ??
											(item.metadata?.error ? String(item.metadata.error) : "")}
									/>
								{:else}
									<Tool
										name={activityLabel(item)}
										status={item.status}
										input={item.input}
										output={item.output ??
											(typeof item.metadata?.output === "string"
												? item.metadata.output
												: "")}
										error={item.error ??
											(item.metadata?.error ? String(item.metadata.error) : "")}
										diff={patch}
										diffFile={path}
										additions={stats?.additions}
										deletions={stats?.deletions}
										onopenfile={onopenfile
											? (target) => void onopenfile(target)
											: undefined}
									/>
								{/if}
							</Trace.Root>
						</li>
					{/each}
				</ol>
			{:else if active}
				<div
					class="flex items-start gap-3 rounded-xl border bg-card/40 p-4 text-sm"
				>
					{#if task.status === "preparing"}<LoaderCircle
							size={16}
							class="mt-0.5 shrink-0 animate-spin text-sky-300"
						/>{:else}<Activity
							size={16}
							class="mt-0.5 shrink-0 text-sky-300"
						/>{/if}
					<div>
						<p class="font-medium">
							{permissionPending
								? "Waiting for your permission"
								: task.status === "preparing"
									? "Preparing the task workspace"
									: "Loom is working…"}
						</p>
						<p class="mt-1 text-xs leading-5 text-muted-foreground">
							{permissionPending
								? "Allow or deny the requested action above to let the task continue."
								: "Tool activity and the response will appear here as the task progresses."}
						</p>
					</div>
				</div>
			{:else if task.status === "queued" || task.status === "ready"}
				<div
					class="flex items-start gap-3 rounded-xl border bg-card/40 p-4 text-sm"
				>
					<Clock3 size={16} class="mt-0.5 shrink-0 text-amber-300" />
					<div>
						<p class="font-medium">
							{task.status === "queued"
								? "Waiting in the task queue"
								: "Ready to start"}
						</p>
						<p class="mt-1 text-xs leading-5 text-muted-foreground">
							This tab will show agent activity and output as soon as the
							scheduler starts the task.
						</p>
					</div>
				</div>
			{:else}
				<p
					class="rounded-xl border bg-card/40 p-4 text-sm text-muted-foreground"
				>
					This task has no live tool activity to show.
				</p>
			{/if}
		</section>

		<section
			class="overflow-hidden rounded-xl border bg-card/40"
			aria-label="Assistant response"
		>
			<div
				class="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground"
			>
				<Bot size={14} />Assistant<span class="ml-auto"
					>{active ? "Live" : statusLabel}</span
				>
			</div>
			{#if output}<div
					class="max-h-[36vh] overflow-auto whitespace-pre-wrap break-words px-4 py-3 text-sm leading-6 text-foreground"
				>
					{output}
				</div>
			{:else if active}<div class="flex items-start gap-3 px-4 py-5 text-sm">
					{#if permissionPending}<CircleAlert
							size={16}
							class="mt-0.5 shrink-0 text-amber-300"
						/>{:else}<LoaderCircle
							size={16}
							class="mt-0.5 shrink-0 animate-spin text-sky-300"
						/>{/if}
					<div>
						<p class="font-medium text-foreground">
							{permissionPending
								? "Waiting for your permission"
								: `Loom is working… · ${elapsed}`}
						</p>
						<p class="mt-1 text-xs leading-5 text-muted-foreground">
							{permissionPending
								? "Respond to the permission request above to resume this task."
								: "The activity log and response will update as the task progresses."}
						</p>
					</div>
				</div>
			{:else if task.status === "queued" || task.status === "ready"}<p
					class="px-4 py-5 text-sm text-muted-foreground"
				>
					Waiting for the task run to start.
				</p>
			{:else}<p class="px-4 py-5 text-sm text-muted-foreground">
					No provider output was recorded for this run.
				</p>{/if}
			{#if outputError && !output}<p
					class="border-t border-white/10 px-4 py-2 text-xs text-muted-foreground"
				>
					{outputError}
				</p>{/if}
		</section>
	</div>
</section>
