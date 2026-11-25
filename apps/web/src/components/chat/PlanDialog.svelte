<script lang="ts">
import { LoaderCircle, Plus, Trash2, X } from "@lucide/svelte";
import { onDestroy, untrack } from "svelte";
import { toast } from "svelte-sonner";
import type { Model } from "$lib/chat";
import Plan from "$lib/components/ai-elements/Plan.svelte";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select/index.js";
import { Textarea } from "$lib/components/ui/textarea";
import { daemon, type PlanTaskDraft } from "$lib/daemon";

let {
	open,
	projectId,
	sessionId,
	messageId,
	messageText,
	role = "user",
	model,
	models = [],
	onconverted,
	onclose,
}: {
	open: boolean;
	projectId: string;
	sessionId?: string;
	messageId: string;
	messageText: string;
	role?: string;
	model?: { providerID: string; modelID: string };
	models?: Model[];
	onconverted?: () => void;
	onclose?: () => void;
} = $props();

type Stage = "generating" | "review" | "done" | "failed";
type Phase = "context" | "generating" | "validating" | "repairing";

let stage = $state<Stage>("generating");
let phase = $state<Phase>("context");
let planId = $state<string | null>(null);
let title = $state("");
let summary = $state("");
let draft = $state<PlanTaskDraft[]>([]);
let error = $state("");
let selectedModelKey = $state("");
let elapsedSeconds = $state(0);
const planSteps = $derived(
	draft.map((task, index) => ({
		id: task.key,
		title: task.title.trim() || `Task ${index + 1}`,
		status: "pending" as const,
	})),
);
let issues = $state<Array<{ code: string; message: string }>>([]);
let saving = $state(false);
let initialPollTimer: ReturnType<typeof setTimeout> | null = null;
let polling: ReturnType<typeof setInterval> | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let runToken = 0;

function modelRefFromKey(
	key: string,
): { providerID: string; modelID: string } | undefined {
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return undefined;
	return {
		providerID: key.slice(0, slash),
		modelID: key.slice(slash + 1),
	};
}

function initialModelKey(): string {
	if (model?.providerID && model?.modelID)
		return `${model.providerID}/${model.modelID}`;
	const first = models[0];
	return first ? `${first.providerID}/${first.modelID}` : "";
}

const activeModelRef = $derived(
	modelRefFromKey(selectedModelKey) ?? model ?? undefined,
);
const activeModelDisplay = $derived.by(() => {
	const ref = activeModelRef;
	if (!ref) return "Default model";
	const match = models.find(
		(item) =>
			item.providerID === ref.providerID && item.modelID === ref.modelID,
	);
	return match
		? `${match.name} (${match.provider})`
		: `${ref.modelID} (${ref.providerID})`;
});
const phaseLabel = $derived.by(() => {
	switch (phase) {
		case "context":
			return "Reading project context…";
		case "validating":
			return "Validating task dependencies…";
		case "repairing":
			return "Repairing plan output…";
		default:
			return "Generating structured tasks…";
	}
});

function stopTimers() {
	if (initialPollTimer) {
		clearTimeout(initialPollTimer);
		initialPollTimer = null;
	}
	if (polling) {
		clearInterval(polling);
		polling = null;
	}
	if (elapsedTimer) {
		clearInterval(elapsedTimer);
		elapsedTimer = null;
	}
}

onDestroy(stopTimers);

$effect(() => {
	const isOpen = open;
	const currentMessageId = messageId;
	if (!isOpen || !currentMessageId) {
		untrack(() => {
			runToken += 1;
			stopTimers();
		});
		return;
	}
	// Fresh dialog per message: (re)generate its plan without tracking
	// background model/catalog updates inside this effect.
	untrack(() => {
		selectedModelKey = initialModelKey();
		stage = "generating";
		phase = "context";
		planId = null;
		draft = [];
		error = "";
		issues = [];
		void generate(false);
	});
});

