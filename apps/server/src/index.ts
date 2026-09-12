import { randomUUID } from "node:crypto";
import { appRouter } from "@loom/api/routers/index";
import type { Database } from "@loom/db";
import { repositories } from "@loom/db";
import { orchestrationRepository } from "@loom/db";
import {
	OpenCodeHttpRuntime,
	type OpenCodeManager,
	OpenCodeServerManager,
} from "@loom/opencode";
import { TaskOrchestrator } from "@loom/orchestrator";
import { RuntimePlanner, buildProjectContext, ContextBuilder } from "@loom/orchestrator";
import { validatePlan } from "@loom/orchestrator";
import { newEpicSchema, taskPlanSchema, artifactInputSchema } from "@loom/protocol";
import {
	createApiError,
	createProjectInputSchema,
	createTaskBatchInputSchema,
	createTaskInputSchema,
	daemonEventSchema,
	permissionDecisionInputSchema,
	taskIdInputSchema,
} from "@loom/protocol";
import {
	MergeConflictError,
	WorktreeError,
	WorktreeManager,
} from "@loom/worktree";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { createChatRoutes } from "./chat";
import { type DaemonConfig, loadDaemonConfig } from "./config";
import { createContext } from "./context";
import {
	createProjectValidationService,
	ProjectValidationError,
} from "./projects";
import { auth, checkDbHealth, getDb } from "./services";

const { upgradeWebSocket, websocket: bunWebSocket } = createBunWebSocket();

async function jsonBody(c: { req: { json: () => Promise<unknown> } }) {
	try {
		return await c.req.json();
	} catch {
		throw new Error("Request body must be valid JSON");
	}
}

function recordToProject(
	record:
		| {
				id: string;
				name: string;
				path: string;
				defaultBranch: string;
				createdAt: Date;
		  }
		| null
		| undefined,
) {
	if (!record) return null;
	return { ...record, createdAt: record.createdAt.toISOString() };
}

function recordToTask(
	record:
		| {
				id: string;
				projectId: string;
				title: string;
				prompt: string;
				status: string;
				workspaceId: string | null;
				sessionId: string | null;
				createdAt: Date;
				startedAt: Date | null;
				completedAt: Date | null;
				errorMessage: string | null;
		  }
		| null
		| undefined,
) {
	if (!record) return null;
	return {
		...record,
		createdAt: record.createdAt.toISOString(),
		startedAt: record.startedAt?.toISOString() ?? null,
		completedAt: record.completedAt?.toISOString() ?? null,
	};
}

function recordToAgentRun(record: {
	id: string;
	taskId: string;
	sessionId: string | null;
	status: string;
	startedAt: Date | null;
	completedAt: Date | null;
	errorMessage: string | null;
	errorCode: string | null;
	recoveryAction: string | null;
	retryOfRunId: string | null;
}) {
	return {
		...record,
		startedAt: record.startedAt?.toISOString() ?? null,
		completedAt: record.completedAt?.toISOString() ?? null,
	};
}

function recordToWorkspace(
	record:
		| {
				id: string;
				taskId: string;
				projectId: string;
				path: string;
				branch: string;
				baseCommit: string;
				createdAt: Date;
		  }
		| null
		| undefined,
) {
	if (!record) return null;
	return { ...record, createdAt: record.createdAt.toISOString() };
}

function errorResponse(
	c: { json: (body: unknown, status?: number) => Response },
	error: unknown,
) {
	let status = 500;
	let code: Parameters<typeof createApiError>[0] = "INTERNAL_ERROR";
	let action: string | null = null;
	if (error instanceof z.ZodError) {
		status = 400;
		code = "VALIDATION_ERROR";
	} else if (error instanceof ProjectValidationError) {
		status = 400;
		code = "BAD_REQUEST";
	} else if (error instanceof MergeConflictError) {
		status = 409;
		code = "MERGE_CONFLICT";
		action =
			"Resolve the listed files in the task worktree and retry the merge";
		return c.json(
			{
				error: createApiError(code, error.message, action, {
					files: error.files,
				}),
			},
			status,
		);
	} else if (error instanceof WorktreeError) {
		const worktreeError = error as WorktreeError;
		status = worktreeError.code === "GIT_UNAVAILABLE" ? 503 : 400;
		code =
			worktreeError.code === "GIT_UNAVAILABLE"
				? "GIT_UNAVAILABLE"
				: "WORKTREE_ERROR";
		action = "Check the project repository and workspace state";
	} else if (error instanceof Error && /not found/i.test(error.message)) {
		status = 404;
		code = "NOT_FOUND";
	} else if (
		error instanceof Error &&
		/already active|cannot start|cannot cancel|clean before merge/i.test(
			error.message,
		)
	) {
		status = 409;
		code = "CONFLICT";
	} else if (
		error instanceof Error &&
		/body must be valid|invalid/i.test(error.message)
	) {
		status = 400;
		code = "BAD_REQUEST";
	}
	const message =
		error instanceof Error ? error.message : "Internal server error";
	return c.json(
		{ error: createApiError(code, message, action) },
		status as 400 | 404 | 409 | 500 | 503,
	);
}

