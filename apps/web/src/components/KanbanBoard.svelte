<script lang="ts">
import { GripVertical, Pencil, Plus, Trash2 } from "@lucide/svelte";
import { onMount } from "svelte";
import { toast } from "svelte-sonner";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Checkbox from "$lib/components/ui/checkbox";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select/index.js";
import { Textarea } from "$lib/components/ui/textarea";
import { daemon, type IntegrationBatch, type ProjectReviewPolicy, type Task } from "$lib/daemon";

let {
	projectId,
	tasks = [],
	onChanged,
}: {
	projectId: string;
	tasks?: Task[];
	onChanged?: () => unknown;
} = $props();

const columns = [
	{ key: "queued", label: "Backlog" },
	{ key: "ready", label: "Ready" },
	{ key: "running", label: "In progress" },
	{ key: "review", label: "Review" },
	{ key: "done", label: "Done" },
	{ key: "failed", label: "Failed / cancelled" },
];

function column(task: Task) {
	if (task.status === "queued" || task.status === "blocked") return "queued";
	if (task.status === "ready") return "ready";
	if (["preparing", "running"].includes(task.status)) return "running";
	if (
		["ready_to_merge", "merge_conflict"].includes(task.status)
	)
		return "review";
	return task.status === "completed" ? "done" : "failed";
}

function orderKey(task: Task) {
	return task.position ?? Number.MAX_SAFE_INTEGER;
}

function setExecutorKind(value: string) {
	if (value === "agent" || value === "direct") executorKind = value;
}

const ordered = $derived(
	[...tasks].sort(
		(a, b) =>
			orderKey(a) - orderKey(b) || a.createdAt.localeCompare(b.createdAt),
	),
);

let dragId = $state("");
let overId = $state("");
let busy = $state(false);
let addOpen = $state(false);
let addTitle = $state("");
let addPrompt = $state("");
let addAcceptanceCriteria = $state("");
let addAgentId = $state("");
let executorKind = $state<"agent" | "direct">("agent");
let directProviderId = $state("");
let directModelId = $state("");
let targetBranch = $state("");
let projectBranches = $state<string[]>([]);
let projectGitAvailable = $state(true);
let availableAgents = $state<
	Array<{ id: string; label: string; provider: string; modelId: string | null }>
>([]);
let availableProviders = $state<Awaited<ReturnType<typeof daemon.listProviders>>>([]);
let availableModels = $state<Awaited<ReturnType<typeof daemon.listProviderModels>>>([]);
let agentsLoading = $state(false);
let modelsLoading = $state(false);
let editTask = $state<Task | null>(null);
let editTitle = $state("");
let editPrompt = $state("");
let deleteTask = $state<Task | null>(null);
let selectedIntegrationTaskIds = $state<string[]>([]);
let integrationBatches = $state<IntegrationBatch[]>([]);
let integrationDiffs = $state<Record<string, string>>({});
let integrationChecksText = $state("");
let reviewPolicy = $state<ProjectReviewPolicy | null>(null);
let reviewPolicyChecksText = $state("");
let reviewerExecutorText = $state("");
let reviewPolicyBusy = $state(false);
let autoMergeAvailable = $state(false);

onMount(() => {
	void loadIntegrationBatches();
	void loadReviewPolicy();
});

async function loadReviewPolicy() {
	try {
		const result = await daemon.getProjectReviewPolicy(projectId);
		reviewPolicy = result.policy;
		autoMergeAvailable = result.autoMergeAvailable;
		reviewerExecutorText = result.policy.reviewerExecutorJson ?? "";
		const checks = JSON.parse(result.policy.requiredChecksJson) as Array<{ command: string; args?: string[] }>;
		reviewPolicyChecksText = checks.map((check) => [check.command, ...(check.args ?? [])].join(" ")).join("\n");
	} catch {
		reviewPolicy = null;
	}
}

