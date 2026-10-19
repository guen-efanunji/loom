export type SchedulerState =
	| "queued"
	| "preparing"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type SchedulerConfig = {
	maxConcurrentAgents: number;
	maxConcurrentAgentsPerProject: number;
	maxConcurrentAgentsPerProvider: number;
};

export const defaultSchedulerConfig: SchedulerConfig = {
	maxConcurrentAgents: 3,
	maxConcurrentAgentsPerProject: 3,
	maxConcurrentAgentsPerProvider: 2,
};

export type SchedulerTask = {
	taskId: string;
	projectId: string;
	state: SchedulerState;
};

export interface Scheduler {
	enqueue(taskId: string, retry?: boolean): Promise<void>;
	restore(input: {
		taskId: string;
		projectId: string;
		state: "queued" | "running";
	}): Promise<void>;
	dispatch(): Promise<void>;
	cancel(taskId: string): Promise<void>;
	shutdown(): Promise<void>;
	wait(taskId: string): Promise<SchedulerState>;
	getState(): {
		running: SchedulerTask[];
		queued: SchedulerTask[];
	};
}

type SchedulerOptions = {
	config?: Partial<SchedulerConfig>;
	getProjectId: (taskId: string) => Promise<string>;
	run: (taskId: string) => Promise<void>;
	canRun?: (taskId: string) => Promise<boolean>;
	claim?: (taskId: string) => Promise<boolean>;
	heartbeat?: (taskId: string) => Promise<boolean>;
	release?: (taskId: string) => Promise<void>;
	onLeaseLost?: (taskId: string) => Promise<void> | void;
	onChanged?: (state: {
		running: number;
		queued: number;
	}) => Promise<void> | void;
};

