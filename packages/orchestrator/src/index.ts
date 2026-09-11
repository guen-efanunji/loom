import { randomUUID } from "node:crypto";

import type {
	CreateTask,
	ProjectRecord,
	TaskRecord,
	WorkspaceRecord,
} from "@loom/db";
import type { AgentRuntime } from "@loom/opencode";
import {
	type CreateTaskInput,
	canTransitionTaskStatus,
	type DaemonEvent,
	type Task,
	type TaskStatus,
} from "@loom/protocol";
import type {
	WorktreeManager,
	Workspace as WorktreeWorkspace,
} from "@loom/worktree";

export type TaskRepository = {
	create(input: CreateTask): Promise<TaskRecord>;
	getById(id: string): Promise<TaskRecord | undefined>;
	list?(): Promise<TaskRecord[]>;
	update(id: string, input: Partial<CreateTask>): Promise<TaskRecord[]>;
};

export type ProjectRepository = {
	getById(id: string): Promise<ProjectRecord | undefined>;
};

export type WorkspaceRepository = {
	create(input: {
		id?: string;
		taskId: string;
		projectId: string;
		path: string;
		branch: string;
		baseCommit: string;
	}): Promise<WorkspaceRecord>;
	getById(id: string): Promise<WorkspaceRecord | undefined>;
	getByTaskId(taskId: string): Promise<WorkspaceRecord | undefined>;
	delete?(id: string): Promise<unknown>;
};

export type AgentRunRepository = {
	create(input: {
		id?: string;
		taskId: string;
		sessionId?: string | null;
		status?: string;
		startedAt?: Date | null;
		completedAt?: Date | null;
	}): Promise<{ id: string }>;
	getByTaskId?(taskId: string): Promise<{ id: string } | undefined>;
	update(
		id: string,
		input: Partial<{
			sessionId: string | null;
			status: string;
			startedAt: Date | null;
			completedAt: Date | null;
		}>,
	): Promise<unknown>;
};

export type EventPublisher = {
	publish(event: DaemonEvent): Promise<void> | void;
};

export type OrchestratorDependencies = {
	tasks: TaskRepository;
	projects: ProjectRepository;
	workspaces: WorkspaceRepository;
	agentRuns?: AgentRunRepository;
	worktree: WorktreeManagerLike;
	runtime: AgentRuntime;
	events?: EventPublisher;
	now?: () => Date;
	id?: () => string;
};

export type WorktreeManagerLike = Pick<
	WorktreeManager,
	"create" | "remove" | "discard" | "merge" | "diff"
>;

export class TaskOrchestrator {
	private readonly active = new Set<string>();
	private readonly tasksById = new Map<string, TaskRecord>();
	private readonly now: () => Date;
	private readonly id: () => string;

	constructor(private readonly dependencies: OrchestratorDependencies) {
		this.now = dependencies.now ?? (() => new Date());
		this.id = dependencies.id ?? randomUUID;
	}

	async reconcile(): Promise<void> {
		this.active.clear();
		if (!this.dependencies.tasks.list) return;
		for (const task of await this.dependencies.tasks.list()) {
			if (task.status === "preparing" || task.status === "running") {
				await this.dependencies.tasks.update(task.id, {
					status: "failed",
					completedAt: this.now(),
					errorMessage: "Task interrupted while the daemon was restarting",
				});
			}
		}
	}

	async create(input: CreateTaskInput): Promise<Task> {
		const project = await this.dependencies.projects.getById(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);
		const record = await this.dependencies.tasks.create({
			id: this.id(),
			projectId: input.projectId,
			title: input.title,
			prompt: input.prompt,
			status: "queued",
			workspaceId: null,
			sessionId: null,
			startedAt: null,
			completedAt: null,
		});
		this.tasksById.set(record.id, record);
		const task = toTask(record);
		await this.publish({ type: "task.created", task });
		return task;
	}

