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
		workspaceId: text("workspace_id"),
		sessionId: text("session_id"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		errorMessage: text("error_message"),
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
	},
	(table) => [index("agent_runs_task_id_idx").on(table.taskId)],
);

export const projectsRelations = relations(projects, ({ many }) => ({
	tasks: many(tasks),
	workspaces: many(workspaces),
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

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
	task: one(tasks, {
		fields: [agentRuns.taskId],
		references: [tasks.id],
	}),
}));
