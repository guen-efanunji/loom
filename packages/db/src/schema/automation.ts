import { relations, sql } from "drizzle-orm";
import {
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

export const plans = sqliteTable("plans", {
	id: text("id").primaryKey(),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	sourceMessageId: text("source_message_id").notNull().default(""),
	title: text("title").notNull(),
	summary: text("summary").notNull().default(""),
	status: text("status").notNull().default("draft"),
	convertedAt: integer("converted_at", { mode: "timestamp_ms" }),
	approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
	errorMessage: text("error_message"),
	createdAt: created(),
});

export const planTasks = sqliteTable(
	"plan_tasks",
	{
		id: text("id").primaryKey(),
		planId: text("plan_id")
			.notNull()
			.references(() => plans.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		title: text("title").notNull(),
		description: text("description").notNull().default(""),
		priority: text("priority").notNull().default("medium"),
		dependencies: text("dependencies").notNull().default("[]"),
		acceptanceCriteria: text("acceptance_criteria").notNull().default("[]"),
		suggestedFiles: text("suggested_files").notNull().default("[]"),
		parallelGroup: text("parallel_group"),
	},
	(t) => [uniqueIndex("plan_tasks_plan_key_uidx").on(t.planId, t.key)],
);

export const plansRelations = relations(plans, ({ many }) => ({
	tasks: many(planTasks),
}));

export const planTasksRelations = relations(planTasks, ({ one }) => ({
	plan: one(plans, {
		fields: [planTasks.planId],
		references: [plans.id],
	}),
}));