	async start(taskId: string): Promise<void> {
		if (this.active.size > 0) throw new Error("Another task is already active");
		const record = await this.requireTask(taskId);
		if (record.status !== "queued")
			throw new Error(`Task cannot start from ${record.status}`);
		this.active.add(taskId);
		let agentRunId: string | undefined;
		try {
			const project = await this.requireProject(record.projectId);
			await this.transition(record, "preparing");
			record.status = "preparing";
			const workspace = await this.dependencies.worktree.create({
				projectPath: project.path,
				projectId: project.id,
				taskId: record.id,
			});
			await this.dependencies.workspaces.create({
				id: workspace.id,
				taskId: record.id,
				projectId: project.id,
				path: workspace.path,
				branch: workspace.branch,
				baseCommit: workspace.baseCommit,
			});
			const session = await this.dependencies.runtime.createSession({
				cwd: workspace.path,
				title: record.title,
			});
			const startedAt = this.now();
			const agentRun = await this.dependencies.agentRuns?.create({
				taskId: record.id,
				sessionId: session.id,
				status: "running",
				startedAt,
			});
			agentRunId = agentRun?.id;
			await this.dependencies.tasks.update(record.id, {
				workspaceId: workspace.id,
				sessionId: session.id,
				startedAt,
			});
			record.status = "preparing";
			await this.transition(record, "running", {
				workspaceId: workspace.id,
				sessionId: session.id,
				startedAt,
			});
			record.status = "running";
			await this.dependencies.runtime.prompt({
				sessionId: session.id,
				prompt: record.prompt,
			});
			const terminalStatus = await this.dependencies.runtime.wait(session.id);
			if (terminalStatus !== "completed") {
				throw new Error(`Agent run ended with status: ${terminalStatus}`);
			}
			if (agentRunId)
				await this.dependencies.agentRuns?.update(agentRunId, {
					status: "completed",
					completedAt: this.now(),
				});
			await this.finish(record.id, "completed");
		} catch (error) {
			if (agentRunId)
				await this.dependencies.agentRuns?.update(agentRunId, {
					status: "failed",
					completedAt: this.now(),
				});
			else if (this.dependencies.agentRuns?.getByTaskId) {
				const run = await this.dependencies.agentRuns.getByTaskId(taskId);
				if (run)
					await this.dependencies.agentRuns.update(run.id, {
						status: "failed",
						completedAt: this.now(),
					});
			}
			await this.fail(taskId, error);
			throw error;
		} finally {
			this.active.delete(taskId);
		}
	}

	async cancel(taskId: string): Promise<void> {
		const record = await this.requireTask(taskId);
		if (record.status === "cancelled") return;
		if (!canTransitionTaskStatus(record.status as TaskStatus, "cancelled"))
			throw new Error(`Task cannot cancel from ${record.status}`);
		if (record.sessionId)
			await this.dependencies.runtime.abort(record.sessionId);
		const workspace = record.workspaceId
			? await this.dependencies.workspaces.getById(record.workspaceId)
			: undefined;
		if (workspace) await this.safeDiscard(workspace, record.id);
		await this.transition(record, "cancelled", { completedAt: this.now() });
		this.active.delete(taskId);
	}

	async diff(taskId: string): Promise<string> {
		const record = await this.requireTask(taskId);
		const workspace = await this.requireWorkspace(record);
		return this.dependencies.worktree.diff(
			toWorktreeWorkspace(
				workspace,
				await this.requireProject(record.projectId),
			),
		);
	}

	async merge(taskId: string): Promise<void> {
		const record = await this.requireTask(taskId);
		const workspace = await this.requireWorkspace(record);
		await this.dependencies.worktree.merge(
			toWorktreeWorkspace(
				workspace,
				await this.requireProject(record.projectId),
			),
		);
		if (this.dependencies.workspaces.delete)
			await this.dependencies.workspaces.delete(workspace.id);
		await this.publish({ type: "task.merged", taskId });
	}

