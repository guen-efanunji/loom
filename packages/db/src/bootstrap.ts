import { Database } from "bun:sqlite";

const schemaStatements = [
	"PRAGMA foreign_keys = ON",
	"CREATE TABLE IF NOT EXISTS user (id text PRIMARY KEY NOT NULL, name text NOT NULL, email text NOT NULL UNIQUE, email_verified integer DEFAULT 0 NOT NULL, image text, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY NOT NULL, expires_at integer NOT NULL, token text NOT NULL UNIQUE, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, ip_address text, user_agent text, user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE)",
	"CREATE INDEX IF NOT EXISTS session_userId_idx ON session (user_id)",
	"CREATE TABLE IF NOT EXISTS account (id text PRIMARY KEY NOT NULL, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE, access_token text, refresh_token text, id_token text, access_token_expires_at integer, refresh_token_expires_at integer, scope text, password text, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
	"CREATE UNIQUE INDEX IF NOT EXISTS account_providerId_accountId_uidx ON account (provider_id, account_id)",
	"CREATE INDEX IF NOT EXISTS account_userId_idx ON account (user_id)",
	"CREATE TABLE IF NOT EXISTS verification (id text PRIMARY KEY NOT NULL, identifier text NOT NULL, value text NOT NULL, expires_at integer NOT NULL, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
	"CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier)",
	"CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY NOT NULL, name text NOT NULL, path text NOT NULL, default_branch text NOT NULL, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
	"CREATE UNIQUE INDEX IF NOT EXISTS projects_path_uidx ON projects (path)",
	"CREATE TABLE IF NOT EXISTS tasks (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title text NOT NULL, prompt text NOT NULL, status text DEFAULT 'queued' NOT NULL, workspace_id text, session_id text, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, started_at integer, completed_at integer, error_message text, merge_conflict_files text, position integer, plan_id text REFERENCES plans(id) ON DELETE SET NULL, description text NOT NULL DEFAULT '', priority text NOT NULL DEFAULT 'medium', acceptance_criteria text NOT NULL DEFAULT '[]', suggested_files text NOT NULL DEFAULT '[]', source text NOT NULL DEFAULT 'manual')",
	"CREATE TABLE IF NOT EXISTS plans (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source_message_id text NOT NULL DEFAULT '', source_message text NOT NULL DEFAULT '', source_session_id text, automation_mode text NOT NULL DEFAULT 'review', title text NOT NULL, summary text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', converted_at integer, approved_at integer, started_at integer, cancelled_at integer, error_message text, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE TABLE IF NOT EXISTS plan_tasks (id text PRIMARY KEY NOT NULL, plan_id text NOT NULL REFERENCES plans(id) ON DELETE CASCADE, key text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '', priority text NOT NULL DEFAULT 'medium', dependencies text NOT NULL DEFAULT '[]', acceptance_criteria text NOT NULL DEFAULT '[]', suggested_files text NOT NULL DEFAULT '[]', parallel_group text)",
	"CREATE UNIQUE INDEX IF NOT EXISTS plan_tasks_plan_key_uidx ON plan_tasks (plan_id, key)",
	"CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks (project_id)",
	"CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, path text NOT NULL, branch text NOT NULL, base_commit text NOT NULL, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
	"CREATE UNIQUE INDEX IF NOT EXISTS workspaces_task_id_uidx ON workspaces (task_id)",
	"CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces (project_id)",
	"CREATE TABLE IF NOT EXISTS agent_runs (id text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, session_id text, status text DEFAULT 'queued' NOT NULL, started_at integer, completed_at integer, error_message text, error_code text, recovery_action text, retry_of_run_id text)",
	"CREATE INDEX IF NOT EXISTS agent_runs_task_id_idx ON agent_runs (task_id)",
	"CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs (status)",
	"CREATE TABLE IF NOT EXISTS permission_requests (id text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, command text NOT NULL, cwd text NOT NULL, reason text NOT NULL, status text DEFAULT 'pending' NOT NULL, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, decided_at integer)",
	"CREATE INDEX IF NOT EXISTS permission_requests_run_id_idx ON permission_requests (run_id)",
	"CREATE INDEX IF NOT EXISTS permission_requests_status_idx ON permission_requests (status)",
	"CREATE TABLE IF NOT EXISTS epics (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title text NOT NULL, prompt text NOT NULL, status text NOT NULL DEFAULT 'planning', plan text, context text, error_message text, approved_at integer, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE TABLE IF NOT EXISTS epic_tasks (task_id text PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, epic_id text NOT NULL REFERENCES epics(id) ON DELETE CASCADE, key text NOT NULL)",
	"CREATE UNIQUE INDEX IF NOT EXISTS epic_tasks_key_uidx ON epic_tasks(epic_id, key)",
	"CREATE TABLE IF NOT EXISTS task_dependencies (task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, depends_on_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE)",
	"CREATE UNIQUE INDEX IF NOT EXISTS task_dependencies_uidx ON task_dependencies(task_id, depends_on_task_id)",
	"CREATE TABLE IF NOT EXISTS task_artifacts (id text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, type text NOT NULL, path text NOT NULL, summary text NOT NULL)",
	"CREATE TABLE IF NOT EXISTS planner_runs (id text PRIMARY KEY NOT NULL, epic_id text NOT NULL REFERENCES epics(id) ON DELETE CASCADE, session_id text, status text NOT NULL, error_message text, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE TABLE IF NOT EXISTS integration_runs (id text PRIMARY KEY NOT NULL, epic_id text NOT NULL REFERENCES epics(id) ON DELETE CASCADE, status text NOT NULL, workspace_path text, branch text, base_commit text, head text, error_message text, checks text NOT NULL DEFAULT '[]', diff text NOT NULL DEFAULT '', session_id text, approved_at integer, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE TABLE IF NOT EXISTS audit_events (id text PRIMARY KEY NOT NULL, epic_id text NOT NULL REFERENCES epics(id) ON DELETE CASCADE, type text NOT NULL, detail text NOT NULL, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE TABLE IF NOT EXISTS design_nodes (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, session_id text, parent_id text, title text NOT NULL DEFAULT 'Untitled design', brief text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'queued', viewport text NOT NULL DEFAULT 'desktop', html text NOT NULL DEFAULT '', error_message text, duration_ms integer, x integer NOT NULL DEFAULT 0, y integer NOT NULL DEFAULT 0, width integer NOT NULL DEFAULT 420, height integer NOT NULL DEFAULT 280, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS design_nodes_project_id_idx ON design_nodes (project_id)",
	"CREATE TABLE IF NOT EXISTS design_messages (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, node_id text, role text NOT NULL, text text NOT NULL DEFAULT '', model text, error_message text, duration_ms integer, created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))",
	"CREATE INDEX IF NOT EXISTS design_messages_project_id_idx ON design_messages (project_id)",
];

export function bootstrapDatabase(path: string): void {
	const database = new Database(path);
	try {
		database.exec("BEGIN");
		for (const statement of schemaStatements) database.exec(statement);
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
