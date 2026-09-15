import { randomUUID } from "node:crypto";
import { and, desc, eq, type InferInsertModel } from "drizzle-orm";

import type { Database } from "./index";
import { plans, planTasks, taskDependencies, tasks } from "./schema";

export type PlanRecord = {
	id: string;
	projectId: string;
	sourceMessageId: string;
	sourceMessage: string;
	sourceSessionId: string | null;
	automationMode: string;
	startedAt: Date | null;
	cancelledAt: Date | null;
	title: string;
	summary: string;
	status: string;
	convertedAt: Date | null;
	approvedAt: Date | null;
	errorMessage: string | null;
	createdAt: Date;
};

export type PlanTaskRecord = {
	id: string;
	planId: string;
	key: string;
	title: string;
	description: string;
	priority: string;
	dependencies: string[];
	acceptanceCriteria: string[];
	suggestedFiles: string[];
	parallelGroup: string | null;
};

export type ConvertedPlanTask = {
	key: string;
	title: string;
	description: string;
	prompt: string;
	priority: string;
	acceptanceCriteria: string[];
	suggestedFiles: string[];
	dependsOn: string[];
	parallelGroup?: string | null;
};

function parseList(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function toPlanTask(row: {
	id: string;
	planId: string;
	key: string;
	title: string;
	description: string;
	priority: string;
	dependencies: string;
	acceptanceCriteria: string;
	suggestedFiles: string;
	parallelGroup: string | null;
}): PlanTaskRecord {
	return {
		...row,
		dependencies: parseList(row.dependencies),
		acceptanceCriteria: parseList(row.acceptanceCriteria),
		suggestedFiles: parseList(row.suggestedFiles),
	};
}

export function planRepository(db: Database) {
	return {
		async create(input: {
			id?: string;
			projectId: string;
			sourceMessageId: string;
			sourceMessage?: string;
			sourceSessionId?: string;
			automationMode?: string;
			title: string;
			summary?: string;
		}): Promise<PlanRecord> {
			const [plan] = await db
				.insert(plans)
				.values({
					id: input.id ?? randomUUID(),
					projectId: input.projectId,
					sourceMessageId: input.sourceMessageId,
					sourceMessage: input.sourceMessage ?? "",
					sourceSessionId: input.sourceSessionId ?? null,
					automationMode: input.automationMode ?? "review",
					title: input.title,
					summary: input.summary ?? "",
					status: "draft",
				})
				.returning();
			if (!plan) throw new Error("Plan insert returned no row");
			return plan as PlanRecord;
		},
		get(id: string) {
			return db.query.plans.findFirst({ where: eq(plans.id, id) });
		},
		all() {
			return db.select().from(plans).orderBy(desc(plans.createdAt));
		},
		listByProject(projectId: string) {
			return db
				.select()
				.from(plans)
				.where(eq(plans.projectId, projectId))
				.orderBy(desc(plans.createdAt));
		},
		update(id: string, input: Partial<InferInsertModel<typeof plans>>) {
			return db.update(plans).set(input).where(eq(plans.id, id)).returning();
		},
		delete(id: string) {
			return db.delete(plans).where(eq(plans.id, id));
		},
		async replaceTasks(
			planId: string,
			tasks: ConvertedPlanTask[],
		): Promise<PlanTaskRecord[]> {
			return db.transaction((tx) => {
			tx.delete(planTasks).where(eq(planTasks.planId, planId)).run();
			if (!tasks.length) return [];
			const rows = tx
				.insert(planTasks)
				.values(
					tasks.map((task) => ({
						id: randomUUID(),
						planId,
						key: task.key,
						title: task.title,
						description: task.description,
						priority: task.priority,
						dependencies: JSON.stringify(task.dependsOn),
						acceptanceCriteria: JSON.stringify(task.acceptanceCriteria),
						suggestedFiles: JSON.stringify(task.suggestedFiles),
						parallelGroup: task.parallelGroup ?? null,
					})),
				)
				.returning().all();
			return rows.map(toPlanTask);
			});
		},
		async planTasks(planId: string): Promise<PlanTaskRecord[]> {
			const rows = await db
				.select()
				.from(planTasks)
				.where(eq(planTasks.planId, planId));
			return rows.map(toPlanTask);
		},
		/** Atomically converts a validated plan into Kanban tasks. Idempotent via convertedAt. */
		async convert(
			planId: string,
			projectId: string,
			items: ConvertedPlanTask[],
		): Promise<{ taskIds: string[]; converted: boolean }> {
			let result: { taskIds: string[]; converted: boolean } = {
				taskIds: [],
				converted: false,
			};
			db.transaction((tx) => {
				const current = tx.query.plans
					.findFirst({ where: eq(plans.id, planId) })
					.sync();
				if (!current) throw new Error("Plan not found");
				if (current.projectId !== projectId)
					throw new Error("Plan does not belong to this project");
				if (current.convertedAt) {
					result = {
						taskIds: tx
							.select({ id: tasks.id })
							.from(tasks)
							.where(eq(tasks.planId, planId))
							.all()
							.map((row) => row.id),
						converted: false,
					};
					return;
				}
				if (current.status !== "approved")
					throw new Error("Plan must be approved before conversion");
				const existing = tx
					.select({ position: tasks.position })
					.from(tasks)
					.where(eq(tasks.projectId, projectId))
					.all();
				let position = existing.reduce(
					(max, row) => Math.max(max, row.position ?? -1),
					-1,
				);
				const ids = new Map(items.map((item) => [item.key, randomUUID()]));
				const taskIdFor = (key: string) => {
					const id = ids.get(key);
					if (!id) throw new Error(`Invalid dependency key: ${key}`);
					return id;
				};
				for (const item of items) {
					position += 1;
					const criteria = item.acceptanceCriteria.length
						? `\n\nAcceptance criteria:\n${item.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`
						: "";
					tx.insert(tasks)
						.values({
							id: taskIdFor(item.key),
							projectId,
							planId,
							title: item.title,
							description: item.description,
							prompt: `${item.description}${criteria}`,
							status: item.dependsOn.length ? "blocked" : "ready",
							position,
							priority: item.priority,
							acceptanceCriteria: JSON.stringify(item.acceptanceCriteria),
							suggestedFiles: JSON.stringify(item.suggestedFiles),
							source: "planner",
						})
						.run();
				}
				for (const item of items)
					for (const dep of item.dependsOn)
						tx.insert(taskDependencies)
							.values({
								taskId: taskIdFor(item.key),
								dependsOnTaskId: taskIdFor(dep),
							})
							.run();
				const now = new Date();
				tx.update(plans)
					.set({ status: "approved", convertedAt: now, errorMessage: null })
					.where(eq(plans.id, planId))
					.run();
				result = {
					taskIds: [...ids.values()],
					converted: true,
				};
			});
			return result;
		},
		dependencies(taskId: string) {
			return db
				.select()
				.from(taskDependencies)
				.where(eq(taskDependencies.taskId, taskId));
		},
		dependents(taskId: string) {
			return db
				.select()
				.from(taskDependencies)
				.where(eq(taskDependencies.dependsOnTaskId, taskId));
		},
		removeDependency(taskId: string, dependsOnTaskId: string) {
			return db
				.delete(taskDependencies)
				.where(
					and(
						eq(taskDependencies.taskId, taskId),
						eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
					),
				);
		},
	};
}

export type PlanRepository = ReturnType<typeof planRepository>;