export type DaemonAppOptions = {
	config?: DaemonConfig;
	database?: Database;
	orchestrator?: TaskOrchestrator;
	openCodeManager?: OpenCodeManager;
	startOpenCode?: boolean;
	projectValidation?: ReturnType<typeof createProjectValidationService>;
};

export async function createApp(options: DaemonAppOptions = {}) {
	const config = options.config ?? (await loadDaemonConfig());
	const clients = new Set<{ send(data: string): void; close(): void }>();
	const db = options.database ?? getDb();
	const repos = repositories(db);
	const orchestration = orchestrationRepository(db);
	const eventPublisher = {
		publish(event: unknown) {
			const parsed = daemonEventSchema.parse(event);
			const payload = JSON.stringify(parsed);
			for (const client of clients) client.send(payload);
		},
	};
	const openCodeManager =
		options.openCodeManager ?? new OpenCodeServerManager();
	const ownsOpenCode = options.startOpenCode ?? true;
	if (ownsOpenCode) await openCodeManager.start();
	const orchestrator =
		options.orchestrator ??
		new TaskOrchestrator({
			...repos,
			worktree: new WorktreeManager(),
			runtime: new OpenCodeHttpRuntime(),
			events: eventPublisher,
		});
	// Dependency readiness is checked at dispatch time, so queued cards stay blocked
	// until every predecessor has completed.
	orchestrator.setLifecycle({
		async canRun(taskId) {
			const member = await orchestration.membership(taskId);
			if (!member) return true;
			const deps = await orchestration.dependencies(taskId);
			const statuses = await Promise.all(deps.map(async d => (await repos.tasks.getById(d.dependsOnTaskId))?.status));
			return statuses.every(status => status === "completed" || status === "ready_to_merge");
		},
		async prepare(task, _workspace) {
			const member = await orchestration.membership(task.id);
			if (!member) return task.prompt;
			const deps = await orchestration.dependencies(task.id);
			const depTasks = await Promise.all(deps.map(d => repos.tasks.getById(d.dependsOnTaskId)));
			const artifacts = await orchestration.artifacts(deps.map(d => d.dependsOnTaskId));
			return new ContextBuilder().build({ prompt: task.prompt, context: { summary: `Epic task ${member.key}`, commands: {} }, dependencies: depTasks.filter(Boolean).map(d => ({ title: d!.title, status: d!.status })), artifacts: artifacts as never[] });
		},
		async complete(task, _workspace) {
			const member = await orchestration.membership(task.id);
			if (member) await orchestration.audit(member.epicId, "task.completed", task.id);
		},
		async settled(taskId) {
			const member = await orchestration.membership(taskId);
			if (!member) return;
			const members = await orchestration.members(member.epicId);
			const rows = await Promise.all(members.map(m => repos.tasks.getById(m.taskId)));
			if (rows.length && rows.every(t => t?.status === "completed" || t?.status === "ready_to_merge")) {
				await orchestration.update(member.epicId, { status: "ready" });
			}
		},
		async guard(_taskId, action) {
			if (action === "merge") throw new Error("Epic tasks are merged through the integration review");
		},
	});
	await orchestrator.reconcile();
	const projectValidation =
		options.projectValidation ?? createProjectValidationService();
	const app = new Hono();

	app.use("/*", logger());
	app.use(
		"/*",
		cors({
			origin: config.corsOrigin,
			allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization"],
			credentials: true,
		}),
	);
	app.on(["POST", "GET"], "/api/auth/*", async (c) => auth.handler(c.req.raw));
	app.get("/health", async (c) => {
		const database = await checkDbHealth(db);
		return c.json(
			{ status: database ? "ok" : "degraded", database },
			database ? 200 : 503,
		);
	});
	app.get("/", (c) => c.text("OK"));

	app.get("/api/bootstrap", (c) => {
		if (c.req.header("Origin") !== config.corsOrigin)
			return c.json(
				{
					error: createApiError(
						"UNAUTHORIZED",
						"Bootstrap is only available to the configured local origin",
					),
				},
				401,
			);
		return c.json({ token: config.token });
	});

	app.use("/api/*", async (c, next) => {
		if (
			c.req.path.startsWith("/api/auth/") ||
			c.req.path === "/api/events" ||
			c.req.path === "/api/bootstrap"
		)
			return next();
		const authorization = c.req.header("Authorization");
		if (authorization !== `Bearer ${config.token}`) {
			return c.json(
				{ error: createApiError("UNAUTHORIZED", "Bearer token is required") },
				401,
			);
		}
		return next();
	});

	app.use("/api/events", async (c, next) => {
		const protocol = c.req.header("Sec-WebSocket-Protocol") ?? "";
		const suppliedToken =
			c.req.query("token") ?? protocol.split(",").at(-1)?.trim();
		if (suppliedToken !== config.token)
			return c.json(
				{
					error: createApiError(
						"UNAUTHORIZED",
						"A valid daemon token is required",
					),
				},
				401,
			);
		return next();
	});
	app.get(
		"/api/events",
		upgradeWebSocket(() => ({
			onOpen(_event, ws) {
				clients.add(ws);
			},
			onClose(_event, ws) {
				clients.delete(ws);
			},
		})),
	);

	app.route("/api/chat", createChatRoutes({ projects: repos.projects }));

	app.post("/api/projects", async (c) => {
		try {
			const input = createProjectInputSchema.parse(await jsonBody(c));
			const repository = await projectValidation.validate(input.path);
			const project = await repos.projects.create({
				name: repository.path.split("/").at(-1) || repository.path,
				path: repository.path,
				defaultBranch: repository.defaultBranch,
			});
			return c.json(recordToProject(project), 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/projects", async (c) =>
		c.json((await repos.projects.list()).map(recordToProject)),
	);
	app.get("/api/projects/:id", async (c) => {
		const project = await repos.projects.getById(c.req.param("id"));
		if (!project) return errorResponse(c, new Error("Project not found"));
		try {
			await projectValidation.validate(project.path);
			return c.json(recordToProject(project));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.delete("/api/projects/:id", async (c) => {
		const project = await repos.projects.getById(c.req.param("id"));
		if (!project) return errorResponse(c, new Error("Project not found"));
		await repos.projects.delete(project.id);
		return c.body(null, 204);
	});

	app.post("/api/epics", async (c) => {
		try {
			const input = newEpicSchema.parse(await jsonBody(c));
			const project = await repos.projects.getById(input.projectId);
			if (!project) throw new Error("Project not found");
			const context = await buildProjectContext(project);
			const epicId = randomUUID();
			await orchestration.create({ id: epicId, projectId: project.id, title: input.title, prompt: input.goal, status: "planning", context: JSON.stringify(context), plan: null, errorMessage: null, approvedAt: null });
			const planner = new RuntimePlanner(new OpenCodeHttpRuntime(), project.path);
			const plan = await planner.plan({ projectId: project.id, goal: input.goal, context });
			await orchestration.update(epicId, { plan: JSON.stringify(plan), status: "ready" });
			await orchestration.audit(epicId, "planner.created", JSON.stringify(plan));
			return c.json({ id: epicId, projectId: project.id, title: input.title, prompt: input.goal, status: "ready", plan, context }, 201);
		} catch (error) { return errorResponse(c, error); }
	});
	app.get("/api/projects/:projectId/epics", async c => c.json(await orchestration.list(c.req.param("projectId"))));
	app.get("/api/epics/:id", async c => {
		const epic = await orchestration.get(c.req.param("id"));
		if (!epic) return errorResponse(c, new Error("Epic not found"));
		const members = await orchestration.members(epic.id);
		const taskRows = await Promise.all(members.map(m => repos.tasks.getById(m.taskId)));
		return c.json({ ...epic, plan: epic.plan ? JSON.parse(epic.plan) : null, context: epic.context ? JSON.parse(epic.context) : null, tasks: members.map((m, i) => ({ ...m, task: taskRows[i] ? recordToTask(taskRows[i]) : null })), integrations: await orchestration.integrations(epic.id), events: await orchestration.events(epic.id) });
	});
	app.put("/api/epics/:id/plan", async c => {
		try { const plan = validatePlan(taskPlanSchema.parse(await jsonBody(c))); const epic = await orchestration.get(c.req.param("id")); if (!epic || epic.status !== "ready") throw new Error("Epic plan is not editable"); await orchestration.update(epic.id, { plan: JSON.stringify(plan) }); return c.json({ plan }); } catch (error) { return errorResponse(c, error); }
	});
	app.post("/api/epics/:id/start", async c => {
		try { const epic = await orchestration.get(c.req.param("id")); if (!epic) throw new Error("Epic not found"); const plan = epic.plan ? validatePlan(JSON.parse(epic.plan)) : null; if (!plan) throw new Error("Epic has no plan"); await orchestration.approve(epic.id, epic.projectId, plan, epic.context ?? "{}"); const members = await orchestration.members(epic.id); await Promise.all(members.map(m => orchestrator.enqueue(m.taskId))); return c.json({ started: true, taskIds: members.map(m => m.taskId) }, 202); } catch (error) { return errorResponse(c, error); }
	});
	app.post("/api/epics/:id/integrate", async c => {
		try { const epic = await orchestration.get(c.req.param("id")); if (!epic) throw new Error("Epic not found"); const members = await orchestration.members(epic.id); const completed = (await Promise.all(members.map(m => repos.tasks.getById(m.taskId)))).filter(t => t?.status === "completed"); if (completed.length !== members.length) throw new Error("All Epic tasks must complete before integration"); const runId = randomUUID(); await orchestration.createIntegration({ id: runId, epicId: epic.id, status: "review", workspacePath: null, branch: null, baseCommit: null, head: null, errorMessage: null, checks: "[]", diff: "Review task diffs before merging each branch.", sessionId: null }); await orchestration.audit(epic.id, "integration.started", runId); return c.json({ id: runId, status: "review" }, 201); } catch (error) { return errorResponse(c, error); }
	});
	app.post("/api/tasks/:id/artifacts", async c => {
		try { const task = await repos.tasks.getById(c.req.param("id")); if (!task) throw new Error("Task not found"); const input = artifactInputSchema.parse(await jsonBody(c)); const artifact = { id: randomUUID(), taskId: task.id, ...input }; await orchestration.addArtifact(artifact); const member = await orchestration.membership(task.id); if (member) await orchestration.audit(member.epicId, "artifact.created", JSON.stringify(artifact)); return c.json(artifact, 201); } catch (error) { return errorResponse(c, error); }
	});

	app.post("/api/tasks", async (c) => {
		try {
			const task = await orchestrator.create(
				createTaskInputSchema.parse(await jsonBody(c)),
			);
			return c.json(task, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/projects/:projectId/tasks/batch", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const input = createTaskBatchInputSchema.parse(await jsonBody(c));
			if (!(await repos.projects.getById(projectId)))
				throw new Error("Project not found");
			const results: Array<{
				index: number;
				task: (ReturnType<typeof recordToTask> & { errorMessage: null }) | null;
				error: string | null;
			}> = [];
			for (const [index, item] of input.tasks.entries()) {
				try {
					const task = await orchestrator.create({ ...item, projectId });
					results.push({
						index,
						task: { ...task, errorMessage: null },
						error: null,
					});
				} catch (error) {
					results.push({
						index,
						task: null,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			const status = results.some((result) => result.error) ? 207 : 201;
			return c.json({ results }, status);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/tasks", async (c) =>
		c.json((await repos.tasks.list()).map(recordToTask)),
	);
	app.get("/api/tasks/:id", async (c) => {
		const task = await repos.tasks.getById(c.req.param("id"));
		if (!task) return errorResponse(c, new Error("Task not found"));
		return c.json(recordToTask(task));
	});
	app.get("/api/tasks/:id/runs", async (c) => {
		try {
			const runs = await orchestrator.listRuns(c.req.param("id"));
			return c.json(runs.map(recordToAgentRun));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/tasks/:id/output", async (c) => {
		try {
			return c.json(await orchestrator.output(c.req.param("id")));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/scheduler", (c) =>
		c.json(orchestrator.getScheduler().getState()),
	);
	app.get("/api/snapshot", async (c) =>
		c.json(await orchestrator.getSnapshot()),
	);
	app.get("/api/recovery", (c) => c.json(orchestrator.getRecoveryState()));
	app.get("/api/permissions", async (c) => {
		try {
			return c.json(
				(await orchestrator.listPendingPermissions()).map((request) => ({
					...request,
					createdAt: request.createdAt.toISOString(),
					decidedAt: request.decidedAt?.toISOString() ?? null,
				})),
			);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/permissions/:id/decision", async (c) => {
		try {
			const input = permissionDecisionInputSchema.parse(await jsonBody(c));
			const request = await orchestrator.decidePermission(
				c.req.param("id"),
				input.decision,
			);
			return c.json({
				...request,
				createdAt: request.createdAt.toISOString(),
				decidedAt: request.decidedAt?.toISOString() ?? null,
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/tasks/:id/retry", async (c) => {
		try {
			return c.json(await orchestrator.retry(c.req.param("id")), 202);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/tasks/:id/start", async (c) => {
		try {
			await taskIdInputSchema.parseAsync({ taskId: c.req.param("id") });
			await orchestrator.enqueue(c.req.param("id"));
			return c.json({ accepted: true });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/tasks/:id/cancel", async (c) => {
		try {
			await orchestrator.cancel(c.req.param("id"));
			return c.json({ cancelled: true });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/tasks/:id/diff", async (c) => {
		try {
			return c.json({ diff: await orchestrator.diff(c.req.param("id")) });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/tasks/:id/merge", async (c) => {
		try {
			return c.json(await orchestrator.merge(c.req.param("id")));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/tasks/:id/discard", async (c) => {
		try {
			await orchestrator.discard(c.req.param("id"));
			return c.json({ discarded: true });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/tasks/:id/workspace", async (c) => {
		const task = await repos.tasks.getById(c.req.param("id"));
		const workspace = task?.workspaceId
			? await repos.workspaces.getById(task.workspaceId)
			: undefined;
		if (!workspace) return errorResponse(c, new Error("Workspace not found"));
		return c.json(recordToWorkspace(workspace));
	});

	const apiHandler = new OpenAPIHandler(appRouter, {
		plugins: [
			new OpenAPIReferencePlugin({
				schemaConverters: [new ZodToJsonSchemaConverter()],
			}),
		],
		interceptors: [onError((error) => console.error(error))],
	});
	const rpcHandler = new RPCHandler(appRouter, {
		interceptors: [onError((error) => console.error(error))],
	});
	app.use("/*", async (c, next) => {
		const context = await createContext({ context: c });
		const rpcResult = await rpcHandler.handle(c.req.raw, {
			prefix: "/rpc",
			context,
		});
		if (rpcResult.matched)
			return c.newResponse(rpcResult.response.body, rpcResult.response);
		const apiResult = await apiHandler.handle(c.req.raw, {
			prefix: "/api-reference",
			context,
		});
		if (apiResult.matched)
			return c.newResponse(apiResult.response.body, apiResult.response);
		return next();
	});
	app.notFound((c) => errorResponse(c, new Error("Route not found")));
	app.onError((error, c) => errorResponse(c, error));
	return {
		app,
		config,
		close: async () => {
			await orchestrator.getScheduler().shutdown();
			for (const client of clients) client.close();
			clients.clear();
			if (ownsOpenCode) await openCodeManager.stop();
		},
	};
}

const daemon = await createApp({
	startOpenCode: import.meta.main || process.env.LOOM_DAEMON === "true",
});
export const app = daemon.app;
export const apiHandler = new OpenAPIHandler(appRouter, {
	plugins: [
		new OpenAPIReferencePlugin({
			schemaConverters: [new ZodToJsonSchemaConverter()],
		}),
	],
});
export const rpcHandler = new RPCHandler(appRouter);

if (import.meta.main || process.env.LOOM_DAEMON === "true") {
	const server = Bun.serve({
		fetch: app.fetch,
		port: daemon.config.port,
		hostname: "127.0.0.1",
		websocket: bunWebSocket,
	});
	const shutdown = async () => {
		server.stop(true);
		await daemon.close();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}
