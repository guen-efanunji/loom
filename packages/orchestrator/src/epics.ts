import { randomUUID } from "node:crypto";
import type { OrchestrationRepository, repositories } from "@loom/db";
import type { AgentRuntime } from "@loom/opencode";
import {
	artifactInputSchema,
	type ProjectContext,
	projectContextSchema,
	type TaskArtifact,
	type TaskPlan,
} from "@loom/protocol";
import type { Workspace, WorktreeManager } from "@loom/worktree";
import { git, snapshotWorkspace } from "./commands";
import {
	buildProjectContext,
	ContextBuilder,
	collectTaskArtifacts,
	readProjectFile,
} from "./context";
import { validatePlan } from "./graph";
import type { TaskLifecycleHooks, TaskOrchestrator } from "./index";
import { approveIntegration, IntegrationCoordinator } from "./integration";
import { RuntimePlanner } from "./planner";

type Repos = ReturnType<typeof repositories>;
export class EpicService {
	private busy = new Map<string, Promise<unknown>>();
	private settling: Promise<void> = Promise.resolve();
	constructor(
		private store: OrchestrationRepository,
		private repos: Repos,
		private tasks: TaskOrchestrator,
		private runtime: AgentRuntime,
		private worktree: WorktreeManager,
		private contextCache?: string,
	) {}

