import { randomUUID } from "node:crypto";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Database } from "./index";
import {
	agentRuns,
	permissionRequests,
	projects,
	providerChatHistory,
	tasks,
	workspaces,
	taskReviews,
	taskArtifacts,
	integrationBatches,
	integrationBatchMembers,
	integrationBatchReviews,
	integrationBatchChecks,
	reviewPolicies,
} from "./schema";

export type ProjectRecord = InferSelectModel<typeof projects>;
export type TaskRecord = InferSelectModel<typeof tasks>;
export type WorkspaceRecord = InferSelectModel<typeof workspaces>;
export type AgentRunRecord = InferSelectModel<typeof agentRuns>;
export type IntegrationBatchRecord = InferSelectModel<typeof integrationBatches>;
export type IntegrationBatchMemberRecord = InferSelectModel<typeof integrationBatchMembers>;
export type ReviewPolicyRecord = InferSelectModel<typeof reviewPolicies>;
export type PermissionRequestRecord = InferSelectModel<
	typeof permissionRequests
>;

export type MergeConflictRecord = {
	taskId: string;
	files: string[];
};

export type CreateProject = Omit<
	InferInsertModel<typeof projects>,
	"id" | "createdAt"
> & {
	id?: string;
};
export type CreateTask = Omit<
	InferInsertModel<typeof tasks>,
	"id" | "createdAt"
> & {
	id?: string;
};
export type CreateWorkspace = Omit<
	InferInsertModel<typeof workspaces>,
	"id" | "createdAt"
> & {
	id?: string;
};
export type CreateAgentRun = Omit<InferInsertModel<typeof agentRuns>, "id"> & {
	id?: string;
};
export type CreatePermissionRequest = Omit<
	InferInsertModel<typeof permissionRequests>,
	"id" | "createdAt"
> & { id?: string };

export function projectRepository(db: Database) {
	return {
		async create(input: CreateProject): Promise<ProjectRecord> {
			const [project] = await db
				.insert(projects)
				.values({ ...input, id: input.id ?? randomUUID() })
				.returning();
			if (!project) {
				throw new Error("Project insert returned no row");
			}
			return project;
		},
		getById(id: string) {
			return db.query.projects.findFirst({ where: eq(projects.id, id) });
		},
		list() {
			return db.select().from(projects).orderBy(desc(projects.createdAt));
		},
		update(id: string, input: Partial<CreateProject>) {
			return db
				.update(projects)
				.set(input)
				.where(eq(projects.id, id))
				.returning();
		},
		delete(id: string) {
			return db.delete(projects).where(eq(projects.id, id));
		},
	};
}

export function taskRepository(db: Database) {
	return {
		async create(input: CreateTask): Promise<TaskRecord> {
			const [task] = await db
				.insert(tasks)
				.values({ ...input, id: input.id ?? randomUUID() })
				.returning();
			if (!task) {
				throw new Error("Task insert returned no row");
			}
			return task;
		},
		getById(id: string) {
			return db.query.tasks.findFirst({ where: eq(tasks.id, id) });
		},
		listByProject(projectId: string) {
			return db
				.select()
				.from(tasks)
				.where(eq(tasks.projectId, projectId))
				.orderBy(desc(tasks.createdAt));
		},
		list() {
			return db.select().from(tasks).orderBy(desc(tasks.createdAt));
		},
		update(id: string, input: Partial<CreateTask>) {
			return db.update(tasks).set(input).where(eq(tasks.id, id)).returning();
		},
		claimLease(id: string, owner: string, now: number, expiresAt: number) {
			return db
				.update(tasks)
				.set({ leaseOwner: owner, heartbeatAt: now, leaseExpiresAt: expiresAt })
				.where(
					and(
						eq(tasks.id, id),
						inArray(tasks.status, ["queued", "ready"]),
						or(isNull(tasks.leaseExpiresAt), lt(tasks.leaseExpiresAt, now)),
					),
				)
				.returning({ id: tasks.id });
		},
		heartbeatLease(id: string, owner: string, now: number, expiresAt: number) {
			return db
				.update(tasks)
				.set({ heartbeatAt: now, leaseExpiresAt: expiresAt })
				.where(and(eq(tasks.id, id), eq(tasks.leaseOwner, owner)))
				.returning({ id: tasks.id });
		},
		releaseLease(id: string, owner: string) {
			return db
				.update(tasks)
				.set({ leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null })
				.where(and(eq(tasks.id, id), eq(tasks.leaseOwner, owner)));
		},
		delete(id: string) {
			return db.delete(tasks).where(eq(tasks.id, id));
		},
	};
}

