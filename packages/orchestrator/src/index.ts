import { randomUUID } from "node:crypto";
import type {
	AgentRunRecord,
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
	type PermissionDecision,
	type Task,
	type TaskStatus,
} from "@loom/protocol";
import {
	MergeConflictError,
	type WorktreeManager,
	type Workspace as WorktreeWorkspace,
} from "@loom/worktree";
import { boundOutput, createOutputLogger, type OutputLog } from "./output";
import {
	createScheduler,
	type Scheduler,
	type SchedulerConfig,
} from "./scheduler";

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
		errorMessage?: string | null;
		errorCode?: string | null;
		recoveryAction?: string | null;
		retryOfRunId?: string | null;
	}): Promise<AgentRunRecord>;
	getById?(id: string): Promise<AgentRunRecord | undefined>;
	getByTaskId?(taskId: string): Promise<AgentRunRecord | undefined>;
	listByTask?(taskId: string): Promise<AgentRunRecord[]>;
	listUnfinished?(): Promise<AgentRunRecord[]>;
	update(
		id: string,
		input: Partial<{
			sessionId: string | null;
			status: string;
			startedAt: Date | null;
			completedAt: Date | null;
			errorMessage: string | null;
			errorCode: string | null;
			recoveryAction: string | null;
			retryOfRunId: string | null;
		}>,
	): Promise<AgentRunRecord[]>;
};

export type PermissionRequestRecord = {
	id: string;
	taskId: string;
	runId: string;
	command: string;
	cwd: string;
	reason: string;
	status: string;
	createdAt: Date;
	decidedAt: Date | null;
};

export type PermissionRepository = {
	create(
		input: Omit<
			PermissionRequestRecord,
			"id" | "createdAt" | "decidedAt" | "status"
		> & { id?: string },
	): Promise<PermissionRequestRecord>;
	getById(id: string): Promise<PermissionRequestRecord | undefined>;
	listPending(): Promise<PermissionRequestRecord[]>;
	update(
		id: string,
		input: { status: string; decidedAt: Date },
	): Promise<PermissionRequestRecord[]>;
};

export type EventPublisher = {
	publish(event: DaemonEvent): Promise<void> | void;
};

export type TaskLifecycleHooks = {
 canRun(taskId: string): Promise<boolean>;
 prepare(task: TaskRecord, workspace: WorktreeWorkspace): Promise<string>;
 complete(task: TaskRecord, workspace: WorktreeWorkspace): Promise<void>;
 settled(taskId: string): Promise<void>;
 guard(taskId: string, action: "retry" | "merge" | "discard"): Promise<void>;
};

export type OrchestratorDependencies = {
	tasks: TaskRepository;
	projects: ProjectRepository;
	workspaces: WorkspaceRepository;
	agentRuns?: AgentRunRepository;
	permissionRequests?: PermissionRepository;
	worktree: WorktreeManagerLike;
	runtime: AgentRuntime;
	events?: EventPublisher;
	now?: () => Date;
	id?: () => string;
	schedulerConfig?: Partial<SchedulerConfig>;
	outputLog?: OutputLog;
	runTimeoutMs?: number;
};

export type WorktreeManagerLike = Pick<
	WorktreeManager,
	"create" | "remove" | "discard" | "merge" | "diff"
> & {
	preflightMerge?: WorktreeManager["preflightMerge"];
	findOrphans?: WorktreeManager["findOrphans"];
};

export type RecoveryState = {
	orphanWorkspaces: Array<{
		path: string;
		branch: string | null;
		reason: string;
	}>;
	interruptedRunIds: string[];
};

export class TaskOrchestrator {
	private readonly active = new Set<string>();
	private lifecycle?: TaskLifecycleHooks;
	setLifecycle(hooks: TaskLifecycleHooks) { this.lifecycle = hooks; }
	private readonly tasksById = new Map<string, TaskRecord>();
	private readonly now: () => Date;
	private readonly id: () => string;
	private readonly scheduler: Scheduler;
	private readonly outputLog: OutputLog;
	private sequence = 0;
	private mergeQueue: Promise<void> = Promise.resolve();
	private recoveryState: RecoveryState = {
		orphanWorkspaces: [],
		interruptedRunIds: [],
	};
	private readonly sessions = new Map<
		string,
		{ taskId: string; runId: string; cwd: string }
	>();