async function saveReviewPolicy() {
	if (!reviewPolicy || reviewPolicyBusy) return;
	reviewPolicyBusy = true;
	try {
		const requiredChecks = reviewPolicyChecksText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
			const [command, ...args] = line.split(/\s+/);
			return { name: command!, command: command!, args };
		});
		const { policy } = await daemon.setProjectReviewPolicy(projectId, {
			mode: reviewPolicy.mode,
			reviewerExecutorJson: reviewerExecutorText.trim() || null,
			autoMerge: reviewPolicy.mode === "automatic" && reviewPolicy.autoMerge,
			requiredChecksJson: JSON.stringify(requiredChecks),
			maxRevisionRounds: reviewPolicy.maxRevisionRounds,
		});
		reviewPolicy = policy;
		toast.success(`Review policy saved · v${policy.version}`);
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Unable to save review policy");
	} finally {
		reviewPolicyBusy = false;
	}
}

async function loadIntegrationBatches() {
	try {
		integrationBatches = (await daemon.listIntegrationBatches(projectId)).batches;
	} catch {
		integrationBatches = [];
	}
}

async function refresh() {
	await onChanged?.();
	await loadIntegrationBatches();
}

function toggleIntegrationTask(taskId: string, checked: boolean) {
	selectedIntegrationTaskIds = checked
		? [...new Set([...selectedIntegrationTaskIds, taskId])]
		: selectedIntegrationTaskIds.filter((id) => id !== taskId);
}

async function createIntegrationBatch() {
	if (selectedIntegrationTaskIds.length < 2 || busy) return;
	busy = true;
	try {
		const requiredChecks = integrationChecksText
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line, index) => {
				const [command, ...args] = line.split(/\s+/);
				return { name: `Check ${index + 1}`, command: command!, args };
			});
		const result = await daemon.createIntegrationBatch(selectedIntegrationTaskIds, requiredChecks);
		selectedIntegrationTaskIds = [];
		integrationChecksText = "";
		if (result.batch?.status === "checks_failed") toast.error(result.batch.errorMessage ?? "Required integration check failed");
		else toast.success(`Integration candidate ready · ${result.candidateSha.slice(0, 12)}`);
		await refresh();
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Unable to assemble integration candidate");
		await refresh();
	} finally {
		busy = false;
	}
}

async function viewIntegrationDiff(batch: IntegrationBatch) {
	busy = true;
	try {
		const result = await daemon.getIntegrationBatchDiff(batch.id);
		integrationDiffs = { ...integrationDiffs, [batch.id]: result.diff };
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Unable to inspect candidate");
	} finally {
		busy = false;
	}
}

async function approveIntegration(batch: IntegrationBatch) {
	if (!(batch.id in integrationDiffs) || busy) return;
	busy = true;
	try {
		await daemon.approveIntegrationBatch(batch.id);
		toast.success("Exact integration candidate approved");
		await refresh();
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Unable to approve integration");
	} finally {
		busy = false;
	}
}

async function promoteIntegration(batch: IntegrationBatch) {
	busy = true;
	try {
		const result = await daemon.promoteIntegrationBatch(batch.id);
		toast.success(`Promoted ${result.promotedSha.slice(0, 12)} to ${batch.targetBranch}`);
		await refresh();
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Unable to promote integration");
	} finally {
		busy = false;
	}
}

