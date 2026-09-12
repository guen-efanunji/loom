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
	"ready_to_merge",
	"merge_conflict",
	"failed",
	"cancelled",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const mergeConflictSchema = z.object({
	taskId: z.string().min(1),
	files: z.array(z.string().min(1)),
});

export type MergeConflict = z.infer<typeof mergeConflictSchema>;

export const taskSchema = z.object({
	id: z.string().min(1),
	projectId: z.string().min(1),
	title: z.string().min(1),
	prompt: z.string().min(1),
	status: taskStatusSchema,
	position: z.number().int().nullable().default(null),
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
	"interrupted",
]);

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentRunSchema = z.object({
	id: z.string().min(1),
	taskId: z.string().min(1),
	sessionId: z.string().min(1).nullable(),
	status: agentRunStatusSchema,
	startedAt: z.iso.datetime().nullable(),
	completedAt: z.iso.datetime().nullable(),
	errorMessage: z.string().nullable(),
	errorCode: z.string().nullable(),
	recoveryAction: z.string().nullable(),
	retryOfRunId: z.string().min(1).nullable(),
});

export type AgentRun = z.infer<typeof agentRunSchema>;

export const permissionDecisionSchema = z.enum(["allow_once", "allow", "deny"]);

export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

export const permissionRequestStatusSchema = z.enum([
	"pending",
	"allow_once",
	"allow",
	"deny",
	"expired",
]);

export type PermissionRequestStatus = z.infer<
	typeof permissionRequestStatusSchema
>;

export const permissionRequestSchema = z.object({
	id: z.string().min(1),
	taskId: z.string().min(1),
	runId: z.string().min(1),
	command: z.string().min(1).max(2000),
	cwd: z.string().min(1).max(2000),
	reason: z.string().min(1).max(2000),
	status: permissionRequestStatusSchema,
	createdAt: z.iso.datetime(),
	decidedAt: z.iso.datetime().nullable(),
});

export type PermissionRequest = z.infer<typeof permissionRequestSchema>;
