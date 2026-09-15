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
import type { AgentRuntime } from "@loom/opencode";
import type { AutomationPlanTask, PlanStatus } from "@loom/protocol";
import type { TaskLifecycleHooks, TaskOrchestrator } from "./index";

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
	}): Promise<{ planId: string; status: PlanStatus }> {
		const project = await this.requireProject(input.projectId);
		const message = input.message.trim();
		if (!message) throw new Error("Plan message is required");
		const id = randomUUID();
		await this.store.create({
			id,
			projectId: project.id,
			sourceMessageId: input.sourceMessageId,
			title: message.split("\n")[0]?.slice(0, 80) || "Untitled plan",
			summary: "",
		});
		await this.tasks.publishDaemonEvent({ type: "plan.created", planId: id });
		this.launch(id, () => this.generate(id, project, message));
		return { planId: id, status: "draft" };
	}

	private async generate(
		planId: string,
		project: ProjectRecord,
		message: string,
	) {
		const context = await buildAutomationContext(project.path, project.name);
		const planner = new RuntimePlanner(this.runtime, project.path);
		const result = await planner.createPlan({
			projectId: project.id,
			message,
			context,
		});
		await this.store.replaceTasks(planId, convertPlanTasks(result.tasks));
		await this.store.update(planId, {
			title: result.title,
			summary: result.summary,
			status: "validated",
			errorMessage: null,
		});
		await this.tasks.publishDaemonEvent({ type: "plan.validated", planId });
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
		if (!["draft", "validated", "failed"].includes(plan.status))
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
		const rows = await projectTasks(this.repos, plan.projectId);
		const ready = rows.filter(
			(row) => row.planId === planId && row.status === "ready",
		);
		const started: string[] = [];
		for (const row of ready) {
			try {
				await this.tasks.enqueue(row.id);
				started.push(row.id);
			} catch {
				// Already scheduled or blocked; the scheduler gate decides.
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
		if (!["draft", "validated", "approved"].includes(plan.status))
			throw new Error("Only unexecuted plans can be cancelled");
		await this.store.update(planId, {
			status: "failed",
			errorMessage: "Cancelled by user",
		});
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
				if (task.status !== "ready") return false;
				for (const dep of await this.store.dependencies(taskId))
					if (
						(await this.repos.tasks.getById(dep.dependsOnTaskId))?.status !==
						"completed"
					)
						return false;
				return true;
			},
			prepare: async (task) => {
				if (!task.planId) return task.prompt;
				const files = parseList(task.suggestedFiles);
				if (!files.length) return task.prompt;
				return `${task.prompt}\n\nSuggested files: ${files.join(", ")}`;
			},
			complete: async () => {},
			settled: (taskId) => this.unlockDependents(taskId),
			guard: async (taskId, action) => {
				const task = await this.repos.tasks.getById(taskId);
				if (!task?.planId) return;
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
				await this.tasks.enqueue(dependent.id);
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