async function generate(reuseFailedPlan = false) {
	const token = ++runToken;
	stopTimers();
	stage = "generating";
	phase = "context";
	error = "";
	elapsedSeconds = 0;
	elapsedTimer = setInterval(() => {
		if (token === runToken && stage === "generating") elapsedSeconds += 1;
	}, 1000);

	const targetModel = activeModelRef;
	let id = reuseFailedPlan ? planId : null;
	try {
		if (id) {
			try {
				await daemon.retryPlan(id, { model: targetModel });
			} catch {
				id = null;
			}
		}
		if (!id) {
			const created = await daemon.createPlan({
				projectId,
				sourceMessageId: messageId,
				message: messageText,
				mode: "plan",
				sourceSessionId: sessionId,
				model: targetModel,
			});
			id = created.planId;
		}
		if (token !== runToken || !open) {
			void daemon.cancelPlan(id).catch(() => {});
			return;
		}
		planId = id;
	} catch (reason) {
		if (token !== runToken) return;
		stopTimers();
		error = reason instanceof Error ? reason.message : "Unable to create plan";
		stage = "failed";
		return;
	}

	let attempts = 0;
	let consecutiveErrors = 0;
	let pollInFlight = false;
	const pollOnce = async () => {
		if (pollInFlight || token !== runToken || !open) return;
		pollInFlight = true;
		attempts += 1;
		try {
			const detail = await daemon.getPlanDetail(id);
			if (token !== runToken || !open) return;
			consecutiveErrors = 0;
			if (detail.activity?.phase) phase = detail.activity.phase;
			if (detail.plan.convertedAt) {
				stopTimers();
				stage = "done";
				toast.success(
					`Added ${detail.tasks.length} task(s) to the Kanban board.`,
				);
				onconverted?.();
				return;
			}
			if (detail.plan.cancelledAt || detail.plan.status === "failed") {
				stopTimers();
				error = detail.plan.errorMessage ?? "Plan generation failed";
				stage = "failed";
				return;
			}
			if (detail.plan.status === "validated") {
				stopTimers();
				if (!detail.draft.length) {
					error = "Planner produced no tasks. Try again or pick another model.";
					stage = "failed";
					return;
				}
				title = detail.plan.title;
				summary = detail.plan.summary;
				draft = detail.draft.map(({ id: _id, planId: _p, ...task }) => task);
				stage = "review";
				return;
			}
			if (attempts > 135) {
				stopTimers();
				void daemon.cancelPlan(id).catch(() => {});
				error = "Plan generation timed out. Try a faster model or retry.";
				stage = "failed";
			}
		} catch (reason) {
			if (token !== runToken || !open) return;
			consecutiveErrors += 1;
			if (consecutiveErrors >= 5) {
				stopTimers();
				error =
					reason instanceof Error
						? reason.message
						: "Lost connection while checking plan status";
				stage = "failed";
			}
		} finally {
			pollInFlight = false;
		}
	};

	initialPollTimer = setTimeout(() => void pollOnce(), 300);
	polling = setInterval(() => void pollOnce(), 900);
}

function moveKey(index: number) {
	return index;
}

async function saveEdits() {
	if (!planId) return;
	saving = true;
	error = "";
	issues = [];
	try {
		await daemon.savePlan(planId, {
			title,
			summary,
			tasks: draft.map((task) => ({
				...task,
				title: task.title.trim() || "Untitled task",
				description: task.description.trim(),
				acceptanceCriteria: task.acceptanceCriteria.filter(Boolean),
			})),
		});
		const validation = await daemon.validatePlan(planId);
		if (!validation.ok) {
			issues = validation.issues;
			toast.error("Fix the highlighted issues before adding to the board.");
			return;
		}
		// Approved for the board: convert immediately.
		await daemon.approvePlan(planId);
		const converted = await daemon.convertPlan(planId);
		stage = "done";
		toast.success(
			`Added ${converted.taskIds.length} task(s) to the Kanban board.`,
		);
		onconverted?.();
	} catch (reason) {
		error = reason instanceof Error ? reason.message : "Unable to save plan";
	} finally {
		saving = false;
	}
}

function addTask() {
	draft = [
		...draft,
		{
			key: `draft-${draft.length + 1}-${Date.now()}`,
			title: "",
			description: "",
			priority: "medium",
			dependencies: [],
			acceptanceCriteria: [],
			suggestedFiles: [],
		},
	];
}

function removeTask(index: number) {
	draft = draft.filter((_, i) => i !== index);
}