	async discard(taskId: string): Promise<void> {
		const record = await this.requireTask(taskId);
		const workspace = await this.requireWorkspace(record);
		await this.dependencies.worktree.discard(
			toWorktreeWorkspace(
				workspace,
				await this.requireProject(record.projectId),
			),
		);
		if (this.dependencies.workspaces.delete)
			await this.dependencies.workspaces.delete(workspace.id);
		await this.publish({ type: "task.discarded", taskId });
	}

	private async finish(taskId: string, status: "completed"): Promise<void> {
		const record = await this.requireTask(taskId);
		await this.transition(record, status, { completedAt: this.now() });
	}

	private async fail(taskId: string, error: unknown): Promise<void> {
		const record = await this.requireTask(taskId);
		const message = error instanceof Error ? error.message : String(error);
		if (canTransitionTaskStatus(record.status as TaskStatus, "failed")) {
			await this.transition(record, "failed", {
				completedAt: this.now(),
				errorMessage: message,
			});
		}
	}

	private async transition(
		record: TaskRecord,
		status: TaskStatus,
		extra: Partial<CreateTask> = {},
	): Promise<void> {
		if (!canTransitionTaskStatus(record.status as TaskStatus, status))
			throw new Error(
				`Invalid task status transition: ${record.status} -> ${status}`,
			);
		const rows = await this.dependencies.tasks.update(record.id, {
			...extra,
			status,
		});
		const updated = rows[0] ?? { ...record, ...extra, status };
		this.tasksById.set(record.id, updated);
		if (status === "running")
			await this.publish({ type: "task.started", taskId: record.id });
		if (status === "completed")
			await this.publish({ type: "task.completed", taskId: record.id });
		if (status === "failed")
			await this.publish({
				type: "task.failed",
				taskId: record.id,
				message: updated.errorMessage ?? "Task execution failed",
			});
		if (status === "cancelled")
			await this.publish({ type: "task.cancelled", taskId: record.id });
		await this.publish({ type: "task.updated", task: toTask(updated) });
	}

	private async safeDiscard(
		workspace: WorkspaceRecord,
		taskId: string,
	): Promise<void> {
		try {
			await this.dependencies.worktree.discard(
				toWorktreeWorkspace(
					workspace,
					await this.requireProject((await this.requireTask(taskId)).projectId),
				),
			);
		} catch {}
	}

	private async publish(event: DaemonEvent): Promise<void> {
		await this.dependencies.events?.publish(event);
	}

	private async requireTask(id: string): Promise<TaskRecord> {
		const task = await this.dependencies.tasks.getById(id);
		if (!task) throw new Error(`Task not found: ${id}`);
		this.tasksById.set(id, task);
		return task;
	}

	private async requireProject(id: string): Promise<ProjectRecord> {
		const project = await this.dependencies.projects.getById(id);
		if (!project) throw new Error(`Project not found: ${id}`);
		return project;
	}

	private async requireWorkspace(task: TaskRecord): Promise<WorkspaceRecord> {
		const workspace = task.workspaceId
			? await this.dependencies.workspaces.getById(task.workspaceId)
			: await this.dependencies.workspaces.getByTaskId(task.id);
		if (!workspace) throw new Error(`Workspace not found for task: ${task.id}`);
		return workspace;
	}
}

function toTask(record: TaskRecord): Task {
	return {
		id: record.id,
		projectId: record.projectId,
		title: record.title,
		prompt: record.prompt,
		status: record.status as Task["status"],
		workspaceId: record.workspaceId,
		sessionId: record.sessionId,
		createdAt: record.createdAt.toISOString(),
		startedAt: record.startedAt?.toISOString() ?? null,
		completedAt: record.completedAt?.toISOString() ?? null,
	};
}

function toWorktreeWorkspace(
	record: WorkspaceRecord,
	project: ProjectRecord,
): WorktreeWorkspace {
	return {
		id: record.id,
		taskId: record.taskId,
		projectId: record.projectId,
		projectPath: project.path,
		path: record.path,
		branch: record.branch,
		baseCommit: record.baseCommit,
		createdAt: record.createdAt.toISOString(),
	};
}
