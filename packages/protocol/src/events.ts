import { z } from "zod";

import { taskSchema } from "./domain";

export const daemonEventSchema = z.discriminatedUnion("type", [
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
