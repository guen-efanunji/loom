<script lang="ts">
	import { LoaderCircle, Plus, Trash2, X } from "@lucide/svelte";
	import { onDestroy } from "svelte";
	import { toast } from "svelte-sonner";
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
		onconverted,
		onclose,
	}: {
		open: boolean;
		projectId: string;
		sessionId?: string;
		messageId: string;
		messageText: string;
		role?: string;
		onconverted?: () => void;
		onclose?: () => void;
	} = $props();

	type Stage = "generating" | "review" | "done" | "failed";

	let stage = $state<Stage>("generating");
	let planId = $state<string | null>(null);
	let title = $state("");
	let summary = $state("");
	let draft = $state<PlanTaskDraft[]>([]);
	let error = $state("");
	let issues = $state<Array<{ code: string; message: string }>>([]);
	let saving = $state(false);
	let polling: ReturnType<typeof setInterval> | null = null;

	function stopPolling() {
		if (polling) {
			clearInterval(polling);
			polling = null;
		}
	}

	onDestroy(stopPolling);

	$effect(() => {
		if (!open) {
			stopPolling();
			return;
		}
		// Fresh dialog per message: (re)generate its plan.
		stage = "generating";
		planId = null;
		draft = [];
		error = "";
		issues = [];
		void generate();
	});

	async function generate() {
		stopPolling();
		let id: string;
		try {
			const created = await daemon.createPlan({
				projectId,
				sourceMessageId: messageId,
				message: messageText,
				mode: "plan",
				sourceSessionId: sessionId,
			});
			id = created.planId;
			planId = id;
		} catch (reason) {
			error = reason instanceof Error ? reason.message : "Unable to create plan";
			stage = "failed";
			return;
		}
		let attempts = 0;
		polling = setInterval(() => {
			void (async () => {
				attempts += 1;
				try {
					const detail = await daemon.getPlanDetail(id);
					if (!open) return;
					if (detail.plan.convertedAt) {
						stopPolling();
						stage = "done";
						toast.success(
							`Added ${detail.tasks.length} task(s) to the Kanban board.`,
						);
						onconverted?.();
						return;
					}
					if (detail.plan.status === "failed") {
						stopPolling();
						error = detail.plan.errorMessage ?? "Plan generation failed";
						stage = "failed";
						return;
					}
					if (detail.plan.status === "validated" && detail.draft.length) {
						stopPolling();
						title = detail.plan.title;
						summary = detail.plan.summary;
						draft = detail.draft.map(
							({ id: _id, planId: _p, ...task }) => task,
						);
						stage = "review";
						return;
					}
					if (attempts > 90) {
						stopPolling();
						error = "Plan generation is taking too long. Try again.";
						stage = "failed";
					}
				} catch {
					// Keep polling through transient failures.
				}
			})();
		}, 2000);
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
		onclose?.();
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		role="dialog"
		aria-modal="true"
		aria-label="Turn message into Kanban tasks"
		onclick={(event) => {
			if (event.target === event.currentTarget) close();
		}}
	>
		<div
			class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/10 bg-background shadow-2xl"
		>
			<div class="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
				<div>
					<p class="text-sm font-semibold text-white/90">
						Add to Kanban board
					</p>
					<p class="mt-0.5 text-xs text-white/50">
						This {role === "assistant" ? "answer" : "message"} becomes structured
						tasks. Review them, then they land in Backlog.
					</p>
				</div>
				<Button variant="ghost" size="sm" class="h-8 w-8 p-0" onclick={close} aria-label="Close">
					<X size={16} />
				</Button>
			</div>

			<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				{#if stage === "generating"}
					<div class="flex items-center gap-3 py-10 text-sm text-white/60">
						<LoaderCircle size={16} class="animate-spin" />
						Planning tasks from this message…
					</div>
				{:else if stage === "failed"}
					<div class="py-6">
						<p class="text-sm text-red-300">{error}</p>
						<Button size="sm" class="mt-4" onclick={() => void generate()}>
							Try again
						</Button>
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
						<span class="mb-1 block text-xs font-medium text-white/60">Plan title</span>
						<Input bind:value={title} />
					</label>
					<label class="mb-4 block">
						<span class="mb-1 block text-xs font-medium text-white/60">Summary</span>
						<Textarea bind:value={summary} rows={2} />
					</label>

					<div class="space-y-4">
						{#each draft as task, index (task.key)}
							<div class="rounded-lg border border-white/10 bg-white/[0.03] p-3">
								<div class="mb-2 flex items-start gap-2">
									<span class="mt-2 text-[11px] font-medium text-white/40">
										{moveKey(index) + 1}
									</span>
									<div class="min-w-0 flex-1 space-y-2">
										<Input
											bind:value={task.title}
											placeholder="Task title"
										/>
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
											if (value) task.priority = value as PlanTaskDraft["priority"];
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
						<div class="mt-4 rounded-lg border border-amber-400/25 bg-amber-500/[0.07] p-3">
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
				<div class="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-3">
					<Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
					<Button size="sm" disabled={saving || !draft.length} onclick={() => void saveEdits()}>
						{saving ? "Adding…" : "Add to board"}
					</Button>
				</div>
			{/if}
		</div>
	</div>
{/if}
