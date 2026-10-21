import { createHash } from "node:crypto";
import { expect, mock, test } from "bun:test";

import type {
	AgentRunRecord,
	ProjectRecord,
	TaskRecord,
	WorkspaceRecord,
} from "@loom/db";
import type { AgentRuntime } from "@loom/opencode";
import { MockAgentRuntime } from "@loom/opencode";
import type { DaemonEvent } from "@loom/protocol";
import type {
	WorktreeManager,
	Workspace as WorktreeWorkspace,
} from "@loom/worktree";

import { TaskOrchestrator } from "../src/index";

const date = new Date("2026-01-01T00:00:00.000Z");

function dependencies(runtime: AgentRuntime = new MockAgentRuntime()) {
	const project: ProjectRecord = {
		id: "project-1",
		name: "Loom",
		path: "/repo",
		defaultBranch: "main",
		createdAt: date,
	};
	const tasks = new Map<string, TaskRecord>();
	const workspaces = new Map<string, WorkspaceRecord>();
	const runs = new Map<string, AgentRunRecord>();
	const reviews: Array<{
		taskId: string;
		baseSha: string;
		subjectSha: string;
		evidenceHash: string;
		status: string;
	}> = [];
	let reviewHead = "checkpoint-sha";
	let integratedCommit = false;
	const events: DaemonEvent[] = [];
	const projectRepository = { getById: mock(async () => project) };
	const taskRepository = {
		create: mock(async (input: TaskRecord) => {
			const task = { ...input, createdAt: date };
			tasks.set(task.id, task);
			return task;
		}),
		getById: mock(async (id: string) => tasks.get(id)),
		list: mock(async () => [...tasks.values()]),
		update: mock(async (id: string, input: Partial<TaskRecord>) => {
			const task = tasks.get(id);
			if (!task) return [];
			const updated = { ...task, ...input };
			tasks.set(id, updated);
			return [updated];
		}),
		delete: mock(async (id: string) => {
			tasks.delete(id);
		}),
	};
	const worktree: Pick<
		WorktreeManager,
		"create" | "remove" | "discard" | "merge" | "diff" | "isCommitIntegrated"
	> = {
		create: mock(
			async (): Promise<WorktreeWorkspace> => ({
				id: "workspace-1",
				taskId: "task-1",
				projectId: "project-1",
				projectPath: "/repo",
				path: "/home/user/.loom/worktrees/project-1/task-1",
				branch: "loom/task-1",
				baseCommit: "abc",
				createdAt: date.toISOString(),
			}),
		),
		remove: mock(async () => {}),
		discard: mock(async () => {}),
		merge: mock(async () => {}),
		isCommitIntegrated: mock(async () => integratedCommit),
		diff: mock(async () => "diff"),
		checkpoint: mock(async () => "checkpoint-sha"),
		inspectHead: mock(async () => ({ head: reviewHead, clean: true })),
	};
	const agentRunRepository = {
		create: mock(
			async (input: Partial<AgentRunRecord> & { taskId: string }) => {
				const run = {
					id: input.id ?? `run-${runs.size + 1}`,
					taskId: input.taskId,
					sessionId: input.sessionId ?? null,
					status: input.status ?? "queued",
					startedAt: input.startedAt ?? null,
					completedAt: input.completedAt ?? null,
					errorMessage: input.errorMessage ?? null,
					errorCode: input.errorCode ?? null,
					recoveryAction: input.recoveryAction ?? null,
					retryOfRunId: input.retryOfRunId ?? null,
					executorSnapshotJson: input.executorSnapshotJson ?? null,
					snapshotHash: input.snapshotHash ?? null,
					outputSha: input.outputSha ?? null,
					baseSha: input.baseSha ?? null,
				} as AgentRunRecord;
				runs.set(run.id, run);
				return run;
			},
		),
		getByTaskId: mock(async (taskId: string) =>
			[...runs.values()].reverse().find((run) => run.taskId === taskId),
		),
		listByTask: mock(async (taskId: string) =>
			[...runs.values()].filter((run) => run.taskId === taskId),
		),
		listUnfinished: mock(async () =>
			[...runs.values()].filter((run) =>
				["queued", "running", "waiting_permission"].includes(run.status),
			),
		),
		update: mock(async (id: string, input: Partial<AgentRunRecord>) => {
			const run = runs.get(id);
			if (!run) return [];
			const updated = { ...run, ...input };
			runs.set(id, updated);
			return [updated];
		}),
	};
	const workspaceRepository = {
		create: mock(async (input: WorkspaceRecord) => {
			const workspace = { ...input, createdAt: date };
			workspaces.set(workspace.id, workspace);
			return workspace;
		}),
		getById: mock(async (id: string) => workspaces.get(id)),
		getByTaskId: mock(async (taskId: string) =>
			[...workspaces.values()].find((workspace) => workspace.taskId === taskId),
		),
	};
	const reviewRepository = {
		create: mock(
			async (input: {
				taskId: string;
				baseSha: string;
				subjectSha: string;
				evidenceHash: string;
				status?: string;
			}) => {
				const review = { ...input, status: input.status ?? "approved" };
				reviews.push(review);
				return review;
			},
		),
		latestApproved: mock(async (taskId: string) =>
			[...reviews]
				.reverse()
				.find(
					(review) => review.taskId === taskId && review.status === "approved",
				),
		),
	};
	return {
		projectRepository,
		taskRepository,
		workspaceRepository,
		agentRunRepository,
		worktree,
		reviewRepository,
		reviews,
		setReviewHead: (head: string) => {
			reviewHead = head;
		},
		setIntegratedCommit: (integrated: boolean) => {
			integratedCommit = integrated;
		},
		events,
		runtime,
		orchestrator: new TaskOrchestrator({
			outputLog: { write: async () => {} },
			projects: projectRepository,
			tasks: taskRepository,
			workspaces: workspaceRepository,
			agentRuns: agentRunRepository,
			worktree,
			reviews: reviewRepository,
			runtime,
			events: {
				publish: (event) => {
					events.push(event);
				},
			},
			now: () => date,
			id: () => "task-1",
		}),
	};
}