function close() {
	runToken += 1;
	stopTimers();
	if (stage === "generating" && planId) {
		void daemon.cancelPlan(planId).catch(() => {});
	}
	onclose?.();
}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		role="dialog"
		aria-modal="true"
		aria-label="Turn message into Kanban tasks"
		tabindex="-1"
		onclick={(event) => {
			if (event.target === event.currentTarget) close();
		}}
		onkeydown={(event) => {
			if (event.key === "Escape") close();
		}}
	>
		<div
			class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/10 bg-background shadow-2xl"
		>
			<div
				class="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4"
			>
				<div>
					<p class="text-sm font-semibold text-white/90">Add to Kanban board</p>
					<p class="mt-0.5 text-xs text-white/50">
						This {role === "assistant" ? "answer" : "message"} becomes structured
						tasks. Review them, then they land in Backlog.
					</p>
				</div>
				<Button
					variant="ghost"
					size="sm"
					class="h-8 w-8 p-0"
					onclick={close}
					aria-label="Close"
				>
					<X size={16} />
				</Button>
			</div>

			<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				{#if stage === "generating"}
					<div class="space-y-4 py-8">
						<div class="flex items-center justify-between gap-3">
							<div class="flex items-center gap-3 text-sm text-white/80">
								<LoaderCircle size={16} class="shrink-0 animate-spin" />
								<span>{phaseLabel}</span>
							</div>
							<span class="text-xs tabular-nums text-white/40">
								{elapsedSeconds}s
							</span>
						</div>
						<p class="text-xs text-white/50">
							Using <span class="text-white/75">{activeModelDisplay}</span>
						</p>
						<div class="flex items-center gap-2 pt-2">
							<Button variant="outline" size="sm" onclick={close}>
								Cancel
							</Button>
						</div>
					</div>
				{:else if stage === "failed"}
					<div class="space-y-4 py-6">
						<p class="text-sm text-red-300">{error}</p>
						{#if models.length}
							<label class="block max-w-sm">
								<span class="mb-1 block text-xs font-medium text-white/60">
									Planner model
								</span>
								<Select.Root
									type="single"
									value={selectedModelKey}
									onValueChange={(value) => {
										if (value) selectedModelKey = value;
									}}
								>
									<Select.Trigger class="w-full">
										{activeModelDisplay}
									</Select.Trigger>
									<Select.Content>
										{#each models as item (`${item.providerID}/${item.modelID}`)}
											<Select.Item
												value={`${item.providerID}/${item.modelID}`}
												label={`${item.name} (${item.provider})`}
											>
												{item.name} ({item.provider})
											</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							</label>
						{/if}
						<div class="flex items-center gap-2">
							<Button size="sm" onclick={() => void generate(true)}>
								Try again
							</Button>
							<Button variant="ghost" size="sm" onclick={close}>
								Cancel
							</Button>
						</div>
					</div>
				{:else if stage === "done"}
					<div class="py-10 text-center">
						<p class="text-sm font-medium text-emerald-300">
							Tasks added to the board
						</p>
						<p class="mt-1 text-xs text-white/50">
							Mention them in chat (e.g. @login) to start them, or run them from
							the board.
						</p>
						<Button size="sm" class="mt-4" onclick={close}>Done</Button>
					</div>
				{:else}
					<label class="mb-3 block">
						<span class="mb-1 block text-xs font-medium text-white/60"
							>Plan title</span
						>
						<Input bind:value={title} />
					</label>
					<label class="mb-4 block">
						<span class="mb-1 block text-xs font-medium text-white/60"
							>Summary</span
						>
						<Textarea bind:value={summary} rows={2} />
					</label>

					<Plan title={title || "Plan preview"} steps={planSteps} open={true} />

					<div class="mt-4 space-y-4">
						{#each draft as task, index (task.key)}
							<div
								class="rounded-lg border border-white/10 bg-white/[0.03] p-3"
							>
								<div class="mb-2 flex items-start gap-2">
									<span class="mt-2 text-[11px] font-medium text-white/40">
										{moveKey(index) + 1}
									</span>
									<div class="min-w-0 flex-1 space-y-2">
										<Input bind:value={task.title} placeholder="Task title" />
										<Textarea
											bind:value={task.description}
											rows={2}
											placeholder="Description"
										/>
										<Textarea
											value={task.acceptanceCriteria.join("\n")}
											oninput={(event) => {
												task.acceptanceCriteria = (
													event.currentTarget as HTMLTextAreaElement
												).value
													.split("\n")
													.map((line) => line.trim())
													.filter(Boolean);
											}}
											rows={2}
											placeholder="Acceptance criteria (one per line)"
										/>
									</div>
									<Select.Root
										type="single"
										bind:value={task.priority}
										onValueChange={(value) => {
											if (value)
												task.priority = value as PlanTaskDraft["priority"];
										}}
									>
										<Select.Trigger class="w-24">
											{task.priority}
										</Select.Trigger>
										<Select.Content>
											<Select.Item value="low">Low</Select.Item>
											<Select.Item value="medium">Medium</Select.Item>
											<Select.Item value="high">High</Select.Item>
										</Select.Content>
									</Select.Root>
									<Button
										variant="ghost"
										size="sm"
										class="h-8 w-8 shrink-0 p-0"
										aria-label={`Remove task ${index + 1}`}
										onclick={() => removeTask(index)}
									>
										<Trash2 size={14} />
									</Button>
								</div>
							</div>
						{/each}
					</div>

					<Button variant="outline" size="sm" class="mt-4" onclick={addTask}>
						<Plus size={14} /> Add task
					</Button>

					{#if issues.length}
						<div
							class="mt-4 rounded-lg border border-amber-400/25 bg-amber-500/[0.07] p-3"
						>
							<ul class="list-disc space-y-1 pl-5 text-xs text-amber-200">
								{#each issues as issue (issue.code + issue.message)}
									<li>{issue.message}</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if error}
						<p class="mt-3 text-xs text-red-300">{error}</p>
					{/if}
				{/if}
			</div>

			{#if stage === "review"}
				<div
					class="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-3"
				>
					<Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
					<Button
						size="sm"
						disabled={saving || !draft.length}
						onclick={() => void saveEdits()}
					>
						{saving ? "Adding…" : "Add to board"}
					</Button>
				</div>
			{/if}
		</div>
	</div>
{/if}
