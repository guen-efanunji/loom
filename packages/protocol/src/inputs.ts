import { z } from "zod";
import { taskExecutorSchema } from "./domain";

export const createProjectInputSchema = z.object({
	path: z.string().trim().min(1),
});

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const createTaskInputSchema = z.object({
	projectId: z.string().min(1),
	title: z.string().trim().min(1).max(200),
	prompt: z.string().trim().min(1),
	acceptanceCriteria: z
		.array(z.string().trim().min(1).max(500))
		.max(30)
		.optional(),
	// null explicitly means this is a planning-only task without a Git target.
	targetBranch: z.string().trim().min(1).max(240).nullable().optional(),
	executor: taskExecutorSchema.optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const createTaskBatchInputSchema = z.object({
	tasks: z
		.array(createTaskInputSchema.omit({ projectId: true }))
		.min(1)
		.max(100),
});

export type CreateTaskBatchInput = z.infer<typeof createTaskBatchInputSchema>;

export const permissionDecisionInputSchema = z.object({
	decision: z.enum(["allow_once", "allow", "deny"]),
});

export type PermissionDecisionInput = z.infer<
	typeof permissionDecisionInputSchema
>;

export const createSessionInputSchema = z.object({
	cwd: z.string().min(1),
	title: z.string().trim().min(1),
});

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const promptInputSchema = z.object({
	sessionId: z.string().min(1),
	prompt: z.string().trim().min(1),
});

export type PromptInput = z.infer<typeof promptInputSchema>;

export const taskIdInputSchema = z.object({
	taskId: z.string().min(1),
});

export type TaskIdInput = z.infer<typeof taskIdInputSchema>;

export const sessionIdInputSchema = z.object({
	sessionId: z.string().min(1),
});

export type SessionIdInput = z.infer<typeof sessionIdInputSchema>;
