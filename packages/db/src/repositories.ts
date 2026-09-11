import { randomUUID } from "node:crypto";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { desc, eq, inArray } from "drizzle-orm";

import type { Database } from "./index";
import {
	agentRuns,
	permissionRequests,
	projects,
	tasks,
	workspaces,
} from "./schema";

export type ProjectRecord = InferSelectModel<typeof projects>;
export type TaskRecord = InferSelectModel<typeof tasks>;
export type WorkspaceRecord = InferSelectModel<typeof workspaces>;
export type AgentRunRecord = InferSelectModel<typeof agentRuns>;
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

export function repositories(db: Database) {
	return {
		projects: projectRepository(db),
		tasks: taskRepository(db),
		workspaces: workspaceRepository(db),
		agentRuns: agentRunRepository(db),
		permissionRequests: permissionRequestRepository(db),
	};
}
