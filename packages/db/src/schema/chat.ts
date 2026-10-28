import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { projects } from "./workflow";

export const providerChatHistory = sqliteTable("provider_chat_history", {
	sessionId: text("session_id").primaryKey(),
	messages: text("messages").notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
});

/**
 * Git worktree bound to a single chat session so several tabs can run agents on
 * the same project without sharing one checkout. `branch`/`path` are Loom
 * managed, and the row is removed once the session is deleted.
 */
export const chatWorkspaces = sqliteTable(
	"chat_workspaces",
	{
		sessionId: text("session_id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		/**
		 * Loom-owned key that names the worktree path and branch. It is generated
		 * before the provider session exists, so it cannot be the session id.
		 */
		taskId: text("task_id").notNull(),
		path: text("path").notNull(),
		branch: text("branch").notNull(),
		baseCommit: text("base_commit").notNull(),
		/** `active` while the session works in isolation, `merged` after intake. */
		status: text("status").notNull().default("active"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		index("chat_workspaces_project_id_idx").on(table.projectId),
		uniqueIndex("chat_workspaces_task_id_uidx").on(table.taskId),
	],
);