	constructor(private readonly dependencies: OrchestratorDependencies) {
		this.now = dependencies.now ?? (() => new Date());
		this.id = dependencies.id ?? randomUUID;
		this.outputLog = dependencies.outputLog ?? createOutputLogger();
		this.scheduler = createScheduler({
			config: dependencies.schedulerConfig,
			getProjectId: async (taskId) =>
				(await this.requireTask(taskId)).projectId,
			run: (taskId) => this.run(taskId),
			canRun: taskId => this.lifecycle?.canRun(taskId) ?? Promise.resolve(true),
			onChanged: (state) =>
				this.publish({
					type: "scheduler.changed",
					...state,
					sequence: ++this.sequence,
					timestamp: this.now().toISOString(),
				}),
		});
	}

	getScheduler(): Scheduler {
		return this.scheduler;
	}

	getRecoveryState(): RecoveryState {
		return {
			orphanWorkspaces: this.recoveryState.orphanWorkspaces.map((orphan) => ({
				...orphan,
			})),
			interruptedRunIds: [...this.recoveryState.interruptedRunIds],
		};
	}

	async getSnapshot() {
		const tasks = this.dependencies.tasks.list
			? await this.dependencies.tasks.list()
			: [];
		const runs = this.dependencies.agentRuns?.listUnfinished
			? await this.dependencies.agentRuns.listUnfinished()
			: [];
		return {
			tasks: tasks.map(toTask),
			runs: runs.map((run) => ({ ...run })),
			scheduler: this.scheduler.getState(),
			recovery: this.getRecoveryState(),
		};
	}

