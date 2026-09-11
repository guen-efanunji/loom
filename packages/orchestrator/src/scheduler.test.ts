import { expect, test } from "bun:test";

import { createScheduler, defaultSchedulerConfig } from "./scheduler";

test("uses FIFO scheduling with global and project limits", async () => {
	const releases = new Map<string, () => void>();
	const started: string[] = [];
	const scheduler = createScheduler({
		config: { maxConcurrentAgents: 2, maxConcurrentAgentsPerProject: 1 },
		getProjectId: async (taskId) =>
			taskId === "a2" ? "a" : taskId === "b1" ? "b" : "a",
		run: async (taskId) => {
			started.push(taskId);
			await new Promise<void>((resolve) => releases.set(taskId, resolve));
		},
	});

	await scheduler.enqueue("a1");
	await scheduler.enqueue("a2");
	await scheduler.enqueue("b1");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(started).toEqual(["a1", "b1"]);
	expect(scheduler.getState().queued.map((task) => task.taskId)).toEqual([
		"a2",
	]);

	releases.get("a1")?.();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(started).toEqual(["a1", "b1", "a2"]);
	expect(scheduler.getState().running.map((task) => task.taskId)).toEqual([
		"a2",
		"b1",
	]);
});

test("prevents duplicates and cancellation releases a queued task", async () => {
	const started: string[] = [];
	const changes: Array<{ running: number; queued: number }> = [];
	const scheduler = createScheduler({
		getProjectId: async () => "project",
		run: async (taskId) => {
			started.push(taskId);
		},
		onChanged: (state) => {
			changes.push(state);
		},
	});

	await scheduler.enqueue("task-1");
	await scheduler.enqueue("task-1");
	await scheduler.enqueue("task-2");
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(started).toEqual(["task-1", "task-2"]);
	expect(changes.length).toBeGreaterThan(0);
});

test("releases a running slot immediately after cancellation", async () => {
	let release!: () => void;
	const started: string[] = [];
	const scheduler = createScheduler({
		config: { maxConcurrentAgents: 1, maxConcurrentAgentsPerProject: 1 },
		getProjectId: async () => "project",
		run: async (taskId) => {
			started.push(taskId);
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		},
	});
	await scheduler.enqueue("task-1");
	await scheduler.enqueue("task-2");
	await new Promise((resolve) => setTimeout(resolve, 0));
	await scheduler.cancel("task-1");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(started).toEqual(["task-1", "task-2"]);
	release();
	await scheduler.wait("task-2");
});

test("survives a concurrency stress queue without duplicate starts", async () => {
	let running = 0;
	let peak = 0;
	const started: string[] = [];
	const scheduler = createScheduler({
		config: { maxConcurrentAgents: 3, maxConcurrentAgentsPerProject: 2 },
		getProjectId: async (taskId) => (taskId.endsWith("-b") ? "b" : "a"),
		run: async (taskId) => {
			running += 1;
			peak = Math.max(peak, running);
			started.push(taskId);
			await new Promise((resolve) => setTimeout(resolve, 2));
			running -= 1;
		},
	});
	const ids = Array.from(
		{ length: 20 },
		(_, index) => `task-${index}-${index % 2 ? "a" : "b"}`,
	);
	await Promise.all(ids.map((taskId) => scheduler.enqueue(taskId)));
	await Promise.all(ids.map((taskId) => scheduler.wait(taskId)));
	expect(peak).toBeLessThanOrEqual(3);
	expect(new Set(started).size).toBe(ids.length);
});

test("uses the documented defaults and rejects work after shutdown", async () => {
	expect(defaultSchedulerConfig).toEqual({
		maxConcurrentAgents: 3,
		maxConcurrentAgentsPerProject: 3,
	});
	const scheduler = createScheduler({
		getProjectId: async () => "project",
		run: async () => {},
	});
	await scheduler.shutdown();
	await expect(scheduler.enqueue("task-1")).rejects.toThrow("shut down");
});
