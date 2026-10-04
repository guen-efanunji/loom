import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, planRepository, repositories } from "@loom/db";
import { MockAgentRuntime } from "@loom/opencode";
import type { DaemonEvent } from "@loom/protocol";
import { WorktreeManager } from "@loom/worktree";
import { AutomationService } from "../src/automation";
import { git } from "../src/commands";
import { combineHooks, TaskOrchestrator } from "../src/index";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

const canned = {
	title: "Widget",
	summary: "Build the widget.",
	tasks: [
		{
			key: "base",
			title: "Base",
			description: "Create the base component.",
			priority: "high" as const,
			dependencies: [] as string[],
			acceptanceCriteria: ["Base renders"],
			suggestedFiles: ["base.html"],
		},
		{
			key: "top",
			title: "Top",
			description: "Create the top component.",
			priority: "medium" as const,
			dependencies: ["base"],
			acceptanceCriteria: ["Top renders"],
			suggestedFiles: ["top.html"],
		},
	],
};

class PlannerRuntime extends MockAgentRuntime {
	override async prompt(input: { sessionId: string; prompt: string }) {
		const session = this.sessions.get(input.sessionId);
		if (!session) throw new Error("missing session");
		if (session.title === "Loom planner") {
			session.output = JSON.stringify(canned);
			session.status = "completed";
			return;
		}
		await super.prompt(input);
	}
}

async function createHarness() {
	const root = await mkdtemp(join(tmpdir(), "loom-automation-"));
	roots.push(root);
	const path = join(root, "repo");
	await mkdir(path, { recursive: true });
	await git(path, "init", "-b", "main");
	await git(path, "config", "user.name", "Loom test");
	await git(path, "config", "user.email", "test@localhost");
	await writeFile(join(path, "README.md"), "fixture\n");
	await git(path, "add", ".");
	await git(path, "commit", "-m", "Initial");
	const db = createDb({ DATABASE_URL: `file:${join(root, "state.db")}` });
	const repos = repositories(db);
	const store = planRepository(db);
	const runtime = new PlannerRuntime();
	const events: DaemonEvent[] = [];
	const tasks = new TaskOrchestrator({
		...repos,
		runtime,
		worktree: new WorktreeManager({ home: root }),
		outputLog: { write: async () => {} },
		events: { publish: (event) => void events.push(event) },
	});
	const automation = new AutomationService(store, repos, tasks, runtime);
	tasks.setLifecycle(combineHooks(automation.hooks()));
	const project = await repos.projects.create({
		name: "Fixture",
		path,
		defaultBranch: "main",
	});
	return { db, repos, store, tasks, automation, events, project };
}

async function buildPlan(harness: Awaited<ReturnType<typeof createHarness>>) {
	const { automation, project } = harness;
	const created = await automation.createPlan({
		projectId: project.id,
		sourceMessageId: "msg-1",
		message: "Build the widget",
	});
	await automation.idle(created.planId);
	return created.planId;
}

