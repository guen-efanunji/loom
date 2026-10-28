import { Database } from "bun:sqlite";

const schemaStatements = [
	"CREATE TABLE IF NOT EXISTS orchestration_events (cursor integer PRIMARY KEY AUTOINCREMENT NOT NULL, scope_id text NOT NULL DEFAULT 'global', type text NOT NULL, payload_redacted text NOT NULL, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS orchestration_events_scope_cursor_idx ON orchestration_events(scope_id, cursor)",
	"CREATE TABLE IF NOT EXISTS managed_mcp_connections (id text PRIMARY KEY NOT NULL, label text NOT NULL, transport text NOT NULL, config_json text NOT NULL, status text NOT NULL DEFAULT 'disconnected', protocol_version text, capabilities_json text NOT NULL DEFAULT '{}', tools_json text NOT NULL DEFAULT '[]', last_connected_at integer, last_tested_at integer, last_error text, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS managed_mcp_connections_status_idx ON managed_mcp_connections(status)",
	"PRAGMA foreign_keys = ON",
	"CREATE TABLE IF NOT EXISTS user (id text PRIMARY KEY NOT NULL, name text NOT NULL, email text NOT NULL UNIQUE, email_verified integer DEFAULT 0 NOT NULL, image text, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY NOT NULL, expires_at integer NOT NULL, token text NOT NULL UNIQUE, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, ip_address text, user_agent text, user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE)",
	"CREATE INDEX IF NOT EXISTS session_userId_idx ON session (user_id)",
	"CREATE TABLE IF NOT EXISTS account (id text PRIMARY KEY NOT NULL, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE, access_token text, refresh_token text, id_token text, access_token_expires_at integer, refresh_token_expires_at integer, scope text, password text, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
	"CREATE UNIQUE INDEX IF NOT EXISTS account_providerId_accountId_uidx ON account (provider_id, account_id)",
	"CREATE INDEX IF NOT EXISTS account_userId_idx ON account (user_id)",
	"CREATE TABLE IF NOT EXISTS verification (id text PRIMARY KEY NOT NULL, identifier text NOT NULL, value text NOT NULL, expires_at integer NOT NULL, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
	"CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier)",
	"CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY NOT NULL, name text NOT NULL, path text NOT NULL, default_branch text NOT NULL, auto_accept integer DEFAULT 0 NOT NULL, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
	"CREATE UNIQUE INDEX IF NOT EXISTS projects_path_uidx ON projects (path)",
	"CREATE TABLE IF NOT EXISTS tasks (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title text NOT NULL, prompt text NOT NULL, status text DEFAULT 'queued' NOT NULL, workspace_id text, session_id text, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, started_at integer, completed_at integer, error_message text, merge_conflict_files text, position integer, plan_id text REFERENCES plans(id) ON DELETE SET NULL, description text NOT NULL DEFAULT '', priority text NOT NULL DEFAULT 'medium', acceptance_criteria text NOT NULL DEFAULT '[]', suggested_files text NOT NULL DEFAULT '[]', source text NOT NULL DEFAULT 'manual', executor_config text, target_branch text, lease_owner text, lease_expires_at integer, heartbeat_at integer)",
	"CREATE TABLE IF NOT EXISTS plans (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source_message_id text NOT NULL DEFAULT '', source_message text NOT NULL DEFAULT '', source_session_id text, automation_mode text NOT NULL DEFAULT 'review', title text NOT NULL, summary text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', converted_at integer, approved_at integer, started_at integer, cancelled_at integer, error_message text, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE TABLE IF NOT EXISTS plan_tasks (id text PRIMARY KEY NOT NULL, plan_id text NOT NULL REFERENCES plans(id) ON DELETE CASCADE, key text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '', priority text NOT NULL DEFAULT 'medium', dependencies text NOT NULL DEFAULT '[]', acceptance_criteria text NOT NULL DEFAULT '[]', suggested_files text NOT NULL DEFAULT '[]', parallel_group text)",
	"CREATE UNIQUE INDEX IF NOT EXISTS plan_tasks_plan_key_uidx ON plan_tasks (plan_id, key)",
	"CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks (project_id)",
	"CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, path text NOT NULL, branch text NOT NULL, base_commit text NOT NULL, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
	"CREATE UNIQUE INDEX IF NOT EXISTS workspaces_task_id_uidx ON workspaces (task_id)",
	"CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces (project_id)",
	"CREATE TABLE IF NOT EXISTS agent_runs (id text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, session_id text, status text DEFAULT 'queued' NOT NULL, started_at integer, completed_at integer, error_message text, error_code text, recovery_action text, retry_of_run_id text, executor_snapshot_json text, snapshot_hash text, effective_provider text, effective_model text, attempt_number integer NOT NULL DEFAULT 1, base_sha text, output_sha text)",
	"CREATE INDEX IF NOT EXISTS agent_runs_task_id_idx ON agent_runs (task_id)",
	"CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs (status)",
	"CREATE TABLE IF NOT EXISTS permission_requests (id text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, command text NOT NULL, cwd text NOT NULL, reason text NOT NULL, status text DEFAULT 'pending' NOT NULL, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, decided_at integer)",
	"CREATE INDEX IF NOT EXISTS permission_requests_run_id_idx ON permission_requests (run_id)",
	"CREATE INDEX IF NOT EXISTS permission_requests_status_idx ON permission_requests (status)",
	"CREATE TABLE IF NOT EXISTS task_dependencies (task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, depends_on_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, required_milestone text NOT NULL DEFAULT 'implementation_ready')",
	"CREATE UNIQUE INDEX IF NOT EXISTS task_dependencies_uidx ON task_dependencies(task_id, depends_on_task_id)",
	"CREATE TABLE IF NOT EXISTS integration_leases (project_id text NOT NULL, target_branch text NOT NULL, owner text NOT NULL, expires_at integer NOT NULL, heartbeat_at integer NOT NULL, UNIQUE(project_id, target_branch))",
	"CREATE TABLE IF NOT EXISTS scheduler_resource_leases (resource_key text NOT NULL, task_id text NOT NULL, owner text NOT NULL, expires_at integer NOT NULL, heartbeat_at integer NOT NULL, UNIQUE(resource_key, task_id))",
	"CREATE INDEX IF NOT EXISTS scheduler_resource_leases_key_expiry_idx ON scheduler_resource_leases(resource_key, expires_at)",
	"CREATE INDEX IF NOT EXISTS scheduler_resource_leases_task_idx ON scheduler_resource_leases(task_id)",
	"CREATE TABLE IF NOT EXISTS review_policies (id text PRIMARY KEY NOT NULL, project_id text NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE, mode text NOT NULL DEFAULT 'hybrid', reviewer_executor_json text, auto_merge integer NOT NULL DEFAULT 0, required_checks_json text NOT NULL DEFAULT '[]', max_revision_rounds integer NOT NULL DEFAULT 2, version integer NOT NULL DEFAULT 1, updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE TABLE IF NOT EXISTS integration_batches (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, target_branch text NOT NULL, target_base_sha text NOT NULL, candidate_sha text, promoted_sha text, required_checks_json text NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'assembling', workspace_path text, workspace_branch text, error_message text, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS integration_batches_project_status_idx ON integration_batches(project_id, status)",
	"CREATE TABLE IF NOT EXISTS integration_batch_checks (id text PRIMARY KEY NOT NULL, batch_id text NOT NULL REFERENCES integration_batches(id) ON DELETE CASCADE, name text NOT NULL, command_redacted text NOT NULL, status text NOT NULL, exit_code integer, evidence_hash text NOT NULL, started_at integer NOT NULL, finished_at integer NOT NULL)",
	"CREATE INDEX IF NOT EXISTS integration_batch_checks_batch_idx ON integration_batch_checks(batch_id, started_at)",
	"CREATE TABLE IF NOT EXISTS integration_batch_members (batch_id text NOT NULL REFERENCES integration_batches(id) ON DELETE CASCADE, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, run_id text, output_sha text NOT NULL, merge_order integer NOT NULL, UNIQUE(batch_id, task_id), UNIQUE(batch_id, merge_order))",
	"CREATE TABLE IF NOT EXISTS integration_batch_reviews (id text PRIMARY KEY NOT NULL, batch_id text NOT NULL REFERENCES integration_batches(id) ON DELETE CASCADE, reviewer_identity text NOT NULL, base_sha text NOT NULL, subject_sha text NOT NULL, evidence_hash text NOT NULL, status text NOT NULL, verdict_json text NOT NULL, policy_version integer NOT NULL DEFAULT 1, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS integration_batch_reviews_batch_created_idx ON integration_batch_reviews(batch_id, created_at)",
	"CREATE TABLE IF NOT EXISTS task_artifacts (id text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, producer_run_id text, kind text NOT NULL, version text NOT NULL, commit_sha text NOT NULL, relative_path text NOT NULL, content_hash text NOT NULL, status text NOT NULL DEFAULT 'ready', created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS task_artifacts_task_idx ON task_artifacts(task_id)",
	"CREATE TABLE IF NOT EXISTS task_reviews (id text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, run_id text, reviewer_identity text NOT NULL, base_sha text NOT NULL, subject_sha text NOT NULL, evidence_hash text NOT NULL, status text NOT NULL DEFAULT 'approved', verdict_json text NOT NULL DEFAULT '{\"decision\":\"approve\"}', policy_version integer NOT NULL DEFAULT 1, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), decided_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS task_reviews_task_created_idx ON task_reviews(task_id, created_at)",
	"CREATE TABLE IF NOT EXISTS design_nodes (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, session_id text, parent_id text, title text NOT NULL DEFAULT 'Untitled design', brief text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'queued', viewport text NOT NULL DEFAULT 'desktop', frame_kind text NOT NULL DEFAULT 'desktop', frame_width integer NOT NULL DEFAULT 1440, frame_height integer NOT NULL DEFAULT 900, html text NOT NULL DEFAULT '', error_message text, duration_ms integer, x integer NOT NULL DEFAULT 0, y integer NOT NULL DEFAULT 0, width integer NOT NULL DEFAULT 420, height integer NOT NULL DEFAULT 280, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS design_nodes_project_id_idx ON design_nodes (project_id)",
	"CREATE TABLE IF NOT EXISTS design_messages (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, node_id text, role text NOT NULL, text text NOT NULL DEFAULT '', model text, error_message text, duration_ms integer, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS design_messages_project_id_idx ON design_messages (project_id)",
	"CREATE TABLE IF NOT EXISTS provider_chat_history (session_id text PRIMARY KEY NOT NULL, messages text NOT NULL, updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE TABLE IF NOT EXISTS chat_workspaces (session_id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, task_id text NOT NULL, path text NOT NULL, branch text NOT NULL, base_commit text NOT NULL, status text NOT NULL DEFAULT 'active', created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS chat_workspaces_project_id_idx ON chat_workspaces (project_id)",
	"CREATE UNIQUE INDEX IF NOT EXISTS chat_workspaces_task_id_uidx ON chat_workspaces (task_id)",
	"CREATE TABLE IF NOT EXISTS context_entries (id text PRIMARY KEY NOT NULL, user_id text NOT NULL DEFAULT 'local', project_id text REFERENCES projects(id) ON DELETE CASCADE, kind text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '', content text NOT NULL DEFAULT '', scope text NOT NULL DEFAULT 'project', source_kind text NOT NULL DEFAULT 'authored', source_ref text, native_runtime text, compatibility text NOT NULL DEFAULT 'untested', status text NOT NULL DEFAULT 'active', enabled_in_loom integer NOT NULL DEFAULT 1, surfaces text NOT NULL DEFAULT '[]', path_globs text NOT NULL DEFAULT '[]', tags text NOT NULL DEFAULT '[]', content_hash text NOT NULL, current_version integer NOT NULL DEFAULT 1, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE TABLE IF NOT EXISTS context_versions (id text PRIMARY KEY NOT NULL, entry_id text NOT NULL REFERENCES context_entries(id) ON DELETE CASCADE, version integer NOT NULL, content text NOT NULL, content_hash text NOT NULL, metadata text NOT NULL DEFAULT '{}', created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE UNIQUE INDEX IF NOT EXISTS context_versions_entry_version_uidx ON context_versions(entry_id, version)",
	"CREATE INDEX IF NOT EXISTS context_versions_entry_idx ON context_versions(entry_id)",
	"CREATE TABLE IF NOT EXISTS context_memory_decisions (id text PRIMARY KEY NOT NULL, entry_id text NOT NULL REFERENCES context_entries(id) ON DELETE CASCADE, version integer NOT NULL, proposed_by text NOT NULL, decided_by text, decision text NOT NULL, supersedes_id text, last_verified_at integer, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS context_memory_decisions_entry_idx ON context_memory_decisions(entry_id, created_at)",
	"CREATE TABLE IF NOT EXISTS context_memory_evidence (id text PRIMARY KEY NOT NULL, entry_id text NOT NULL REFERENCES context_entries(id) ON DELETE CASCADE, source_type text NOT NULL, source_id text NOT NULL, source_hash text, verification_status text NOT NULL DEFAULT 'unverified', created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS context_memory_evidence_entry_idx ON context_memory_evidence(entry_id)",
	"CREATE TABLE IF NOT EXISTS custom_agents (id text PRIMARY KEY NOT NULL, user_id text NOT NULL DEFAULT 'local', project_id text REFERENCES projects(id) ON DELETE CASCADE, label text NOT NULL, role text NOT NULL, role_description text, provider text NOT NULL, model_id text, effort text, system_instructions text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active', execution_mode text NOT NULL DEFAULT 'on_demand', allow_chat integer NOT NULL DEFAULT 1, allow_canvas integer NOT NULL DEFAULT 0, allow_kanban integer NOT NULL DEFAULT 1, approval_policy text NOT NULL DEFAULT 'ask_before_write', max_run_duration_minutes integer NOT NULL DEFAULT 30, max_retries integer NOT NULL DEFAULT 1, max_task_hops integer NOT NULL DEFAULT 3, fallback_provider text, fallback_model_id text, fallback_enabled integer NOT NULL DEFAULT 0, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), last_used_at integer)",
	"CREATE UNIQUE INDEX IF NOT EXISTS custom_agents_scope_label_uidx ON custom_agents (user_id, ifnull(project_id, ''), label COLLATE NOCASE)",
	"CREATE TABLE IF NOT EXISTS custom_agent_skills (id text PRIMARY KEY NOT NULL, agent_id text NOT NULL REFERENCES custom_agents(id) ON DELETE CASCADE, skill_id text, name text NOT NULL, source text NOT NULL DEFAULT 'custom', instructions text NOT NULL, enabled integer NOT NULL DEFAULT 1, allow_chat integer NOT NULL DEFAULT 1, allow_canvas integer NOT NULL DEFAULT 0, allow_kanban integer NOT NULL DEFAULT 1, can_read_files integer NOT NULL DEFAULT 0, can_write_files integer NOT NULL DEFAULT 0, can_run_tests integer NOT NULL DEFAULT 0, can_use_network integer NOT NULL DEFAULT 0, sort_order integer NOT NULL DEFAULT 0, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS custom_agent_skills_agent_idx ON custom_agent_skills(agent_id)",
	"CREATE TABLE IF NOT EXISTS custom_agent_assignments (id text PRIMARY KEY NOT NULL, agent_id text NOT NULL REFERENCES custom_agents(id) ON DELETE CASCADE, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, task_id text REFERENCES tasks(id) ON DELETE CASCADE, status text NOT NULL DEFAULT 'active', continuous_enabled integer NOT NULL DEFAULT 0, last_run_id text, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS custom_agent_assignments_task_idx ON custom_agent_assignments(task_id)",
	"CREATE TABLE IF NOT EXISTS custom_agent_assignment_runs (id text PRIMARY KEY NOT NULL, assignment_id text NOT NULL REFERENCES custom_agent_assignments(id) ON DELETE CASCADE, idempotency_key text NOT NULL, task_ids_json text NOT NULL, status text NOT NULL DEFAULT 'queued', max_tasks integer NOT NULL, concurrency integer NOT NULL, duration_ms integer NOT NULL, completed_tasks integer NOT NULL DEFAULT 0, current_task_ids_json text NOT NULL DEFAULT '[]', error_message text, started_at integer, finished_at integer, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE UNIQUE INDEX IF NOT EXISTS custom_agent_assignment_runs_idempotency_uidx ON custom_agent_assignment_runs(assignment_id, idempotency_key)",
	"CREATE UNIQUE INDEX IF NOT EXISTS custom_agent_assignment_runs_active_uidx ON custom_agent_assignment_runs(assignment_id) WHERE status IN ('queued', 'running', 'cancel_requested')",
	"CREATE INDEX IF NOT EXISTS custom_agent_assignment_runs_assignment_idx ON custom_agent_assignment_runs(assignment_id, created_at)",
	"CREATE TABLE IF NOT EXISTS custom_agent_runs (id text PRIMARY KEY NOT NULL, agent_id text NOT NULL REFERENCES custom_agents(id) ON DELETE CASCADE, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, task_id text REFERENCES tasks(id) ON DELETE SET NULL, chat_session_id text, canvas_design_id text, provider text NOT NULL, model_id text, fallback_from_run_id text, status text NOT NULL DEFAULT 'queued', trigger text NOT NULL, input_summary text NOT NULL, output_summary text, started_at integer, finished_at integer, error_class text, error_message text, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS custom_agent_runs_agent_idx ON custom_agent_runs(agent_id, created_at)",
	"CREATE TABLE IF NOT EXISTS custom_agent_run_events (id text PRIMARY KEY NOT NULL, run_id text NOT NULL REFERENCES custom_agent_runs(id) ON DELETE CASCADE, type text NOT NULL, message text NOT NULL, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS custom_agent_run_events_run_idx ON custom_agent_run_events(run_id, created_at)",
];

