import { z } from "zod";

export const planTaskSchema = z.object({
	key: z
		.string()
		.trim()
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
	title: z.string().trim().min(1).max(200),
	prompt: z.string().trim().min(1).max(20000),
	dependsOn: z.array(z.string().min(1)).max(100),
});
export const taskPlanSchema = z.object({
	tasks: z.array(planTaskSchema).min(1).max(100),
});
export type TaskPlan = z.infer<typeof taskPlanSchema>;
export const projectContextSchema = z.object({
	summary: z.string().max(16000),
	architecture: z.string().max(8000).optional(),
	conventions: z.string().max(8000).optional(),
	commands: z.object({
		install: z.string().max(1000).optional(),
		lint: z.string().max(1000).optional(),
		test: z.string().max(1000).optional(),
		build: z.string().max(1000).optional(),
	}),
});
export type ProjectContext = z.infer<typeof projectContextSchema>;
export const newEpicSchema = z.object({
	projectId: z.string().min(1),
	title: z.string().trim().min(1).max(200),
	goal: z.string().trim().min(1).max(20000),
});
export const artifactInputSchema = z.object({
	type: z.enum([
		"api-contract",
		"schema",
		"decision",
		"documentation",
		"custom",
	]),
	path: z
		.string()
		.min(1)
		.max(1000)
		.refine(
			(p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."),
			"Artifact path must be relative to the workspace",
		),
	summary: z.string().trim().min(1).max(2000),
});
export type TaskArtifact = z.infer<typeof artifactInputSchema> & {
	id: string;
	taskId: string;
};
export type TaskDependency = { taskId: string; dependsOnTaskId: string };
export type Epic = {
	id: string;
	projectId: string;
	title: string;
	prompt: string;
	status: "planning" | "ready" | "running" | "completed" | "failed";
	createdAt: string;
	errorMessage: string | null;
	plan: TaskPlan | null;
	context: ProjectContext | null;
	approvedAt: string | null;
};
export type IntegrationCheck = {
	name: string;
	command: string;
	exitCode: number;
	output: string;
};
export type IntegrationRun = {
	id: string;
	epicId: string;
	status:
		| "merging"
		| "checking"
		| "failed"
		| "resolving"
		| "review"
		| "completed";
	workspacePath: string | null;
	branch: string | null;
	baseCommit: string | null;
	head: string | null;
	errorMessage: string | null;
	checks: IntegrationCheck[];
	diff: string;
	sessionId: string | null;
	createdAt: string;
	approvedAt: string | null;
};
export type PlannerRun = {
	id: string;
	epicId: string;
	sessionId: string | null;
	status: string;
	errorMessage: string | null;
	createdAt: string;
};
export type AuditEvent = {
	id: string;
	epicId: string;
	type: string;
	detail: string;
	createdAt: string;
};
