import { randomUUID } from "node:crypto";
import {
	buildAutomationContext,
	convertPlanTasks,
	RuntimePlanner,
	validateAutomationPlan,
} from "@loom/automation";
import type {
	PlanRepository,
	PlanTaskRecord,
	ProjectRecord,
	repositories,
	TaskRecord,
} from "@loom/db";
import type { AgentModel, AgentRuntime } from "@loom/opencode";
import type { AutomationPlanTask, PlanStatus } from "@loom/protocol";
import type { TaskLifecycleHooks, TaskOrchestrator } from "./index";
import { git, snapshotWorkspace } from "./commands";

type Repos = ReturnType<typeof repositories>;

async function projectTasks(
	repos: Repos,
	projectId: string,
): Promise<TaskRecord[]> {
	if (repos.tasks.listByProject) return repos.tasks.listByProject(projectId);
	const all = (await repos.tasks.list?.()) ?? [];
	return all.filter((task) => task.projectId === projectId);
}

const TERMINAL_TASK = new Set(["completed", "failed", "cancelled"]);
const LOCKED_TASK = new Set([
	"preparing",
	"running",
	"completed",
	"ready_to_merge",
	"merge_conflict",
]);

function parseList(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

export class AutomationService {
	private busy = new Map<string, Promise<unknown>>();
	private sessions = new Map<string, string>();
	constructor(
		private readonly store: PlanRepository,
		private readonly repos: Repos,
		private readonly tasks: TaskOrchestrator,
		private readonly runtime: AgentRuntime,
	) {}

	private launch(id: string, work: () => Promise<unknown>) {
		if (this.busy.has(id)) throw new Error("Plan operation is already active");
		const job = Promise.resolve()
			.then(work)
			.catch(async (error) => {
				if ((await this.store.get(id))?.cancelledAt) return;
				const message = error instanceof Error ? error.message : String(error);
				await this.store.update(id, {
					status: "failed",
					errorMessage: message,
				});
				await this.tasks.publishDaemonEvent({
					type: "plan.validation_failed",
					planId: id,
					message,
				});
			})
			.finally(() => {
				this.busy.delete(id);
				this.sessions.delete(id);
			});
		this.busy.set(id, job);
	}

	async idle(id: string) {
		await this.busy.get(id);
	}

	async createPlan(input: {
		projectId: string;
		sourceMessageId: string;
		message: string;
		sourceSessionId?: string;
		automationMode?: "review" | "auto-create" | "auto-start";
		model?: AgentModel;
	}): Promise<{ planId: string; status: PlanStatus }> {
		const project = await this.requireProject(input.projectId);
		const message = input.message.trim();
		if (!message) throw new Error("Plan message is required");
		const id = randomUUID();
		await this.store.create({
			id,
			projectId: project.id,
			sourceMessageId: input.sourceMessageId,
			sourceMessage: message,
			sourceSessionId: input.sourceSessionId,
			automationMode: input.automationMode,
			title: message.split("\n")[0]?.slice(0, 80) || "Untitled plan",
			summary: "",
		});
		await this.tasks.publishDaemonEvent({ type: "plan.created", planId: id });
		this.launch(id, () => this.generate(id, project, message, input.model));
		return { planId: id, status: "draft" };
	}

	private async generate(
		planId: string,
		project: ProjectRecord,
		message: string,
		model?: AgentModel,
	) {
		const context = await buildAutomationContext(project.path, project.name);
		const planner = new RuntimePlanner(this.runtime, project.path, "Loom planner", async sessionId => {
			this.sessions.set(planId, sessionId);
			if ((await this.requirePlan(planId)).cancelledAt) throw new Error("Plan cancelled");
		});
		const result = await planner.createPlan({
			projectId: project.id,
			message,
			context,
			model,
		});
		if ((await this.requirePlan(planId)).cancelledAt) return;
		await this.store.replaceTasks(planId, convertPlanTasks(result.tasks));
		await this.store.update(planId, {
			title: result.title,
			summary: result.summary,
			status: "validated",
			errorMessage: null,
		});
		await this.tasks.publishDaemonEvent({ type: "plan.validated", planId });
		const plan = await this.requirePlan(planId);
		if (plan.automationMode !== "review") {
			await this.store.update(planId, { status: "approved", approvedAt: new Date() });
			await this.tasks.publishDaemonEvent({ type: "plan.approved", planId });
			const conversion = await this.store.convert(planId, project.id, convertPlanTasks(result.tasks));
			await this.tasks.publishDaemonEvent({ type: "plan.converted", planId, taskIds: conversion.taskIds });
			await this.tasks.publishDaemonEvent({ type: "plan.tasksCreated", planId, taskIds: conversion.taskIds });
			if (plan.automationMode === "auto-start") await this.start(planId);
		}
	}

	async savePlan(
		planId: string,
		input: {
			title?: string;
			summary?: string;
			tasks: AutomationPlanTask[];
		},
	): Promise<void> {
		if (this.busy.has(planId))
			throw new Error("Plan operation is already active");
		const plan = await this.requirePlan(planId);
		if (plan.convertedAt || plan.cancelledAt || !["draft", "validated", "failed"].includes(plan.status))
			throw new Error("Plan is not editable");
		const validation = validateAutomationPlan({
			title: input.title ?? plan.title,
			summary: input.summary ?? plan.summary,
			tasks: input.tasks,
		});
		if (!validation.ok || !validation.plan)
			throw new Error(
				`Plan invalid: ${validation.issues.map((issue) => issue.message).join("; ")}`,
			);
		await this.store.replaceTasks(
			planId,
			convertPlanTasks(validation.plan.tasks),
		);
		await this.store.update(planId, {
			title: validation.plan.title,
			summary: validation.plan.summary,
			status: "validated",
			errorMessage: null,
		});
		await this.tasks.publishDaemonEvent({ type: "plan.validated", planId });
	}

	async validatePlan(planId: string) {
		const plan = await this.requirePlan(planId);
		const tasks = await this.store.planTasks(planId);
		return validateAutomationPlan({
			title: plan.title,
			summary: plan.summary,
			tasks: tasks.map((task) => ({
				key: task.key,
				title: task.title,
				description: task.description,
				priority: task.priority as AutomationPlanTask["priority"],
				dependencies: task.dependencies,
				acceptanceCriteria: task.acceptanceCriteria,
				suggestedFiles: task.suggestedFiles,
				...(task.parallelGroup ? { parallelGroup: task.parallelGroup } : {}),
			})),
		});
	}

	async approve(planId: string): Promise<void> {
		const plan = await this.requirePlan(planId);
		if (this.busy.has(planId))
			throw new Error("Plan operation is already active");
		if (plan.status !== "validated")
			throw new Error("Plan must be validated before approval");
		if (plan.approvedAt || plan.convertedAt)
			throw new Error("Plan was already approved");
		const validation = await this.validatePlan(planId);
		if (!validation.ok) throw new Error(`Plan invalid: ${validation.issues.map(i => i.message).join("; ")}`);
		await this.store.update(planId, {
			status: "approved",
			approvedAt: new Date(),
			errorMessage: null,
		});
		await this.tasks.publishDaemonEvent({ type: "plan.approved", planId });
	}

	async convert(
		planId: string,
	): Promise<{ taskIds: string[]; converted: boolean }> {
		const plan = await this.requirePlan(planId);
		if (this.busy.has(planId))
			throw new Error("Plan operation is already active");
		if (plan.status !== "approved" && !plan.convertedAt)
			throw new Error("Plan must be approved before conversion");
		const stored = await this.store.planTasks(planId);
		const result = await this.store.convert(
			plan.id,
			plan.projectId,
			convertPlanTasks(
				stored.map((task) => ({
					key: task.key,
					title: task.title,
					description: task.description,
					priority: task.priority as AutomationPlanTask["priority"],
					dependencies: task.dependencies,
					acceptanceCriteria: task.acceptanceCriteria,
					suggestedFiles: task.suggestedFiles,
					...(task.parallelGroup ? { parallelGroup: task.parallelGroup } : {}),
				})),
			),
		);
		if (result.converted) {
			await this.tasks.publishDaemonEvent({
				type: "plan.converted",
				planId,
				taskIds: result.taskIds,
			});
			await this.tasks.publishDaemonEvent({
				type: "plan.tasksCreated",
				planId,
				taskIds: result.taskIds,
			});
		}
		return result;
	}

	async start(planId: string): Promise<{ started: string[] }> {
		const plan = await this.requirePlan(planId);
		if (!plan.convertedAt) throw new Error("Convert the plan first");
		if (plan.cancelledAt) throw new Error("Plan was cancelled");
		if (plan.status === "completed") return { started: [] };
		await this.store.update(planId, { status: "executing", startedAt: plan.startedAt ?? new Date() });
		const rows = await projectTasks(this.repos, plan.projectId);
		const ready = rows.filter(
			(row) => row.planId === planId && row.status === "ready",
		);
		const started: string[] = [];
		for (const row of ready) {
			try {
				await this.tasks.enqueue(row.id);
				started.push(row.id);
			} catch (error) {
				if (!this.tasks.getScheduler().getState().running.some(t => t.taskId === row.id) && !this.tasks.getScheduler().getState().queued.some(t => t.taskId === row.id)) throw error;
			}
		}
		await this.tasks.publishDaemonEvent({
			type: "plan.started",
			planId,
			taskIds: started,
		});
		return { started };
	}

	async cancel(planId: string): Promise<void> {
		const plan = await this.requirePlan(planId);
		if (plan.status === "completed") throw new Error("Completed plans cannot be cancelled");
		await this.store.update(planId, {
			status: "failed",
			cancelledAt: new Date(),
			errorMessage: "Cancelled by user",
		});
		const sessionId = this.sessions.get(planId);
		if (sessionId) await this.runtime.abort(sessionId);
		for (const row of (await projectTasks(this.repos, plan.projectId)).filter(t => t.planId === planId))
			if (["ready", "blocked", "queued", "preparing", "running"].includes(row.status)) {
				if (["preparing", "running", "queued"].includes(row.status)) await this.tasks.cancel(row.id).catch(() => {});
				else await this.repos.tasks.update(row.id, { status: "cancelled" });
			}
	}

	async deletePlan(planId: string): Promise<void> {
		const plan = await this.requirePlan(planId);
		if (this.busy.has(planId))
			throw new Error("Plan is still working; cancel it before deleting");
		if (plan.convertedAt)
			throw new Error("This plan created Kanban tasks; delete those tasks first");
		const sessionId = this.sessions.get(planId);
		if (sessionId) await this.runtime.abort(sessionId).catch(() => {});
		await this.store.delete(planId);
	}

	async retryPlan(planId: string, model?: AgentModel) {
		const plan = await this.requirePlan(planId);
		if (plan.convertedAt || plan.status !== "failed" || !plan.sourceMessage) throw new Error("Only failed, unconverted plans with a saved brief can regenerate");
		if (this.busy.has(planId)) throw new Error("Plan operation is already active");
		const project = await this.requireProject(plan.projectId);
		await this.store.update(planId, { status: "draft", cancelledAt: null, errorMessage: null });
		this.launch(planId, () => this.generate(planId, project, plan.sourceMessage, model));
	}

	async detail(planId: string) {
		const plan = await this.requirePlan(planId);
		const draft = await this.store.planTasks(planId);
		const rows = (await projectTasks(this.repos, plan.projectId)).filter(
			(row) => row.planId === planId,
		);
		const byId = new Map(rows.map((row) => [row.id, row]));
		const tasks = await Promise.all(
			rows.map(async (row) => {
				const blockedBy: string[] = [];
				for (const dep of await this.store.dependencies(row.id)) {
					const upstream = byId.get(dep.dependsOnTaskId);
					if (upstream && upstream.status !== "completed")
						blockedBy.push(upstream.title);
				}
				return { ...row, blockedBy };
			}),
		);
		return {
			plan,
			draft,
			tasks,
			validation: await this.validatePlan(planId),
			progress: this.progress(rows),
		};
	}

	progress(rows: Array<{ status: string | null }>) {
		const total = rows.length;
		const count = (status: string) =>
			rows.filter((row) => row.status === status).length;
		const done = count("completed");
		return {
			total,
			done,
			running: rows.filter((row) =>
				["preparing", "running"].includes(row.status ?? ""),
			).length,
			ready: count("ready"),
			blocked: count("blocked"),
			failed: rows.filter((row) =>
				["failed", "cancelled"].includes(row.status ?? ""),
			).length,
			percent: total ? Math.round((done / total) * 100) : 0,
		};
	}

	hooks(): TaskLifecycleHooks {
		return {
			canRun: async (taskId) => {
				const task = await this.repos.tasks.getById(taskId);
				if (!task?.planId) return true;
				if ((await this.store.get(task.planId))?.cancelledAt) return false;
				if (task.status !== "ready") return false;
				for (const dep of await this.store.dependencies(taskId))
					if (
						(await this.repos.tasks.getById(dep.dependsOnTaskId))?.status !==
						"completed"
					)
						return false;
				return true;
			},
			prepare: async (task, workspace) => {
				if (!task.planId) return task.prompt;
				await this.store.update(task.planId, { status: "executing" });
				for (const dependency of await this.store.dependencies(task.id)) {
					const upstream = await this.repos.workspaces.getByTaskId(dependency.dependsOnTaskId);
					if (!upstream) throw new Error("Dependency workspace not found; cannot inherit its changes");
					await git(workspace.path, "merge", "--no-edit", "--no-ff", "--", upstream.branch);
				}
				const files = parseList(task.suggestedFiles);
				if (!files.length) return task.prompt;
				return `${task.prompt}\n\nSuggested files: ${files.join(", ")}`;
			},
			complete: async (task, workspace) => {
				if (task.planId) await snapshotWorkspace(workspace.path, `Complete task: ${task.title}`);
			},
			settled: (taskId) => this.unlockDependents(taskId),
			guard: async (taskId, action) => {
				const task = await this.repos.tasks.getById(taskId);
				if (!task?.planId) return;
				if (action === "retry") {
					if ((await this.store.get(task.planId))?.cancelledAt) throw new Error("Plan was cancelled");
					for (const dep of await this.store.dependencies(taskId))
						if ((await this.repos.tasks.getById(dep.dependsOnTaskId))?.status !== "completed") throw new Error("Retry dependencies first");
				}
				if (action === "remove") {
					if (LOCKED_TASK.has(task.status ?? ""))
						throw new Error(
							`Plan tasks cannot be deleted while ${task.status}; manage them from the plan`,
						);
					const dependents = await this.store.dependents(taskId);
					if (dependents.length)
						throw new Error(
							"Remove or reassign dependent tasks before deleting this task",
						);
				}
			},
		};
	}

	private async unlockDependents(taskId: string): Promise<void> {
		const task = await this.repos.tasks.getById(taskId);
		if (!task?.planId) return;
		const plan = await this.requirePlan(task.planId);
		if (plan.cancelledAt) return;
		if (!TERMINAL_TASK.has(task.status ?? "")) return;
		if (task.status !== "completed") return;
		for (const link of await this.store.dependents(taskId)) {
			const dependent = await this.repos.tasks.getById(link.taskId);
			if (dependent?.status !== "blocked") continue;
			const deps = await this.store.dependencies(dependent.id);
			const states = await Promise.all(
				deps.map((dep) => this.repos.tasks.getById(dep.dependsOnTaskId)),
			);
			if (!states.every((row) => row?.status === "completed")) continue;
			await this.repos.tasks.update(dependent.id, { status: "ready" });
			await this.tasks.publishDaemonEvent({
				type: "task.ready",
				taskId: dependent.id,
			});
			await this.tasks.publishDaemonEvent({
				type: "task.unblocked",
				taskId: dependent.id,
				unblockedBy: taskId,
			});
			try {
				if (plan.startedAt) await this.tasks.enqueue(dependent.id);
			} catch {
				// Already scheduled; the scheduler gate decides.
			}
		}
		const remaining = (await projectTasks(this.repos, task.projectId)).filter(
			(row) => row.planId === task.planId,
		);
		if (
			remaining.length &&
			remaining.every((row) => row.status === "completed")
		)
			await this.store.update(task.planId, { status: "completed" });
	}

	async recover(): Promise<void> {
		for (const plan of await this.store.all()) {
			if (plan.status === "draft") {
				await this.store.update(plan.id, { status: "failed", errorMessage: "Planner interrupted by daemon restart. Regenerate from the saved brief." });
				continue;
			}
			if (plan.cancelledAt) continue;
			if (plan.convertedAt && !plan.startedAt && plan.status === "executing") {
				await this.store.update(plan.id, { status: "approved" });
				continue;
			}
			if (plan.status !== "executing") continue;
			const rows = (await projectTasks(this.repos, plan.projectId)).filter(
				(row) => row.planId === plan.id,
			);
			for (const row of rows)
				if (row.status === "ready")
					await this.tasks.enqueue(row.id).catch(() => {});
			for (const row of rows)
				if (TERMINAL_TASK.has(row.status ?? ""))
					await this.unlockDependents(row.id);
		}
	}

	private async requirePlan(id: string) {
		const plan = await this.store.get(id);
		if (!plan) throw new Error("Plan not found");
		return plan;
	}

	private async requireProject(id: string) {
		const project = await this.repos.projects.getById(id);
		if (!project) throw new Error("Project not found");
		return project;
	}

	async planTaskList(planId: string): Promise<PlanTaskRecord[]> {
		await this.requirePlan(planId);
		return this.store.planTasks(planId);
	}

	async list(projectId: string) {
		const plans = await this.store.listByProject(projectId);
		return Promise.all(
			plans.map(async (plan) => ({
				...plan,
				progress: this.progress(
					(await this.repos.tasks.listByProject(plan.projectId)).filter(
						(row) => row.planId === plan.id,
					),
				),
			})),
		);
	}
}
