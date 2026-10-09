import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects, tasks } from "./workflow";

const created = () =>
	integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`);
const updated = () =>
	integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`);

export const customAgents = sqliteTable("custom_agents", {
	id: text("id").primaryKey(),
	userId: text("user_id").notNull().default("local"),
	projectId: text("project_id").references(() => projects.id, {
		onDelete: "cascade",
	}),
	label: text("label").notNull(),
	role: text("role").notNull(),
	roleDescription: text("role_description"),
	provider: text("provider").notNull(),
	modelId: text("model_id"),
	effort: text("effort"),
	systemInstructions: text("system_instructions").notNull().default(""),
	status: text("status").notNull().default("active"),
	executionMode: text("execution_mode").notNull().default("on_demand"),
	allowChat: integer("allow_chat", { mode: "boolean" }).notNull().default(true),
	allowCanvas: integer("allow_canvas", { mode: "boolean" })
		.notNull()
		.default(false),
	allowKanban: integer("allow_kanban", { mode: "boolean" })
		.notNull()
		.default(true),
	approvalPolicy: text("approval_policy").notNull().default("ask_before_write"),
	maxRunDurationMinutes: integer("max_run_duration_minutes")
		.notNull()
		.default(30),
	maxRetries: integer("max_retries").notNull().default(1),
	maxTaskHops: integer("max_task_hops").notNull().default(3),
	fallbackProvider: text("fallback_provider"),
	fallbackModelId: text("fallback_model_id"),
	fallbackEnabled: integer("fallback_enabled", { mode: "boolean" })
		.notNull()
		.default(false),
	createdAt: created(),
	updatedAt: updated(),
	lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
});

export const customAgentSkills = sqliteTable("custom_agent_skills", {
	id: text("id").primaryKey(),
	agentId: text("agent_id")
		.notNull()
		.references(() => customAgents.id, { onDelete: "cascade" }),
	skillId: text("skill_id"),
	name: text("name").notNull(),
	source: text("source").notNull().default("custom"),
	instructions: text("instructions").notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	allowChat: integer("allow_chat", { mode: "boolean" }).notNull().default(true),
	allowCanvas: integer("allow_canvas", { mode: "boolean" })
		.notNull()
		.default(false),
	allowKanban: integer("allow_kanban", { mode: "boolean" })
		.notNull()
		.default(true),
	canReadFiles: integer("can_read_files", { mode: "boolean" })
		.notNull()
		.default(false),
	canWriteFiles: integer("can_write_files", { mode: "boolean" })
		.notNull()
		.default(false),
	canRunTests: integer("can_run_tests", { mode: "boolean" })
		.notNull()
		.default(false),
	canUseNetwork: integer("can_use_network", { mode: "boolean" })
		.notNull()
		.default(false),
	sortOrder: integer("sort_order").notNull().default(0),
	createdAt: created(),
	updatedAt: updated(),
});

export const customAgentAssignments = sqliteTable("custom_agent_assignments", {
	id: text("id").primaryKey(),
	agentId: text("agent_id")
		.notNull()
		.references(() => customAgents.id, { onDelete: "cascade" }),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
	status: text("status").notNull().default("active"),
	continuousEnabled: integer("continuous_enabled", { mode: "boolean" })
		.notNull()
		.default(false),
	lastRunId: text("last_run_id"),
	createdAt: created(),
	updatedAt: updated(),
});

export const customAgentRuns = sqliteTable("custom_agent_runs", {
	id: text("id").primaryKey(),
	agentId: text("agent_id")
		.notNull()
		.references(() => customAgents.id, { onDelete: "cascade" }),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
	chatSessionId: text("chat_session_id"),
	canvasDesignId: text("canvas_design_id"),
	provider: text("provider").notNull(),
	modelId: text("model_id"),
	fallbackFromRunId: text("fallback_from_run_id"),
	status: text("status").notNull().default("queued"),
	trigger: text("trigger").notNull(),
	inputSummary: text("input_summary").notNull(),
	outputSummary: text("output_summary"),
	startedAt: integer("started_at", { mode: "timestamp_ms" }),
	finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	errorClass: text("error_class"),
	errorMessage: text("error_message"),
	createdAt: created(),
});

export const customAgentRunEvents = sqliteTable("custom_agent_run_events", {
	id: text("id").primaryKey(),
	runId: text("run_id")
		.notNull()
		.references(() => customAgentRuns.id, { onDelete: "cascade" }),
	type: text("type").notNull(),
	message: text("message").notNull(),
	createdAt: created(),
});
