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
	integrationBatchRepository,
	integrationBatchReviewRepository,
	integrationLeaseRepository,
	projectRepository,
	providerChatHistoryRepository,
	reviewPolicyRepository,
	schedulerResourceLeaseRepository,
	taskArtifactRepository,
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
		"CREATE TABLE IF NOT EXISTS tasks (id text primary key, project_id text not null references projects(id) on delete cascade, title text not null, prompt text not null, status text not null default 'queued', position integer, plan_id text references plans(id) on delete set null, description text not null default '', priority text not null default 'medium', acceptance_criteria text not null default '[]', suggested_files text not null default '[]', source text not null default 'manual', workspace_id text, session_id text, created_at integer not null, started_at integer, completed_at integer, error_message text, merge_conflict_files text, executor_config text, target_branch text, lease_owner text, lease_expires_at integer, heartbeat_at integer)",
		"CREATE TABLE IF NOT EXISTS plans (id text primary key, project_id text not null references projects(id) on delete cascade, source_message_id text not null default '', title text not null, summary text not null default '', status text not null default 'draft', converted_at integer, approved_at integer, error_message text, created_at integer not null)",
		"CREATE TABLE IF NOT EXISTS plan_tasks (id text primary key, plan_id text not null references plans(id) on delete cascade, key text not null, title text not null, description text not null default '', priority text not null default 'medium', dependencies text not null default '[]', acceptance_criteria text not null default '[]', suggested_files text not null default '[]', parallel_group text)",
		"CREATE UNIQUE INDEX IF NOT EXISTS plan_tasks_plan_key_uidx ON plan_tasks (plan_id, key)",
		"CREATE TABLE IF NOT EXISTS task_dependencies (task_id text not null references tasks(id) on delete cascade, depends_on_task_id text not null references tasks(id) on delete cascade, required_milestone text not null default 'implementation_ready', artifact_id text)",
		"CREATE UNIQUE INDEX IF NOT EXISTS task_dependencies_uidx ON task_dependencies (task_id, depends_on_task_id)",
		"CREATE TABLE IF NOT EXISTS task_artifacts (id text primary key, task_id text not null references tasks(id) on delete cascade, producer_run_id text, kind text not null, version text not null, commit_sha text not null, relative_path text not null, content_hash text not null, status text not null default 'ready', created_at integer not null)",
		"CREATE INDEX IF NOT EXISTS task_artifacts_task_idx ON task_artifacts(task_id)",
		"CREATE UNIQUE INDEX IF NOT EXISTS task_artifacts_task_kind_version_uidx ON task_artifacts(task_id, kind, version)",
		"CREATE TABLE IF NOT EXISTS integration_leases (project_id text not null, target_branch text not null, owner text not null, expires_at integer not null, heartbeat_at integer not null, unique(project_id, target_branch))",
		"CREATE TABLE IF NOT EXISTS scheduler_resource_leases (resource_key text not null, task_id text not null, owner text not null, expires_at integer not null, heartbeat_at integer not null, unique(resource_key, task_id))",
		"CREATE TABLE IF NOT EXISTS review_policies (id text primary key not null, project_id text not null unique references projects(id) on delete cascade, mode text not null default 'hybrid', reviewer_executor_json text, auto_merge integer not null default 0, required_checks_json text not null default '[]', max_revision_rounds integer not null default 2, version integer not null default 1, updated_at integer not null)",
		"CREATE TABLE IF NOT EXISTS integration_batches (id text primary key not null, project_id text not null references projects(id) on delete cascade, target_branch text not null, target_base_sha text not null, candidate_sha text, promoted_sha text, required_checks_json text not null default '[]', status text not null default 'assembling', workspace_path text, workspace_branch text, error_message text, created_at integer not null, updated_at integer not null)",
		"CREATE INDEX IF NOT EXISTS integration_batches_project_status_idx ON integration_batches(project_id, status)",
		"CREATE TABLE IF NOT EXISTS integration_batch_members (batch_id text not null references integration_batches(id) on delete cascade, task_id text not null references tasks(id) on delete cascade, run_id text, output_sha text not null, merge_order integer not null, unique(batch_id, task_id), unique(batch_id, merge_order))",
		"CREATE TABLE IF NOT EXISTS integration_batch_checks (id text primary key not null, batch_id text not null references integration_batches(id) on delete cascade, name text not null, command_redacted text not null, status text not null, exit_code integer, evidence_hash text not null, started_at integer not null, finished_at integer not null)",
		"CREATE INDEX IF NOT EXISTS integration_batch_checks_batch_idx ON integration_batch_checks(batch_id, started_at)",
		"CREATE TABLE IF NOT EXISTS integration_batch_reviews (id text primary key not null, batch_id text not null references integration_batches(id) on delete cascade, reviewer_identity text not null, base_sha text not null, subject_sha text not null, evidence_hash text not null, status text not null, verdict_json text not null, policy_version integer not null default 1, created_at integer not null)",
		"CREATE TABLE IF NOT EXISTS workspaces (id text primary key, task_id text not null unique references tasks(id) on delete cascade, project_id text not null references projects(id) on delete cascade, path text not null, branch text not null, base_commit text not null, created_at integer not null)",
		"CREATE TABLE IF NOT EXISTS agent_runs (id text primary key, task_id text not null references tasks(id) on delete cascade, session_id text, status text not null default 'queued', started_at integer, completed_at integer, error_message text, error_code text, recovery_action text, retry_of_run_id text, executor_snapshot_json text, snapshot_hash text, effective_provider text, effective_model text, attempt_number integer not null default 1, base_sha text, output_sha text)",
	]) {
		await db.run(statement);
	}
}