export function workspaceRepository(db: Database) {
	return {
		async create(input: CreateWorkspace): Promise<WorkspaceRecord> {
			const [workspace] = await db
				.insert(workspaces)
				.values({ ...input, id: input.id ?? randomUUID() })
				.returning();
			if (!workspace) {
				throw new Error("Workspace insert returned no row");
			}
			return workspace;
		},
		getById(id: string) {
			return db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
		},
		getByTaskId(taskId: string) {
			return db.query.workspaces.findFirst({
				where: eq(workspaces.taskId, taskId),
			});
		},
		delete(id: string) {
			return db.delete(workspaces).where(eq(workspaces.id, id));
		},
	};
}

export function agentRunRepository(db: Database) {
	return {
		async create(input: CreateAgentRun): Promise<AgentRunRecord> {
			const [run] = await db
				.insert(agentRuns)
				.values({ ...input, id: input.id ?? randomUUID() })
				.returning();
			if (!run) {
				throw new Error("Agent run insert returned no row");
			}
			return run;
		},
		getById(id: string) {
			return db.query.agentRuns.findFirst({ where: eq(agentRuns.id, id) });
		},
		getByTaskId(taskId: string) {
			return db.query.agentRuns.findFirst({
				where: eq(agentRuns.taskId, taskId),
				orderBy: desc(agentRuns.startedAt),
			});
		},
		listUnfinished() {
			return db
				.select()
				.from(agentRuns)
				.where(
					inArray(agentRuns.status, [
						"queued",
						"running",
						"waiting_permission",
					]),
				)
				.orderBy(desc(agentRuns.startedAt));
		},
		listByTask(taskId: string) {
			return db
				.select()
				.from(agentRuns)
				.where(eq(agentRuns.taskId, taskId))
				.orderBy(desc(agentRuns.startedAt));
		},
		update(id: string, input: Partial<CreateAgentRun>) {
			return db
				.update(agentRuns)
				.set(input)
				.where(eq(agentRuns.id, id))
				.returning();
		},
		delete(id: string) {
			return db.delete(agentRuns).where(eq(agentRuns.id, id));
		},
	};
}

export function permissionRequestRepository(db: Database) {
	return {
		create(input: CreatePermissionRequest): Promise<PermissionRequestRecord> {
			return db
				.insert(permissionRequests)
				.values({ ...input, id: input.id ?? randomUUID() })
				.returning()
				.then((rows) => {
					const request = rows[0];
					if (!request)
						throw new Error("Permission request insert returned no row");
					return request;
				});
		},
		getById(id: string) {
			return db.query.permissionRequests.findFirst({
				where: eq(permissionRequests.id, id),
			});
		},
		listPending() {
			return db
				.select()
				.from(permissionRequests)
				.where(eq(permissionRequests.status, "pending"))
				.orderBy(permissionRequests.createdAt);
		},
		listByRun(runId: string) {
			return db
				.select()
				.from(permissionRequests)
				.where(eq(permissionRequests.runId, runId))
				.orderBy(desc(permissionRequests.createdAt));
		},
		update(
			id: string,
			input: Partial<CreatePermissionRequest> & {
				status?: string;
				decidedAt?: Date | null;
			},
		) {
			return db
				.update(permissionRequests)
				.set(input)
				.where(eq(permissionRequests.id, id))
				.returning();
		},
	};
}

export function taskReviewRepository(db: Database) {
	return {
		create(input: {
			id?: string;
			taskId: string;
			runId?: string | null;
			reviewerIdentity: string;
			baseSha: string;
			subjectSha: string;
			evidenceHash: string;
			status?: string;
			verdictJson?: string;
			policyVersion?: number;
		}) {
			return db.insert(taskReviews).values({ ...input, id: input.id ?? randomUUID() }).returning().then((rows) => {
				const review = rows[0];
				if (!review) throw new Error("Task review insert returned no row");
				return review;
			});
		},
		latestApproved(taskId: string) {
			return db.query.taskReviews.findFirst({
				where: and(eq(taskReviews.taskId, taskId), eq(taskReviews.status, "approved")),
				orderBy: desc(taskReviews.createdAt),
			});
		},
		list(taskId: string) {
			return db.select().from(taskReviews).where(eq(taskReviews.taskId, taskId)).orderBy(desc(taskReviews.createdAt));
		},
	};
}

