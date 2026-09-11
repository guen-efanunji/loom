import { describe, expect, test } from "bun:test";

import {
	apiErrorSchema,
	canTransitionTaskStatus,
	createProjectInputSchema,
	daemonEventSchema,
	projectSchema,
	taskSchema,
	transitionTaskStatus,
} from "../src";

const task = {
	id: "task-1",
	projectId: "project-1",
	title: "Implement feature",
	prompt: "Implement the feature",
	status: "queued" as const,
	workspaceId: null,
	sessionId: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	startedAt: null,
	completedAt: null,
};

describe("protocol schemas", () => {
	test("parses a project", () => {
		const result = projectSchema.parse({
			id: "project-1",
			name: "loom",
			path: "/tmp/loom",
			defaultBranch: "main",
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		expect(result.defaultBranch).toBe("main");
	});

	test("rejects an invalid task status", () => {
		expect(() => taskSchema.parse({ ...task, status: "unknown" })).toThrow();
	});

	test("parses task events", () => {
		const result = daemonEventSchema.parse({ type: "task.created", task });

		expect(result.type).toBe("task.created");
		expect(
			daemonEventSchema.parse({ type: "task.cancelled", taskId: "task-1" })
				.type,
		).toBe("task.cancelled");
		expect(
			daemonEventSchema.parse({
				type: "task.output",
				taskId: "task-1",
				output: "done",
			}).type,
		).toBe("task.output");
	});

	test("rejects empty input values", () => {
		expect(() => createProjectInputSchema.parse({ path: " " })).toThrow();
	});

	test("parses actionable API errors", () => {
		const result = apiErrorSchema.parse({
			code: "WORKTREE_ERROR",
			message: "Unable to create workspace",
			action: "Check that the project has no conflicting worktree",
		});

		expect(result.code).toBe("WORKTREE_ERROR");
	});
});

describe("task status transitions", () => {
	test("allows the V1 lifecycle", () => {
		expect(canTransitionTaskStatus("queued", "preparing")).toBe(true);
		expect(transitionTaskStatus("preparing", "running")).toBe("running");
		expect(transitionTaskStatus("running", "completed")).toBe("completed");
	});

	test("rejects transitions from terminal states", () => {
		expect(canTransitionTaskStatus("completed", "running")).toBe(false);
		expect(() => transitionTaskStatus("failed", "queued")).toThrow();
	});
});
