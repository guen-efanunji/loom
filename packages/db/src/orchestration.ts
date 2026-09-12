import { randomUUID } from "node:crypto";
import { asc, desc, eq, inArray, type InferInsertModel } from "drizzle-orm";
import type { Database } from "./index";
import { epics, epicTasks, taskDependencies, taskArtifacts, plannerRuns, integrationRuns, auditEvents, tasks } from "./schema";

export function orchestrationRepository(db: Database) {
 return {
  list: (projectId: string) => db.select().from(epics).where(eq(epics.projectId, projectId)).orderBy(desc(epics.createdAt)),
  all: () => db.select().from(epics),
  get: (id: string) => db.query.epics.findFirst({ where: eq(epics.id, id) }),
  create: (input: InferInsertModel<typeof epics>) => db.insert(epics).values(input),
  update: (id: string, input: Partial<InferInsertModel<typeof epics>>) => db.update(epics).set(input).where(eq(epics.id, id)),
  membership: (taskId: string) => db.query.epicTasks.findFirst({ where: eq(epicTasks.taskId, taskId) }),
  members: (epicId: string) => db.select().from(epicTasks).where(eq(epicTasks.epicId, epicId)),
  dependencies: (taskId: string) => db.select().from(taskDependencies).where(eq(taskDependencies.taskId, taskId)),
  async approve(epicId: string, projectId: string, plan: { tasks: Array<{ key: string; title: string; prompt: string; dependsOn: string[] }> }, context: string) {
   await db.transaction(async tx => {
    const current = await tx.query.epics.findFirst({ where: eq(epics.id, epicId) });
    if (!current || current.status !== "ready" || current.approvedAt) throw new Error("Plan cannot start from its current state");
    const ids = new Map(plan.tasks.map(t => [t.key, randomUUID()]));
    for (const task of plan.tasks) {
     const id = ids.get(task.key)!;
     await tx.insert(tasks).values({ id, projectId, title: task.title, prompt: task.prompt });
     await tx.insert(epicTasks).values({ taskId: id, epicId, key: task.key });
    }
    for (const task of plan.tasks) for (const dep of task.dependsOn) await tx.insert(taskDependencies).values({ taskId: ids.get(task.key)!, dependsOnTaskId: ids.get(dep)! });
    await tx.update(epics).set({ status: "running", plan: JSON.stringify(plan), context, approvedAt: new Date(), errorMessage: null }).where(eq(epics.id, epicId));
    await tx.insert(auditEvents).values({ id: randomUUID(), epicId, type: "plan.approved", detail: JSON.stringify(plan) });
   });
  },
  artifacts: (taskIds: string[]) => taskIds.length ? db.select().from(taskArtifacts).where(inArray(taskArtifacts.taskId, taskIds)) : Promise.resolve([]),
  addArtifact: (input: InferInsertModel<typeof taskArtifacts>) => db.insert(taskArtifacts).values(input),
  createPlannerRun: (input: InferInsertModel<typeof plannerRuns>) => db.insert(plannerRuns).values(input),
  updatePlannerRun: (id: string, input: Partial<InferInsertModel<typeof plannerRuns>>) => db.update(plannerRuns).set(input).where(eq(plannerRuns.id, id)),
  plannerRuns: (epicId: string) => db.select().from(plannerRuns).where(eq(plannerRuns.epicId, epicId)).orderBy(desc(plannerRuns.createdAt)),
  createIntegration: (input: InferInsertModel<typeof integrationRuns>) => db.insert(integrationRuns).values(input),
  updateIntegration: (id: string, input: Partial<InferInsertModel<typeof integrationRuns>>) => db.update(integrationRuns).set(input).where(eq(integrationRuns.id, id)),
  integration: (id: string) => db.query.integrationRuns.findFirst({ where: eq(integrationRuns.id, id) }),
  integrations: (epicId: string) => db.select().from(integrationRuns).where(eq(integrationRuns.epicId, epicId)).orderBy(desc(integrationRuns.createdAt)),
  audit: (epicId: string, type: string, detail: string) => db.insert(auditEvents).values({ id: randomUUID(), epicId, type, detail }),
  events: (epicId: string) => db.select().from(auditEvents).where(eq(auditEvents.epicId, epicId)).orderBy(asc(auditEvents.createdAt)),
 };
}
export type OrchestrationRepository = ReturnType<typeof orchestrationRepository>;
