import { z } from "zod";

export const projectSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	path: z.string().min(1),
	defaultBranch: z.string().min(1),
	createdAt: z.iso.datetime(),
});

export type Project = z.infer<typeof projectSchema>;

export const taskStatusSchema = z.enum([
	"queued",
	"preparing",
	"running",
	"completed",
	"failed",
	"cancelled",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
	id: z.string().min(1),
	projectId: z.string().min(1),
	title: z.string().min(1),
	prompt: z.string().min(1),
	status: taskStatusSchema,
	workspaceId: z.string().min(1).nullable(),
	sessionId: z.string().min(1).nullable(),
	createdAt: z.iso.datetime(),
	startedAt: z.iso.datetime().nullable(),
	completedAt: z.iso.datetime().nullable(),
});

export type Task = z.infer<typeof taskSchema>;

export const workspaceSchema = z.object({
	id: z.string().min(1),
	taskId: z.string().min(1),
	projectId: z.string().min(1),
	path: z.string().min(1),
	branch: z.string().min(1),
	baseCommit: z.string().min(1),
	createdAt: z.iso.datetime(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const agentRunStatusSchema = z.enum([
	"queued",
	"running",
	"waiting_permission",
	"completed",
	"failed",
	"cancelled",
]);

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentRunSchema = z.object({
	id: z.string().min(1),
	taskId: z.string().min(1),
	sessionId: z.string().min(1).nullable(),
	status: agentRunStatusSchema,
	startedAt: z.iso.datetime().nullable(),
	completedAt: z.iso.datetime().nullable(),
});

export type AgentRun = z.infer<typeof agentRunSchema>;