test("runs a task through the persisted lifecycle", async () => {
	const setup = dependencies();
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Build",
		prompt: "Build it",
	});
	await setup.orchestrator.start(task.id);
	const stored = await setup.taskRepository.getById(task.id);
	const run = await setup.agentRunRepository.getByTaskId(task.id);
	expect(stored?.status).toBe("completed");
	expect(run?.executorSnapshotJson).toBeTruthy();
	expect(run?.snapshotHash).toBe(
		createHash("sha256")
			.update(run?.executorSnapshotJson ?? "")
			.digest("hex"),
	);
	expect(setup.events.map((event) => event.type)).toEqual([
		"task.created",
		"task.updated",
		"agent.run.updated",
		"run.started",
		"task.started",
		"task.updated",
		"run.progress",
		"run.output",
		"agent.run.updated",
		"run.completed",
		"task.completed",
		"task.updated",
	]);
});

test("reconciles a promotion completed by Git before the daemon recorded it", async () => {
	const setup = dependencies();
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Recover merge",
		prompt: "Implement",
	});
	await setup.orchestrator.start(task.id);
	await setup.orchestrator.checkpoint(task.id);
	setup.setIntegratedCommit(true);
	await setup.orchestrator.reconcile();
	const recovered = await setup.taskRepository.getById(task.id);
	expect(recovered?.status).toBe("completed");
	expect(
		setup.events.some(
			(event) => event.type === "task.merged" && event.taskId === task.id,
		),
	).toBe(true);
});

test("requires checkpoint and keeps manual approval bound to the reviewed SHA", async () => {
	const setup = dependencies();
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Review",
		prompt: "Implement",
	});
	await setup.orchestrator.start(task.id);
	await setup.orchestrator.checkpoint(task.id);
	const run = await setup.agentRunRepository.getByTaskId(task.id);
	expect(run?.outputSha).toBe("checkpoint-sha");
	await expect(setup.orchestrator.merge(task.id)).rejects.toThrow(
		"review approval",
	);
	await setup.orchestrator.approveReview(task.id, "tester");
	expect(setup.reviews[0]?.subjectSha).toBe("checkpoint-sha");
	setup.setReviewHead("changed-after-review");
	await expect(setup.orchestrator.merge(task.id)).rejects.toThrow("stale");
	setup.setReviewHead("checkpoint-sha");
	await setup.orchestrator.merge(task.id);
	const integrated = await setup.taskRepository.getById(task.id);
	expect(integrated?.status).toBe("completed");
	expect(integrated?.workspaceId).toBeNull();
});

