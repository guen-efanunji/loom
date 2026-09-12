import { type TaskPlan, taskPlanSchema } from "@loom/protocol";

export type GraphTask = {
	id: string;
	projectId: string;
	epicId: string;
	status: string;
	dependsOn: string[];
};

export function detectCycle(
	tasks: Array<{ id: string; dependsOn: string[] }>,
): boolean {
	const nodes = new Map(tasks.map((task) => [task.id, task]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): boolean => {
		if (visiting.has(id)) return true;
		if (visited.has(id)) return false;
		visiting.add(id);
		if (nodes.get(id)?.dependsOn.some(visit)) return true;
		visiting.delete(id);
		visited.add(id);
		return false;
	};
	return tasks.some((task) => visit(task.id));
}

export function validateGraph(tasks: GraphTask[]): void {
	const nodes = new Map(tasks.map((task) => [task.id, task]));
	if (nodes.size !== tasks.length)
		throw new Error("Invalid graph: duplicate task keys");
	for (const task of tasks) {
		if (new Set(task.dependsOn).size !== task.dependsOn.length)
			throw new Error(`Invalid graph: duplicate dependency in ${task.id}`);
		for (const id of task.dependsOn) {
			const dependency = nodes.get(id);
			if (!dependency)
				throw new Error(`Invalid graph: missing dependency ${id}`);
			if (
				dependency.projectId !== task.projectId ||
				dependency.epicId !== task.epicId
			)
				throw new Error(
					"Invalid graph: dependencies must belong to the same epic and project",
				);
		}
	}
	if (detectCycle(tasks))
		throw new Error("Invalid graph: dependency cycle detected");
}

export function validatePlan(value: unknown): TaskPlan {
	const plan = taskPlanSchema.parse(value);
	validateGraph(
		plan.tasks.map((task) => ({
			id: task.key,
			projectId: "plan",
			epicId: "plan",
			status: "queued",
			dependsOn: task.dependsOn,
		})),
	);
	return plan;
}

export function getRunnableTasks(tasks: GraphTask[]): GraphTask[] {
	validateGraph(tasks);
	const nodes = new Map(tasks.map((task) => [task.id, task]));
	return tasks.filter(
		(task) =>
			task.status === "queued" &&
			task.dependsOn.every((id) => nodes.get(id)?.status === "completed"),
	);
}

export function getBlockedTasks(tasks: GraphTask[]) {
	const runnable = new Set(getRunnableTasks(tasks).map((task) => task.id));
	return tasks
		.filter((task) => task.status === "queued" && !runnable.has(task.id))
		.map((task) => ({
			...task,
			blockedBy: task.dependsOn.filter(
				(id) =>
					tasks.find((candidate) => candidate.id === id)?.status !==
					"completed",
			),
		}));
}
