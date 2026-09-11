import Database from "libsql";

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
	"CREATE TABLE IF NOT EXISTS tasks (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title text NOT NULL, prompt text NOT NULL, status text DEFAULT 'queued' NOT NULL, workspace_id text, session_id text, created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, started_at integer, completed_at integer, error_message text, merge_conflict_files text)",
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
];

export function bootstrapDatabase(path: string): void {
	const database = new Database(path);
	try {
		database.exec("BEGIN");
		for (const statement of schemaStatements) database.exec(statement);
		for (const column of ["merge_conflict_files text"]) {
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
