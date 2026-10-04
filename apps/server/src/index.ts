import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { appRouter } from "@loom/api/routers/index";
import type { Database } from "@loom/db";
import {
	type DesignMessageRecord,
	type DesignNodeRecord,
	designRepository,
	planRepository,
	repositories,
} from "@loom/db";
import {
	automationModeSchema,
	dataDirectory,
	log,
	PROTOCOL_VERSION,
	readSettings,
	releaseChannelSchema,
	saveSettings,
	VERSION,
} from "@loom/distribution";
import { checkForUpdate } from "@loom/distribution/updates";
import {
	type AgentRuntime,
	OpenCodeHttpRuntime,
	type OpenCodeManager,
	OpenCodeServerManager,
} from "@loom/opencode";
import {
	AutomationService,
	combineHooks,
	DesignService,
	deriveDesignTitle,
	TaskOrchestrator,
} from "@loom/orchestrator";
import {
	agentModelRefSchema,
	automationPlanTaskSchema,
	createApiError,
	createDesignSchema,
	createProjectInputSchema,
	createTaskBatchInputSchema,
	createTaskInputSchema,
	daemonEventSchema,
	designPatchSchema,
	permissionDecisionInputSchema,
	refineDesignSchema,
	type Task,
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
				position: number | null;
				planId: string | null;
				description: string;
				priority: string;
				acceptanceCriteria: string;
				suggestedFiles: string;
				source: string;
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

function recordToDesignNode(record: DesignNodeRecord) {
	return {
		...record,
		status: record.status as "queued" | "generating" | "ready" | "failed",
		viewport:
			record.viewport === "mobile" ? ("mobile" as const) : ("desktop" as const),
		createdAt: record.createdAt.toISOString(),
		updatedAt: record.updatedAt.toISOString(),
	};
}

function recordToDesignMessage(record: DesignMessageRecord) {
	return {
		...record,
		role:
			record.role === "assistant" ? ("assistant" as const) : ("user" as const),
		createdAt: record.createdAt.toISOString(),
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
	update?: (
		channel?: string,
	) => Promise<{ updating: boolean; version: string }>;
	staticAssets?: Record<string, { body: string; type: string }>;
	onShutdown?: () => void;
	config?: DaemonConfig;
	database?: Database;
	orchestrator?: TaskOrchestrator;
	openCodeManager?: OpenCodeManager;
	startOpenCode?: boolean;
	projectValidation?: ReturnType<typeof createProjectValidationService>;
	plannerRuntime?: AgentRuntime;
	designRuntime?: AgentRuntime;
};

export async function createApp(options: DaemonAppOptions = {}) {
	const config = options.config ?? (await loadDaemonConfig());
	const clients = new Set<{ send(data: string): void; close(): void }>();
	const db = options.database ?? getDb();
	const repos = repositories(db);
	const eventPublisher = {
		publish(event: unknown) {
			const parsed = daemonEventSchema.parse(event);
			log(
				"orchestrator",
				parsed.type,
				"taskId" in parsed ? { taskId: parsed.taskId } : {},
			);
			const payload = JSON.stringify(parsed);
			for (const client of clients) client.send(payload);
		},
	};
	const openCodeManager =
		options.openCodeManager ?? new OpenCodeServerManager();
	const ownsOpenCode = options.startOpenCode ?? true;
	if (ownsOpenCode) {
		// Start OpenCode in the background so the daemon can bind its API
		// immediately. A missing or slow provider must not leave the client in
		// an endless reconnect loop.
		void openCodeManager.start().catch((error) =>
			log(
				"opencode",
				"unavailable",
				{
					error: error instanceof Error ? error.message : String(error),
				},
				"warn",
			),
		);
	}
	const worktreeManager = new WorktreeManager();
	const agentRuntime = new OpenCodeHttpRuntime();
	const orchestrator =
		options.orchestrator ??
		new TaskOrchestrator({
			...repos,
			worktree: worktreeManager,
			runtime: agentRuntime,
			events: eventPublisher,
		});
	const automation = new AutomationService(
		planRepository(db),
		repos,
		orchestrator,
		options.plannerRuntime ?? agentRuntime,
	);
	const designs = new DesignService(
		designRepository(db),
		repos,
		options.designRuntime ?? agentRuntime,
	);
	orchestrator.setLifecycle(combineHooks(automation.hooks()));
	await orchestrator.reconcile();
	await automation.recover();
	await designs.recover();
	const projectValidation =
		options.projectValidation ?? createProjectValidationService();
	const app = new Hono();
	const allowedOrigins = new Set(
		config.corsOrigin
			.split(",")
			.map((origin) => origin.trim())
			.filter(Boolean),
	);

	app.use("/*", async (c, next) => {
		const host = c.req.header("Host");
		if (
			host &&
			!["127.0.0.1", "localhost", "[::1]"].includes(host.replace(/:\d+$/, ""))
		)
			return c.json({ error: { message: "Local host required" } }, 403);
		const origin = c.req.header("Origin");
		if (origin && !allowedOrigins.has(origin))
			return c.json({ error: { message: "Origin is not allowed" } }, 403);
		if (
			/^\/(rpc|api-reference)(\/|$)/.test(c.req.path) &&
			c.req.header("Authorization") !== `Bearer ${config.token}`
		)
			return c.json({ error: { message: "Bearer token is required" } }, 401);
		if (
			!["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
			!["/api/bootstrap", "/api/daemon/stop"].includes(c.req.path)
		) {
			const updating = await access(
				join(dataDirectory(), "cache", "update.lock"),
			).then(
				() => true,
				() => false,
			);
			if (updating)
				return c.json(
					{ error: { message: "Loom is updating; retry after restart" } },
					409,
				);
		}
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Referrer-Policy", "no-referrer");
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.use(
		"/*",
		cors({
			origin: (origin) =>
				!origin || allowedOrigins.has(origin) ? origin : undefined,
			allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization"],
			credentials: true,
		}),
	);
	app.on(["POST", "GET"], "/api/auth/*", async (c) => auth.handler(c.req.raw));
	app.get("/health", async (c) => {
		const database = await checkDbHealth(db);
		return c.json(
			{
				status: database ? "ok" : "degraded",
				database,
				product: "loom",
				version: VERSION,
				protocolVersion: PROTOCOL_VERSION,
			},
			database ? 200 : 503,
		);
	});
	if (!options.staticAssets) app.get("/", (c) => c.text("OK"));

	app.on(["POST", "GET"], "/api/bootstrap", (c) => {
		if (!allowedOrigins.has(c.req.header("Origin") ?? ""))
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
	app.get("/api/meta", (c) =>
		c.json({ version: VERSION, protocolVersion: PROTOCOL_VERSION }),
	);
	const updateReady = async () => {
		const scheduler = orchestrator.getScheduler().getState();
		if (scheduler.running.length || scheduler.queued.length)
			throw new Error("Finish or cancel active tasks before updating");
		try {
			const response = await fetch("http://127.0.0.1:4096/session/status", {
				signal: AbortSignal.timeout(2000),
			});
			if (response.ok) {
				const states = (await response.json()) as Record<
					string,
					{ type: string }
				>;
				if (Object.values(states).some((s) => s.type !== "idle"))
					throw new Error("Wait for OpenCode chats to finish before updating");
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Wait for"))
				throw error;
		}
	};
	app.get("/api/updates/ready", async (c) => {
		try {
			await updateReady();
			return c.json({ ready: true });
		} catch (error) {
			return c.json(
				{
					error: {
						message:
							error instanceof Error
								? error.message
								: "Active work prevents update",
					},
				},
				409,
			);
		}
	});
	app.get("/api/updates", async (c) => {
		const settings = await readSettings();
		const status = settings.updateChecks
			? await checkForUpdate(settings.releaseChannel)
			: {
					current: VERSION,
					channel: settings.releaseChannel,
					checkedAt: null,
					latest: null,
					available: false,
				};
		let lastResult: unknown = null;
		try {
			lastResult = JSON.parse(
				await readFile(
					join(dataDirectory(), "cache", "update-result.json"),
					"utf8",
				),
			);
		} catch {}
		return c.json({
			...status,
			supported: !!options.update,
			enabled: settings.updateChecks,
			lastResult,
		});
	});
	app.post("/api/updates/check", async (c) =>
		c.json(
			await checkForUpdate((await readSettings()).releaseChannel, {
				force: true,
			}),
		),
	);
	app.post("/api/updates/install", async (c) => {
		if (!options.update)
			return c.json(
				{
					error: { message: "Updates require an installed standalone binary" },
				},
				409,
			);
		try {
			await updateReady();
			return c.json(await options.update(), 202);
		} catch (error) {
			return c.json(
				{
					error: {
						message: error instanceof Error ? error.message : "Update failed",
					},
				},
				409,
			);
		}
	});
	app.put("/api/updates/settings", async (c) => {
		const input = z
			.object({
				releaseChannel: releaseChannelSchema,
				updateChecks: z.boolean(),
			})
			.parse(await jsonBody(c));
		await saveSettings({ ...(await readSettings()), ...input });
		return c.json(input);
	});
	app.post("/api/daemon/stop", (c) => {
		if (!options.onShutdown)
			return c.json(
				{
					error: {
						message: "Use the development terminal to stop this daemon",
					},
				},
				409,
			);
		setTimeout(options.onShutdown, 100);
		return c.json({ stopping: true });
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

	app.route(
		"/api/chat",
		createChatRoutes({
			projects: repos.projects,
			sessionScope: (id) => orchestrator.sessionScope(id),
		}),
	);

	app.post("/api/projects", async (c) => {
		try {
			const input = createProjectInputSchema.parse(await jsonBody(c));
			const repository = await projectValidation.validate(input.path);
			const project = await repos.projects.create({
				name: basename(repository.path) || repository.path,
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
	app.patch("/api/projects/:id", async (c) => {
		try {
			const project = await repos.projects.getById(c.req.param("id"));
			if (!project) return errorResponse(c, new Error("Project not found"));
			const input = z
				.object({
					name: z.string().trim().min(1).max(120).optional(),
					path: z.string().trim().min(1).optional(),
				})
				.refine((value) => value.name !== undefined || value.path !== undefined)
				.parse(await jsonBody(c));
			const path = input.path
				? (await projectValidation.validate(input.path)).path
				: project.path;
			const [updated] = await repos.projects.update(c.req.param("id"), {
				...(input.name ? { name: input.name } : {}),
				path,
			});
			if (!updated) throw new Error("Project not found");
			return c.json(recordToProject(updated));
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

	const planInputSchema = z.object({
		projectId: z.string().min(1),
		sourceMessageId: z.string().min(1).max(200),
		message: z.string().trim().min(1).max(20000),
		sourceSessionId: z.string().min(1).max(200).optional(),
		mode: z.enum(["plan", "build"]).default("plan"),
		model: z
			.object({ providerID: z.string().min(1), modelID: z.string().min(1) })
			.optional(),
	});
	const planPatchSchema = z.object({
		title: z.string().trim().min(1).max(200).optional(),
		summary: z.string().trim().max(5000).optional(),
		tasks: z.array(automationPlanTaskSchema).min(1).max(30),
	});
	app.post("/api/plans", async (c) => {
		try {
			const input = planInputSchema.parse(await jsonBody(c));
			const settings = await readSettings();
			const { planId, status } = await automation.createPlan({
				...input,
				automationMode:
					input.mode === "build" && settings.automationMode === "review"
						? "auto-create"
						: settings.automationMode,
			});
			return c.json({ planId, status }, 202);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/projects/:projectId/plans", async (c) => {
		try {
			return c.json(await automation.list(c.req.param("projectId")));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/plans/:id", async (c) => {
		try {
			return c.json(await automation.detail(c.req.param("id")));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.patch("/api/plans/:id", async (c) => {
		try {
			const input = planPatchSchema.parse(await jsonBody(c));
			await automation.savePlan(c.req.param("id"), input);
			return c.json({ saved: true });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/plans/:id/validate", async (c) => {
		try {
			return c.json(await automation.validatePlan(c.req.param("id")));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/plans/:id/approve", async (c) => {
		try {
			await automation.approve(c.req.param("id"));
			return c.json({ approved: true });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/plans/:id/tasks", async (c) => {
		try {
			return c.json(await automation.convert(c.req.param("id")), 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/plans/:id/start", async (c) => {
		try {
			return c.json(await automation.start(c.req.param("id")), 202);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/plans/:id/cancel", async (c) => {
		try {
			await automation.cancel(c.req.param("id"));
			return c.json({ cancelled: true });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.delete("/api/plans/:id", async (c) => {
		try {
			await automation.deletePlan(c.req.param("id"));
			return c.body(null, 204);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/plans/:id/retry", async (c) => {
		try {
			const input = z
				.object({
					model: z
						.object({
							providerID: z.string().min(1),
							modelID: z.string().min(1),
						})
						.optional(),
				})
				.parse(await jsonBody(c).catch(() => ({})));
			await automation.retryPlan(c.req.param("id"), input.model);
			return c.json({ accepted: true }, 202);
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	const designPublishSchema = z.object({
		path: z.string().trim().min(1).max(300).optional(),
	});
	const designRetrySchema = z.object({
		model: agentModelRefSchema.optional(),
	});
	app.post("/api/designs", async (c) => {
		try {
			const input = createDesignSchema.parse(await jsonBody(c));
			return c.json(await designs.create(input), 202);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/projects/:projectId/designs", async (c) => {
		try {
			const thread = await designs.list(c.req.param("projectId"));
			return c.json({
				nodes: thread.nodes.map(recordToDesignNode),
				messages: thread.messages.map(recordToDesignMessage),
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/designs/:id", async (c) => {
		try {
			return c.json(
				recordToDesignNode(await designs.detail(c.req.param("id"))),
			);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.patch("/api/designs/:id", async (c) => {
		try {
			const input = designPatchSchema.parse(await jsonBody(c));
			return c.json(
				recordToDesignNode(await designs.save(c.req.param("id"), input)),
			);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/designs/:id/refine", async (c) => {
		try {
			const input = refineDesignSchema.parse(await jsonBody(c));
			return c.json(await designs.refine(c.req.param("id"), input), 202);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/designs/:id/retry", async (c) => {
		try {
			const body = designRetrySchema.parse(await jsonBody(c).catch(() => ({})));
			return c.json(await designs.retry(c.req.param("id"), body.model), 202);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/designs/:id/publish", async (c) => {
		try {
			const node = await designs.detail(c.req.param("id"));
			if (node.status !== "ready" || !node.html.trim())
				throw new Error("Only completed designs can be published");
			const project = await repos.projects.getById(node.projectId);
			if (!project) return errorResponse(c, new Error("Project not found"));
			const input = designPublishSchema.parse(
				await jsonBody(c).catch(() => ({})),
			);
			const slug =
				deriveDesignTitle(node.brief)
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 60) || "design";
			const requested = (input.path ?? `designs/${slug}.html`).replace(
				/^\/+/,
				"",
			);
			if (!/\.html?$/i.test(requested))
				throw new Error("Publish path must end in .html");
			const root = resolve(project.path);
			const target = resolve(root, requested);
			const inside = relative(root, target);
			if (
				!inside ||
				isAbsolute(inside) ||
				inside === ".." ||
				inside.startsWith(`..${sep}`)
			)
				throw new Error("Publish path must stay inside the project");
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, `${node.html}\n`, "utf8");
			return c.json({ published: true, path: inside.split(sep).join("/") });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.delete("/api/designs/:id", async (c) => {
		try {
			await designs.remove(c.req.param("id"));
			return c.body(null, 204);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.delete("/api/projects/:projectId/designs", async (c) => {
		try {
			await designs.clear(c.req.param("projectId"));
			return c.body(null, 204);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/automation/settings", async (c) => {
		try {
			const settings = await readSettings();
			return c.json({ automationMode: settings.automationMode });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.put("/api/automation/settings", async (c) => {
		try {
			const input = z
				.object({ automationMode: automationModeSchema })
				.parse(await jsonBody(c));
			await saveSettings({ ...(await readSettings()), ...input });
			return c.json(input);
		} catch (error) {
			return errorResponse(c, error);
		}
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
				task: (Task & { errorMessage: null }) | null;
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
		c.json(
			await Promise.all(
				(await repos.tasks.list()).map(async (task) => ({
					...recordToTask(task),
				})),
			),
		),
	);
	app.get("/api/tasks/:id", async (c) => {
		const task = await repos.tasks.getById(c.req.param("id"));
		if (!task) return errorResponse(c, new Error("Task not found"));
		return c.json({
			...recordToTask(task),
		});
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
	app.patch("/api/tasks/:id", async (c) => {
		try {
			const input = z
				.object({
					title: z.string().trim().min(1).max(200).optional(),
					prompt: z.string().trim().min(1).max(20000).optional(),
				})
				.parse(await jsonBody(c));
			const task = await orchestrator.renameTask(c.req.param("id"), input);
			return c.json(task);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.delete("/api/tasks/:id", async (c) => {
		try {
			await orchestrator.removeTask(c.req.param("id"));
			return c.body(null, 204);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/projects/:projectId/tasks/reorder", async (c) => {
		try {
			const input = z
				.object({ orderedIds: z.array(z.string().min(1)).max(500) })
				.parse(await jsonBody(c));
			await orchestrator.reorderTasks(
				c.req.param("projectId"),
				input.orderedIds,
			);
			return c.json({ reordered: true });
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
	app.notFound((c) => {
		if (
			options.staticAssets &&
			["GET", "HEAD"].includes(c.req.method) &&
			!/^\/(api|rpc|api-reference)(\/|$)/.test(c.req.path)
		) {
			const asset =
				options.staticAssets[c.req.path] ??
				(c.req.header("Accept")?.includes("text/html")
					? options.staticAssets["/index.html"]
					: undefined);
			if (asset)
				return new Response(
					c.req.method === "HEAD" ? null : Buffer.from(asset.body, "base64"),
					{
						headers: {
							"Content-Type": asset.type,
							"X-Content-Type-Options": "nosniff",
							"Cache-Control": c.req.path.includes("/immutable/")
								? "public, max-age=31536000, immutable"
								: "no-cache",
							"Content-Security-Policy":
								"frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
						},
					},
				);
		}
		return errorResponse(c, new Error("Route not found"));
	});
	app.onError((error, c) => errorResponse(c, error));
	return {
		app,
		config,
		close: async () => {
			await orchestrator.getScheduler().shutdown();
			for (const client of clients) client.close();
			clients.clear();
			if (ownsOpenCode) await openCodeManager.stop();
			if (!options.database) db.$client.close();
		},
	};
}

export { bunWebSocket };
export const apiHandler = new OpenAPIHandler(appRouter, {
	plugins: [
		new OpenAPIReferencePlugin({
			schemaConverters: [new ZodToJsonSchemaConverter()],
		}),
	],
});
export const rpcHandler = new RPCHandler(appRouter);

if (import.meta.main || process.env.LOOM_DAEMON === "true") {
	const daemon = await createApp();
	const server = Bun.serve({
		fetch: daemon.app.fetch,
		port: daemon.config.port,
		hostname: "127.0.0.1",
		websocket: bunWebSocket,
	});
	log("daemon", "started", { port: daemon.config.port, version: VERSION });
	const shutdown = async () => {
		server.stop(true);
		await daemon.close();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}