test("assembles, reviews and promotes pinned outputs as one integration batch", async () => {
	const setup = dependencies();
	const first = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Frontend",
		prompt: "UI",
	});
	const second = await setup.taskRepository.create({
		...first,
		id: "task-2",
		title: "Backend",
		createdAt: date,
	});
	for (const [task, workspaceId] of [
		[first, "ws-1"],
		[second, "ws-2"],
	] as const) {
		await setup.taskRepository.update(task.id, {
			status: "ready_to_merge",
			workspaceId,
		});
		await setup.workspaceRepository.create({
			id: workspaceId,
			taskId: task.id,
			projectId: "project-1",
			path: `/tmp/${workspaceId}`,
			branch: `loom/${task.id}`,
			baseCommit: "base-sha",
			createdAt: date,
		});
		await setup.agentRunRepository.create({
			taskId: task.id,
			status: "completed",
			outputSha: `output-${task.id}`,
		});
	}
	const integrationWorkspace: WorktreeWorkspace = {
		id: "integration-batch-1",
		taskId: "integration-batch-1",
		projectId: "project-1",
		projectPath: "/repo",
		path: "/tmp/integration-batch-1",
		branch: "loom/integration/batch-1",
		targetBranch: "main",
		baseCommit: "base-sha",
		createdAt: date.toISOString(),
	};
	const worktree = setup.worktree as WorktreeManager & Record<string, unknown>;
	worktree.preflightMerge = mock(async () => ({
		path: "/repo",
		defaultBranch: "main",
		head: "base-sha",
		clean: true,
		branchExists: true,
	}));
	worktree.inspectHead = mock(async (workspace: WorktreeWorkspace) => ({
		head:
			workspace.id === integrationWorkspace.id
				? "candidate-sha"
				: `output-${workspace.taskId}`,
		clean: true,
	}));
	const candidateRequest: Record<string, unknown>[] = [];
	worktree.createIntegrationCandidate = mock(
		async (input: Record<string, unknown>) => {
			candidateRequest.push(input);
			return {
				workspace: integrationWorkspace,
				targetBaseSha: "base-sha",
				memberShas: ["output-task-1", "output-task-2"],
				candidateSha: "candidate-sha",
			};
		},
	);
	worktree.promoteIntegrationCandidate = mock(async () => "candidate-sha");
	worktree.runIntegrationCheck = mock(
		async (_workspace: WorktreeWorkspace, check: { name: string }) => ({
			name: check.name,
			status: "passed" as const,
			exitCode: 0,
			stdout: "ok",
			stderr: "",
			evidenceHash: "check-evidence",
			startedAt: date,
			finishedAt: date,
		}),
	);
	const batches = new Map<string, Record<string, any>>();
	const batchMembers = new Map<string, Array<Record<string, any>>>();
	const batchChecks = new Map<string, Array<Record<string, any>>>();
	const approved = new Map<string, Record<string, any>>();
	const integrationBatches = {
		create: mock(async (input: Record<string, any>) => {
			const batch = {
				...input,
				candidateSha: null,
				promotedSha: null,
				workspacePath: null,
				workspaceBranch: null,
				errorMessage: null,
				createdAt: date,
				updatedAt: date,
			};
			batches.set(input.id, batch);
			return batch;
		}),
		getById: mock(async (id: string) => batches.get(id)),
		listByProject: mock(async () => [...batches.values()]),
		addMembers: mock(
			async (id: string, members: Array<Record<string, any>>) => {
				const rows = members.map((member) => ({ ...member, batchId: id }));
				batchMembers.set(id, rows);
				return rows;
			},
		),
		listMembers: mock(async (id: string) => batchMembers.get(id) ?? []),
		addChecks: mock(async (id: string, checks: Array<Record<string, any>>) => {
			const rows = [
				...(batchChecks.get(id) ?? []),
				...checks.map((check) => ({ ...check, batchId: id })),
			];
			batchChecks.set(id, rows);
			return rows;
		}),
		listChecks: mock(async (id: string) => batchChecks.get(id) ?? []),
		update: mock(async (id: string, input: Record<string, any>) => {
			const batch = batches.get(id)!;
			const updated = { ...batch, ...input, updatedAt: date };
			batches.set(id, updated);
			return [updated];
		}),
	};
	const integrationBatchReviews = {
		create: mock(async (input: Record<string, any>) => {
			approved.set(input.batchId, input);
			return input;
		}),
		latestApproved: mock(async (id: string) => approved.get(id)),
	};
	const batchOrchestrator = new TaskOrchestrator({
		tasks: setup.taskRepository,
		projects: setup.projectRepository,
		workspaces: setup.workspaceRepository,
		agentRuns: setup.agentRunRepository,
		worktree,
		runtime: setup.runtime,
		outputLog: { write: async () => {} },
		integrationBatches,
		integrationBatchReviews,
		integrationLeases: {
			claim: () => ({ owner: "test" }),
			heartbeat: () => ({ owner: "test" }),
			release: () => {},
		},
		now: () => date,
		id: () => "batch-1",
	});
	const assembled = await batchOrchestrator.createIntegrationBatch(
		[first.id, second.id],
		{
			requiredChecks: [
				{ name: "typecheck", command: "bun", args: ["run", "check-types"] },
			],
		},
	);
	expect(assembled.candidateSha).toBe("candidate-sha");
	expect(assembled.batch?.status).toBe("pending_review");
	expect(batchChecks.get("batch-1")?.[0]?.status).toBe("passed");
	expect(candidateRequest[0]?.members).toEqual([
		{ taskId: "task-1", outputSha: "output-task-1" },
		{ taskId: "task-2", outputSha: "output-task-2" },
	]);
	await batchOrchestrator.integrationBatchDiff("batch-1");
	await batchOrchestrator.approveIntegrationBatch("batch-1", "reviewer");
	const promoted = await batchOrchestrator.promoteIntegrationBatch("batch-1");
	expect(promoted.promotedSha).toBe("candidate-sha");
	expect((await setup.taskRepository.getById(first.id))?.status).toBe(
		"completed",
	);
	expect((await setup.taskRepository.getById(second.id))?.status).toBe(
		"completed",
	);
	expect(batches.get("batch-1")?.status).toBe("merged");
});

