<script lang="ts">
import { Activity, Bot, LoaderCircle } from "@lucide/svelte";
import { toast } from "svelte-sonner";
import { type Catalog, type ChatState, chat } from "$lib/chat";
import { groupTurns } from "$lib/chat-utils";
import { Button } from "$lib/components/ui/button";
import { daemon, type PermissionRequest, type Task } from "$lib/daemon";
import TaskRunChat from "./TaskRunChat.svelte";
import Turn from "./Turn.svelte";

/**
 * Renders a Kanban task like a normal chat: the run's provider session is
 * resolved through the same chat API (`/api/chat/sessions/:id` — the
 * orchestrator registers task sessions in the session scope), so messages
 * appear as regular bubbles with tool traces. Falls back to the legacy
 * activity/output view when the run used a CLI provider runtime that keeps
 * no gateway message list.
 */
let {
	task,
	output: streamedOutput = "",
	activities = [],
	progress = [],
	permissions = [],
	onpermission,
	oncancel,
	onopenfile,
	onfile,
}: {
	task: Task;
	output?: string;
	activities?: Array<{
		id: string;
		tool: string;
		status: "running" | "completed" | "error";
		input?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
	}>;
	progress?: Array<{
		id: string;
		stage: string;
		message: string;
		timestamp: string;
	}>;
	permissions?: PermissionRequest[];
	onpermission?: (
		requestId: string,
		decision: "allow_once" | "allow" | "deny",
	) => unknown;
	oncancel?: (taskId: string) => unknown;
	onopenfile?: (path: string) => unknown;
	onfile?: (path: string) => unknown;
} = $props();

const emptyCatalog: Catalog = {
	models: [],
	defaults: {},
	agents: [],
	commands: [],
};
let catalog = $state<Catalog>(emptyCatalog);
let agents = $state<
	Array<{ id: string; label: string; role: string; status: string }>
>([]);
let conversation = $state<ChatState | null>(null);
let conversationFailed = $state(false);
let conversationLoading = $state(true);
let disposed = false;
let followUpDraft = $state("");
let queueing = $state(false);
const followUpVisible = $derived(
	["queued", "ready", "preparing", "running"].includes(task.status),
);
const canQueueNow = $derived(followUpVisible);
async function sendFollowUp() {
	const text = followUpDraft.trim();
	if (!text || queueing || !canQueueNow) return;
	queueing = true;
	try {
		const result = await daemon.queueTaskMessage(task.id, text);
		followUpDraft = "";
		toast.success(
			result.position > 1
				? `Follow-up queued (position ${result.position}).`
				: "Follow-up queued. It will be sent to the running agent.",
		);
		await refreshConversation();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to queue follow-up",
		);
	} finally {
		queueing = false;
	}
}

const sessionId = $derived(task.sessionId ?? "");
const active = $derived(
	task.status === "running" || task.status === "preparing",
);
// Chat-like rendering is only possible when the run's provider session
// actually exposed messages (OpenCode gateway). CLI providers fall back.
const hasConversation = $derived(
	!!conversation &&
		conversation.messages.some((message) =>
			message.parts.some(
				(part) =>
					(part.type === "text" && part.text?.trim()) || part.type === "tool",
			),
		),
);
const statusLabel = $derived(
	(task.status ?? "")
		.replaceAll("_", " ")
		.replace(/^./, (letter) => letter.toUpperCase()),
);
const executorAgent = $derived.by(() => {
	const executor = task.executor;
	if (!executor || executor.kind !== "agent") return undefined;
	return agents.find((agent) => agent.id === executor.agentId);
});
const executorLabel = $derived(
	executorAgent
		? `${executorAgent.label}${executorAgent.role ? ` · ${executorAgent.role}` : ""}`
		: task.executor?.kind === "agent"
			? task.executor.agentId
			: task.executor
				? `${task.executor.providerId}${task.executor.modelId ? ` · ${task.executor.modelId}` : ""}`
				: "Default executor",
);
const turns = $derived(
	hasConversation && conversation ? groupTurns(conversation.messages) : [],
);
const turnBusy = $derived(
	conversation?.status.type === "busy" || conversation?.status.type === "retry",
);

async function refreshConversation() {
	if (!sessionId) {
		conversationLoading = false;
		return;
	}
	try {
		const result = await chat.state(sessionId);
		if (disposed) return;
		conversation = result;
		conversationFailed = false;
	} catch {
		if (!disposed) conversationFailed = true;
	} finally {
		if (!disposed) conversationLoading = false;
	}
}

$effect(() => {
	const id = task.sessionId ?? "";
	conversationLoading = true;
	conversation = null;
	conversationFailed = false;
	void refreshConversation();
	// Live poll mirrors the chat page cadence; cheap status-only once idle.
	if (!id || !active) return;
	const timer = window.setInterval(() => void refreshConversation(), 2_000);
	return () => window.clearInterval(timer);
});

