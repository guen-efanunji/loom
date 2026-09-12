import { appRouter } from "@loom/api/routers/index";
import type { Database } from "@loom/db";
import { repositories } from "@loom/db";
import {
	OpenCodeHttpRuntime,
	type OpenCodeManager,
	OpenCodeServerManager,
} from "@loom/opencode";
import { TaskOrchestrator } from "@loom/orchestrator";
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
			credentials: false,
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
			await orchestrator.enqueueAndWait(c.req.param("id"));
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
