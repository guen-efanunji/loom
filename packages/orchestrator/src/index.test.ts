import { expect, mock, test } from "bun:test";

import type { ProjectRecord, TaskRecord, WorkspaceRecord } from "@loom/db";
import type { AgentRuntime } from "@loom/opencode";
import { MockAgentRuntime } from "@loom/opencode";
import type { DaemonEvent } from "@loom/protocol";
import type {
	WorktreeManager,
	Workspace as WorktreeWorkspace,
} from "@loom/worktree";

import { TaskOrchestrator } from "./index";

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
	};
	const worktree: Pick<
		WorktreeManager,
		"create" | "remove" | "discard" | "merge" | "diff"
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
		diff: mock(async () => "diff"),
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
	return {
		projectRepository,
		taskRepository,
		workspaceRepository,
		worktree,
		events,
		runtime,
		orchestrator: new TaskOrchestrator({
			projects: projectRepository,
			tasks: taskRepository,
			workspaces: workspaceRepository,
			worktree,
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
	expect(stored?.status).toBe("completed");
	expect(setup.events.map((event) => event.type)).toEqual([
		"task.created",
		"task.updated",
		"task.started",
		"task.updated",
		"task.completed",
		"task.updated",
	]);
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