export function reviewPolicyRepository(db: Database) {
	return {
		getByProject(projectId: string) {
			return db.query.reviewPolicies.findFirst({ where: eq(reviewPolicies.projectId, projectId) });
		},
		async set(input: Omit<InferInsertModel<typeof reviewPolicies>, "id" | "version" | "updatedAt">) {
			const existing = await db.query.reviewPolicies.findFirst({ where: eq(reviewPolicies.projectId, input.projectId) });
			const updatedAt = new Date();
			const [record] = await db.insert(reviewPolicies).values({
				...input,
				id: existing?.id ?? randomUUID(),
				version: 1,
				updatedAt,
			}).onConflictDoUpdate({
				target: reviewPolicies.projectId,
				set: { ...input, version: sql`version + 1`, updatedAt },
			}).returning();
			if (!record) throw new Error("Review policy update returned no row");
			return record;
		},
	};
}

export function taskArtifactRepository(db: Database) {
	return {
		create(input: {
			id?: string;
			taskId: string;
			producerRunId?: string | null;
			kind: string;
			version: string;
			commitSha: string;
			relativePath: string;
			contentHash: string;
			status?: string;
		}) {
			return db.insert(taskArtifacts).values({ ...input, id: input.id ?? randomUUID() }).returning().then((rows) => {
				const artifact = rows[0];
				if (!artifact) throw new Error("Task artifact insert returned no row");
				return artifact;
			});
		},
		getById(id: string) {
			return db.query.taskArtifacts.findFirst({ where: eq(taskArtifacts.id, id) });
		},
		listByTask(taskId: string) {
			return db.select().from(taskArtifacts).where(eq(taskArtifacts.taskId, taskId)).orderBy(desc(taskArtifacts.createdAt));
		},
	};
}

export function integrationLeaseRepository(db: Database) {
	return {
		claim(projectId: string, targetBranch: string, owner: string, now: number, expiresAt: number) {
			return db.$client.query(
				"INSERT INTO integration_leases(project_id, target_branch, owner, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, target_branch) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at, heartbeat_at = excluded.heartbeat_at WHERE integration_leases.expires_at <= ? OR integration_leases.owner = ? RETURNING owner",
			).get(projectId, targetBranch, owner, expiresAt, now, now, owner) as { owner: string } | null;
		},
		heartbeat(projectId: string, targetBranch: string, owner: string, now: number, expiresAt: number) {
			return db.$client.query(
				"UPDATE integration_leases SET heartbeat_at = ?, expires_at = ? WHERE project_id = ? AND target_branch = ? AND owner = ? RETURNING owner",
			).get(now, expiresAt, projectId, targetBranch, owner) as { owner: string } | null;
		},
		release(projectId: string, targetBranch: string, owner: string) {
			return db.$client.query(
				"DELETE FROM integration_leases WHERE project_id = ? AND target_branch = ? AND owner = ?",
			).run(projectId, targetBranch, owner);
		},
	};
}

export function schedulerResourceLeaseRepository(db: Database) {
	return {
		claim(resourceKey: string, taskId: string, owner: string, now: number, expiresAt: number, limit: number) {
			// SQLite serializes writers; the conditional insert therefore enforces the cap across daemon processes.
			return db.$client.query(
				"INSERT INTO scheduler_resource_leases(resource_key, task_id, owner, expires_at, heartbeat_at) SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM scheduler_resource_leases WHERE resource_key = ? AND expires_at > ? AND task_id <> ?) < ? ON CONFLICT(resource_key, task_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at, heartbeat_at = excluded.heartbeat_at WHERE scheduler_resource_leases.expires_at <= ? OR scheduler_resource_leases.owner = excluded.owner RETURNING task_id",
			).get(resourceKey, taskId, owner, expiresAt, now, resourceKey, now, taskId, limit, now) as { task_id: string } | null;
		},
		heartbeat(taskId: string, owner: string, now: number, expiresAt: number) {
			return db.$client.query(
				"UPDATE scheduler_resource_leases SET heartbeat_at = ?, expires_at = ? WHERE task_id = ? AND owner = ? RETURNING resource_key",
			).all(now, expiresAt, taskId, owner) as Array<{ resource_key: string }>;
		},
		release(taskId: string, owner: string) {
			return db.$client.query(
				"DELETE FROM scheduler_resource_leases WHERE task_id = ? AND owner = ?",
			).run(taskId, owner);
		},
	};
}

