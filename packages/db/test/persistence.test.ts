import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { planRepository } from "../src/automation";
import { createDb, databaseSchemaStatements } from "../src/index";
import {
	agentRunRepository,
	projectRepository,
	taskRepository,
	workspaceRepository,
} from "../src/repositories";
import * as schema from "../src/schema";

const db = drizzle({
	client: new Database(":memory:"),
	schema,
});

async function setup() {
	for (const statement of [
		"CREATE TABLE IF NOT EXISTS projects (id text primary key, name text not null, path text not null unique, default_branch text not null, auto_accept integer not null default 0, created_at integer not null)",
		"CREATE TABLE IF NOT EXISTS tasks (id text primary key, project_id text not null references projects(id) on delete cascade, title text not null, prompt text not null, status text not null default 'queued', position integer, plan_id text references plans(id) on delete set null, description text not null default '', priority text not null default 'medium', acceptance_criteria text not null default '[]', suggested_files text not null default '[]', source text not null default 'manual', workspace_id text, session_id text, created_at integer not null, started_at integer, completed_at integer, error_message text, merge_conflict_files text)",
		"CREATE TABLE IF NOT EXISTS plans (id text primary key, project_id text not null references projects(id) on delete cascade, source_message_id text not null default '', title text not null, summary text not null default '', status text not null default 'draft', converted_at integer, approved_at integer, error_message text, created_at integer not null)",
		"CREATE TABLE IF NOT EXISTS plan_tasks (id text primary key, plan_id text not null references plans(id) on delete cascade, key text not null, title text not null, description text not null default '', priority text not null default 'medium', dependencies text not null default '[]', acceptance_criteria text not null default '[]', suggested_files text not null default '[]', parallel_group text)",
		"CREATE UNIQUE INDEX IF NOT EXISTS plan_tasks_plan_key_uidx ON plan_tasks (plan_id, key)",
		"CREATE TABLE IF NOT EXISTS task_dependencies (task_id text not null references tasks(id) on delete cascade, depends_on_task_id text not null references tasks(id) on delete cascade)",
		"CREATE UNIQUE INDEX IF NOT EXISTS task_dependencies_uidx ON task_dependencies (task_id, depends_on_task_id)",
		"CREATE TABLE IF NOT EXISTS workspaces (id text primary key, task_id text not null unique references tasks(id) on delete cascade, project_id text not null references projects(id) on delete cascade, path text not null, branch text not null, base_commit text not null, created_at integer not null)",
		"CREATE TABLE IF NOT EXISTS agent_runs (id text primary key, task_id text not null references tasks(id) on delete cascade, session_id text, status text not null default 'queued', started_at integer, completed_at integer, error_message text, error_code text, recovery_action text, retry_of_run_id text)",
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
			"design_messages",
			"design_nodes",
			"permission_requests",
			"plan_tasks",
			"plans",
			"projects",
			"session",
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

test("converts a plan atomically and exactly once", async () => {
	await setup();
	const projects = projectRepository(db);
	const tasks = taskRepository(db);
	const plans = planRepository(db);
	const project = await projects.create({
		name: "Loom",
		path: "/tmp/loom-plan",
		defaultBranch: "main",
	});
	const plan = await plans.create({
		projectId: project.id,
		sourceMessageId: "msg-1",
		title: "Landing page",
		summary: "Build it.",
	});
	const items = [
		{
			key: "html",
			title: "Semantic HTML",
			description: "Write the markup.",
			prompt: "Write the markup.",
			priority: "high",
			acceptanceCriteria: ["Valid HTML"],
			suggestedFiles: ["index.html"],
			dependsOn: [],
		},
		{
			key: "css",
			title: "Styles",
			description: "Write the styles.",
			prompt: "Write the styles.",
			priority: "medium",
			acceptanceCriteria: ["Responsive layout"],
			suggestedFiles: ["styles.css"],
			dependsOn: ["html"],
		},
	];
	await plans.update(plan.id, { status: "approved", approvedAt: new Date() });
	const first = await plans.convert(plan.id, project.id, items);
	expect(first.converted).toBe(true);
	expect(first.taskIds).toHaveLength(2);
	const stored = await tasks.listByProject(project.id);
	expect(stored.map((task) => task.status).sort()).toEqual([
		"blocked",
		"ready",
	]);
	expect(stored.find((task) => task.title === "Styles")?.planId).toBe(plan.id);
	const deps = await plans.dependencies(
		stored.find((task) => task.title === "Styles")?.id ?? "",
	);
	expect(deps).toHaveLength(1);
	const second = await plans.convert(plan.id, project.id, items);
	expect(second.converted).toBe(false);
	expect([...second.taskIds].sort()).toEqual([...first.taskIds].sort());
	expect((await tasks.listByProject(project.id)).length).toBe(2);
	await expect(plans.convert("missing", project.id, items)).rejects.toThrow(
		"Plan not found",
	);
});