	async reconcile(): Promise<void> {
		this.active.clear();
		this.recoveryState = { orphanWorkspaces: [], interruptedRunIds: [] };
		const runs = this.dependencies.agentRuns?.listUnfinished
			? await this.dependencies.agentRuns.listUnfinished()
			: [];
		const tasks = this.dependencies.tasks.list
			? await this.dependencies.tasks.list()
			: [];
		const taskIds = tasks.map((task) => task.id);
		if (this.dependencies.worktree.findOrphans && tasks.length > 0) {
			const projectIds = [...new Set(tasks.map((task) => task.projectId))];
			for (const projectId of projectIds) {
				const orphans = await this.dependencies.worktree.findOrphans(
					projectId,
					taskIds,
				);
				this.recoveryState.orphanWorkspaces.push(...orphans);
			}
		}
		for (const run of runs) {
			const task = tasks.find((item) => item.id === run.taskId);
			const workspace = task?.workspaceId
				? await this.dependencies.workspaces.getById(task.workspaceId)
				: task
					? await this.dependencies.workspaces.getByTaskId(task.id)
					: undefined;
			let status: "running" | "queued" | "interrupted" =
				run.status === "queued" ? "queued" : "interrupted";
			let reason = "No task metadata is available for recovery";
			if (task && workspace && run.sessionId) {
				try {
					const runtimeStatus = await this.dependencies.runtime.status(
						run.sessionId,
					);
					if (
						runtimeStatus === "running" ||
						runtimeStatus === "waiting_permission"
					) {
						status = "running";
						reason = "OpenCode session is still active after daemon restart";
					} else if (
						runtimeStatus === "completed" ||
						runtimeStatus === "failed" ||
						runtimeStatus === "cancelled" ||
						runtimeStatus === "interrupted"
					) {
						status = "interrupted";
						reason = `OpenCode session reported ${runtimeStatus} during recovery`;
					}
				} catch {
					reason = "OpenCode session is unavailable after daemon restart";
				}
			} else if (task && !workspace) {
				reason = "Task workspace metadata or directory is unavailable";
			}
			if (status === "running" && task) {
				await this.scheduler.restore({
					taskId: task.id,
					projectId: task.projectId,
					state: "running",
				});
				this.active.add(task.id);
				continue;
			}
			if (status === "queued" && task) {
				await this.scheduler.restore({
					taskId: task.id,
					projectId: task.projectId,
					state: "queued",
				});
				continue;
			}
			const recoveryAction = workspace
				? "Review the preserved worktree, then retry the task"
				: "Restore the worktree or retry the task to create a new workspace";
			const extra = {
				status: "interrupted",
				completedAt: this.now(),
				errorMessage: `Agent run recovery failed: ${reason}`,
				errorCode: "RECOVERY_UNAVAILABLE",
				recoveryAction,
			};
			const rows = await this.dependencies.agentRuns?.update(run.id, extra);
			this.recoveryState.interruptedRunIds.push(run.id);
			if (rows?.[0]) await this.publishRun(rows[0], {});
			await this.publish({
				type: "run.interrupted",
				taskId: run.taskId,
				runId: run.id,
				reason,
				sequence: ++this.sequence,
				timestamp: this.now().toISOString(),
			});
		}
		await this.scheduler.dispatch();
		for (const task of tasks) {
			if (
				(task.status === "preparing" || task.status === "running") &&
				!runs.some((run) => run.taskId === task.id && run.status === "running")
			) {
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

	async retry(taskId: string): Promise<{ id: string }> {
		await this.lifecycle?.guard(taskId, "retry");
		const record = await this.requireTask(taskId);
		if (!["failed", "cancelled"].includes(record.status))
			throw new Error(`Task cannot retry from ${record.status}`);
		const previous = this.dependencies.agentRuns?.getByTaskId
			? await this.dependencies.agentRuns.getByTaskId(taskId)
			: undefined;
		if (record.workspaceId) {
			const workspace = await this.dependencies.workspaces.getById(
				record.workspaceId,
			);
			if (workspace) await this.safeDiscard(workspace, taskId);
			if (workspace && this.dependencies.workspaces.delete)
				await this.dependencies.workspaces.delete(workspace.id);
		}
		await this.dependencies.tasks.update(taskId, {
			status: "queued",
			workspaceId: null,
			sessionId: null,
			startedAt: null,
			completedAt: null,
			errorMessage: null,
		});
		const run = await this.dependencies.agentRuns?.create({
			taskId,
			status: "queued",
			retryOfRunId: previous?.id ?? null,
		});
		if (!run) throw new Error("Agent run repository is unavailable");
		await this.publishRun(run, {});
		await this.enqueue(taskId);
		return { id: run.id };
	}

	async requestPermission(input: {
		taskId: string;
		runId: string;
		command: string;
		cwd: string;
		reason: string;
	}): Promise<PermissionRequestRecord> {
		const repository = this.dependencies.permissionRequests;
		if (!repository) throw new Error("Permission repository is unavailable");
		const request = await repository.create(input);
		if (this.dependencies.agentRuns?.update) {
			await this.dependencies.agentRuns.update(input.runId, {
				status: "waiting_permission",
			});
		}
		await this.publish({
			type: "permission.requested",
			request: toPermissionRequest(request),
		});
		return request;
	}

	async listPendingPermissions(): Promise<PermissionRequestRecord[]> {
		if (!this.dependencies.permissionRequests) return [];
		return this.dependencies.permissionRequests.listPending();
	}

	async decidePermission(
		id: string,
		decision: PermissionDecision,
	): Promise<PermissionRequestRecord> {
		const repository = this.dependencies.permissionRequests;
		if (!repository) throw new Error("Permission repository is unavailable");
		const request = await repository.getById(id);
		if (!request) throw new Error(`Permission request not found: ${id}`);
		if (request.status !== "pending")
			throw new Error(`Permission request is already ${request.status}`);
		const rows = await repository.update(id, {
			status: decision,
			decidedAt: this.now(),
		});
		const updated = rows[0];
		if (!updated) throw new Error(`Permission request not found: ${id}`);
		await this.publish({
			type: "permission.updated",
			request: toPermissionRequest(updated),
		});
		return updated;
	}

	async listRuns(taskId: string): Promise<AgentRunRecord[]> {
		if (!this.dependencies.agentRuns?.listByTask)
			throw new Error("Agent run repository is unavailable");
		await this.requireTask(taskId);
		return this.dependencies.agentRuns.listByTask(taskId);
	}

	async output(
		taskId: string,
	): Promise<{ output: string; truncated: boolean }> {
		const task = await this.requireTask(taskId);
		if (!task.sessionId || !this.dependencies.runtime.readOutput)
			return { output: "", truncated: false };
		const result = await this.dependencies.runtime.readOutput(task.sessionId);
		return { output: result?.output ?? "", truncated: result?.truncated ?? false };
	}

	async start(taskId: string): Promise<void> {
		if (this.active.size > 0) throw new Error("Another task is already active");
		await this.run(taskId);
	}

	async enqueueAndWait(taskId: string): Promise<void> {
		await this.scheduler.enqueue(taskId);
		await this.scheduler.wait(taskId);
	}

	async enqueue(taskId: string): Promise<void> {
		await this.scheduler.enqueue(taskId);
	}

	private async run(taskId: string): Promise<void> {
		const record = await this.requireTask(taskId);
		if (record.status !== "queued")
			throw new Error(`Task cannot start from ${record.status}`);
		if (this.lifecycle && !(await this.lifecycle.canRun(taskId))) throw new Error("Task cannot start while dependencies or epic approval are pending");
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
				runId: this.id(),
			});
			await this.dependencies.workspaces.create({
				id: workspace.id,
				taskId: record.id,
				projectId: project.id,
				path: workspace.path,
				branch: workspace.branch,
				baseCommit: workspace.baseCommit,
			});
			const preparedPrompt = await this.lifecycle?.prepare(record, workspace) ?? record.prompt;
			if ((await this.requireTask(taskId)).status === "cancelled") throw new Error("Task cancelled during preparation");
			const session = await this.dependencies.runtime.createSession({
				cwd: workspace.path,
				title: record.title,
			});
			const startedAt = this.now();
			const existingRun = this.dependencies.agentRuns?.getByTaskId
				? await this.dependencies.agentRuns.getByTaskId(record.id)
				: undefined;
			const agentRun =
				existingRun?.status === "queued"
					? ((await this.dependencies.agentRuns?.update(existingRun.id, {
							sessionId: session.id,
							status: "running",
							startedAt,
						})) ?? [])[0]
					: await this.dependencies.agentRuns?.create({
							taskId: record.id,
							sessionId: session.id,
							status: "running",
							startedAt,
						});
			agentRunId = agentRun?.id;
			if (agentRun) {
				this.sessions.set(session.id, {
					taskId: record.id,
					runId: agentRun.id,
					cwd: workspace.path,
				});
				await this.publishRun(agentRun, {});
				await this.publish({
					type: "run.started",
					taskId: record.id,
					runId: agentRun.id,
					sessionId: session.id,
					cwd: workspace.path,
					sequence: ++this.sequence,
					timestamp: this.now().toISOString(),
				});
			}
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
				prompt: preparedPrompt,
			});
			const terminalStatus = await this.dependencies.runtime.wait(session.id, {
				timeoutMs: this.dependencies.runTimeoutMs,
			});
			const runtimeOutput = await this.dependencies.runtime.readOutput?.(
				session.id,
			);
			if (runtimeOutput?.output && agentRunId) {
				const bounded = boundOutput(runtimeOutput.output);
				await this.outputLog.write(record.id, agentRunId, runtimeOutput.output);
				await this.publish({
					type: "run.output",
					taskId: record.id,
					runId: agentRunId,
					output: bounded.output,
					truncated: bounded.truncated,
					sequence: ++this.sequence,
					timestamp: this.now().toISOString(),
				});
			}
			if (terminalStatus !== "completed") {
				throw new Error(`Agent run ended with status: ${terminalStatus}`);
			}
			await this.lifecycle?.complete(record, workspace);
			if (agentRunId) {
				const rows = await this.dependencies.agentRuns?.update(agentRunId, {
					status: "completed",
					completedAt: this.now(),
				});
				if (rows?.[0]) await this.publishRun(rows[0], {});
				await this.publish({
					type: "run.completed",
					taskId: record.id,
					runId: agentRunId,
					sequence: ++this.sequence,
					timestamp: this.now().toISOString(),
				});
			}
			await this.finish(record.id, "completed");
		} catch (error) {
			const currentTask = await this.requireTask(taskId);
			if (agentRunId && currentTask.status !== "cancelled") {
				const rows = await this.dependencies.agentRuns?.update(agentRunId, {
					status: "failed",
					completedAt: this.now(),
					errorMessage: error instanceof Error ? error.message : String(error),
					recoveryAction: "Retry the task to create a new agent run",
				});
				if (rows?.[0]) {
					await this.publishRun(rows[0], {});
					await this.publish({
						type: "run.failed",
						taskId,
						runId: agentRunId,
						message: rows[0].errorMessage ?? "Agent run failed",
						sequence: ++this.sequence,
						timestamp: this.now().toISOString(),
					});
				}
			} else if (agentRunId && currentTask.status === "cancelled") {
				await this.dependencies.agentRuns?.update(agentRunId, {
					status: "cancelled",
					completedAt: this.now(),
				});
			} else if (this.dependencies.agentRuns?.getByTaskId) {
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
			await this.lifecycle?.settled(taskId);
		}
	}

	async cancel(taskId: string): Promise<void> {
		const record = await this.requireTask(taskId);
		if (record.status === "cancelled") return;
		if (!canTransitionTaskStatus(record.status as TaskStatus, "cancelled"))
			throw new Error(`Task cannot cancel from ${record.status}`);
		await this.scheduler.cancel(taskId);
		await this.transition(record, "cancelled", { completedAt: this.now() });
		record.status = "cancelled";
		if (record.sessionId) {
			await this.dependencies.runtime.abort(record.sessionId);
			const run = this.dependencies.agentRuns?.getByTaskId
				? await this.dependencies.agentRuns.getByTaskId(taskId)
				: undefined;
			if (run) {
				const rows = await this.dependencies.agentRuns?.update(run.id, {
					status: "cancelled",
					completedAt: this.now(),
				});
				if (rows?.[0]) await this.publishRun(rows[0], {});
				await this.publish({
					type: "run.cancelled",
					taskId,
					runId: run.id,
					sequence: ++this.sequence,
					timestamp: this.now().toISOString(),
				});
			}
		}
		const workspace = record.workspaceId
			? await this.dependencies.workspaces.getById(record.workspaceId)
			: undefined;
		if (workspace) await this.safeDiscard(workspace, record.id);
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

	async merge(
		taskId: string,
	): Promise<
		| { merged: true; head: string }
		| { merged: false; conflict: { taskId: string; files: string[] } }
	> {
		await this.lifecycle?.guard(taskId, "merge");
		const operation = this.mergeQueue.then(() => this.mergeNow(taskId));
		this.mergeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private async mergeNow(
		taskId: string,
	): Promise<
		| { merged: true; head: string }
		| { merged: false; conflict: { taskId: string; files: string[] } }
	> {
		const record = await this.requireTask(taskId);
		if (record.status === "completed") {
			await this.dependencies.tasks.update(taskId, {
				status: "ready_to_merge",
			});
			record.status = "ready_to_merge";
		}
		if (record.status === "merge_conflict") {
			throw new Error("Task has unresolved merge conflicts");
		}
		if (record.status !== "ready_to_merge")
			throw new Error(`Task cannot merge from ${record.status}`);
		const workspace = await this.requireWorkspace(record);
		const project = await this.requireProject(record.projectId);
		const preflight = this.dependencies.worktree.preflightMerge
			? await this.dependencies.worktree.preflightMerge(
					toWorktreeWorkspace(workspace, project),
				)
			: undefined;
		try {
			await this.dependencies.worktree.merge(
				toWorktreeWorkspace(workspace, project),
				preflight?.head,
			);
		} catch (error) {
			if (error instanceof MergeConflictError) {
				const conflict = { taskId, files: error.files };
				await this.dependencies.tasks.update(taskId, {
					status: "merge_conflict",
					mergeConflictFiles: JSON.stringify(error.files),
				});
				await this.publish({
					type: "merge_conflict.detected",
					conflict,
					sequence: ++this.sequence,
					timestamp: this.now().toISOString(),
				});
				return { merged: false, conflict };
			}
			throw error;
		}
		if (this.dependencies.workspaces.delete)
			await this.dependencies.workspaces.delete(workspace.id);
		await this.dependencies.tasks.update(taskId, {
			status: "completed",
			mergeConflictFiles: null,
		});
		await this.publish({ type: "task.merged", taskId });
		return { merged: true, head: preflight?.head ?? "" };
	}

	async discard(taskId: string): Promise<void> {
		await this.lifecycle?.guard(taskId, "discard");
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

	private async publishRun(
		run: AgentRunRecord,
		extra: Partial<AgentRunRecord>,
	): Promise<void> {
		const current = { ...run, ...extra };
		await this.publish({
			type: "agent.run.updated",
			run: {
				id: current.id,
				taskId: current.taskId,
				sessionId: current.sessionId,
				status: current.status as
					| "queued"
					| "running"
					| "waiting_permission"
					| "completed"
					| "failed"
					| "cancelled"
					| "interrupted",
				startedAt: current.startedAt?.toISOString() ?? null,
				completedAt: current.completedAt?.toISOString() ?? null,
				errorMessage: current.errorMessage ?? null,
				errorCode: current.errorCode ?? null,
				recoveryAction: current.recoveryAction ?? null,
				retryOfRunId: current.retryOfRunId ?? null,
			},
		});
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

function toPermissionRequest(record: PermissionRequestRecord) {
	return {
		id: record.id,
		taskId: record.taskId,
		runId: record.runId,
		command: record.command,
		cwd: record.cwd,
		reason: record.reason,
		status: record.status as
			| "pending"
			| "allow_once"
			| "allow"
			| "deny"
			| "expired",
		createdAt: record.createdAt.toISOString(),
		decidedAt: record.decidedAt?.toISOString() ?? null,
	};
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
		owner: "loom",
	};
}
export * from "./graph";
export * from "./planner";
export * from "./context";