test("cancels a running task and discards its workspace", async () => {
	const runtime = new MockAgentRuntime();
	const setup = dependencies(runtime);
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Build",
		prompt: "Build it",
	});
	await setup.orchestrator.cancel(task.id);
	expect((await setup.taskRepository.getById(task.id))?.status).toBe(
		"cancelled",
	);
});

test("does not complete before runtime reaches a terminal state", async () => {
	let resolveWait!: (status: "completed") => void;
	const runtime: AgentRuntime = {
		createSession: async () => ({ id: "session-1" }),
		prompt: async () => {},
		status: async () => "running",
		wait: () =>
			new Promise((resolve) => {
				resolveWait = resolve;
			}),
		abort: async () => {},
		getDiff: async () => [],
	};
	const setup = dependencies(runtime);
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Build",
		prompt: "Build it",
	});
	const start = setup.orchestrator.start(task.id);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect((await setup.taskRepository.getById(task.id))?.status).toBe("running");
	resolveWait("completed");
	await start;
	expect((await setup.taskRepository.getById(task.id))?.status).toBe(
		"completed",
	);
});

test("reconciles missing sessions as interrupted and preserves workspace state", async () => {
	const setup = dependencies();
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Build",
		prompt: "Build it",
	});
	await setup.taskRepository.update(task.id, {
		status: "running",
		workspaceId: "workspace-1",
	});
	await setup.workspaceRepository.create({
		id: "workspace-1",
		taskId: task.id,
		projectId: "project-1",
		path: "/home/user/.loom/worktrees/project-1/task-1",
		branch: "loom/task-1",
		baseCommit: "abc",
		createdAt: date,
	});
	await setup.orchestrator.reconcile();
	const state = setup.orchestrator.getRecoveryState();
	expect(state.interruptedRunIds).toEqual([]);
	expect(state.orphanWorkspaces).toEqual([]);
});

test("keeps retry history and creates a new run", async () => {
	const setup = dependencies({
		createSession: async () => ({ id: "retry-session" }),
		prompt: async () => {
			throw new Error("runtime failure");
		},
		status: async () => "failed",
		wait: async () => "failed",
		abort: async () => {},
		getDiff: async () => [],
	});
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Retry",
		prompt: "Retry",
	});
	await expect(setup.orchestrator.start(task.id)).rejects.toThrow(
		"runtime failure",
	);
	const failedTask = await setup.taskRepository.getById(task.id);
	expect(failedTask?.workspaceId).toBe("workspace-1");
	await setup.orchestrator.retry(task.id);
	expect(setup.worktree.discard).not.toHaveBeenCalled();
	expect((await setup.taskRepository.getById(task.id))?.workspaceId).toBe(
		"workspace-1",
	);
	const retryRuntime = new MockAgentRuntime();
	const retrySetup = dependencies(retryRuntime);
	const retryTask = await retrySetup.orchestrator.create({
		projectId: "project-1",
		title: "Retry",
		prompt: "Retry",
	});
	await retrySetup.taskRepository.update(retryTask.id, { status: "failed" });
	const failedRun = await retrySetup.agentRunRepository.create({
		taskId: retryTask.id,
		status: "failed",
	});
	expect(failedRun.id).toBe("run-1");
	const retry = await retrySetup.orchestrator.retry(retryTask.id);
	expect(retry.id).toBe("run-2");
	expect(
		(await retrySetup.orchestrator.listRuns(retryTask.id)).map((run) => run.id),
	).toEqual(["run-1", "run-2"]);
});