async function openAddTask() {
	addTitle = "";
	addPrompt = "";
	addAcceptanceCriteria = "";
	addAgentId = "";
	directProviderId = "";
	directModelId = "";
	targetBranch = "";
	projectBranches = [];
	projectGitAvailable = true;
	addOpen = true;
	agentsLoading = true;
	try {
		const [agents, providers] = await Promise.all([
			daemon.listCustomAgents(projectId),
			daemon.listProviders(),
		]);
		try {
			const git = await daemon.getProjectGit(projectId);
			projectBranches = git.branches;
			targetBranch = git.branches.includes(git.defaultBranch)
				? git.defaultBranch
				: git.branches.includes(git.branch)
					? git.branch
					: "";
			projectGitAvailable = git.gitAvailable !== false;
		} catch {
			// Kanban planning is useful before a project has been initialized as Git.
			projectBranches = [];
			targetBranch = "";
			projectGitAvailable = false;
		}
		availableAgents = agents
			.filter(
				(agent) =>
					agent.status === "active" &&
					agent.allowKanban &&
					agent.approvalPolicy !== "read_only",
			)
			.map((agent) => ({
				id: String(agent.id),
				label: String(agent.label),
				provider: String(agent.provider),
				modelId: typeof agent.modelId === "string" ? agent.modelId : null,
			}));
		availableProviders = providers.filter((provider) => provider.status === "connected");
		executorKind = availableAgents.length ? "agent" : "direct";
		directProviderId = availableProviders[0]?.providerId ?? "";
		if (directProviderId) await loadProviderModels(directProviderId);
	} catch (reason) {
			availableAgents = [];
			availableProviders = [];
			availableModels = [];
		toast.error(
			reason instanceof Error ? reason.message : "Unable to load agents",
		);
	} finally {
		agentsLoading = false;
	}
}

async function loadProviderModels(providerId: string) {
	directModelId = "";
	if (!providerId) {
		availableModels = [];
		return;
	}
	modelsLoading = true;
	try {
		availableModels = (await daemon.listProviderModels(providerId)).filter(
			(model) => model.isAvailable,
		);
	} catch {
		availableModels = [];
	} finally {
		modelsLoading = false;
	}
}

async function persist(order: Task[]) {
	busy = true;
	try {
		await daemon.reorderTasks(
			projectId,
			order.map((task) => task.id),
		);
		await refresh();
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Reorder failed");
		await refresh();
	} finally {
		busy = false;
	}
}

function move(draggedId: string, targetId: string | null) {
	const dragged = ordered.find((task) => task.id === draggedId);
	if (!dragged) return;
	if (targetId) {
		const target = ordered.find((task) => task.id === targetId);
		if (!target || target.id === draggedId) return;
		if (column(target) !== column(dragged)) {
			toast.info(
				"Drag to reorder within a column. Use Run or Retry to change status.",
			);
			return;
		}
		const next = ordered.filter((task) => task.id !== draggedId);
		next.splice(next.indexOf(target), 0, dragged);
		void persist(next);
		return;
	}
	const next = [...ordered.filter((task) => task.id !== draggedId), dragged];
	void persist(next);
}

function onDragStart(event: DragEvent, id: string) {
	dragId = id;
	overId = "";
	event.dataTransfer?.setData("text/plain", id);
	if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragEnd() {
	dragId = "";
	overId = "";
}

async function doAdd() {
	if (!addTitle.trim() || !addPrompt.trim() || !addAcceptanceCriteria.trim() || busy) return;
	if (
		(executorKind === "agent" && !addAgentId) ||
		(executorKind === "direct" && !directProviderId)
	)
		return;
	busy = true;
	try {
		await daemon.createTask({
			projectId,
			title: addTitle.trim(),
			prompt: addPrompt.trim(),
			acceptanceCriteria: addAcceptanceCriteria.split("\n").map((item) => item.trim()).filter(Boolean),
			targetBranch: projectBranches.includes(targetBranch) ? targetBranch : null,
			executor:
				executorKind === "agent"
					? { kind: "agent", agentId: addAgentId }
					: {
							kind: "direct",
							providerId: directProviderId,
							modelId: directModelId || null,
						},
		});
		addTitle = "";
		addPrompt = "";
			addAcceptanceCriteria = "";
		addAgentId = "";
		addOpen = false;
		toast.success("Task added with executor settings");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to add task",
		);
	} finally {
		busy = false;
	}
}

function openEdit(task: Task) {
	editTask = task;
	editTitle = task.title;
	editPrompt = task.prompt;
}