test("plans, converts, unlocks dependents, and completes", async () => {
	const harness = await createHarness();
	const { automation, events, store, tasks } = harness;
	const planId = await buildPlan(harness);
	expect((await store.get(planId))?.status).toBe("validated");
	expect(await store.planTasks(planId)).toHaveLength(2);
	await automation.savePlan(planId, {
		title: "Widget v2",
		tasks: canned.tasks.map((task) => ({ ...task })),
	});
	expect((await store.get(planId))?.title).toBe("Widget v2");
	await automation.approve(planId);
	const first = await automation.convert(planId);
	expect(first.converted).toBe(true);
	expect(first.taskIds).toHaveLength(2);
	const detail = await automation.detail(planId);
	expect(detail.tasks.map((task) => task.status).sort()).toEqual([
		"blocked",
		"ready",
	]);
	const blocked = detail.tasks.find((task) => task.status === "blocked");
	expect(blocked?.blockedBy).toEqual(["Base"]);
	const again = await automation.convert(planId);
	expect(again.converted).toBe(false);
	expect([...again.taskIds].sort()).toEqual([...first.taskIds].sort());
	const started = await automation.start(planId);
	expect(started.started).toHaveLength(1);
	const ready = detail.tasks.find((task) => task.status === "ready");
	if (!ready) throw new Error("ready task missing");
	await tasks.getScheduler().wait(ready.id);
	const top = detail.tasks.find((task) => task.status === "blocked");
	if (!top) throw new Error("blocked task missing");
	await tasks.getScheduler().wait(top.id);
	const done = await automation.detail(planId);
	expect(done.progress.done).toBe(2);
	expect(done.progress.percent).toBe(100);
	expect((await store.get(planId))?.status).toBe("completed");
	const types = events.map((event) => event.type);
	for (const type of [
		"plan.created",
		"plan.validated",
		"plan.approved",
		"plan.converted",
		"plan.tasksCreated",
		"plan.started",
		"task.ready",
		"task.unblocked",
	] as const)
		expect(types).toContain(type);
	expect(blocked && done.tasks.find((t) => t.id === blocked.id)?.status).toBe(
		"completed",
	);
});

test("rejects invalid edits, premature actions, and failed dependencies stay blocked", async () => {
	const harness = await createHarness();
	const { automation, events, repos, store, tasks } = harness;
	const planId = await buildPlan(harness);
	const duplicate = canned.tasks[0];
	if (!duplicate) throw new Error("fixture task missing");
	await expect(
		automation.savePlan(planId, {
			tasks: [duplicate, { ...duplicate }],
		}),
	).rejects.toThrow("Duplicate");
	await expect(automation.convert(planId)).rejects.toThrow("approved");
	await automation.approve(planId);
	const converted = await automation.convert(planId);
	const rows = await repos.tasks.listByProject(harness.project.id);
	const base = rows.find((row) => row.title === "Base");
	const top = rows.find((row) => row.title === "Top");
	if (!base || !top) throw new Error("converted tasks missing");
	await repos.tasks.update(base.id, { status: "failed" });
	await automation.hooks().settled(base.id);
	expect((await repos.tasks.getById(top.id))?.status).toBe("blocked");
	expect(
		events.some(
			(event) => event.type === "task.ready" && event.taskId === top.id,
		),
	).toBe(false);
	await repos.tasks.update(base.id, { status: "running" });
	await expect(tasks.removeTask(base.id)).rejects.toThrow("deleted");
	await repos.tasks.update(base.id, { status: "ready" });
	await expect(tasks.removeTask(base.id)).rejects.toThrow("dependent");
	expect(converted.taskIds).toHaveLength(2);
	expect((await store.get(planId))?.status).toBe("approved");
});

test("cancels unexecuted plans and combines hooks", async () => {
	const harness = await createHarness();
	const { automation, store } = harness;
	const planId = await buildPlan(harness);
	await automation.cancel(planId);
	expect((await store.get(planId))?.status).toBe("failed");
	const combined = combineHooks(
		undefined,
		{
			canRun: async () => true,
			prepare: async (task) => `${task.prompt} [a]`,
			complete: async () => {},
			settled: async () => {},
			guard: async () => {},
		},
		{
			canRun: async () => false,
			prepare: async (task) => `${task.prompt} [b]`,
			complete: async () => {},
			settled: async () => {},
			guard: async () => {
				throw new Error("denied");
			},
		},
	);
	expect(await combined.canRun("task-1")).toBe(false);
	expect(
		await combined.prepare(
			{
				id: "task-1",
				projectId: "project-1",
				title: "t",
				prompt: "base",
				status: "queued",
			} as never,
			{} as never,
		),
	).toBe("base [a] [b]");
	await expect(combined.guard("task-1", "retry")).rejects.toThrow("denied");
});
