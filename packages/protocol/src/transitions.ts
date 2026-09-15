import type { TaskStatus } from "./domain";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
	queued: ["preparing", "cancelled", "failed"],
	ready: ["preparing", "cancelled", "failed"],
	blocked: ["ready", "cancelled", "failed"],
	preparing: ["running", "cancelled", "failed"],
	running: ["completed", "cancelled", "failed"],
	completed: ["ready_to_merge"],
	ready_to_merge: ["merge_conflict", "completed"],
	merge_conflict: ["ready_to_merge", "completed"],
	failed: [],
	cancelled: [],
};

export function canTransitionTaskStatus(
	from: TaskStatus,
	to: TaskStatus,
): boolean {
	return transitions[from].includes(to);
}

export function transitionTaskStatus(
	from: TaskStatus,
	to: TaskStatus,
): TaskStatus {
	if (!canTransitionTaskStatus(from, to)) {
		throw new Error(`Invalid task status transition: ${from} -> ${to}`);
	}

	return to;
}