async function doEdit() {
	if (!editTask || !editTitle.trim() || busy) return;
	busy = true;
	try {
		await daemon.renameTask(editTask.id, {
			title: editTitle.trim(),
			prompt: editPrompt.trim() || undefined,
		});
		editTask = null;
		toast.success("Task updated");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to update task",
		);
	} finally {
		busy = false;
	}
}

async function doDelete() {
	if (!deleteTask || busy) return;
	busy = true;
	try {
		await daemon.deleteTask(deleteTask.id);
		deleteTask = null;
		toast.success("Task deleted");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to delete task",
		);
	} finally {
		busy = false;
	}
}

async function doRun(task: Task) {
	busy = true;
	try {
		await daemon.startTask(task.id);
		toast.success("Task started");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to start task",
		);
	} finally {
		busy = false;
	}
}

async function doRetry(task: Task) {
	busy = true;
	try {
		await daemon.retryTask(task.id);
		toast.success("Task queued for retry");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to retry task",
		);
	} finally {
		busy = false;
	}
}

async function doCancel(task: Task) {
	busy = true;
	try {
		await daemon.cancelTask(task.id);
		toast.success("Task cancelled");
		await refresh();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to cancel task",
		);
	} finally {
		busy = false;
	}
}
</script>

<div class="flex h-full flex-col gap-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="text-sm text-muted-foreground">{tasks.length} tasks · drag cards to reorder</p>
		<div class="flex flex-wrap items-center gap-2">
			{#if selectedIntegrationTaskIds.length >= 2}<Button size="sm" variant="outline" onclick={() => void createIntegrationBatch()} disabled={busy}>Assemble {selectedIntegrationTaskIds.length} outputs</Button>{/if}
			<Button size="sm" onclick={() => void openAddTask()} disabled={busy}><Plus size={15} />Add task</Button>
		</div>
	</div>
	{#if reviewPolicy}
		<details class="rounded-lg border bg-card px-3 py-2">
			<summary class="cursor-pointer text-sm font-medium">Review policy · {reviewPolicy.mode} · v{reviewPolicy.version}</summary>
			<div class="mt-3 grid gap-3 md:grid-cols-[180px_1fr_1fr_auto] md:items-end">
				<label class="grid gap-1 text-xs text-muted-foreground">Review mode
					<select class="h-9 rounded-md border bg-background px-2 text-sm text-foreground" value={reviewPolicy.mode} onchange={(event) => { const mode = event.currentTarget.value as ProjectReviewPolicy["mode"]; reviewPolicy = { ...reviewPolicy!, mode, autoMerge: mode === "automatic" && reviewPolicy!.autoMerge }; }}>
						<option value="manual">Manual</option><option value="hybrid">Hybrid</option><option value="automatic">Automatic review</option>
					</select>
				</label>
				<label class="grid gap-1 text-xs text-muted-foreground">Required checks · one command per line
					<Textarea bind:value={reviewPolicyChecksText} rows={2} placeholder="bun run check-types&#10;bun test" />
				</label>
				<label class="grid gap-1 text-xs text-muted-foreground">Reviewer executor · required for hybrid/automatic
					<Textarea bind:value={reviewerExecutorText} rows={2} placeholder={'{"kind":"agent","agentId":"…"}'} />
				</label>
				<Button size="sm" variant="outline" disabled={reviewPolicyBusy} onclick={() => void saveReviewPolicy()}>{reviewPolicyBusy ? "Saving…" : "Save policy"}</Button>
			</div>
			{#if autoMergeAvailable}<label class="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Checkbox.Root bind:checked={reviewPolicy.autoMerge} disabled={reviewPolicy.mode !== "automatic"} aria-label="Allow automatic merge after review" /> Allow automatic merge after required checks and approved automated review</label>{/if}
			<p class="mt-2 text-xs text-muted-foreground">Policy changes invalidate prior approvals. Automatic merge availability is controlled by the server feature flag.</p>
		</details>
	{/if}
	{#if integrationBatches.length}
		<section class="space-y-2 rounded-xl border p-3" aria-label="Integration batches">
			<h3 class="text-sm font-medium">Integration candidates</h3>
			{#each integrationBatches as batch (batch.id)}
				<div class="space-y-2 rounded-lg border bg-card p-3">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<div class="min-w-0">
							<p class="text-sm font-medium">{batch.targetBranch} · {batch.status.replaceAll("_", " ")}</p>
							<p class="text-xs text-muted-foreground">{batch.candidateSha ? `candidate ${batch.candidateSha.slice(0, 12)}` : batch.errorMessage ?? "Assembly pending"}</p>
						</div>
						<div class="flex flex-wrap gap-1">
							{#if batch.status === "pending_review"}<Button size="sm" variant="outline" disabled={busy} onclick={() => void viewIntegrationDiff(batch)}>View candidate diff</Button>{/if}
							{#if batch.status === "pending_review" && batch.id in integrationDiffs}<Button size="sm" variant="outline" disabled={busy} onclick={() => void approveIntegration(batch)}>Approve candidate</Button>{/if}
							{#if batch.status === "approved"}<Button size="sm" disabled={busy} onclick={() => void promoteIntegration(batch)}>Promote</Button>{/if}
						</div>
					</div>
					{#if batch.checks?.length}
						<div class="space-y-1 border-t pt-2">
							{#each batch.checks as check (check.name)}
								<p class={`text-xs ${check.status === "passed" ? "text-emerald-400" : "text-destructive"}`}>{check.status === "passed" ? "✓" : "×"} {check.name} · {check.commandRedacted} · exit {check.exitCode ?? "timeout"}</p>
							{/each}
						</div>
					{/if}
					{#if batch.id in integrationDiffs}<pre class="max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-xs">{integrationDiffs[batch.id]}</pre>{/if}
				</div>
			{/each}
		</section>
	{/if}
	<div class="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-x-auto sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
		{#each columns as item}
			{@const cards = ordered.filter((task) => column(task) === item.key)}
			<section
				aria-label={`${item.label} column`}
				class="flex min-h-44 flex-col rounded-xl border bg-muted/20 p-3"
				ondragover={(event) => event.preventDefault()}
				ondrop={(event) => {
					event.preventDefault();
					if (dragId) move(dragId, null);
					onDragEnd();
				}}
			>
				<div class="mb-3 flex items-center justify-between gap-2">
					<h3 class="text-sm font-medium">{item.label}</h3>
					<Badge variant="secondary">{cards.length}</Badge>
				</div>
				<div class="min-h-10 flex-1 space-y-2">
					{#each cards as task (task.id)}
						<article
							draggable="true"
							aria-label={`Task ${task.title}`}
							class={`space-y-2 rounded-lg border bg-card p-3 shadow-sm transition ${dragId === task.id ? "opacity-40" : ""} ${overId === task.id ? "border-primary ring-1 ring-primary" : ""}`}
							ondragstart={(event) => onDragStart(event, task.id)}
							ondragend={onDragEnd}
							ondragover={(event) => {
								event.preventDefault();
								event.stopPropagation();
								if (task.id !== dragId) overId = task.id;
							}}
							ondrop={(event) => {
								event.preventDefault();
								event.stopPropagation();
								if (dragId) move(dragId, task.id);
								onDragEnd();
							}}
						>
							<div class="flex items-start gap-1">
								{#if task.status === "ready_to_merge"}<Checkbox.Root aria-label={`Select ${task.title} for integration`} checked={selectedIntegrationTaskIds.includes(task.id)} onCheckedChange={(checked) => toggleIntegrationTask(task.id, checked === true)} />{/if}
								<span class="mt-0.5 cursor-grab text-muted-foreground" title="Drag to reorder" aria-hidden="true"><GripVertical size={14} /></span>
								<p class="min-w-0 flex-1 text-sm font-medium break-words">{task.title}</p>
								<Button variant="ghost" size="icon" class="size-7 shrink-0" title="Edit task" aria-label={`Edit ${task.title}`} onclick={() => openEdit(task)}><Pencil size={13} /></Button>
								<Button variant="ghost" size="icon" class="size-7 shrink-0 text-destructive" title="Delete task" aria-label={`Delete ${task.title}`} onclick={() => (deleteTask = task)}><Trash2 size={13} /></Button>
							</div>
							<p class="line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>
							<div class="flex flex-wrap items-center gap-1">
								{#if task.source === "planner"}<Badge variant="outline" class="text-[10px]">AI Planned</Badge>{/if}
								{#if task.status === "blocked"}<Badge variant="secondary" class="text-[10px] text-amber-300">Blocked</Badge>{/if}
								{#if task.acceptanceCriteria.length}<span class="text-[10px] text-muted-foreground">✓ {task.acceptanceCriteria.length} checks</span>{/if}
							</div>
							<div class="flex flex-wrap gap-1">
								{#if ["queued", "ready"].includes(task.status)}<Button size="sm" variant="outline" disabled={busy} onclick={() => doRun(task)}>Run</Button>{/if}
								{#if ["failed", "cancelled"].includes(task.status)}<Button size="sm" variant="outline" disabled={busy} onclick={() => doRetry(task)}>Retry</Button>{/if}
								{#if ["queued", "preparing", "running"].includes(task.status)}<Button size="sm" variant="ghost" disabled={busy} onclick={() => doCancel(task)}>Cancel</Button>{/if}
								<Button size="sm" variant="ghost" href={`/task/${task.id}`}>Open</Button>
							</div>
						</article>
					{/each}
					{#if !cards.length}<p class="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">Drop here</p>{/if}
				</div>
			</section>
		{/each}
	</div>
	{#if selectedIntegrationTaskIds.length >= 2}
		<div class="space-y-2 rounded-lg border p-3">
			<label class="text-sm font-medium" for="integration-required-checks">Required integration checks (optional)</label>
			<Textarea id="integration-required-checks" bind:value={integrationChecksText} rows={2} placeholder="bun run check-types&#10;bun test" />
			<p class="text-xs text-muted-foreground">One executable and its arguments per line. Checks run in the isolated candidate worktree without a shell; a nonzero exit or timeout blocks review.</p>
		</div>
	{/if}
</div>

<AlertDialog.Root bind:open={addOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Add task</AlertDialog.Title>
		<AlertDialog.Description>Create a queued task and choose the exact executor that will run it.</AlertDialog.Description>
		</AlertDialog.Header>
		<div class="space-y-3">
			<Input aria-label="Task title" bind:value={addTitle} maxlength={200} placeholder="Task title" />
			<Textarea aria-label="Task prompt" bind:value={addPrompt} rows={4} placeholder="What should the agent do?" />
			<Textarea aria-label="Acceptance criteria" bind:value={addAcceptanceCriteria} rows={3} placeholder="Acceptance criteria (one per line)" />
			<div class="space-y-2">
			<label class="text-sm font-medium" for="task-target-branch">Target branch</label>
			{#if projectBranches.length}
				<Select.Root type="single" value={targetBranch} onValueChange={(value) => targetBranch = value}>
					<Select.Trigger id="task-target-branch" class="w-full" disabled={agentsLoading}>
						<Select.Value placeholder="Choose a target branch" />
					</Select.Trigger>
					<Select.Content>
						{#each projectBranches as branch}
							<Select.Item value={branch}>{branch}{branch === targetBranch ? " · default" : ""}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{:else}
				<div id="task-target-branch" class="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
					Planning only · no Git branch available
					<p class="mt-1 text-xs">{projectGitAvailable ? "Create an initial commit to run tasks in a worktree." : "You can add tasks now. Initialize Git and create an initial commit when you are ready to run them."}</p>
				</div>
			{/if}
				<label class="text-sm font-medium" for="task-executor-kind">Executor</label>
				<Select.Root type="single" value={executorKind} onValueChange={setExecutorKind}>
					<Select.Trigger id="task-executor-kind" class="w-full">
						<Select.Value />
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="agent">Custom agent</Select.Item>
						<Select.Item value="direct">Provider and model</Select.Item>
					</Select.Content>
				</Select.Root>
				{#if executorKind === "agent"}
					<label class="text-sm font-medium" for="task-agent-select">Kanban agent</label>
					<Select.Root type="single" value={addAgentId} onValueChange={(value) => addAgentId = value}>
						<Select.Trigger id="task-agent-select" class="w-full" disabled={agentsLoading}>
							<Select.Value placeholder={agentsLoading ? "Loading agents…" : "Select an agent"} />
						</Select.Trigger>
						<Select.Content>
							{#each availableAgents as agent}
								<Select.Item value={agent.id}>{agent.label} · {agent.provider}{agent.modelId ? ` / ${agent.modelId}` : ""}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					{#if !agentsLoading && !availableAgents.length}
						<p class="text-xs text-muted-foreground">No writable Kanban agents. Read-only agents cannot implement project files. Create or enable a coding agent in <a class="underline underline-offset-4" href="/settings/agents">Agent settings</a>, or choose a provider and model.</p>
					{/if}
				{:else}
					<label class="text-sm font-medium" for="task-provider-select">Provider</label>
					<Select.Root type="single" value={directProviderId} onValueChange={(value) => { directProviderId = value; void loadProviderModels(value); }}>
						<Select.Trigger id="task-provider-select" class="w-full" disabled={agentsLoading || !availableProviders.length}>
							<Select.Value placeholder={agentsLoading ? "Loading providers…" : "Select a connected provider"} />
						</Select.Trigger>
						<Select.Content>
							{#each availableProviders as provider}
								<Select.Item value={provider.providerId}>{provider.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<label class="text-sm font-medium" for="task-model-select">Model</label>
					<Select.Root type="single" value={directModelId || "__provider_default"} onValueChange={(value) => directModelId = value === "__provider_default" ? "" : value}>
						<Select.Trigger id="task-model-select" class="w-full" disabled={!directProviderId || modelsLoading}>
							<Select.Value placeholder={modelsLoading ? "Loading models…" : "Provider default"} />
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="__provider_default">Provider default</Select.Item>
							{#each availableModels as model}
								<Select.Item value={String(model.metadata?.modelId ?? model.name)}>{model.displayName || model.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<p class="text-xs text-muted-foreground">The selected provider and model are pinned to each task run.</p>
				{/if}
			</div>
		</div>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<Button onclick={() => void doAdd()} disabled={!addTitle.trim() || !addPrompt.trim() || !addAcceptanceCriteria.trim() || busy || (executorKind === "agent" ? !addAgentId : !directProviderId)}>{busy ? "Adding…" : "Add task"}</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root open={!!editTask} onOpenChange={(open) => { if (!open) editTask = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Edit task</AlertDialog.Title>
			<AlertDialog.Description>Update the title or instructions. Prompt edits are blocked while running.</AlertDialog.Description>
		</AlertDialog.Header>
		<div class="space-y-3">
			<Input aria-label="Task title" bind:value={editTitle} maxlength={200} placeholder="Task title" />
			<Textarea aria-label="Task prompt" bind:value={editPrompt} rows={5} placeholder="Task instructions" />
		</div>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<Button onclick={() => void doEdit()} disabled={!editTitle.trim() || busy}>{busy ? "Saving…" : "Save changes"}</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root open={!!deleteTask} onOpenChange={(open) => { if (!open) deleteTask = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete task?</AlertDialog.Title>
			<AlertDialog.Description>“{deleteTask?.title}” and its workspace will be removed permanently. Active runs are cancelled first.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => void doDelete()} disabled={busy}>{busy ? "Deleting…" : "Delete task"}</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
