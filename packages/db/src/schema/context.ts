import { relations, sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./workflow";

const created = () =>
	integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`);

export const contextEntries = sqliteTable(
	"context_entries",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull().default("local"),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		kind: text("kind").notNull(),
		title: text("title").notNull(),
		description: text("description").notNull().default(""),
		content: text("content").notNull().default(""),
		scope: text("scope").notNull().default("project"),
		sourceKind: text("source_kind").notNull().default("authored"),
		sourceRef: text("source_ref"),
		nativeRuntime: text("native_runtime"),
		compatibility: text("compatibility").notNull().default("untested"),
		status: text("status").notNull().default("active"),
		enabledInLoom: integer("enabled_in_loom", { mode: "boolean" })
			.notNull()
			.default(true),
		surfaces: text("surfaces").notNull().default("[]"),
		pathGlobs: text("path_globs").notNull().default("[]"),
		tags: text("tags").notNull().default("[]"),
		contentHash: text("content_hash").notNull(),
		currentVersion: integer("current_version").notNull().default(1),
		createdAt: created(),
		updatedAt: created(),
	},
	(table) => [
		index("context_entries_scope_kind_status_idx").on(
			table.userId,
			table.projectId,
			table.kind,
			table.status,
		),
	],
);

export const contextVersions = sqliteTable(
	"context_versions",
	{
		id: text("id").primaryKey(),
		entryId: text("entry_id")
			.notNull()
			.references(() => contextEntries.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		content: text("content").notNull(),
		contentHash: text("content_hash").notNull(),
		metadata: text("metadata").notNull().default("{}"),
		createdAt: created(),
	},
	(table) => [
		uniqueIndex("context_versions_entry_version_uidx").on(
			table.entryId,
			table.version,
		),
		index("context_versions_entry_idx").on(table.entryId),
	],
);

export const contextEntriesRelations = relations(
	contextEntries,
	({ many }) => ({
		versions: many(contextVersions),
	}),
);

export const contextVersionsRelations = relations(
	contextVersions,
	({ one }) => ({
		entry: one(contextEntries, {
			fields: [contextVersions.entryId],
			references: [contextEntries.id],
		}),
	}),
);

export const contextMemoryDecisions = sqliteTable(
	"context_memory_decisions",
	{
		id: text("id").primaryKey(),
		entryId: text("entry_id")
			.notNull()
			.references(() => contextEntries.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		proposedBy: text("proposed_by").notNull(),
		decidedBy: text("decided_by"),
		decision: text("decision").notNull(),
		supersedesId: text("supersedes_id"),
		lastVerifiedAt: integer("last_verified_at", { mode: "timestamp_ms" }),
		createdAt: created(),
	},
	(table) => [
		index("context_memory_decisions_entry_idx").on(
			table.entryId,
			table.createdAt,
		),
	],
);

export const contextMemoryEvidence = sqliteTable(
	"context_memory_evidence",
	{
		id: text("id").primaryKey(),
		entryId: text("entry_id")
			.notNull()
			.references(() => contextEntries.id, { onDelete: "cascade" }),
		sourceType: text("source_type").notNull(),
		sourceId: text("source_id").notNull(),
		sourceHash: text("source_hash"),
		verificationStatus: text("verification_status")
			.notNull()
			.default("unverified"),
		createdAt: created(),
	},
	(table) => [index("context_memory_evidence_entry_idx").on(table.entryId)],
);
