import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects } from "./workflow";

const created = () =>
	integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`);

export const designNodes = sqliteTable("design_nodes", {
	id: text("id").primaryKey(),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	sessionId: text("session_id"),
	parentId: text("parent_id"),
	title: text("title").notNull().default("Untitled design"),
	brief: text("brief").notNull().default(""),
	status: text("status").notNull().default("queued"),
	viewport: text("viewport").notNull().default("desktop"),
	html: text("html").notNull().default(""),
	errorMessage: text("error_message"),
	durationMs: integer("duration_ms"),
	x: integer("x").notNull().default(0),
	y: integer("y").notNull().default(0),
	width: integer("width").notNull().default(420),
	height: integer("height").notNull().default(280),
	createdAt: created(),
	updatedAt: created(),
});

export const designMessages = sqliteTable("design_messages", {
	id: text("id").primaryKey(),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	nodeId: text("node_id"),
	role: text("role").notNull(),
	text: text("text").notNull().default(""),
	model: text("model"),
	errorMessage: text("error_message"),
	durationMs: integer("duration_ms"),
	createdAt: created(),
});