test("bootstraps an empty database and is idempotent", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-db-"));
	const path = join(directory, "state.db");
	const handles: ReturnType<typeof createDb>[] = [];
	try {
		const db = createDb({ DATABASE_URL: `file:${path}` });
		handles.push(db);
		const tables = await db.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
		);
		expect(tables.map((table) => table.name)).toEqual([
			"account",
			"agent_runs",
			"chat_workspaces",
			"context_entries",
			"context_memory_decisions",
			"context_memory_evidence",
			"context_versions",
			"custom_agent_assignment_runs",
			"custom_agent_assignments",
			"custom_agent_run_events",
			"custom_agent_runs",
			"custom_agent_skills",
			"custom_agents",
			"design_messages",
			"design_nodes",
			"integration_batch_checks",
			"integration_batch_members",
			"integration_batch_reviews",
			"integration_batches",
			"integration_leases",
			"managed_mcp_connections",
			"orchestration_events",
			"permission_requests",
			"plan_tasks",
			"plans",
			"projects",
			"provider_chat_history",
			"review_policies",
			"scheduler_resource_leases",
			"session",
			"sqlite_sequence",
			"ssh_connections",
			"task_artifacts",
			"task_dependencies",
			"task_reviews",
			"tasks",
			"user",
			"verification",
			"workspaces",
		]);
		handles.push(createDb({ DATABASE_URL: `file:${path}` }));
		for (const statement of databaseSchemaStatements()) await db.run(statement);
	} finally {
		// WAL keeps shared-memory files beside state.db; they must be released
		// before the temporary directory can be removed.
		for (const handle of handles) handle.$client.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("migrates legacy kind columns before creating their indexes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-db-legacy-context-"));
	const path = join(directory, "state.db");
	try {
		const legacy = new Database(path);
		legacy.exec(
			"CREATE TABLE context_entries (id text PRIMARY KEY, user_id text NOT NULL DEFAULT 'local', project_id text, title text NOT NULL, status text NOT NULL DEFAULT 'active')",
		);
		legacy.exec(
			"CREATE TABLE task_artifacts (id text PRIMARY KEY, task_id text NOT NULL, producer_run_id text, commit_sha text NOT NULL, relative_path text NOT NULL, content_hash text NOT NULL, status text NOT NULL DEFAULT 'ready', created_at integer NOT NULL DEFAULT 0)",
		);
		legacy.exec(
			"INSERT INTO context_entries (id, title) VALUES ('legacy-entry', 'Existing context')",
		);
		legacy.exec(
			"INSERT INTO task_artifacts (id, task_id, commit_sha, relative_path, content_hash) VALUES ('legacy-artifact', 'task-1', 'abc123', 'contract.json', 'hash')",
		);
		legacy.close();

		createDb({ DATABASE_URL: `file:${path}` }).$client.close();
		// Reopened with no writer left alive: a WAL database must create its -shm
		// file, which a readonly handle cannot do. The assertions only read.
		const migrated = new Database(path);
		try {
			const entry = migrated
				.query<{ kind: string; title: string }, [string]>(
					"SELECT kind, title FROM context_entries WHERE id = ?",
				)
				.get("legacy-entry");
			const contextIndexes = migrated
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
				)
				.all("context_entries_scope_kind_status_idx");
			const artifact = migrated
				.query<{ kind: string; version: string }, [string]>(
					"SELECT kind, version FROM task_artifacts WHERE id = ?",
				)
				.get("legacy-artifact");
			const artifactIndexes = migrated
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
				)
				.all("task_artifacts_task_kind_version_uidx");
			expect(entry).toEqual({ kind: "knowledge", title: "Existing context" });
			expect(contextIndexes).toHaveLength(1);
			expect(artifact).toEqual({ kind: "evidence", version: "v1" });
			expect(artifactIndexes).toHaveLength(1);
		} finally {
			migrated.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("integration lease is exclusive, renewable, and expires", async () => {
	await setup();
	const leases = integrationLeaseRepository(db as never);
	const lease = leases.claim("project-lock", "main", "worker-a", 100, 200);
	expect(lease?.owner).toBe("worker-a");
	expect(leases.claim("project-lock", "main", "worker-b", 150, 250)).toBeNull();
	expect(
		leases.heartbeat("project-lock", "main", "worker-a", 160, 260)?.owner,
	).toBe("worker-a");
	expect(
		leases.claim("project-lock", "main", "worker-b", 261, 361)?.owner,
	).toBe("worker-b");
	leases.release("project-lock", "main", "worker-a");
	expect(leases.claim("project-lock", "main", "worker-c", 270, 370)).toBeNull();
	leases.release("project-lock", "main", "worker-b");
	expect(
		leases.claim("project-lock", "main", "worker-c", 280, 380)?.owner,
	).toBe("worker-c");
});

test("scheduler resource lease enforces global, project and provider caps and expires safely", async () => {
	await setup();
	const leases = schedulerResourceLeaseRepository(db as never);
	expect(
		leases.claim("provider:provider-a", "task-a", "worker-a", 100, 200, 1)
			?.task_id,
	).toBe("task-a");
	expect(
		leases.claim("provider:provider-a", "task-b", "worker-b", 150, 250, 1),
	).toBeNull();
	expect(
		leases.claim("provider:provider-b", "task-b", "worker-b", 150, 250, 1)
			?.task_id,
	).toBe("task-b");
	expect(
		leases.claim("project:project-a", "task-a", "worker-a", 100, 200, 1)
			?.task_id,
	).toBe("task-a");
	expect(
		leases.claim("project:project-a", "task-b", "worker-b", 150, 250, 1),
	).toBeNull();
	expect(leases.heartbeat("task-a", "worker-a", 160, 260)).toHaveLength(2);
	expect(
		leases.claim("provider:provider-a", "task-b", "worker-b", 261, 361, 1)
			?.task_id,
	).toBe("task-b");
	leases.release("task-b", "worker-b");
	expect(leases.heartbeat("task-b", "worker-b", 270, 370)).toHaveLength(0);
});

test("review policy versions advance when project policy changes", async () => {
	await setup();
	const project = await projectRepository(db).create({
		name: "Review",
		path: "/tmp/loom-review-policy",
		defaultBranch: "main",
	});
	const policies = reviewPolicyRepository(db);
	const first = await policies.set({
		projectId: project.id,
		mode: "manual",
		reviewerExecutorJson: null,
		autoMerge: false,
		requiredChecksJson: "[]",
		maxRevisionRounds: 2,
	});
	const second = await policies.set({
		projectId: project.id,
		mode: "hybrid",
		reviewerExecutorJson: null,
		autoMerge: false,
		requiredChecksJson: "[]",
		maxRevisionRounds: 3,
	});
	expect(first.version).toBe(1);
	expect(second.version).toBe(2);
	expect((await policies.getByProject(project.id))?.mode).toBe("hybrid");
});

test("persists integration batches and their pinned output commits in merge order", async () => {
	await setup();
	const project = await projectRepository(db).create({
		name: "Batch",
		path: "/tmp/loom-batch",
		defaultBranch: "main",
	});
	const tasks = taskRepository(db);
	const frontend = await tasks.create({
		projectId: project.id,
		title: "Frontend",
		prompt: "UI",
	});
	const backend = await tasks.create({
		projectId: project.id,
		title: "Backend",
		prompt: "API",
	});
	const batches = integrationBatchRepository(db);
	const batch = await batches.create({
		id: "batch-1",
		projectId: project.id,
		targetBranch: "main",
		targetBaseSha: "base-sha",
		status: "assembling",
	});
	await batches.addMembers(batch.id, [
		{
			taskId: frontend.id,
			runId: "run-1",
			outputSha: "frontend-sha",
			mergeOrder: 0,
		},
		{
			taskId: backend.id,
			runId: "run-2",
			outputSha: "backend-sha",
			mergeOrder: 1,
		},
	]);
	await batches.addChecks(batch.id, [
		{
			name: "typecheck",
			commandRedacted: "bun run check-types",
			status: "passed",
			exitCode: 0,
			evidenceHash: "check-hash",
			startedAt: new Date(),
			finishedAt: new Date(),
		},
	]);
	const members = await batches.listMembers(batch.id);
	expect(members.map((member) => member.outputSha)).toEqual([
		"frontend-sha",
		"backend-sha",
	]);
	expect((await batches.listChecks(batch.id))[0]?.status).toBe("passed");
	await batches.update(batch.id, {
		candidateSha: "candidate-sha",
		status: "pending_review",
	});
	expect((await batches.getById(batch.id))?.candidateSha).toBe("candidate-sha");
	const reviews = integrationBatchReviewRepository(db);
	await reviews.create({
		batchId: batch.id,
		reviewerIdentity: "human:test",
		baseSha: "base-sha",
		subjectSha: "candidate-sha",
		evidenceHash: "diff-hash",
		status: "approved",
		verdictJson: '{"decision":"approve"}',
	});
	expect((await reviews.latestApproved(batch.id))?.subjectSha).toBe(
		"candidate-sha",
	);
});

test("persists provider chat history when the database is reopened", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-provider-chat-"));
	const path = join(directory, "state.db");
	try {
		const firstDb = createDb({ DATABASE_URL: `file:${path}` });
		const firstHistory = providerChatHistoryRepository(firstDb);
		await firstHistory.save("ses_provider", [
			{ role: "user", text: "Keep this after restart" },
		]);
		firstDb.$client.close();

		const restartedDb = createDb({ DATABASE_URL: `file:${path}` });
		const history =
			await providerChatHistoryRepository(restartedDb).get<
				Array<{ role: string; text: string }>
			>("ses_provider");
		expect(history).toEqual([
			{ role: "user", text: "Keep this after restart" },
		]);
		restartedDb.$client.close();
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
	const run = await runs.create({
		taskId: task.id,
		status: "running",
		executorSnapshotJson: '{"providerId":"test","modelId":"m1"}',
		snapshotHash: "snapshot-sha256",
	});
	const storedTask = await tasks.getById(task.id);
	expect(storedTask?.workspaceId).toBe(workspace.id);
	expect(run.taskId).toBe(task.id);
	expect(run.snapshotHash).toBe("snapshot-sha256");
	expect((await runs.getById(run.id))?.executorSnapshotJson).toBe(
		'{"providerId":"test","modelId":"m1"}',
	);
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

test("validates task dependency scope, milestones and cycles", async () => {
	await setup();
	const projects = projectRepository(db);
	const tasks = taskRepository(db);
	const plans = planRepository(db);
	const artifacts = taskArtifactRepository(db);
	const project = await projects.create({
		name: "Dependencies",
		path: "/tmp/loom-deps",
		defaultBranch: "main",
	});
	const first = await tasks.create({
		projectId: project.id,
		title: "Contract",
		prompt: "Publish the contract",
	});
	const second = await tasks.create({
		projectId: project.id,
		title: "Frontend",
		prompt: "Implement the client",
	});
	const third = await tasks.create({
		projectId: project.id,
		title: "Tests",
		prompt: "Add tests",
	});
	const edge = await plans.addDependency(
		second.id,
		first.id,
		"implementation_ready",
	);
	expect(edge.requiredMilestone).toBe("implementation_ready");
	await plans.addDependency(third.id, second.id, "integrated");
	await expect(
		plans.addDependency(third.id, first.id, "contract_published"),
	).rejects.toThrow("pin an artifact");
	const contract = await artifacts.create({
		taskId: first.id,
		kind: "contract",
		version: "v1",
		commitSha: "contract-sha",
		relativePath: "contracts/api.yaml",
		contentHash: "hash",
	});
	await plans.addDependency(
		third.id,
		first.id,
		"contract_published",
		contract.id,
	);
	await expect(plans.addDependency(first.id, third.id)).rejects.toThrow(
		"cycle",
	);
	const other = await projects.create({
		name: "Other",
		path: "/tmp/loom-other",
		defaultBranch: "main",
	});
	const foreign = await tasks.create({
		projectId: other.id,
		title: "Foreign",
		prompt: "No cross project",
	});
	await expect(plans.addDependency(second.id, foreign.id)).rejects.toThrow(
		"Cross-project",
	);
	await expect(plans.addDependency(second.id, second.id)).rejects.toThrow(
		"itself",
	);
});

test("atomically leases queued tasks and prevents claims after task starts", async () => {
	await setup();
	const project = await projectRepository(db).create({
		name: "Lease",
		path: "/tmp/loom-lease",
		defaultBranch: "main",
	});
	const tasks = taskRepository(db);
	const task = await tasks.create({
		projectId: project.id,
		title: "Claim once",
		prompt: "Run once",
	});
	const now = Date.now();
	expect(
		await tasks.claimLease(task.id, "worker-a", now, now + 60_000),
	).toHaveLength(1);
	expect(
		await tasks.claimLease(task.id, "worker-b", now, now + 60_000),
	).toHaveLength(0);
	await tasks.update(task.id, { status: "running" });
	await tasks.releaseLease(task.id, "worker-a");
	expect(
		await tasks.claimLease(task.id, "worker-b", now + 1, now + 60_001),
	).toHaveLength(0);
});
