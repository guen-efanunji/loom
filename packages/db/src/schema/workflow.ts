import { relations, sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		path: text("path").notNull(),
		defaultBranch: text("default_branch").notNull(),
		autoAccept: integer("auto_accept", { mode: "boolean" })
			.notNull()
			.default(false),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [uniqueIndex("projects_path_uidx").on(table.path)],
);

export const tasks = sqliteTable(
	"tasks",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		prompt: text("prompt").notNull(),
		status: text("status").notNull().default("queued"),
		position: integer("position"),
		planId: text("plan_id"),
		description: text("description").notNull().default(""),
		priority: text("priority").notNull().default("medium"),
		acceptanceCriteria: text("acceptance_criteria").notNull().default("[]"),
		suggestedFiles: text("suggested_files").notNull().default("[]"),
		source: text("source").notNull().default("manual"),
		workspaceId: text("workspace_id"),
		sessionId: text("session_id"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		errorMessage: text("error_message"),
		mergeConflictFiles: text("merge_conflict_files"),
	},
	(table) => [index("tasks_project_id_idx").on(table.projectId)],
);

export const workspaces = sqliteTable(
	"workspaces",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		branch: text("branch").notNull(),
		baseCommit: text("base_commit").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("workspaces_task_id_uidx").on(table.taskId),
		index("workspaces_project_id_idx").on(table.projectId),
	],
);

export const agentRuns = sqliteTable(
	"agent_runs",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		sessionId: text("session_id"),
		status: text("status").notNull().default("queued"),
		startedAt: integer("started_at", { mode: "timestamp_ms" }),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		errorMessage: text("error_message"),
		errorCode: text("error_code"),
		recoveryAction: text("recovery_action"),
		retryOfRunId: text("retry_of_run_id"),
	},
	(table) => [
		index("agent_runs_task_id_idx").on(table.taskId),
		index("agent_runs_status_idx").on(table.status),
	],
);

export const permissionRequests = sqliteTable(
	"permission_requests",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		runId: text("run_id")
			.notNull()
			.references(() => agentRuns.id, { onDelete: "cascade" }),
		command: text("command").notNull(),
		cwd: text("cwd").notNull(),
		reason: text("reason").notNull(),
		status: text("status").notNull().default("pending"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		index("permission_requests_run_id_idx").on(table.runId),
		index("permission_requests_status_idx").on(table.status),
	],
);

export const projectsRelations = relations(projects, ({ many }) => ({
	tasks: many(tasks),
	workspaces: many(workspaces),
	permissionRequests: many(permissionRequests),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
	project: one(projects, {
		fields: [tasks.projectId],
		references: [projects.id],
	}),
	workspace: one(workspaces, {
		fields: [tasks.workspaceId],
		references: [workspaces.id],
	}),
	runs: many(agentRuns),
	permissionRequests: many(permissionRequests),
}));

export const workspacesRelations = relations(workspaces, ({ one }) => ({
	task: one(tasks, {
		fields: [workspaces.taskId],
		references: [tasks.id],
	}),
	project: one(projects, {
		fields: [workspaces.projectId],
		references: [projects.id],
	}),
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
	task: one(tasks, {
		fields: [agentRuns.taskId],
		references: [tasks.id],
	}),
	permissionRequests: many(permissionRequests),
}));

export const permissionRequestsRelations = relations(
	permissionRequests,
	({ one }) => ({
		task: one(tasks, {
			fields: [permissionRequests.taskId],
			references: [tasks.id],
		}),
		run: one(agentRuns, {
			fields: [permissionRequests.runId],
			references: [agentRuns.id],
		}),
	}),
);