	private launch(id: string, work: () => Promise<unknown>) {
		if (this.busy.has(id)) throw new Error("Epic operation is already active");
		const job = Promise.resolve()
			.then(work)
			.catch(async (error) => {
				const message = error instanceof Error ? error.message : String(error);
				await this.store.update(id, {
					status: "failed",
					errorMessage: message,
				});
				await this.store.audit(id, "epic.failed", message);
			})
			.finally(() => {
				this.busy.delete(id);
			});
		this.busy.set(id, job);
	}
	async idle(id: string) {
		await this.busy.get(id);
	}
	async create(input: { projectId: string; title: string; goal: string }) {
		const project = await this.repos.projects.getById(input.projectId);
		if (!project) throw new Error("Project not found");
		const id = randomUUID();
		await this.store.create({
			id,
			projectId: project.id,
			title: input.title,
			prompt: input.goal,
			status: "planning",
		});
		this.launch(id, () => this.plan(id));
		return { id };
	}
	private async plan(id: string) {
		const epic = await this.requireEpic(id);
		const project = await this.requireProject(epic.projectId);
		const runId = randomUUID();
		await this.store.createPlannerRun({
			id: runId,
			epicId: id,
			status: "running",
		});
		await this.store.audit(id, "planner.created", epic.prompt);
		try {
			const context = await buildProjectContext(project, this.contextCache);
			await this.store.update(id, {
				context: JSON.stringify(context),
				status: "planning",
				errorMessage: null,
			});
			const planner = new RuntimePlanner(
				this.runtime,
				project.path,
				async (sessionId) => {
					await this.store.updatePlannerRun(runId, { sessionId });
				},
			);
			const plan = await planner.plan({
				projectId: project.id,
				goal: epic.prompt,
				context,
			});
			await this.store.update(id, {
				plan: JSON.stringify(plan),
				status: "ready",
			});
			await this.store.updatePlannerRun(runId, { status: "completed" });
		} catch (error) {
			await this.store.updatePlannerRun(runId, {
				status: "failed",
				errorMessage: String(error),
			});
			throw error;
		}
	}
	async replan(id: string) {
		const epic = await this.requireEpic(id);
		if (epic.approvedAt)
			throw new Error("Approved plans cannot be regenerated");
		this.launch(id, () => this.plan(id));
	}
	async save(id: string, plan: TaskPlan, context?: ProjectContext) {
		if (this.busy.has(id)) throw new Error("Epic operation is already active");
		const epic = await this.requireEpic(id);
		if (epic.approvedAt || !["ready", "failed"].includes(epic.status))
			throw new Error("Epic plan is not editable");
		validatePlan(plan);
		const saved = await this.store.savePlan(id, {
			plan: JSON.stringify(plan),
			...(context
				? { context: JSON.stringify(projectContextSchema.parse(context)) }
				: {}),
		});
		if (!saved.length) throw new Error("Epic plan is no longer editable");
	}
	async start(id: string) {
		const epic = await this.requireEpic(id);
		if (this.busy.has(id) || !epic.plan || !epic.context)
			throw new Error("Epic is not ready to start");
		await this.store.approve(
			id,
			epic.projectId,
			validatePlan(JSON.parse(epic.plan)),
			JSON.stringify(projectContextSchema.parse(JSON.parse(epic.context))),
		);
		for (const member of await this.store.members(id))
			await this.tasks.enqueue(member.taskId);
	}
	async integrate(id: string) {
		const epic = await this.requireEpic(id);
		if (!epic.approvedAt || epic.status === "completed")
			throw new Error("Epic cannot integrate from its current state");
		const members = await this.store.members(id);
		const rows = await Promise.all(
			members.map((m) => this.repos.tasks.getById(m.taskId)),
		);
		if (!rows.length || rows.some((t) => t?.status !== "completed"))
			throw new Error("All Epic tasks must complete before integration");
		const project = await this.requireProject(epic.projectId);
		const workspaces = await Promise.all(
			rows.map((t) => {
				if (!t) throw new Error("Task not found");
				return this.repos.workspaces.getByTaskId(t.id);
			}),
		);
		if (workspaces.some((w) => !w)) throw new Error("Task workspace not found");
		const context = projectContextSchema.parse(
			JSON.parse(epic.context ?? "null"),
		);
		const artifacts = await this.artifacts(members.map((m) => m.taskId));
		const runId = randomUUID();
		this.launch(id, async () => {
			await this.store.update(id, { status: "running", errorMessage: null });
			await this.store.createIntegration({
				id: runId,
				epicId: id,
				status: "merging",
			});
			await this.store.audit(id, "integration.started", runId);
			try {
				const result = await new IntegrationCoordinator(
					this.worktree,
					this.runtime,
				).integrate({
					id: runId,
					title: epic.title,
					project,
					branches: workspaces.map((w) => {
						if (!w) throw new Error("Workspace not found");
						return w.branch;
					}),
					context,
					artifacts,
					onUpdate: async (r) => {
						await this.store.updateIntegration(runId, {
							status: r.status,
							workspacePath: r.workspace.path,
							branch: r.workspace.branch,
							baseCommit: r.workspace.baseCommit,
							head: r.head,
							diff: r.diff,
							checks: JSON.stringify(r.checks),
							sessionId: r.sessionId,
							errorMessage: r.errorMessage,
						});
					},
				});
				await this.store.update(id, {
					status: result.status === "failed" ? "failed" : "running",
					errorMessage: result.errorMessage,
				});
				await this.store.audit(
					id,
					result.status === "failed"
						? "integration.failed"
						: "integration.completed",
					result.errorMessage ?? runId,
				);
			} catch (error) {
				await this.store.updateIntegration(runId, {
					status: "failed",
					errorMessage: String(error),
				});
				await this.store.audit(id, "integration.failed", String(error));
				throw error;
			}
		});
		return { id: runId };
	}
	async approve(runId: string, reviewedHead: string) {
		const run = await this.store.integration(runId);
		if (
			run?.status !== "review" ||
			!run.workspacePath ||
			!run.branch ||
			!run.baseCommit ||
			!run.head ||
			run.head !== reviewedHead
		)
			throw new Error("Integration is not ready for this approval");
		const epic = await this.requireEpic(run.epicId);
		if (this.busy.has(epic.id) || epic.status === "completed")
			throw new Error("Epic operation is already active or completed");
		const latest = (await this.store.integrations(epic.id))[0];
		if (latest?.id !== runId)
			throw new Error("A newer integration exists; review it before approval");
		const project = await this.requireProject(epic.projectId);
		const workspace: Workspace = {
			id: `integration-${run.id}`,
			taskId: `integration-${run.id}`,
			projectId: project.id,
			projectPath: project.path,
			path: run.workspacePath,
			branch: run.branch,
			baseCommit: run.baseCommit,
			createdAt: run.createdAt.toISOString(),
			owner: "loom",
		};
		// Hold the epic lock through the checked merge, including concurrent approval requests.
		const job = approveIntegration(this.worktree, workspace, run.head);
		this.busy.set(epic.id, job);
		try {
			await job;
			await this.store.updateIntegration(run.id, {
				status: "completed",
				approvedAt: new Date(),
			});
			await this.store.update(epic.id, {
				status: "completed",
				errorMessage: null,
			});
			await this.store.audit(epic.id, "integration.approved", run.id);
		} finally {
			this.busy.delete(epic.id);
		}
	}
	async detail(id: string) {
		const epic = await this.requireEpic(id);
		const members = await this.store.members(id);
		const rows = await Promise.all(
			members.map(async (m) => {
				const task = await this.repos.tasks.getById(m.taskId);
				const deps = await this.store.dependencies(m.taskId);
				const blockedBy: string[] = [];
				for (const dep of deps)
					if (
						(await this.repos.tasks.getById(dep.dependsOnTaskId))?.status !==
						"completed"
					)
						blockedBy.push(
							members.find((x) => x.taskId === dep.dependsOnTaskId)?.key ??
								dep.dependsOnTaskId,
						);
				return {
					...m,
					task: task
						? { ...task, epicId: id, integrated: epic.status === "completed" }
						: null,
					blockedBy,
				};
			}),
		);
		return {
			...epic,
			plan: epic.plan ? validatePlan(JSON.parse(epic.plan)) : null,
			context: epic.context
				? projectContextSchema.parse(JSON.parse(epic.context))
				: null,
			tasks: rows,
			artifacts: await this.artifacts(members.map((m) => m.taskId)),
			integrations: (await this.store.integrations(id)).map((r) => ({
				...r,
				checks: JSON.parse(r.checks),
			})),
			events: await this.store.events(id),
			plannerRuns: await this.store.plannerRuns(id),
		};
	}
	async artifacts(ids: string[]): Promise<TaskArtifact[]> {
		return (await this.store.artifacts(ids)).map((a) => ({
			id: a.id,
			taskId: a.taskId,
			...artifactInputSchema.parse(a),
		}));
	}
	async taskMetadata(taskId: string) {
		const member = await this.store.membership(taskId);
		if (!member) return { epicId: null, blockedBy: [], integrated: false };
		const epic = await this.requireEpic(member.epicId);
		const blockedBy: string[] = [];
		for (const dep of await this.store.dependencies(taskId)) {
			const task = await this.repos.tasks.getById(dep.dependsOnTaskId);
			if (task?.status !== "completed")
				blockedBy.push(task?.title ?? dep.dependsOnTaskId);
		}
		return {
			epicId: epic.id,
			blockedBy,
			integrated: epic.status === "completed",
		};
	}
	async sessionScope(sessionId: string) {
		const task = (await this.repos.tasks.list()).find(
			(t) => t.sessionId === sessionId,
		);
		if (task) {
			const workspace = await this.repos.workspaces.getByTaskId(task.id);
			if (workspace)
				return { directory: workspace.path, projectId: task.projectId };
		}
		for (const epic of await this.store.all()) {
			const run = (await this.store.integrations(epic.id)).find(
				(r) => r.sessionId === sessionId,
			);
			if (run?.workspacePath)
				return { directory: run.workspacePath, projectId: epic.projectId };
		}
		return undefined;
	}
	async addArtifact(taskId: string, input: unknown) {
		const task = await this.repos.tasks.getById(taskId);
		const workspace = await this.repos.workspaces.getByTaskId(taskId);
		if (!task || !workspace) throw new Error("Task workspace not found");
		const artifact = artifactInputSchema.parse(input);
		await readProjectFile(workspace.path, artifact.path, 1);
		const result = { ...artifact, taskId, id: randomUUID() };
		await this.store.addArtifact(result);
		const member = await this.store.membership(taskId);
		if (member)
			await this.store.audit(
				member.epicId,
				"artifact.created",
				JSON.stringify(result),
			);
		return result;
	}
	hooks(): TaskLifecycleHooks {
		return {
			canRun: async (taskId) => {
				const member = await this.store.membership(taskId);
				if (!member) return true;
				const epic = await this.requireEpic(member.epicId);
				if (!epic.approvedAt || !["running", "failed"].includes(epic.status))
					return false;
				for (const dep of await this.store.dependencies(taskId))
					if (
						(await this.repos.tasks.getById(dep.dependsOnTaskId))?.status !==
						"completed"
					)
						return false;
				return true;
			},
			prepare: async (task, workspace) => {
				const member = await this.store.membership(task.id);
				if (!member) return task.prompt;
				const epic = await this.requireEpic(member.epicId);
				const deps = await this.store.dependencies(task.id);
				const depTasks = [];
				for (const dep of deps) {
					const row = await this.repos.tasks.getById(dep.dependsOnTaskId);
					const previous = await this.repos.workspaces.getByTaskId(
						dep.dependsOnTaskId,
					);
					if (!row || !previous)
						throw new Error("Dependency workspace not found");
					await git(
						workspace.path,
						"merge",
						"--no-edit",
						"--no-ff",
						"--",
						previous.branch,
					);
					depTasks.push({ title: row.title, status: row.status });
				}
				await this.store.audit(epic.id, "task.started", task.id);
				return new ContextBuilder().build({
					prompt: task.prompt,
					context: projectContextSchema.parse(
						JSON.parse(epic.context ?? "null"),
					),
					dependencies: depTasks,
					artifacts: await this.artifacts(deps.map((d) => d.dependsOnTaskId)),
				});
			},
			complete: async (task, workspace) => {
				const member = await this.store.membership(task.id);
				if (!member) return;
				const artifacts = await collectTaskArtifacts(task.id, workspace.path);
				await snapshotWorkspace(workspace.path, `Complete task: ${task.title}`);
				await this.store.replaceArtifacts(task.id, artifacts);
				for (const artifact of artifacts)
					await this.store.audit(
						member.epicId,
						"artifact.created",
						JSON.stringify(artifact),
					);
				await this.store.audit(member.epicId, "task.completed", task.id);
			},
			settled: (taskId) => {
				const operation = this.settling.then(async () => {
					const member = await this.store.membership(taskId);
					if (!member) return;
					const rows = await Promise.all(
						(await this.store.members(member.epicId)).map((m) =>
							this.repos.tasks.getById(m.taskId),
						),
					);
					if (
						rows.some((t) => ["failed", "cancelled"].includes(t?.status ?? ""))
					)
						await this.store.update(member.epicId, {
							status: "failed",
							errorMessage:
								"A task failed or was cancelled; retry it to unblock dependents",
						});
					else if (
						rows.every((t) => t?.status === "completed") &&
						!this.busy.has(member.epicId) &&
						!(await this.store.integrations(member.epicId)).length
					)
						await this.integrate(member.epicId);
				});
				this.settling = operation.catch(() => {});
				return operation;
			},
			guard: async (taskId, action) => {
				const member = await this.store.membership(taskId);
				if (!member) return;
				if (action !== "retry")
					throw new Error(
						"Epic task workspaces are retained for integration; use the Epic review",
					);
				if (
					this.busy.has(member.epicId) ||
					(await this.requireEpic(member.epicId)).status === "completed"
				)
					throw new Error("Epic cannot retry now");
			},
		};
	}
	async recover() {
		for (const epic of await this.store.all()) {
			for (const run of await this.store.plannerRuns(epic.id))
				if (run.status === "running") {
					if (run.sessionId)
						await this.runtime.abort(run.sessionId).catch(() => {});
					await this.store.updatePlannerRun(run.id, {
						status: "failed",
						errorMessage: "Planner interrupted by daemon restart",
					});
					await this.store.update(epic.id, {
						status: "failed",
						errorMessage: "Planner interrupted; regenerate or edit the plan",
					});
				}
			for (const run of await this.store.integrations(epic.id))
				if (["merging", "checking", "resolving"].includes(run.status)) {
					if (run.sessionId)
						await this.runtime.abort(run.sessionId).catch(() => {});
					await this.store.updateIntegration(run.id, {
						status: "failed",
						errorMessage:
							"Integration interrupted; workspace preserved. Run integration again.",
					});
					await this.store.update(epic.id, {
						status: "failed",
						errorMessage: "Integration interrupted by daemon restart",
					});
				}
			if (epic.approvedAt && epic.status !== "completed") {
				const members = await this.store.members(epic.id);
				for (const member of members)
					if (
						(await this.repos.tasks.getById(member.taskId))?.status === "queued"
					)
						await this.tasks.enqueue(member.taskId);
				if (members[0]) await this.hooks().settled(members[0].taskId);
			}
		}
	}
	private async requireEpic(id: string) {
		const epic = await this.store.get(id);
		if (!epic) throw new Error("Epic not found");
		return epic;
	}
	private async requireProject(id: string) {
		const project = await this.repos.projects.getById(id);
		if (!project) throw new Error("Project not found");
		return project;
	}
}
