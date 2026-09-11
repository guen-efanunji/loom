import { z } from "zod";

import {
	agentRunSchema,
	mergeConflictSchema,
	permissionRequestSchema,
	taskSchema,
} from "./domain";

const eventMetaSchema = z.object({
	sequence: z.number().int().positive(),
	timestamp: z.iso.datetime(),
});

const runEventSchema = z.object({
	taskId: z.string().min(1),
	runId: z.string().min(1),
});

export const daemonEventSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("scheduler.changed"),
			running: z.number().int().nonnegative(),
			queued: z.number().int().nonnegative(),
		})
		.merge(eventMetaSchema),
	z
		.object({
			type: z.literal("run.started"),
			...runEventSchema.shape,
			sessionId: z.string().min(1),
			cwd: z.string().min(1),
		})
		.merge(eventMetaSchema),
	z
		.object({
			type: z.literal("run.output"),
			...runEventSchema.shape,
			output: z.string(),
			truncated: z.boolean(),
		})
		.merge(eventMetaSchema),
	z
		.object({
			type: z.literal("run.completed"),
			...runEventSchema.shape,
		})
		.merge(eventMetaSchema),
	z
		.object({
			type: z.literal("run.failed"),
			...runEventSchema.shape,
			message: z.string().min(1),
		})
		.merge(eventMetaSchema),
	z
		.object({
			type: z.literal("run.cancelled"),
			...runEventSchema.shape,
		})
		.merge(eventMetaSchema),
	z
		.object({
			type: z.literal("run.waiting_permission"),
			...runEventSchema.shape,
			request: permissionRequestSchema,
		})
		.merge(eventMetaSchema),
	z
		.object({
			type: z.literal("run.interrupted"),
			...runEventSchema.shape,
			reason: z.string().min(1),
		})
		.merge(eventMetaSchema),
	z
		.object({
			type: z.literal("merge_conflict.detected"),
			conflict: mergeConflictSchema,
		})
		.merge(eventMetaSchema),
	z
		.object({
			type: z.literal("merge.ready"),
			taskId: z.string().min(1),
		})
		.merge(eventMetaSchema),
	z.object({
		type: z.literal("permission.requested"),
		request: permissionRequestSchema,
	}),
	z.object({
		type: z.literal("permission.updated"),
		request: permissionRequestSchema,
	}),
	z.object({
		type: z.literal("agent.run.created"),
		run: agentRunSchema,
	}),
	z.object({
		type: z.literal("agent.run.updated"),
		run: agentRunSchema,
	}),
	z.object({
		type: z.literal("task.created"),
		task: taskSchema,
	}),
	z.object({
		type: z.literal("task.started"),
		taskId: z.string().min(1),
	}),
	z.object({
		type: z.literal("task.updated"),
		task: taskSchema,
	}),
	z.object({
		type: z.literal("task.completed"),
		taskId: z.string().min(1),
	}),
	z.object({
		type: z.literal("task.failed"),
		taskId: z.string().min(1),
		message: z.string().min(1),
	}),
	z.object({
		type: z.literal("task.cancelled"),
		taskId: z.string().min(1),
	}),
	z.object({
		type: z.literal("task.output"),
		taskId: z.string().min(1),
		output: z.string(),
	}),
	z.object({
		type: z.literal("task.workspace"),
		taskId: z.string().min(1),
		workspace: z.object({
			id: z.string().min(1),
			path: z.string().min(1),
			branch: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("task.merged"),
		taskId: z.string().min(1),
	}),
	z.object({
		type: z.literal("task.discarded"),
		taskId: z.string().min(1),
	}),
]);

export type DaemonEvent = z.infer<typeof daemonEventSchema>;
