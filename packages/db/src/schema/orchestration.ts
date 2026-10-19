import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects, tasks } from "./workflow";

export const orchestrationEvents = sqliteTable(
	"orchestration_events",
	{
		cursor: integer("cursor").primaryKey({ autoIncrement: true }),
		scopeId: text("scope_id").notNull().default("global"),
		type: text("type").notNull(),
		payloadRedacted: text("payload_redacted").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
	},
	(table) => [
		index("orchestration_events_scope_cursor_idx").on(
			table.scopeId,
			table.cursor,
		),
	],
);

export const taskDependencies = sqliteTable(
	"task_dependencies",
	{
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		dependsOnTaskId: text("depends_on_task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		requiredMilestone: text("required_milestone")
			.notNull()
			.default("implementation_ready"),
		artifactId: text("artifact_id"),
	},
	(t) => [
		uniqueIndex("task_dependencies_uidx").on(t.taskId, t.dependsOnTaskId),
	],
);

export const integrationLeases = sqliteTable(
	"integration_leases",
	{
		projectId: text("project_id").notNull(),
		targetBranch: text("target_branch").notNull(),
		owner: text("owner").notNull(),
		expiresAt: integer("expires_at").notNull(),
		heartbeatAt: integer("heartbeat_at").notNull(),
	},
	(table) => [
		uniqueIndex("integration_leases_project_branch_uidx").on(
			table.projectId,
			table.targetBranch,
		),
	],
);

export const schedulerResourceLeases = sqliteTable(
	"scheduler_resource_leases",
	{
		resourceKey: text("resource_key").notNull(),
		taskId: text("task_id").notNull(),
		owner: text("owner").notNull(),
		expiresAt: integer("expires_at").notNull(),
		heartbeatAt: integer("heartbeat_at").notNull(),
	},
	(table) => [
		uniqueIndex("scheduler_resource_leases_key_task_uidx").on(
			table.resourceKey,
			table.taskId,
		),
		index("scheduler_resource_leases_key_expiry_idx").on(
			table.resourceKey,
			table.expiresAt,
		),
		index("scheduler_resource_leases_task_idx").on(table.taskId),
	],
);

export const reviewPolicies = sqliteTable(
	"review_policies",
	{
		id: text("id").primaryKey().notNull(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		mode: text("mode").notNull().default("hybrid"),
		reviewerExecutorJson: text("reviewer_executor_json"),
		autoMerge: integer("auto_merge", { mode: "boolean" })
			.notNull()
			.default(false),
		requiredChecksJson: text("required_checks_json").notNull().default("[]"),
		maxRevisionRounds: integer("max_revision_rounds").notNull().default(2),
		version: integer("version").notNull().default(1),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
	},
	(table) => [uniqueIndex("review_policies_project_uidx").on(table.projectId)],
);

export const integrationBatches = sqliteTable(
	"integration_batches",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		targetBranch: text("target_branch").notNull(),
		targetBaseSha: text("target_base_sha").notNull(),
		candidateSha: text("candidate_sha"),
		promotedSha: text("promoted_sha"),
		requiredChecksJson: text("required_checks_json").notNull().default("[]"),
		status: text("status").notNull().default("assembling"),
		workspacePath: text("workspace_path"),
		workspaceBranch: text("workspace_branch"),
		errorMessage: text("error_message"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		index("integration_batches_project_status_idx").on(
			table.projectId,
			table.status,
		),
	],
);

export const integrationBatchChecks = sqliteTable(
	"integration_batch_checks",
	{
		id: text("id").primaryKey(),
		batchId: text("batch_id")
			.notNull()
			.references(() => integrationBatches.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		commandRedacted: text("command_redacted").notNull(),
		status: text("status").notNull(),
		exitCode: integer("exit_code"),
		evidenceHash: text("evidence_hash").notNull(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("integration_batch_checks_batch_idx").on(
			table.batchId,
			table.startedAt,
		),
	],
);

export const integrationBatchMembers = sqliteTable(
	"integration_batch_members",
	{
		batchId: text("batch_id")
			.notNull()
			.references(() => integrationBatches.id, { onDelete: "cascade" }),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		runId: text("run_id"),
		outputSha: text("output_sha").notNull(),
		mergeOrder: integer("merge_order").notNull(),
	},
	(table) => [
		uniqueIndex("integration_batch_members_batch_task_uidx").on(
			table.batchId,
			table.taskId,
		),
		uniqueIndex("integration_batch_members_batch_order_uidx").on(
			table.batchId,
			table.mergeOrder,
		),
	],
);

export const integrationBatchReviews = sqliteTable(
	"integration_batch_reviews",
	{
		id: text("id").primaryKey(),
		batchId: text("batch_id")
			.notNull()
			.references(() => integrationBatches.id, { onDelete: "cascade" }),
		reviewerIdentity: text("reviewer_identity").notNull(),
		baseSha: text("base_sha").notNull(),
		subjectSha: text("subject_sha").notNull(),
		evidenceHash: text("evidence_hash").notNull(),
		status: text("status").notNull(),
		verdictJson: text("verdict_json").notNull(),
		policyVersion: integer("policy_version").notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		index("integration_batch_reviews_batch_created_idx").on(
			table.batchId,
			table.createdAt,
		),
	],
);

export const taskReviews = sqliteTable(
	"task_reviews",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		runId: text("run_id"),
		reviewerIdentity: text("reviewer_identity").notNull(),
		baseSha: text("base_sha").notNull(),
		subjectSha: text("subject_sha").notNull(),
		evidenceHash: text("evidence_hash").notNull(),
		status: text("status").notNull().default("approved"),
		verdictJson: text("verdict_json")
			.notNull()
			.default('{"decision":"approve"}'),
		policyVersion: integer("policy_version").notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		decidedAt: integer("decided_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		index("task_reviews_task_created_idx").on(table.taskId, table.createdAt),
	],
);

export const taskArtifacts = sqliteTable(
	"task_artifacts",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		producerRunId: text("producer_run_id"),
		kind: text("kind").notNull(),
		version: text("version").notNull(),
		commitSha: text("commit_sha").notNull(),
		relativePath: text("relative_path").notNull(),
		contentHash: text("content_hash").notNull(),
		status: text("status").notNull().default("ready"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		index("task_artifacts_task_idx").on(table.taskId),
		uniqueIndex("task_artifacts_task_kind_version_uidx").on(
			table.taskId,
			table.kind,
			table.version,
		),
	],
);