export function integrationBatchRepository(db: Database) {
	return {
		create(input: Omit<InferInsertModel<typeof integrationBatches>, "createdAt" | "updatedAt">) {
			return db.insert(integrationBatches).values({
				...input,
				createdAt: new Date(),
				updatedAt: new Date(),
			}).returning().then((rows) => {
				const batch = rows[0];
				if (!batch) throw new Error("Integration batch insert returned no row");
				return batch;
			});
		},
		getById(id: string) {
			return db.query.integrationBatches.findFirst({ where: eq(integrationBatches.id, id) });
		},
		listByProject(projectId: string) {
			return db.select().from(integrationBatches)
				.where(eq(integrationBatches.projectId, projectId))
				.orderBy(desc(integrationBatches.createdAt));
		},
		listMembers(batchId: string) {
			return db.select().from(integrationBatchMembers)
				.where(eq(integrationBatchMembers.batchId, batchId))
				.orderBy(integrationBatchMembers.mergeOrder);
		},
		listChecks(batchId: string) {
			return db.select().from(integrationBatchChecks)
				.where(eq(integrationBatchChecks.batchId, batchId))
				.orderBy(integrationBatchChecks.startedAt);
		},
		addChecks(batchId: string, checks: Array<Omit<InferInsertModel<typeof integrationBatchChecks>, "id" | "batchId">>) {
			return db.insert(integrationBatchChecks).values(checks.map((check) => ({ ...check, batchId, id: randomUUID() }))).returning();
		},
		addMembers(batchId: string, members: Array<Omit<InferInsertModel<typeof integrationBatchMembers>, "batchId">>) {
			return db.insert(integrationBatchMembers).values(members.map((member) => ({ ...member, batchId }))).returning();
		},
		update(id: string, input: Partial<Omit<InferInsertModel<typeof integrationBatches>, "id" | "createdAt">>) {
			return db.update(integrationBatches)
				.set({ ...input, updatedAt: new Date() })
				.where(eq(integrationBatches.id, id))
				.returning();
		},
	};
}

export function integrationBatchReviewRepository(db: Database) {
	return {
		create(input: Omit<InferInsertModel<typeof integrationBatchReviews>, "id" | "createdAt"> & { id?: string }) {
			return db.insert(integrationBatchReviews).values({
				...input,
				id: input.id ?? randomUUID(),
				createdAt: new Date(),
			}).returning().then((rows) => {
				const review = rows[0];
				if (!review) throw new Error("Integration batch review insert returned no row");
				return review;
			});
		},
		latestApproved(batchId: string) {
			return db.query.integrationBatchReviews.findFirst({
				where: and(eq(integrationBatchReviews.batchId, batchId), eq(integrationBatchReviews.status, "approved")),
				orderBy: desc(integrationBatchReviews.createdAt),
			});
		},
	};
}

export function providerChatHistoryRepository(db: Database) {
	return {
		async get<T>(sessionId: string): Promise<T | undefined> {
			const record = await db.query.providerChatHistory.findFirst({
				where: eq(providerChatHistory.sessionId, sessionId),
			});
			return record ? (JSON.parse(record.messages) as T) : undefined;
		},
		save(sessionId: string, messages: unknown[]) {
			const serialized = JSON.stringify(messages);
			return db
				.insert(providerChatHistory)
				.values({ sessionId, messages: serialized })
				.onConflictDoUpdate({
					target: providerChatHistory.sessionId,
					set: { messages: serialized, updatedAt: new Date() },
				});
		},
		delete(sessionId: string) {
			return db
				.delete(providerChatHistory)
				.where(eq(providerChatHistory.sessionId, sessionId));
		},
	};
}

export function repositories(db: Database) {
	return {
		projects: projectRepository(db),
		tasks: taskRepository(db),
		workspaces: workspaceRepository(db),
		agentRuns: agentRunRepository(db),
		permissionRequests: permissionRequestRepository(db),
		taskReviews: taskReviewRepository(db),
		taskArtifacts: taskArtifactRepository(db),
		integrationLeases: integrationLeaseRepository(db),
		schedulerResourceLeases: schedulerResourceLeaseRepository(db),
		integrationBatches: integrationBatchRepository(db),
		integrationBatchReviews: integrationBatchReviewRepository(db),
		reviewPolicies: reviewPolicyRepository(db),
		providerChatHistory: providerChatHistoryRepository(db),
	};
}
