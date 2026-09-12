import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { createDb, databaseSchemaStatements } from "./index";
import {
	agentRunRepository,
	projectRepository,
	taskRepository,
	workspaceRepository,
} from "./repositories";
import * as schema from "./schema";

const db = drizzle({
	client: new Database(":memory:"),
	schema,
});

async function setup() {
	for (const statement of [
		"CREATE TABLE projects (id text primary key, name text not null, path text not null unique, default_branch text not null, created_at integer not null)",
		"CREATE TABLE tasks (id text primary key, project_id text not null references projects(id) on delete cascade, title text not null, prompt text not null, status text not null default 'queued', position integer, workspace_id text, session_id text, created_at integer not null, started_at integer, completed_at integer, error_message text, merge_conflict_files text)",
		"CREATE TABLE workspaces (id text primary key, task_id text not null unique references tasks(id) on delete cascade, project_id text not null references projects(id) on delete cascade, path text not null, branch text not null, base_commit text not null, created_at integer not null)",
		"CREATE TABLE agent_runs (id text primary key, task_id text not null references tasks(id) on delete cascade, session_id text, status text not null default 'queued', started_at integer, completed_at integer, error_message text, error_code text, recovery_action text, retry_of_run_id text)",
	]) {
		await db.run(statement);
	}
}

test("bootstraps an empty database and is idempotent", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-db-"));
	const path = join(directory, "state.db");
	try {
		const db = createDb({ DATABASE_URL: `file:${path}` });
		const tables = await db.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
		);
		expect(tables.map((table) => table.name)).toEqual([
			"account",
			"agent_runs",
			"audit_events",
			"epic_tasks",
			"epics",
			"integration_runs",
			"permission_requests",
			"planner_runs",
			"projects",
			"session",
			"task_artifacts",
			"task_dependencies",
			"tasks",
			"user",
			"verification",
			"workspaces",
		]);
		createDb({ DATABASE_URL: `file:${path}` });
		for (const statement of databaseSchemaStatements()) await db.run(statement);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("persists workflow records in a temporary database", async () => {
	await setup();
	const projects = projectRepository(db);
	const tasks = taskRepository(db);
	const workspaces = workspaceRepository(db);
	const runs = agentRunRepository(db);
	const project = await projects.create({
		name: "Loom",
		path: "/tmp/loom",
		defaultBranch: "main",
	});
	const task = await tasks.create({
		projectId: project.id,
		title: "Persist",
		prompt: "Implement persistence",
	});
	const workspace = await workspaces.create({
		taskId: task.id,
		projectId: project.id,
		path: "/tmp/worktree",
		branch: "loom/task",
		baseCommit: "abc",
	});
	await tasks.update(task.id, { workspaceId: workspace.id, status: "running" });
	const run = await runs.create({ taskId: task.id, status: "running" });
	const storedTask = await tasks.getById(task.id);
	expect(storedTask?.workspaceId).toBe(workspace.id);
	expect(run.taskId).toBe(task.id);
});