export function createScheduler(options: SchedulerOptions): Scheduler {
	const config = {
		...defaultSchedulerConfig,
		...options.config,
	};
	if (
		config.maxConcurrentAgents < 1 ||
		config.maxConcurrentAgentsPerProject < 1
		|| config.maxConcurrentAgentsPerProvider < 1
	)
		throw new Error("Scheduler concurrency limits must be at least 1");

	const tasks = new Map<string, SchedulerTask>();
	const queue: string[] = [];
	const dispatching = new Set<string>();
	const pending = new Set<string>();
	const waiters = new Map<string, Array<(state: SchedulerState) => void>>();
	let shuttingDown = false;
	let dispatchPromise: Promise<void> | undefined;
	let redispatch = false;
	let leasePoll: ReturnType<typeof setTimeout> | undefined;

	const changed = async () => {
		await options.onChanged?.({
			running: [...tasks.values()].filter((task) => task.state === "running")
				.length,
			queued: queue.length,
		});
	};

	const dispatch = async () => {
		if (shuttingDown) return;
		if (dispatchPromise) {
			redispatch = true;
			return dispatchPromise;
		}
		dispatchPromise = (async () => {
			let changedState = false;
			while (queue.length > 0) {
				const running = [...tasks.values()].filter(
					(task) => task.state === "running" || dispatching.has(task.taskId),
				);
				if (running.length >= config.maxConcurrentAgents) break;
				let nextIndex = -1;
				let claimedTaskId: string | undefined;
				for (let i = 0; i < queue.length; i++) {
					const candidate = queue[i];
					if (!candidate) continue;
					const task = tasks.get(candidate);
					if (task?.state !== "queued") continue;
					if (
						running.filter((item) => item.projectId === task.projectId)
							.length >= config.maxConcurrentAgentsPerProject
					)
						continue;
					if (options.canRun && !(await options.canRun(candidate))) continue;
					if (options.claim && !(await options.claim(candidate))) continue;
					// Readiness is asynchronous: cancellation may have removed this candidate.
					if (task.state !== "queued" || !queue.includes(candidate)) {
						if (options.release) await options.release(candidate);
						continue;
					}
					nextIndex = queue.indexOf(candidate);
					claimedTaskId = options.claim ? candidate : undefined;
					break;
				}
				if (nextIndex < 0) {
					if (queue.length && options.claim && !leasePoll)
						leasePoll = setTimeout(() => {
							leasePoll = undefined;
							void dispatch();
						}, 1500);
					break;
				}
				if (leasePoll) {
					clearTimeout(leasePoll);
					leasePoll = undefined;
				}
				const taskId = queue.splice(nextIndex, 1)[0];
				if (!taskId) {
					if (claimedTaskId && options.release) await options.release(claimedTaskId);
					break;
				}
				const task = tasks.get(taskId);
				if (task?.state !== "queued") {
					if (claimedTaskId && options.release) await options.release(claimedTaskId);
					continue;
				}
				task.state = "running";
				dispatching.add(taskId);
				changedState = true;
				void run(task);
			}
			if (changedState) await changed();
		})().finally(() => {
			dispatchPromise = undefined;
			if (redispatch) {
				redispatch = false;
				queueMicrotask(() => {
					void dispatch();
				});
			}
		});
		return dispatchPromise;
	};

	const run = async (task: SchedulerTask) => {
		let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
		if (options.heartbeat) {
			heartbeatTimer = setInterval(() => {
				void options.heartbeat?.(task.taskId).then((owned) => {
					if (!owned) {
						if (heartbeatTimer) clearInterval(heartbeatTimer);
						heartbeatTimer = undefined;
						void options.onLeaseLost?.(task.taskId);
					}
				}).catch(() => {});
			}, 15_000);
			heartbeatTimer.unref?.();
		}
		try {
			await options.run(task.taskId);
			if (task.state === "running") task.state = "completed";
		} catch {
			if (task.state === "running") task.state = "failed";
		} finally {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			await options.release?.(task.taskId);
			dispatching.delete(task.taskId);
			for (const resolve of waiters.get(task.taskId) ?? []) resolve(task.state);
			waiters.delete(task.taskId);
			if (!shuttingDown) {
				await changed();
				await dispatch();
			}
		}
	};

	return {
		async restore(input) {
			if (shuttingDown) throw new Error("Scheduler is shut down");
			if (tasks.has(input.taskId)) return;
			tasks.set(input.taskId, {
				taskId: input.taskId,
				projectId: input.projectId,
				state: input.state,
			});
			if (input.state === "queued") queue.push(input.taskId);
		},
		async enqueue(taskId, retry = false) {
			if (shuttingDown) throw new Error("Scheduler is shut down");
			if (
				pending.has(taskId) ||
				dispatching.has(taskId) ||
				(tasks.has(taskId) && !retry)
			)
				return;
			if (
				retry &&
				["queued", "running"].includes(tasks.get(taskId)?.state ?? "")
			)
				return;
			pending.add(taskId);
			let projectId: string;
			try {
				projectId = await options.getProjectId(taskId);
			} finally {
				pending.delete(taskId);
			}
			if (shuttingDown) throw new Error("Scheduler is shut down");
			tasks.set(taskId, { taskId, projectId, state: "queued" });
			queue.push(taskId);
			await changed();
			await dispatch();
		},
		dispatch,
		async wait(taskId) {
			const task = tasks.get(taskId);
			if (!task) throw new Error(`Task not found: ${taskId}`);
			if (["completed", "failed", "cancelled"].includes(task.state))
				return task.state;
			return new Promise((resolve) => {
				const current = waiters.get(taskId) ?? [];
				current.push(resolve);
				waiters.set(taskId, current);
			});
		},
		async cancel(taskId) {
			const task = tasks.get(taskId);
			if (!task) return;
			if (task.state === "queued") {
				task.state = "cancelled";
				const index = queue.indexOf(taskId);
				if (index >= 0) queue.splice(index, 1);
				for (const resolve of waiters.get(taskId) ?? []) resolve("cancelled");
				waiters.delete(taskId);
				await changed();
				return;
			}
			if (dispatching.has(taskId)) {
				task.state = "cancelled";
				await changed();
				await dispatch();
			}
		},
		async shutdown() {
			shuttingDown = true;
			if (leasePoll) clearTimeout(leasePoll);
			leasePoll = undefined;
			for (const taskId of queue.splice(0)) {
				const task = tasks.get(taskId);
				if (task) task.state = "cancelled";
				for (const resolve of waiters.get(taskId) ?? []) resolve("cancelled");
				waiters.delete(taskId);
			}
			await changed();
		},
		getState() {
			return {
				running: [...tasks.values()].filter((task) => task.state === "running"),
				queued: queue
					.map((taskId) => tasks.get(taskId))
					.filter((task): task is SchedulerTask => Boolean(task)),
			};
		},
	};
}

export function schedulerConfig(
	config: Partial<SchedulerConfig> = {},
): SchedulerConfig {
	return { ...defaultSchedulerConfig, ...config };
}