$effect(() => {
	const projectId = task.projectId;
	if (!projectId) return;
	void chat
		.catalog(projectId)
		.then((result) => {
			if (!disposed) catalog = result;
		})
		.catch(() => {});
	void daemon
		.listCustomAgents(projectId)
		.then((items) => {
			if (!disposed)
				agents = (items as typeof agents).filter(
					(item) => item.status === "active",
				);
		})
		.catch(() => {});
});

// The fallback renderer (TaskRunChat) keeps its own output polling.
$effect(() => () => {
	disposed = true;
});
</script>

<section
	class="nice-scroll min-h-0 flex-1 overflow-y-auto"
	aria-label={`Task: ${task.title}`}
>
	<div class="mx-auto flex min-h-full w-full max-w-[740px] flex-col px-5 py-8">
		<header class="mb-6 flex flex-wrap items-center gap-2">
			<span
				class="inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-400/10 px-2.5 py-0.5 text-[11px] font-medium text-violet-200"
			>
				<Activity size={11} />Task
			</span>
			<span
				class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] ${active ? "border-sky-400/30 bg-sky-400/10 text-sky-200" : task.status === "completed" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : task.status === "failed" ? "border-red-400/30 bg-red-400/10 text-red-200" : "text-muted-foreground"}`}
			>
				{#if active}<LoaderCircle size={11} class="animate-spin" />{/if}
				{active ? "Live · " : ""}{statusLabel}
			</span>
			<span
				class="inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] text-muted-foreground"
				title="Registered agent running this task"
			>
				<Bot size={11} class="shrink-0" />
				<span class="max-w-52 truncate">{executorLabel}</span>
			</span>
			{#if oncancel && (active || task.status === "queued" || task.status === "ready")}
				<Button
					variant="outline"
					size="sm"
					class="ml-auto h-7 shrink-0"
					onclick={() => oncancel?.(task.id)}>Cancel task</Button
				>
			{/if}
		</header>

		{#if conversationLoading && sessionId}
			<div
				role="status"
				class="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
			>
				<LoaderCircle size={16} class="animate-spin" />Loading task
				conversation…
			</div>
		{:else if hasConversation && conversation}
			<div class="space-y-8" aria-live="polite" aria-relevant="additions text">
				{#each turns as turn (turn.key)}
					<Turn
						messages={turn.messages}
						conversationMessages={conversation.messages}
						{catalog}
						sessionId={sessionId}
						projectId={task.projectId}
						onfile={(path) => (onfile ?? onopenfile)?.(path)}
						onopenfile={onopenfile}
					/>
				{/each}
				{#if turnBusy || (active && !conversation.messages.at(-1)?.info.time.completed)}
					<div class="flex items-center gap-2 text-sm text-muted-foreground">
						<LoaderCircle size={14} class="animate-spin" />
						{active ? "Loom is working…" : "Finishing up…"}
					</div>
				{/if}
			</div>
		{:else}
			{#if conversationFailed && sessionId}
				<p class="mb-4 text-xs text-muted-foreground">
					Provider conversation is not available for this run — showing the
					activity log instead.
				</p>
			{/if}
			{#if progress.length}
				<ol class="mb-4 space-y-2" aria-label="Task progress log">
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
			<TaskRunChat
				{task}
				output={streamedOutput}
				{activities}
				permissions={permissions}
				onpermission={onpermission}
				oncancel={oncancel}
				onopenfile={onopenfile}
				showTaskHeader={false}
				showTaskBrief
				wide
				compact
			/>
		{/if}
		{#if followUpVisible}
			<form
				class="sticky bottom-0 mt-6 border-t bg-background/90 pt-3 backdrop-blur"
				onsubmit={(event) => {
					event.preventDefault();
					void sendFollowUp();
				}}
			>
				<div class="flex items-end gap-2">
					<input
						type="text"
						bind:value={followUpDraft}
						placeholder={canQueueNow
							? active
								? "Send a follow-up — steers the running agent"
								: "Send a follow-up — included when the task starts"
							: "Task is finished — retry to start a new run"}
						disabled={!canQueueNow || queueing}
						class="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm text-white/85 placeholder:text-white/35 focus:border-white/25 focus:outline-none disabled:opacity-50"
						aria-label="Send a follow-up to the running task"
						onkeydown={(event) => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void sendFollowUp();
							}
						}}
					/>
					<Button
						type="submit"
						size="sm"
						class="h-10 shrink-0"
						disabled={!canQueueNow || queueing || !followUpDraft.trim()}
						>{queueing ? "Queuing…" : "Send"}</Button
					>
				</div>
				<p class="mt-1.5 text-[11px] text-muted-foreground">
					Follow-ups are queued and delivered as extra turns in the same
					session — correct the agent without cancelling. Queue is lost if
					the daemon restarts.
				</p>
			</form>
		{/if}
	</div>
</section>
