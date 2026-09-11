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
};

export const defaultSchedulerConfig: SchedulerConfig = {
	maxConcurrentAgents: 3,
	maxConcurrentAgentsPerProject: 3,
};

export type SchedulerTask = {
	taskId: string;
	projectId: string;
	state: SchedulerState;
};

export interface Scheduler {
	enqueue(taskId: string): Promise<void>;
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
	)
		throw new Error("Scheduler concurrency limits must be at least 1");

	const tasks = new Map<string, SchedulerTask>();
	const queue: string[] = [];
	const dispatching = new Set<string>();
	const waiters = new Map<string, Array<(state: SchedulerState) => void>>();
	let shuttingDown = false;
	let dispatchPromise: Promise<void> | undefined;

	const changed = async () => {
		await options.onChanged?.({
			running: [...tasks.values()].filter((task) => task.state === "running")
				.length,
			queued: queue.length,
		});
	};

	const dispatch = async () => {
		if (shuttingDown) return;
		if (dispatchPromise) return dispatchPromise;
		dispatchPromise = (async () => {
			let changedState = false;
			while (queue.length > 0) {
				const running = [...tasks.values()].filter(
					(task) => task.state === "running",
				);
				if (running.length >= config.maxConcurrentAgents) break;
				const nextIndex = queue.findIndex((taskId) => {
					const task = tasks.get(taskId);
					if (task?.state !== "queued") return false;
					return (
						running.filter((item) => item.projectId === task.projectId).length <
						config.maxConcurrentAgentsPerProject
					);
				});
				if (nextIndex < 0) break;
				const taskId = queue.splice(nextIndex, 1)[0];
				if (!taskId) break;
				const task = tasks.get(taskId);
				if (task?.state !== "queued") continue;
				task.state = "running";
				dispatching.add(taskId);
				changedState = true;
				void run(task);
			}
			if (changedState) await changed();
		})().finally(() => {
			dispatchPromise = undefined;
		});
		return dispatchPromise;
	};

	const run = async (task: SchedulerTask) => {
		try {
			await options.run(task.taskId);
			if (task.state === "running") task.state = "completed";
		} catch {
			if (task.state === "running") task.state = "failed";
		} finally {
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
		async enqueue(taskId) {
			if (shuttingDown) throw new Error("Scheduler is shut down");
			if (tasks.has(taskId)) return;
			const projectId = await options.getProjectId(taskId);
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
			for (const taskId of queue.splice(0)) {
				const task = tasks.get(taskId);
				if (task) task.state = "cancelled";
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
