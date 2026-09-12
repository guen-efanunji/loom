import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects, tasks } from "./workflow";
const created = () => integer("created_at", { mode: "timestamp_ms" }).notNull().default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`);
export const epics = sqliteTable("epics", {
 id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
 title: text("title").notNull(), prompt: text("prompt").notNull(), status: text("status").notNull().default("planning"),
 plan: text("plan"), context: text("context"), errorMessage: text("error_message"), approvedAt: integer("approved_at", { mode: "timestamp_ms" }), createdAt: created(),
});
export const epicTasks = sqliteTable("epic_tasks", {
 taskId: text("task_id").primaryKey().references(() => tasks.id, { onDelete: "cascade" }),
 epicId: text("epic_id").notNull().references(() => epics.id, { onDelete: "cascade" }), key: text("key").notNull(),
}, t => [uniqueIndex("epic_tasks_key_uidx").on(t.epicId, t.key)]);
export const taskDependencies = sqliteTable("task_dependencies", {
 taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }), dependsOnTaskId: text("depends_on_task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
}, t => [uniqueIndex("task_dependencies_uidx").on(t.taskId, t.dependsOnTaskId)]);
export const taskArtifacts = sqliteTable("task_artifacts", {
 id: text("id").primaryKey(), taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }), type: text("type").notNull(), path: text("path").notNull(), summary: text("summary").notNull(),
});
export const plannerRuns = sqliteTable("planner_runs", {
 id: text("id").primaryKey(), epicId: text("epic_id").notNull().references(() => epics.id, { onDelete: "cascade" }), sessionId: text("session_id"), status: text("status").notNull(), errorMessage: text("error_message"), createdAt: created(),
});
export const integrationRuns = sqliteTable("integration_runs", {
 id: text("id").primaryKey(), epicId: text("epic_id").notNull().references(() => epics.id, { onDelete: "cascade" }), status: text("status").notNull(), workspacePath: text("workspace_path"), branch: text("branch"), baseCommit: text("base_commit"), head: text("head"), errorMessage: text("error_message"), checks: text("checks").notNull().default("[]"), diff: text("diff").notNull().default(""), sessionId: text("session_id"), approvedAt: integer("approved_at", { mode: "timestamp_ms" }), createdAt: created(),
});
export const auditEvents = sqliteTable("audit_events", {
 id: text("id").primaryKey(), epicId: text("epic_id").notNull().references(() => epics.id, { onDelete: "cascade" }), type: text("type").notNull(), detail: text("detail").notNull(), createdAt: created(),
});