test("reconciles interrupted tasks as failed with retained error", async () => {
	const setup = dependencies();
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Build",
		prompt: "Build it",
	});
	await setup.taskRepository.update(task.id, { status: "running" });
	await setup.orchestrator.reconcile();
	const stored = await setup.taskRepository.getById(task.id);
	expect(stored?.status).toBe("failed");
	expect(stored?.errorMessage).toContain("restarting");
});

test("renames a queued task and publishes an update", async () => {
	const setup = dependencies();
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Old",
		prompt: "Old prompt",
	});
	const renamed = await setup.orchestrator.renameTask(task.id, {
		title: "New",
		prompt: "New prompt",
	});
	expect(renamed.title).toBe("New");
	expect(renamed.prompt).toBe("New prompt");
	expect((await setup.taskRepository.getById(task.id))?.title).toBe("New");
	expect(setup.events.at(-1)?.type).toBe("task.updated");
	await expect(setup.orchestrator.renameTask(task.id, {})).rejects.toThrow(
		"Nothing to update",
	);
});

test("rejects prompt changes once a task is running", async () => {
	const setup = dependencies();
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Build",
		prompt: "Build it",
	});
	await setup.taskRepository.update(task.id, { status: "running" });
	await expect(
		setup.orchestrator.renameTask(task.id, { prompt: "Changed" }),
	).rejects.toThrow("cannot change");
	const renamed = await setup.orchestrator.renameTask(task.id, {
		title: "Renamed",
	});
	expect(renamed.title).toBe("Renamed");
});

test("updates the executor agent of a queued task", async () => {
	const setup = dependencies();
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Build",
		prompt: "Build it",
		executor: { kind: "agent", agentId: "agent-a" },
	});
	const updated = await setup.orchestrator.renameTask(task.id, {
		executor: { kind: "agent", agentId: "agent-b" },
	});
	expect(updated.executor).toEqual({ kind: "agent", agentId: "agent-b" });
	const stored = await setup.taskRepository.getById(task.id);
	expect(JSON.parse(stored?.executorConfig ?? "{}")).toEqual({
		kind: "agent",
		agentId: "agent-b",
	});
	await expect(
		setup.orchestrator.renameTask(task.id, {
			executor: { kind: "agent", agentId: "" },
		}),
	).rejects.toThrow();
	await setup.taskRepository.update(task.id, { status: "running" });
	await expect(
		setup.orchestrator.renameTask(task.id, {
			executor: { kind: "agent", agentId: "agent-c" },
		}),
	).rejects.toThrow("cannot change");
});

test("removes a queued task and publishes discard", async () => {
	const setup = dependencies();
	const task = await setup.orchestrator.create({
		projectId: "project-1",
		title: "Temporary",
		prompt: "Remove me",
	});
	await setup.orchestrator.removeTask(task.id);
	expect(await setup.taskRepository.getById(task.id)).toBeUndefined();
	expect(setup.events.at(-1)).toEqual({
		type: "task.discarded",
		taskId: task.id,
	});
});

test("reorders project tasks and rejects mismatched lists", async () => {
	const setup = dependencies();
	for (const id of ["task-a", "task-b", "task-c"]) {
		await setup.taskRepository.create({
			id,
			projectId: "project-1",
			title: id,
			prompt: id,
			status: "queued",
		} as TaskRecord);
	}
	await setup.orchestrator.reorderTasks("project-1", [
		"task-c",
		"task-a",
		"task-b",
	]);
	expect((await setup.taskRepository.getById("task-c"))?.position).toBe(0);
	expect((await setup.taskRepository.getById("task-a"))?.position).toBe(1);
	expect((await setup.taskRepository.getById("task-b"))?.position).toBe(2);
	await expect(
		setup.orchestrator.reorderTasks("project-1", ["task-a"]),
	).rejects.toThrow("must match");
	await expect(
		setup.orchestrator.reorderTasks("project-1", ["task-a", "task-b", "nope"]),
	).rejects.toThrow("must match");
});