export function bootstrapDatabase(path: string): void {
	const database = new Database(path);
	try {
		database.exec("BEGIN");
		for (const statement of schemaStatements) database.exec(statement);
		try {
			database.exec(
				"ALTER TABLE task_artifacts ADD COLUMN kind text NOT NULL DEFAULT 'evidence'",
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("duplicate column")
			)
				throw error;
		}
		try {
			database.exec(
				"ALTER TABLE task_artifacts ADD COLUMN version text NOT NULL DEFAULT 'v1'",
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("duplicate column")
			)
				throw error;
		}
		try {
			database.exec(
				"ALTER TABLE task_artifacts ADD COLUMN created_at integer NOT NULL DEFAULT 0",
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("duplicate column")
			)
				throw error;
		}
		database.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS task_artifacts_task_kind_version_uidx ON task_artifacts(task_id, kind, version)",
		);
		try {
			database.exec(
				"ALTER TABLE context_entries ADD COLUMN kind text NOT NULL DEFAULT 'knowledge'",
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("duplicate column")
			)
				throw error;
		}
		database.exec(
			"CREATE INDEX IF NOT EXISTS context_entries_scope_kind_status_idx ON context_entries(user_id, project_id, kind, status)",
		);
		for (const column of ["auto_accept integer NOT NULL DEFAULT 0"]) {
			try {
				database.exec(`ALTER TABLE projects ADD COLUMN ${column}`);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!error.message.includes("duplicate column")
				)
					throw error;
			}
		}
		for (const column of [
			"source_message text NOT NULL DEFAULT ''",
			"source_session_id text",
			"automation_mode text NOT NULL DEFAULT 'review'",
			"started_at integer",
			"cancelled_at integer",
		]) {
			try {
				database.exec(`ALTER TABLE plans ADD COLUMN ${column}`);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!error.message.includes("duplicate column")
				)
					throw error;
			}
		}
		for (const column of [
			"merge_conflict_files text",
			"position integer",
			"plan_id text REFERENCES plans(id) ON DELETE SET NULL",
			"description text NOT NULL DEFAULT ''",
			"priority text NOT NULL DEFAULT 'medium'",
			"acceptance_criteria text NOT NULL DEFAULT '[]'",
			"suggested_files text NOT NULL DEFAULT '[]'",
			"source text NOT NULL DEFAULT 'manual'",
			"executor_config text",
			"target_branch text",
			"lease_owner text",
			"lease_expires_at integer",
			"heartbeat_at integer",
		]) {
			try {
				database.exec(`ALTER TABLE tasks ADD COLUMN ${column}`);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!error.message.includes("duplicate column")
				)
					throw error;
			}
		}
		for (const column of [
			"error_message text",
			"error_code text",
			"recovery_action text",
			"retry_of_run_id text",
			"executor_snapshot_json text",
			"snapshot_hash text",
			"effective_provider text",
			"effective_model text",
			"attempt_number integer NOT NULL DEFAULT 1",
			"base_sha text",
			"output_sha text",
		]) {
			try {
				database.exec(`ALTER TABLE agent_runs ADD COLUMN ${column}`);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!error.message.includes("duplicate column")
				)
					throw error;
			}
		}
		database.exec(
			"CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs (status)",
		);
		for (const [table, column] of [
			["task_reviews", "policy_version integer NOT NULL DEFAULT 1"],
			[
				"integration_batch_reviews",
				"policy_version integer NOT NULL DEFAULT 1",
			],
		] as const) {
			try {
				database.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!error.message.includes("duplicate column")
				)
					throw error;
			}
		}
		try {
			database.exec(
				"ALTER TABLE integration_batches ADD COLUMN required_checks_json text NOT NULL DEFAULT '[]'",
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("duplicate column")
			)
				throw error;
		}
		try {
			database.exec(
				"ALTER TABLE task_dependencies ADD COLUMN required_milestone text NOT NULL DEFAULT 'implementation_ready'",
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("duplicate column")
			)
				throw error;
		}
		try {
			database.exec(
				"ALTER TABLE task_dependencies ADD COLUMN artifact_id text",
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("duplicate column")
			)
				throw error;
		}
		database.exec("COMMIT");
		database.exec(
			"CREATE INDEX IF NOT EXISTS tasks_plan_id_idx ON tasks (plan_id)",
		);
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	} finally {
		database.close();
	}
}

export function databaseSchemaStatements(): readonly string[] {
	return schemaStatements;
}
