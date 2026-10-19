import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	access,
	chmod,
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
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
	customAgentAssignmentRuns,
	customAgentRunEvents,
	customAgentRuns,
	customAgentSkills,
	customAgents,
	type DesignMessageRecord,
	type DesignNodeRecord,
	desc,
	designRepository,
	eq,
	gt,
	or,
	orchestrationEvents,
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
	chatDesignSchema,
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
	type TaskExecutor,
	taskExecutorSchema,
	taskIdInputSchema,
} from "@loom/protocol";
import {
	createDefaultProviderRegistry,
	CustomProviderAdapter,
	discoverCustomModels,
	ProviderManager,
	readPrompt,
	testCustomModel,
} from "@loom/providers";
import type { CustomProviderConfig } from "@loom/providers";
import type {
	AgentModel,
	AgentRuntime,
	RuntimeModel,
	RuntimePermission,
	RuntimeToolAuthorization,
} from "@loom/providers/core";
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
import { createAgentSettingsRoutes } from "./agents";
import { registerAgyPermissionHook } from "./agy-hooks";
import { type ChatRequestGateway, createChatRoutes } from "./chat";
import { type DaemonConfig, loadDaemonConfig } from "./config";
import { createContext } from "./context";
import { createContextHubRoutes } from "./context-hub";
import { createMcpManagerRoutes } from "./mcp-manager";
import {
	type AgyPermissionStore,
	createAgyPermissionStore,
} from "./permissions";
import {
	createProjectValidationService,
	ProjectValidationError,
} from "./projects";
import { checkProviderUpdate, updateProviderCli } from "./provider-updates";
import { auth, checkDbHealth, getDb } from "./services";
import { TerminalManager } from "./terminal";
import { collectWalkthroughSnapshot } from "./walkthrough";

const { upgradeWebSocket, websocket: bunWebSocket } = createBunWebSocket();

const walkthroughDocumentSchema = z.object({
	schemaVersion: z.literal(1),
	title: z.string().trim().min(1).max(180),
	summary: z.string().trim().min(1).max(4000),
	groups: z
		.array(
			z.object({
				id: z.string().min(1).max(100),
				title: z.string().trim().min(1).max(180),
				steps: z
					.array(
						z.object({
							id: z.string().min(1).max(100),
							title: z.string().trim().min(1).max(180),
							explanation: z.string().trim().min(1).max(4000),
							evidenceIds: z.array(z.string().min(1).max(100)).min(1).max(30),
							observations: z.array(z.string().max(1000)).max(12).default([]),
							cautions: z
								.array(
									z.object({
										kind: z.enum(["observed", "inferred", "unverified"]),
										message: z.string().trim().min(1).max(1000),
										evidenceIds: z.array(z.string().min(1).max(100)).max(30),
									}),
								)
								.max(12)
								.default([]),
						}),
					)
					.min(1)
					.max(30),
			}),
		)
		.max(20),
	limitations: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
});

type WalkthroughRun = {
	projectId: string;
	startedAt: number;
	evidenceIds: string[];
	provider: { providerId: string; modelId: string };
	status: "running" | "completed" | "failed";
	document?: z.infer<typeof walkthroughDocumentSchema> | null;
	error?: string;
};

function parseWalkthroughOutput(
	output: { output: string; truncated?: boolean } | null,
	evidenceIds: string[],
) {
	if (!output?.output.trim())
		throw new Error("The selected provider returned an empty walkthrough.");
	if (output.truncated)
		throw new Error(
			"The selected provider response was truncated; retry with a smaller snapshot.",
		);
	if (output.output.length > 64_000)
		throw new Error("The walkthrough response exceeded the 64 KiB limit.");
	const raw = output.output
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	const document = walkthroughDocumentSchema.parse(JSON.parse(raw));
	const allowedEvidence = new Set(evidenceIds);
	const generatedIds = new Set<string>();
	for (const group of document.groups) {
		if (generatedIds.has(group.id))
			throw new Error("The generated walkthrough contains duplicate IDs.");
		generatedIds.add(group.id);
		for (const step of group.steps) {
			if (generatedIds.has(step.id))
				throw new Error("The generated walkthrough contains duplicate IDs.");
			generatedIds.add(step.id);
			if (step.evidenceIds.some((id) => !allowedEvidence.has(id)))
				throw new Error(
					"The generated walkthrough referenced evidence outside the captured snapshot.",
				);
			if (
				step.cautions.some((caution) =>
					caution.evidenceIds.some((id) => !allowedEvidence.has(id)),
				)
			)
				throw new Error(
					"The generated walkthrough referenced evidence outside the captured snapshot.",
				);
		}
	}
	return document;
}

async function jsonBody(c: { req: { json: () => Promise<unknown> } }) {
	try {
		return await c.req.json();
	} catch {
		throw new Error("Request body must be valid JSON");
	}
}

async function runWorkspaceCommand(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs = 5_000,
) {
	const child = Bun.spawn([command, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeout = setTimeout(() => child.kill(), timeoutMs);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return {
			exitCode,
			stdout: stdout.slice(0, 500_000),
			stderr: stderr.slice(0, 20_000),
		};
	} finally {
		clearTimeout(timeout);
	}
}

function recordToProject(
	record:
		| {
				id: string;
				name: string;
				path: string;
				defaultBranch: string;
				autoAccept?: boolean;
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
				executorConfig: string | null;
				targetBranch: string | null;
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
	const { executorConfig, ...task } = record;
	const parseList = (value: string) => {
		try {
			const parsed: unknown = JSON.parse(value);
			return Array.isArray(parsed)
				? parsed.filter((item): item is string => typeof item === "string")
				: [];
		} catch {
			return [];
		}
	};
	let executor: TaskExecutor | null = null;
	if (executorConfig) {
		try {
			executor = taskExecutorSchema.parse(JSON.parse(executorConfig));
		} catch {
			// Preserve task readability if a legacy or manually edited config is invalid.
		}
	}
	return {
		...task,
		acceptanceCriteria: parseList(record.acceptanceCriteria),
		suggestedFiles: parseList(record.suggestedFiles),
		executor,
		targetBranch: record.targetBranch ?? null,
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
	executorSnapshotJson?: string | null;
	snapshotHash?: string | null;
	effectiveProvider?: string | null;
	effectiveModel?: string | null;
	attemptNumber?: number;
	baseSha?: string | null;
	outputSha?: string | null;
}) {
	return {
		...record,
		executorSnapshotJson: record.executorSnapshotJson ?? null,
		snapshotHash: record.snapshotHash ?? null,
		effectiveProvider: record.effectiveProvider ?? null,
		effectiveModel: record.effectiveModel ?? null,
		attemptNumber: record.attemptNumber ?? 1,
		baseSha: record.baseSha ?? null,
		outputSha: record.outputSha ?? null,
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
	agentRuntime?: AgentRuntime;
	projectValidation?: ReturnType<typeof createProjectValidationService>;
	plannerRuntime?: AgentRuntime;
	designRuntime?: AgentRuntime;
	agyPermissionStore?: AgyPermissionStore;
	agyPermissionUrl?: string;
	registerAgyHook?: boolean;
	initializeProviders?: boolean;
};

function redactEvent(value: unknown, key = ""): unknown {
	if (
		/(authorization|api.?key|access.?token|refresh.?token|password|secret|credential)/i.test(
			key,
		)
	)
		return "[REDACTED]";
	if (typeof value === "string")
		return value
			.replace(
				/\b(sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi,
				"[REDACTED]",
			)
			.replace(
				/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[:=]\s*["']?[^\s,"'}]+/gi,
				"[REDACTED]",
			)
			.slice(-64_000);
	if (Array.isArray(value))
		return value.slice(0, 500).map((item) => redactEvent(item));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([childKey, child]) => [
				childKey,
				redactEvent(child, childKey),
			]),
		);
	return value;
}

export async function createApp(options: DaemonAppOptions = {}) {
	const config = options.config ?? (await loadDaemonConfig());
	const clients = new Set<{ send(data: string): void; close(): void }>();
	const db = options.database ?? getDb();
	const repos = repositories(db);
	const designRepo = designRepository(db);
	let eventWriteQueue = Promise.resolve();
	const eventPublisher = {
		publish(event: unknown) {
			const parsed = daemonEventSchema.parse(event);
			log(
				"orchestrator",
				parsed.type,
				"taskId" in parsed ? { taskId: parsed.taskId } : {},
			);
			eventWriteQueue = eventWriteQueue
				.then(async () => {
					const safeEvent = redactEvent(parsed);
					const scopeId =
						("taskId" in parsed && parsed.taskId) ||
						("task" in parsed && parsed.task.id) ||
						("planId" in parsed && parsed.planId) ||
						("providerId" in parsed && parsed.providerId) ||
						("conflict" in parsed && parsed.conflict.taskId) ||
						"global";
					const inserted = await db
						.insert(orchestrationEvents)
						.values({
							scopeId,
							type: parsed.type,
							payloadRedacted: JSON.stringify(safeEvent),
						})
						.returning({ cursor: orchestrationEvents.cursor });
					const payload = JSON.stringify({
						...parsed,
						replayCursor: inserted[0]?.cursor,
					});
					for (const client of clients) client.send(payload);
				})
				.catch((error) => {
					log(
						"orchestrator",
						"event-persist-failed",
						{ error: error instanceof Error ? error.message : String(error) },
						"warn",
					);
					for (const client of clients) client.send(JSON.stringify(parsed));
				});
		},
	};
	const openCodeManager =
		options.openCodeManager ?? new OpenCodeServerManager();
	const openCodeRuntime = new OpenCodeHttpRuntime();
	const providerModelCachePath = join(
		dataDirectory(),
		"cache",
		"provider-models.json",
	);
	const customProviderPath = join(dataDirectory(), "custom-providers.json");
	const storedCustomProviderSchema = z.array(
		z.object({
			id: z.string().regex(/^loom_custom_[a-z0-9_-]+$/),
			name: z.string().min(1).max(80),
			baseUrl: z.string().url(),
			apiKey: z.string().max(4096),
			models: z.array(
				z.object({
					id: z.string().min(1).max(300),
					name: z.string().min(1).max(300),
					contextWindow: z.number().int().positive().optional(),
					outputLimit: z.number().int().positive().optional(),
				}),
			),
		}),
	);
	let customProviderConfigs: CustomProviderConfig[] = [];
	try {
		customProviderConfigs = storedCustomProviderSchema.parse(
			JSON.parse(await readFile(customProviderPath, "utf8")),
		);
	} catch {}
	let persistProviderModelCache = () => {};
	const providerRegistry = createDefaultProviderRegistry(
		openCodeManager,
		openCodeRuntime,
	);
	for (const provider of customProviderConfigs)
		providerRegistry.register(new CustomProviderAdapter(provider));
	const providerManager = new ProviderManager({
		registry: providerRegistry,
		onEvent: (event) => {
			// Model catalogs can contain hundreds of entries. Logging the complete
			// payload on every refresh blocks startup on stdout and produces huge logs.
			if (event.type === "provider.modelsUpdated") {
				log("provider", event.type, {
					providerId: event.providerId,
					modelCount: event.models.length,
				});
				persistProviderModelCache();
				eventPublisher.publish({
					type: event.type,
					providerId: event.providerId,
					models: event.models,
				});
			} else if (
				event.type === "provider.detected" ||
				event.type === "provider.connected"
			) {
				log("provider", event.type, event);
				eventPublisher.publish({
					type: event.type,
					providerId: event.providerId,
					connection: event.connection,
				});
			} else if (
				event.type === "provider.disconnected" ||
				event.type === "provider.authRequired"
			) {
				log("provider", event.type, event);
				eventPublisher.publish({
					type: event.type,
					providerId: event.providerId,
				});
			} else {
				log("provider", event.type, event);
				eventPublisher.publish({
					type: event.type,
					providerId: event.providerId,
					message: event.message,
				});
			}
		},
	});
	// Reuse the last known catalog while CLI/provider discovery runs in the
	// background. The connection check will refresh availability shortly after.
	try {
		const cached = JSON.parse(await readFile(providerModelCachePath, "utf8"));
		const cachedModels = z
			.array(
				z
					.object({
						id: z.string(),
						providerId: z.string(),
						connectionId: z.string(),
						name: z.string(),
						displayName: z.string(),
						capabilities: z.array(z.string()),
						isAvailable: z.boolean(),
						metadata: z.record(z.string(), z.unknown()).optional(),
					})
					.passthrough(),
			)
			.safeParse(cached);
		if (cachedModels.success)
			providerManager.catalog.set(cachedModels.data as AgentModel[]);
	} catch {}
	let providerModelCacheWrite = Promise.resolve();
	persistProviderModelCache = () => {
		const snapshot = JSON.stringify(providerManager.catalog.all());
		providerModelCacheWrite = providerModelCacheWrite
			.catch(() => {})
			.then(async () => {
				await mkdir(dirname(providerModelCachePath), { recursive: true });
				await writeFile(providerModelCachePath, `${snapshot}\n`, "utf8");
			});
		void providerModelCacheWrite.catch((error) =>
			log(
				"provider",
				"model-cache-write-failed",
				{ error: error instanceof Error ? error.message : String(error) },
				"warn",
			),
		);
	};
	let providerDiscovery:
		| ReturnType<typeof providerManager.refreshAll>
		| undefined;
	let providerModelBootstrap: Promise<void> | undefined;
	let openCodeStartup: Promise<void> = Promise.resolve();
	const discoverProviders = () =>
		(providerDiscovery ??= openCodeStartup.then(async () => {
			return providerManager.refreshAll();
		}));
	const refreshConnectedProviderModels = async (
		connections: Awaited<ReturnType<typeof providerManager.refreshAll>>,
	) => {
		for (const connection of connections) {
			if (connection.status !== "connected")
				providerManager.catalog.replaceConnection(connection.id, []);
		}
		await Promise.allSettled(
			connections
				.filter((connection) => connection.status === "connected")
				.map((connection) =>
					providerManager.refreshModels(connection.providerId),
				),
		);
		persistProviderModelCache();
	};
	const loadProviderModels = () =>
		(providerModelBootstrap ??= discoverProviders().then(
			refreshConnectedProviderModels,
		));
	const ownsOpenCode = options.startOpenCode ?? true;
	if (ownsOpenCode) {
		// Start OpenCode in the background so the daemon can bind its API
		// immediately. A missing or slow provider must not leave the client in
		// an endless reconnect loop.
		openCodeStartup = openCodeManager.start().catch((error) =>
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
	const agentRuntime = options.agentRuntime ?? providerManager.getRuntime();
	const agyPermissions =
		options.agyPermissionStore ?? createAgyPermissionStore();
	const agyPermissionBase =
		options.agyPermissionUrl ??
		`http://127.0.0.1:${config.port}/api/agy/permission`;
	let agyPermissionError = "Agy permission hook is not configured";
	if (options.agyPermissionUrl) {
		agyPermissionError = "";
	} else if (options.registerAgyHook) {
		try {
			const registration = await registerAgyPermissionHook();
			agyPermissionError = registration.reason
				? `Agy permission hook unavailable: ${registration.reason}`
				: "";
		} catch (error) {
			agyPermissionError = `Agy permission hook unavailable: ${error instanceof Error ? error.message : String(error)}`;
			log(
				"agy",
				"hook-registration-failed",
				{ error: agyPermissionError },
				"warn",
			);
		}
	}
	const resolveTaskExecutor = async (task: {
		id: string;
		executorConfig: string | null;
		projectId: string;
		source: string;
		targetBranch: string | null;
	}) => {
		if (!task.executorConfig && task.source === "manual" && !task.targetBranch)
			return {
				runtime: agentRuntime,
				providerId: "legacy-default",
				modelId: null,
				snapshot: { kind: "legacy-default", providerId: "legacy-default" },
			};
		if (!task.executorConfig)
			throw new Error(
				"This task has no executor pinned. Edit or recreate it with a Kanban agent or direct provider/model before running.",
			);
		let selection: TaskExecutor;
		try {
			selection = taskExecutorSchema.parse(JSON.parse(task.executorConfig));
		} catch {
			throw new Error(
				"Task executor configuration is invalid; edit the task before running it",
			);
		}
		let agent: typeof customAgents.$inferSelect | undefined;
		let system =
			"You are Loom's Kanban coding agent. Implement the requested task in the assigned worktree, follow acceptance criteria, inspect relevant code before editing, and report concrete results. Never commit, push, merge, deploy, or delete branches; Loom checkpoints and integrates output through explicit user actions.";
		let permissionMode: RuntimePermission["mode"] = "ask";
		let agentSkills: Array<{ name: string; instructions: string }> = [];
		let providerId: string;
		let modelId: string | null;
		if (selection.kind === "agent") {
			agent = await db.query.customAgents.findFirst({
				where: eq(customAgents.id, selection.agentId),
			});
			if (
				!agent ||
				agent.status !== "active" ||
				!agent.allowKanban ||
				(agent.projectId && agent.projectId !== task.projectId)
			)
				throw new Error(
					"Selected agent is disabled, unavailable in this project, or not allowed in Kanban",
				);
			if (agent.approvalPolicy === "read_only")
				throw new Error(
					`Agent “${agent.label}” is read-only and cannot implement Kanban tasks. Choose a writable coding agent or a direct provider/model.`,
				);
			providerId = agent.provider;
			modelId = agent.modelId;
			const skills = await db
				.select()
				.from(customAgentSkills)
				.where(eq(customAgentSkills.agentId, agent.id));
			agentSkills = skills
				.filter((skill) => skill.enabled && skill.allowKanban)
				.map((skill) => ({
					name: skill.name,
					instructions: skill.instructions,
				}));
			system = [
				system,
				`You are ${agent.label}, a ${agent.role} implementation agent.`,
				agent.roleDescription ?? "",
				agent.systemInstructions,
				...agentSkills.map(
					(skill) => `## Skill: ${skill.name}\n${skill.instructions}`,
				),
				"Follow the task acceptance criteria. Stay inside the assigned worktree. Never commit, push, merge, deploy, or delete branches; Loom checkpoints and integrates output through explicit user actions.",
				`Permission policy: ${agent.approvalPolicy}.`,
			]
				.filter(Boolean)
				.join("\n\n");
		} else {
			providerId = selection.providerId;
			modelId = selection.modelId;
		}
		const connection = providerManager.get(providerId);
		if (connection?.status !== "connected")
			throw new Error(`Selected provider is unavailable: ${providerId}`);
		const adapter = providerManager.registry.require(providerId);
		const runtime = adapter.getRuntime?.();
		if (!runtime)
			throw new Error(
				`Selected provider has no task execution runtime: ${providerId}`,
			);
		const isCustomProvider =
			adapter.definition.capabilities.includes("custom-model");
		if (isCustomProvider)
			system = [
				system,
				"Use list_files and read_file to inspect the assigned project before editing. Implement changes with write_file or edit_file and use run_command for checks. This task runs in its own Loom worktree, so file changes stay isolated until the user reviews and integrates them. Do not ask the user to paste files that these tools can inspect. Loom will ask the user before each edit or command; if denied, continue without that operation.",
			].join("\n\n");
		let model: RuntimeModel | undefined;
		if (modelId) {
			const catalogModel = providerManager.catalog
				.listByProvider(providerId)
				.find(
					(item) =>
						item.metadata?.modelId === modelId ||
						item.name === modelId ||
						item.id === modelId,
				);
			if (
				!catalogModel &&
				!adapter.definition.capabilities.includes("custom-model")
			)
				throw new Error(
					`Selected model is unavailable for ${providerId}: ${modelId}`,
				);
			modelId = String(
				catalogModel?.metadata?.modelId ?? catalogModel?.name ?? modelId,
			);
			model = { providerID: adapter.definition.id, modelID: modelId };
		}
		if (
			permissionMode === "ask" &&
			adapter.definition.id === "agy" &&
			agyPermissionError
		)
			throw new Error(agyPermissionError);
		return {
			runtime,
			providerId: adapter.definition.id,
			modelId,
			model,
			timeoutMs: agent ? agent.maxRunDurationMinutes * 60_000 : undefined,
			system,
			permission: { mode: permissionMode as RuntimePermission["mode"] },
			...(isCustomProvider
				? {
						authorizeTool: async ({
							toolName,
							args,
							reason,
							cwd,
						}: Parameters<RuntimeToolAuthorization>[0]) => {
							const runs = await orchestrator.listRuns(task.id);
							const activeRun = runs.find((run) =>
								["running", "waiting_permission"].includes(run.status),
							);
							if (!activeRun) return false;
							const request = await orchestrator.requestPermission({
								taskId: task.id,
								runId: activeRun.id,
								command: `${toolName}: ${JSON.stringify(args)}`.slice(
									0,
									20_000,
								),
								cwd: cwd ?? "",
								reason,
							});
							const deadline = Date.now() + 120_000;
							while (Date.now() < deadline) {
								const current = await repos.permissionRequests.getById(
									request.id,
								);
								if (!current || current.status !== "pending") {
									await repos.agentRuns.update(activeRun.id, {
										status: "running",
									});
									return (
										current?.status === "allow" ||
										current?.status === "allow_once"
									);
								}
								await new Promise((resolve) => setTimeout(resolve, 250));
							}
							return false;
						},
					}
				: {}),
			...(adapter.definition.id === "agy"
				? {
						permissionForSession: async (sessionId: string) => {
							const token = randomBytes(24).toString("hex");
							agyPermissions.registerRun({
								token,
								sessionId,
								autoAccept: false,
							});
							return {
								permission: {
									mode: "ask" as const,
									env: {
										LOOM_PERMISSION_URL: agyPermissionBase,
										LOOM_PERMISSION_TOKEN: token,
									},
								},
								cleanup: () => agyPermissions.unregisterRun(token),
							};
						},
					}
				: {}),
			snapshot: {
				selection,
				providerId: adapter.definition.id,
				modelId,
				effort: agent?.effort ?? null,
				timeoutMs: agent ? agent.maxRunDurationMinutes * 60_000 : null,
				fallback: agent
					? {
							enabled: false,
							configuredEnabled: agent.fallbackEnabled,
							provider: agent.fallbackProvider,
							modelId: agent.fallbackModelId,
						}
					: { enabled: false },
				sourceConfigUpdatedAt: agent?.updatedAt.toISOString() ?? null,
				renderedInstructionsHash: createHash("sha256")
					.update(system)
					.digest("hex"),
				agent: agent
					? {
							id: agent.id,
							label: agent.label,
							role: agent.role,
							roleDescription: agent.roleDescription,
							instructions: agent.systemInstructions,
							skills: agentSkills,
							approvalPolicy: agent.approvalPolicy,
						}
					: null,
				permissionMode,
			},
		};
	};
	const orchestrator =
		options.orchestrator ??
		new TaskOrchestrator({
			...repos,
			leases: repos.tasks,
			reviews: repos.taskReviews,
			artifacts: repos.taskArtifacts,
			integrationLeases: repos.integrationLeases,
			schedulerResourceLeases: repos.schedulerResourceLeases,
			allowAutoMerge: process.env.LOOM_ENABLE_KANBAN_AUTO_MERGE === "true",
			integrationBatches: repos.integrationBatches,
			integrationBatchReviews: repos.integrationBatchReviews,
			worktree: worktreeManager,
			runtime: agentRuntime,
			resolveExecutor: resolveTaskExecutor,
			resolveReviewerExecutor: resolveTaskExecutor,
			runtimeForProvider: (providerId) =>
				providerId === "legacy-default"
					? agentRuntime
					: providerManager.registry.get(providerId)?.getRuntime?.(),
			events: eventPublisher,
		});
	orchestrator.setEventPublisher(eventPublisher);
	const planStore = planRepository(db);
	const automation = new AutomationService(
		planStore,
		repos,
		orchestrator,
		options.plannerRuntime ?? agentRuntime,
	);
	orchestrator.setLifecycle(combineHooks(automation.hooks()));
	await orchestrator.reconcile();
	await db
		.update(customAgentAssignmentRuns)
		.set({
			status: "interrupted",
			errorMessage: "Daemon restarted before the bounded assignment finished",
			currentTaskIdsJson: "[]",
			finishedAt: new Date(),
		})
		.where(
			or(
				eq(customAgentAssignmentRuns.status, "queued"),
				eq(customAgentAssignmentRuns.status, "running"),
				eq(customAgentAssignmentRuns.status, "cancel_requested"),
			),
		);
	await automation.recover();
	const projectValidation =
		options.projectValidation ?? createProjectValidationService();
	const terminalManager = new TerminalManager();
	await terminalManager.ready();
	const app = new Hono();
	const walkthroughRuns = new Map<string, WalkthroughRun>();
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
			allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
			c.req.path.startsWith("/api/agy/permission/") ||
			c.req.path === "/api/events" ||
			c.req.path === "/api/bootstrap" ||
			(/^\/api\/terminals\/[^/]+\/stream$/.test(c.req.path) &&
				c.req.method === "GET")
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
	app.get("/api/projects/:id/terminals", async (c) => {
		const project = await repos.projects.getById(c.req.param("id"));
		if (!project) return errorResponse(c, new Error("Project not found"));
		try {
			const root = await projectValidation.validate(project.path);
			return c.json(await terminalManager.list(project.id, root.path));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/projects/:id/terminals", async (c) => {
		const project = await repos.projects.getById(c.req.param("id"));
		if (!project) return errorResponse(c, new Error("Project not found"));
		try {
			const root = await projectValidation.validate(project.path);
			const input = z
				.object({
					cols: z.number().int().min(20).max(300),
					rows: z.number().int().min(5).max(120),
					idempotencyKey: z.string().trim().min(1).max(120),
				})
				.parse(await jsonBody(c));
			return c.json(
				await terminalManager.create({
					projectId: project.id,
					workspaceId: root.path,
					cwd: root.path,
					...input,
				}),
				201,
			);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/terminals/:id/ticket", async (c) => {
		const projectId = c.req.query("projectId") ?? "";
		if (!projectId || !(await repos.projects.getById(projectId)))
			return errorResponse(c, new Error("Project not found"));
		try {
			return c.json(terminalManager.issueTicket(c.req.param("id"), projectId));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/terminals/:id/restart", async (c) => {
		const projectId = c.req.query("projectId") ?? "";
		const project = projectId
			? await repos.projects.getById(projectId)
			: undefined;
		if (!project) return errorResponse(c, new Error("Project not found"));
		try {
			const root = await projectValidation.validate(project.path);
			const input = z
				.object({
					expectedGeneration: z.number().int().positive(),
					approved: z.literal(true),
					idempotencyKey: z.string().trim().min(1).max(120),
				})
				.parse(await jsonBody(c));
			return c.json(
				await terminalManager.restart(
					c.req.param("id"),
					projectId,
					root.path,
					input.expectedGeneration,
					input.approved,
					input.idempotencyKey,
				),
			);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.delete("/api/terminals/:id", async (c) => {
		const projectId = c.req.query("projectId") ?? "";
		if (!projectId || !(await repos.projects.getById(projectId)))
			return errorResponse(c, new Error("Project not found"));
		try {
			const input = z
				.object({
					expectedGeneration: z.number().int().positive(),
					approved: z.literal(true),
				})
				.parse(await jsonBody(c));
			await terminalManager.closeSession(
				c.req.param("id"),
				projectId,
				input.expectedGeneration,
				input.approved,
			);
			return c.body(null, 204);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get(
		"/api/terminals/:id/stream",
		upgradeWebSocket((c) => {
			const terminalId = c.req.param("id") ?? "";
			const ticket = c.req.query("ticket") ?? "";
			let attachment: ReturnType<typeof terminalManager.attach> | undefined;
			return {
				onOpen(_event, ws) {
					attachment = terminalManager.attach(terminalId, ticket, {
						send: (value) => ws.send(value),
						close: (code, reason) => ws.close(code, reason),
					});
				},
				onMessage(event, _ws) {
					const attachmentId = attachment?.id;
					if (!attachmentId) return;
					const data = typeof event.data === "string" ? event.data : "";
					terminalManager.message(terminalId, attachmentId, data);
				},
				onClose() {
					attachment?.detach();
				},
				onError() {
					attachment?.detach();
				},
			};
		}),
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
	app.get("/api/events/replay", async (c) => {
		await eventWriteQueue;
		const after = Math.max(
			0,
			Number.parseInt(c.req.query("after") ?? "0", 10) || 0,
		);
		const limit = Math.min(
			500,
			Math.max(1, Number.parseInt(c.req.query("limit") ?? "200", 10) || 200),
		);
		const latest = await db
			.select({ cursor: orchestrationEvents.cursor })
			.from(orchestrationEvents)
			.orderBy(desc(orchestrationEvents.cursor))
			.limit(1);
		const highWaterCursor = latest[0]?.cursor ?? 0;
		if (c.req.query("latest") === "1")
			return c.json({ events: [], cursor: highWaterCursor, highWaterCursor });
		const rows = await db
			.select()
			.from(orchestrationEvents)
			.where(gt(orchestrationEvents.cursor, after))
			.orderBy(orchestrationEvents.cursor)
			.limit(limit);
		return c.json({
			events: rows.map((row) => ({
				cursor: row.cursor,
				event: daemonEventSchema.parse(JSON.parse(row.payloadRedacted)),
			})),
			cursor: rows.at(-1)?.cursor ?? after,
			highWaterCursor,
		});
	});

	const openCodeChatRequest: ChatRequestGateway = <T>(
		path: string,
		options: Parameters<ChatRequestGateway>[1] = {},
	) =>
		openCodeRuntime.request<T>(
			path,
			{
				method: options.method ?? (options.body ? "POST" : "GET"),
				...(options.body ? { body: JSON.stringify(options.body) } : {}),
			},
			options.directory,
		);
	const designRuntimes = new Map(
		providerManager.registry.list().flatMap((adapter) => {
			const runtime = options.designRuntime ?? adapter.getRuntime?.();
			return runtime ? [[adapter.definition.id, runtime] as const] : [];
		}),
	);
	const designs = new DesignService(
		designRepo,
		repos,
		options.designRuntime ?? agentRuntime,
		designRuntimes,
		{ store: agyPermissions, url: agyPermissionError ? "" : agyPermissionBase },
	);
	await designs.recover();
	app.route(
		"/api/context",
		createContextHubRoutes({ db, projects: repos.projects }),
	);
	app.route("/api/mcp", createMcpManagerRoutes({ projects: repos.projects }));
	app.route(
		"/api/agents",
		createAgentSettingsRoutes({
			db,
			projects: repos.projects,
			tasks: repos.tasks,
			startTask: (taskId) => orchestrator.enqueue(taskId),
			enqueueAndWait: (taskId) => orchestrator.enqueueAndWait(taskId),
			retryTask: async (taskId) => {
				await orchestrator.retry(taskId);
				await orchestrator.enqueueAndWait(taskId);
			},
			cancelTask: (taskId) => orchestrator.cancel(taskId),
			providers: providerManager,
		}),
	);
	app.route(
		"/api/chat",
		createChatRoutes({
			projects: repos.projects,
			request: openCodeChatRequest,
			sessionScope: (id) => orchestrator.sessionScope(id),
			providerManager,
			permissions: agyPermissions,
			agyPermissionUrl: agyPermissionError ? undefined : agyPermissionBase,
			agyPermissionError,
			providerHistory: repos.providerChatHistory,
			agents: {
				async get(id) {
					const agent = await db.query.customAgents.findFirst({
						where: eq(customAgents.id, id),
					});
					if (!agent) return undefined;
					const skills = await db
						.select()
						.from(customAgentSkills)
						.where(eq(customAgentSkills.agentId, id));
					return { ...agent, skills };
				},
			},
			agentRunStore: {
				async start(input) {
					await db
						.update(customAgents)
						.set({ lastUsedAt: new Date(), updatedAt: new Date() })
						.where(eq(customAgents.id, input.agentId));
					await db.insert(customAgentRuns).values({
						id: input.id,
						agentId: input.agentId,
						projectId: input.projectId,
						chatSessionId: input.sessionId,
						provider: input.provider,
						modelId: input.modelId,
						status: "running",
						trigger: "chat",
						inputSummary: input.inputSummary,
						startedAt: new Date(),
					});
					await db.insert(customAgentRunEvents).values({
						id: randomUUID(),
						runId: input.id,
						type: "started",
						message: `Started ${input.provider}`,
					});
				},
				async finish(input) {
					const safe = (value: string | null) =>
						value
							?.replace(
								/(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+|LOOM_PERMISSION_TOKEN=\S+)/gi,
								"[redacted]",
							)
							.slice(-4000) ?? null;
					await db
						.update(customAgentRuns)
						.set({
							status: input.status,
							outputSummary: safe(input.outputSummary),
							errorMessage: safe(input.errorMessage),
							finishedAt: new Date(),
						})
						.where(eq(customAgentRuns.id, input.id));
					await db.insert(customAgentRunEvents).values({
						id: randomUUID(),
						runId: input.id,
						type: input.status,
						message:
							safe(input.errorMessage) ??
							safe(input.outputSummary) ??
							input.status,
					});
				},
			},
			designs: designRepo,
			runtimes: (providerId) =>
				providerManager.registry.get(providerId)?.getRuntime?.(),
		}),
	);

	// PreToolUse hook endpoints. The spawned Agy hook subprocess authenticates
	// with its per-run token (minted at prompt time) rather than the daemon
	// bearer token, so these are exempt from the /api/* guard and validated here.
	app.post("/api/agy/permission/request", async (c) => {
		const input = z
			.object({
				token: z.string().min(1),
				conversationId: z.string().default(""),
				toolName: z.string().min(1),
				args: z.record(z.string(), z.unknown()).default({}),
				stepIdx: z.number().int().min(0).default(0),
			})
			.parse(await c.req.json());
		const result = agyPermissions.submit(
			{
				token: input.token,
				conversationId: input.conversationId,
				toolName: input.toolName,
				args: input.args,
				stepIdx: input.stepIdx,
			},
			1_800_000,
		);
		if (result.status === "unknown") return c.json({ decision: "deny" });
		if (result.status === "auto") return c.json({ decision: "allow" });
		const decision = await result.decision;
		return c.json({ decision });
	});

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
	app.get("/api/filesystem/directories", async (c) => {
		try {
			const requestedPath = c.req.query("path")?.trim();
			const showHidden = c.req.query("showHidden") === "true";
			const directory = resolve(requestedPath || homedir());
			const details = await stat(directory);
			if (!details.isDirectory())
				return c.json({ error: { message: "Path is not a directory." } }, 400);
			const entries = await readdir(directory, { withFileTypes: true });
			return c.json({
				path: directory,
				parentPath:
					dirname(directory) === directory ? null : dirname(directory),
				entries: entries
					.filter((entry) => entry.isDirectory())
					.filter((entry) => showHidden || !entry.name.startsWith("."))
					.sort((a, b) => a.name.localeCompare(b.name))
					.slice(0, 500)
					.map((entry) => ({
						name: entry.name,
						path: join(directory, entry.name),
					})),
			});
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
	app.get("/api/projects/:id/review-policy", async (c) => {
		try {
			return c.json({
				policy: await orchestrator.getReviewPolicy(c.req.param("id")),
				autoMergeAvailable: orchestrator.isAutoMergeEnabled(),
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.put("/api/projects/:id/review-policy", async (c) => {
		try {
			const body = await jsonBody(c);
			if (!body || typeof body !== "object")
				throw new Error("Invalid review policy");
			const input = body as Record<string, unknown>;
			if (
				typeof input.mode !== "string" ||
				typeof input.requiredChecksJson !== "string" ||
				typeof input.maxRevisionRounds !== "number"
			)
				throw new Error(
					"mode, requiredChecksJson and maxRevisionRounds are required",
				);
			if (input.autoMerge !== undefined && typeof input.autoMerge !== "boolean")
				throw new Error("autoMerge must be boolean");
			if (
				input.autoMerge === true &&
				process.env.LOOM_ENABLE_KANBAN_AUTO_MERGE !== "true"
			)
				return c.json(
					{
						error: createApiError(
							"VALIDATION_ERROR",
							"Automatic merge is disabled by the LOOM_ENABLE_KANBAN_AUTO_MERGE feature flag",
						),
					},
					400,
				);
			if (input.autoMerge === true && input.mode !== "automatic")
				return c.json(
					{
						error: createApiError(
							"VALIDATION_ERROR",
							"Automatic merge requires automatic review mode",
						),
					},
					400,
				);
			if (
				input.reviewerExecutorJson !== null &&
				input.reviewerExecutorJson !== undefined &&
				typeof input.reviewerExecutorJson !== "string"
			)
				throw new Error("reviewerExecutorJson must be a JSON string or null");
			const policy = await orchestrator.setReviewPolicy(c.req.param("id"), {
				mode: input.mode as "manual" | "automatic" | "hybrid",
				reviewerExecutorJson:
					(input.reviewerExecutorJson as string | null | undefined) ?? null,
				autoMerge: (input.autoMerge as boolean | undefined) ?? false,
				requiredChecksJson: input.requiredChecksJson,
				maxRevisionRounds: input.maxRevisionRounds,
			});
			return c.json({ policy });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/projects/:id/git", async (c) => {
		const project = await repos.projects.getById(c.req.param("id"));
		if (!project) return errorResponse(c, new Error("Project not found"));
		try {
			const repository = await projectValidation.validate(project.path);
			const [status, diff, stagedDiff, remote, branchResult, worktreeResult] =
				await Promise.all([
					runWorkspaceCommand(
						"git",
						["status", "--short", "--branch", "--untracked-files=all"],
						repository.path,
					),
					runWorkspaceCommand(
						"git",
						["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--stat"],
						repository.path,
					),
					runWorkspaceCommand(
						"git",
						[
							"--no-pager",
							"diff",
							"--no-ext-diff",
							"--no-textconv",
							"--cached",
							"--stat",
						],
						repository.path,
					),
					runWorkspaceCommand(
						"git",
						["remote", "get-url", "origin"],
						repository.path,
					),
					runWorkspaceCommand(
						"git",
						[
							"for-each-ref",
							"--format=%(refname:short)",
							"refs/heads",
							"refs/remotes/origin",
						],
						repository.path,
					),
					runWorkspaceCommand(
						"git",
						["worktree", "list", "--porcelain"],
						repository.path,
					),
				]);
			if (status.exitCode !== 0)
				throw new Error(status.stderr.trim() || "Unable to read Git status");
			const lines = status.stdout.trimEnd().split("\n");
			const files = lines
				.slice(1)
				.filter(Boolean)
				.map((line) => ({
					status: line.slice(0, 2).trim() || "?",
					path: line.slice(3).split(" -> ").at(-1) ?? line.slice(3),
				}));
			const worktrees = worktreeResult.stdout
				.trim()
				.split(/\n\n+/)
				.filter(Boolean)
				.map((entry) => {
					const path = entry.match(/^worktree (.+)$/m)?.[1] ?? "";
					const branch =
						entry.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "(detached)";
					return {
						path,
						branch,
						current: resolve(path) === resolve(repository.path),
					};
				});
			const branches =
				branchResult.exitCode === 0
					? [
							...new Set(
								branchResult.stdout
									.split(/\r?\n/)
									.filter(Boolean)
									.filter((branch) => branch !== "origin/HEAD")
									.map((branch) => branch.replace(/^origin\//, "")),
							),
						]
					: [];
			const currentBranch =
				lines[0]?.replace(/^##\s*/, "").split("...")[0] ?? "";
			const defaultBranch = branches.includes(project.defaultBranch)
				? project.defaultBranch
				: branches.includes(currentBranch)
					? currentBranch
					: (branches[0] ?? "");
			return c.json({
				gitAvailable: true,
				branch: currentBranch || "Unknown branch",
				defaultBranch,
				branches,
				worktrees,
				remoteUrl:
					remote.exitCode === 0
						? remote.stdout.trim().replace(/(https?:\/\/)[^/@\s]+@/i, "$1")
						: null,
				files: files.slice(0, 300),
				truncated: files.length > 300,
				diffStat: [diff.stdout.trim(), stagedDiff.stdout.trim()]
					.filter(Boolean)
					.join("\n"),
			});
		} catch (error) {
			if (
				!(error instanceof ProjectValidationError) ||
				!/not a git repository/i.test(error.message)
			)
				return errorResponse(c, error);
			return c.json({
				gitAvailable: false,
				gitMessage:
					"This project is not a Git repository. Kanban planning is available; Git is required to run tasks in worktrees.",
				branch: "No Git repository",
				defaultBranch: "",
				branches: [],
				worktrees: [],
				remoteUrl: null,
				files: [],
				truncated: false,
				diffStat: "",
			});
		}
	});
	app.post("/api/projects/:id/git/commit-message", async (c) => {
		try {
			const project = await repos.projects.getById(c.req.param("id"));
			if (!project) return errorResponse(c, new Error("Project not found"));
			const repository = await projectValidation.validate(project.path);
			const input = z
				.object({
					model: z.object({
						providerId: z.string().min(1).max(100),
						modelId: z.string().min(1).max(300),
					}),
				})
				.parse(await jsonBody(c));
			const snapshot = await collectWalkthroughSnapshot(repository.path);
			if (!snapshot.files.length)
				throw new Error("There are no uncommitted changes to summarize.");
			const requestedProviderId = input.model.providerId;
			const managedProvider =
				requestedProviderId !== "opencode" &&
				!!providerManager.registry.get(requestedProviderId);
			const providerId = managedProvider
				? providerManager.normalizeProviderId(requestedProviderId)
				: requestedProviderId;
			let candidate:
				| ReturnType<typeof providerManager.catalog.listByProvider>[number]
				| undefined;
			if (managedProvider) {
				if (providerManager.get(providerId)?.status !== "connected")
					throw new Error(`Provider is not connected: ${providerId}`);
				candidate = providerManager.catalog
					.listByProvider(providerId)
					.find((item) => {
						const requested = input.model.modelId.toLowerCase();
						return [item.metadata?.modelId, item.name, item.displayName].some(
							(value) =>
								typeof value === "string" && value.toLowerCase() === requested,
						);
					});
				if (!candidate)
					throw new Error(
						"The selected model is no longer available. Refresh the model list and try again.",
					);
			}
			const runtime = managedProvider
				? providerManager.getRuntime(providerId)
				: agentRuntime;
			const runtimeModelId = String(
				candidate?.metadata?.modelId ?? candidate?.name ?? input.model.modelId,
			);
			const runtimeModel =
				providerId === "opencode"
					? (() => {
							const [upstreamProviderId, ...upstreamModelParts] =
								runtimeModelId.split("/");
							return {
								providerID: upstreamProviderId || providerId,
								modelID: upstreamModelParts.join("/") || runtimeModelId,
							};
						})()
					: { providerID: providerId, modelID: input.model.modelId };
			const created = await runtime.createSession({
				cwd: repository.path,
				title: "Loom commit message suggestion",
				readOnly: true,
			});
			try {
				await runtime.prompt({
					sessionId: created.id,
					model: runtimeModel,
					permission: { mode: "read-only" },
					system: await readPrompt("git/commit-message.md"),
					prompt: JSON.stringify({
						files: snapshot.files.map(({ file, status, patch }) => ({
							file,
							status,
							patch,
						})),
					}),
				});
				const status = await runtime.wait(created.id, {
					timeoutMs: 90_000,
					pollIntervalMs: 500,
				});
				if (status !== "completed")
					throw new Error(
						(await runtime.lastError?.(created.id)) ||
							`Commit message generation ${status}`,
					);
				const output = await runtime.readOutput?.(created.id);
				const raw = output?.output.trim() ?? "";
				const message = raw
					.replace(/^```(?:\w+)?\s*/i, "")
					.replace(/\s*```$/, "")
					.replace(/^(?:commit message|subject)\s*:\s*/i, "")
					.split(/\r?\n/)[0]
					?.replace(/^['"`]|['"`]$/g, "")
					.trim();
				if (!message) throw new Error("The selected model returned an empty commit message.");
				return c.json({ message, provider: { providerId, modelId: runtimeModelId } });
			} catch (error) {
				await runtime.abort(created.id).catch(() => undefined);
				throw error;
			} finally {
				await runtime.deleteSession?.(created.id).catch(() => undefined);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unable to generate commit message";
			return errorResponse(c, new Error(message.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").slice(0, 600)));
		}
	});
	app.post("/api/projects/:id/git/commit", async (c) => {
		try {
			const project = await repos.projects.getById(c.req.param("id"));
			if (!project) return errorResponse(c, new Error("Project not found"));
			const repository = await projectValidation.validate(project.path);
			const { message, push } = z
				.object({
					message: z.string().trim().min(1).max(500),
					push: z.boolean().default(false),
				})
				.parse(await jsonBody(c));
			const status = await runWorkspaceCommand(
				"git",
				["status", "--porcelain", "--untracked-files=all"],
				repository.path,
			);
			if (status.exitCode !== 0)
				throw new Error(status.stderr.trim() || "Unable to read Git status");
			if (!status.stdout.trim())
				throw new Error("There are no changes to commit.");
			if (push) {
				const remote = await runWorkspaceCommand(
					"git",
					["remote", "get-url", "origin"],
					repository.path,
				);
				if (remote.exitCode !== 0 || !remote.stdout.trim())
					throw new Error(
						"This repository has no origin remote. Add a remote before syncing.",
					);
			}
			const staged = await runWorkspaceCommand(
				"git",
				["add", "-A"],
				repository.path,
			);
			if (staged.exitCode !== 0)
				throw new Error(staged.stderr.trim() || "Unable to stage changes");
			const committed = await runWorkspaceCommand(
				"git",
				["commit", "-m", message],
				repository.path,
				30_000,
			);
			if (committed.exitCode !== 0)
				throw new Error(committed.stderr.trim() || "Unable to create commit");
			let synced = false;
			if (push) {
				const branch = await runWorkspaceCommand(
					"git",
					["branch", "--show-current"],
					repository.path,
				);
				if (branch.exitCode !== 0 || !branch.stdout.trim())
					throw new Error(
						"Commit created, but this detached HEAD cannot be synced. Check out a branch and push it.",
					);
				const upstream = await runWorkspaceCommand(
					"git",
					["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
					repository.path,
				);
				const args =
					upstream.exitCode === 0
						? ["push"]
						: ["push", "--set-upstream", "origin", branch.stdout.trim()];
				const pushed = await runWorkspaceCommand(
					"git",
					args,
					repository.path,
					60_000,
				);
				if (pushed.exitCode !== 0)
					throw new Error(
						`Commit created, but push failed: ${pushed.stderr.trim() || "Git push failed"}`,
					);
				synced = true;
			}
			return c.json({
				committed: true,
				synced,
				output: committed.stdout.trim(),
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/projects/:id/git/checkout", async (c) => {
		try {
			const project = await repos.projects.getById(c.req.param("id"));
			if (!project) return errorResponse(c, new Error("Project not found"));
			const repository = await projectValidation.validate(project.path);
			const { branch } = z
				.object({ branch: z.string().trim().min(1).max(240) })
				.parse(await jsonBody(c));
			const valid = await runWorkspaceCommand(
				"git",
				["check-ref-format", "--branch", branch],
				repository.path,
			);
			if (valid.exitCode !== 0) throw new Error("Invalid branch name");
			const status = await runWorkspaceCommand(
				"git",
				["status", "--porcelain", "--untracked-files=all"],
				repository.path,
			);
			if (status.exitCode !== 0)
				throw new Error(status.stderr.trim() || "Unable to read Git status");
			if (status.stdout.trim())
				throw new Error(
					"Commit or stash local changes before switching branches.",
				);
			const listed = await runWorkspaceCommand(
				"git",
				["worktree", "list", "--porcelain"],
				repository.path,
			);
			if (
				listed.stdout
					.split(/\n\n+/)
					.some(
						(entry) =>
							entry.includes(`\nbranch refs/heads/${branch}`) &&
							resolve(entry.match(/^worktree (.+)$/m)?.[1] ?? "") !==
								resolve(repository.path),
					)
			)
				throw new Error(
					"This branch is already checked out in another worktree.",
				);
			const switched = await runWorkspaceCommand(
				"git",
				["switch", branch],
				repository.path,
			);
			if (switched.exitCode !== 0)
				throw new Error(switched.stderr.trim() || "Unable to switch branch");
			return c.json({ branch });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/projects/:id/git/worktrees", async (c) => {
		try {
			const project = await repos.projects.getById(c.req.param("id"));
			if (!project) return errorResponse(c, new Error("Project not found"));
			const repository = await projectValidation.validate(project.path);
			const { branch } = z
				.object({ branch: z.string().trim().min(1).max(240) })
				.parse(await jsonBody(c));
			const valid = await runWorkspaceCommand(
				"git",
				["check-ref-format", "--branch", branch],
				repository.path,
			);
			if (valid.exitCode !== 0)
				throw new Error("Enter a valid new branch name.");
			const slug = branch
				.replace(/[^a-zA-Z0-9._-]+/g, "-")
				.replace(/^[-.]+|[-.]+$/g, "");
			const path = join(
				dataDirectory(),
				"worktrees",
				project.id,
				`${slug}-${randomUUID().slice(0, 8)}`,
			);
			await mkdir(dirname(path), { recursive: true });
			const created = await runWorkspaceCommand(
				"git",
				["worktree", "add", "-b", branch, path, "HEAD"],
				repository.path,
				30_000,
			);
			if (created.exitCode !== 0)
				throw new Error(created.stderr.trim() || "Unable to create worktree");
			return c.json({ path, branch }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/projects/:id/pull-requests", async (c) => {
		const project = await repos.projects.getById(c.req.param("id"));
		if (!project) return errorResponse(c, new Error("Project not found"));
		try {
			const repository = await projectValidation.validate(project.path);
			const remote = await runWorkspaceCommand(
				"git",
				["remote", "get-url", "origin"],
				repository.path,
			);
			const origin = remote.exitCode === 0 ? remote.stdout.trim() : "";
			if (
				!/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/i.test(
					origin,
				)
			)
				return c.json({
					available: false,
					message:
						"Pull request listing is enabled for repositories hosted on github.com with an origin remote.",
					pullRequests: [],
				});
			const result = await runWorkspaceCommand(
				"gh",
				[
					"pr",
					"list",
					"--json",
					"number,title,url,state,headRefName",
					"--limit",
					"20",
				],
				repository.path,
				8_000,
			);
			if (result.exitCode !== 0)
				return c.json({
					available: false,
					message:
						result.stderr.trim() || "GitHub CLI could not load pull requests.",
					pullRequests: [],
				});
			return c.json({
				available: true,
				message: null,
				pullRequests: JSON.parse(result.stdout),
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "GitHub CLI is unavailable";
			return c.json({ available: false, message, pullRequests: [] });
		}
	});
	app.post("/api/projects/:id/pull-requests", async (c) => {
		try {
			const project = await repos.projects.getById(c.req.param("id"));
			if (!project) return errorResponse(c, new Error("Project not found"));
			const repository = await projectValidation.validate(project.path);
			const input = z
				.object({
					title: z.string().trim().min(1).max(256),
					body: z.string().max(20_000).default(""),
					base: z.string().trim().min(1).max(240).optional(),
					draft: z.boolean().default(false),
				})
				.parse(await jsonBody(c));
			const remote = await runWorkspaceCommand(
				"git",
				["remote", "get-url", "origin"],
				repository.path,
			);
			if (
				remote.exitCode !== 0 ||
				!/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/i.test(
					remote.stdout.trim(),
				)
			)
				throw new Error("Pull requests require a GitHub origin remote.");
			const args = [
				"pr",
				"create",
				"--title",
				input.title,
				"--body",
				input.body,
			];
			if (input.base) args.push("--base", input.base);
			if (input.draft) args.push("--draft");
			const result = await runWorkspaceCommand(
				"gh",
				args,
				repository.path,
				60_000,
			);
			if (result.exitCode !== 0)
				throw new Error(
					result.stderr.trim() ||
						"Unable to create pull request. Check that gh is installed, authenticated, and the branch is pushed.",
				);
			return c.json({ url: result.stdout.trim() }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/projects/:id/walkthrough/snapshot", async (c) => {
		const project = await repos.projects.getById(c.req.param("id"));
		if (!project) return errorResponse(c, new Error("Project not found"));
		try {
			const repository = await projectValidation.validate(project.path);
			return c.json({
				snapshot: await collectWalkthroughSnapshot(repository.path),
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to capture changes";
			return c.json(
				{ error: { message } },
				message.startsWith("SNAPSHOT_UNSTABLE") ? 409 : 400,
			);
		}
	});
	app.post("/api/projects/:id/walkthrough", async (c) => {
		const project = await repos.projects.getById(c.req.param("id"));
		if (!project) return errorResponse(c, new Error("Project not found"));
		if (
			[...walkthroughRuns.values()].filter((run) => run.status === "running")
				.length >= 8
		)
			return c.json(
				{ error: { message: "Too many walkthroughs are already running." } },
				429,
			);
		const input = z
			.object({
				language: z.enum(["en", "id"]),
				model: z.object({
					providerId: z.string().min(1).max(100),
					modelId: z.string().min(1).max(300),
				}),
			})
			.parse(await jsonBody(c));
		const requestedProviderId = input.model.providerId;
		const managedProvider =
			requestedProviderId !== "opencode" &&
			!!providerManager.registry.get(requestedProviderId);
		const providerId = managedProvider
			? providerManager.normalizeProviderId(requestedProviderId)
			: requestedProviderId;
		try {
			const repository = await projectValidation.validate(project.path);
			const snapshot = await collectWalkthroughSnapshot(repository.path);
			if (!snapshot.files.length)
				return c.json({
					snapshot,
					document: null,
					runId: null,
					status: "completed" as const,
					provider: { providerId, modelId: input.model.modelId },
				});
			let candidate:
				| ReturnType<typeof providerManager.catalog.listByProvider>[number]
				| undefined;
			if (managedProvider) {
				const connection = providerManager.get(providerId);
				if (connection?.status !== "connected")
					return c.json(
						{ error: { message: `Provider is not connected: ${providerId}` } },
						409,
					);
				candidate = providerManager.catalog
					.listByProvider(providerId)
					.find((model) => {
						const requested = input.model.modelId.toLowerCase();
						return [
							model.metadata?.modelId,
							model.name,
							model.displayName,
						].some(
							(value) =>
								typeof value === "string" && value.toLowerCase() === requested,
						);
					});
				if (!candidate)
					return c.json(
						{
							error: {
								message:
									"The selected model is no longer available. Refresh the model list and try again.",
							},
						},
						409,
					);
			}
			const runtime = managedProvider
				? providerManager.getRuntime(providerId)
				: agentRuntime;
			const runtimeModelId = String(
				candidate?.metadata?.modelId ?? candidate?.name ?? input.model.modelId,
			);
			const runtimeModel =
				providerId === "opencode"
					? (() => {
							const [upstreamProviderId, ...upstreamModelParts] =
								runtimeModelId.split("/");
							return {
								providerID: upstreamProviderId || providerId,
								modelID: upstreamModelParts.join("/") || runtimeModelId,
							};
						})()
					: { providerID: providerId, modelID: input.model.modelId };
			const systemPrompt = await readPrompt("review/walkthrough.md");
			const created = await runtime.createSession({
				cwd: repository.path,
				title: "Loom change walkthrough",
				readOnly: true,
			});
			const evidence = snapshot.files.map(
				({ id, file, status, kind, patch, truncated }) => ({
					id,
					file,
					status,
					kind,
					patch,
					truncated,
				}),
			);
			const prompt = JSON.stringify({
				requestedOutputLanguage:
					input.language === "en" ? "English" : "Indonesian",
				snapshotIdentity: {
					scope: snapshot.scope,
					fingerprint: snapshot.fingerprint,
					capturedAt: snapshot.capturedAt,
				},
				changedFileInventory: snapshot.files.map(
					({ id, file, status, kind }) => ({
						id,
						file,
						status,
						kind,
					}),
				),
				evidence,
				coverage: snapshot.coverage,
				requiredJsonSchema: {
					schemaVersion: 1,
					title: "string",
					summary: "string",
					groups: [
						{
							id: "string",
							title: "string",
							steps: [
								{
									id: "string",
									title: "string",
									explanation: "string",
									evidenceIds: ["server-issued evidence id"],
									observations: ["string"],
									cautions: [
										{
											kind: "observed | inferred | unverified",
											message: "string",
											evidenceIds: ["server-issued evidence id"],
										},
									],
								},
							],
						},
					],
					limitations: ["string"],
				},
			});
			try {
				await runtime.prompt({
					sessionId: created.id,
					prompt,
					system: systemPrompt,
					model: runtimeModel,
					permission: { mode: "read-only" },
				});
				const runId = randomUUID();
				const run: WalkthroughRun = {
					projectId: project.id,
					startedAt: Date.now(),
					evidenceIds: snapshot.files.map((file) => file.id),
					provider: { providerId, modelId: runtimeModelId },
					status: "running",
				};
				walkthroughRuns.set(runId, run);
				for (const [oldRunId, oldRun] of walkthroughRuns) {
					if (
						oldRun.status !== "running" &&
						Date.now() - oldRun.startedAt > 60 * 60_000
					)
						walkthroughRuns.delete(oldRunId);
				}
				void (async () => {
					try {
						const status = await runtime.wait(created.id, {
							timeoutMs: 15 * 60_000,
							pollIntervalMs: 500,
						});
						if (status !== "completed")
							throw new Error(
								(await runtime.lastError?.(created.id)) ||
									`Walkthrough generation ${status}`,
							);
						run.document = parseWalkthroughOutput(
							(await runtime.readOutput?.(created.id)) ?? null,
							run.evidenceIds,
						);
						run.status = "completed";
					} catch (error) {
						run.status = "failed";
						run.error = (
							error instanceof Error
								? error.message
								: "Unable to generate walkthrough"
						)
							.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
							.slice(0, 600);
						await runtime.abort(created.id).catch(() => undefined);
					} finally {
						await runtime.deleteSession?.(created.id).catch(() => undefined);
					}
				})();
				return c.json({
					snapshot,
					document: null,
					runId,
					status: "running" as const,
					provider: run.provider,
				});
			} catch (error) {
				await runtime.abort(created.id).catch(() => undefined);
				await runtime.deleteSession?.(created.id).catch(() => undefined);
				throw error;
			}
		} catch (error) {
			const message = (
				error instanceof Error
					? error.message
					: "Unable to generate walkthrough"
			)
				.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
				.slice(0, 600);
			const status = message.startsWith("SNAPSHOT_UNSTABLE")
				? 409
				: message.startsWith("INPUT_TOO_LARGE")
					? 413
					: 502;
			return c.json({ error: { message } }, status);
		}
	});
	app.get("/api/projects/:id/walkthrough/runs/:runId", async (c) => {
		const project = await repos.projects.getById(c.req.param("id"));
		if (!project) return errorResponse(c, new Error("Project not found"));
		const run = walkthroughRuns.get(c.req.param("runId"));
		if (!run || run.projectId !== project.id)
			return c.json({ error: { message: "Walkthrough run not found" } }, 404);
		return c.json({
			status: run.status,
			document: run.document ?? null,
			error: run.error,
			provider: run.provider,
		});
	});
	app.patch("/api/projects/:id", async (c) => {
		try {
			const project = await repos.projects.getById(c.req.param("id"));
			if (!project) return errorResponse(c, new Error("Project not found"));
			const input = z
				.object({
					name: z.string().trim().min(1).max(120).optional(),
					path: z.string().trim().min(1).optional(),
					autoAccept: z.boolean().optional(),
				})
				.refine(
					(value) =>
						value.name !== undefined ||
						value.path !== undefined ||
						value.autoAccept !== undefined,
				)
				.parse(await jsonBody(c));
			const path = input.path
				? (await projectValidation.validate(input.path)).path
				: project.path;
			const [updated] = await repos.projects.update(c.req.param("id"), {
				...(input.name ? { name: input.name } : {}),
				...(input.autoAccept === undefined
					? {}
					: { autoAccept: input.autoAccept }),
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
		if (terminalManager.hasLiveSessions(project.id))
			return c.json(
				{
					error: {
						message:
							"Stop active terminal sessions before removing this project.",
					},
				},
				409,
			);
		await repos.projects.delete(project.id);
		return c.body(null, 204);
	});
	// Serializes every known provider (from the registry) merged with its last
	// detected state. Reading this never touches the CLIs, so opening the
	// Providers page is instant; only an explicit refresh runs detection.
	const serializeProviders = () =>
		providerManager.registry.list().map((adapter) => {
			const connection = providerManager.get(adapter.definition.id);
			return {
				id: connection?.id ?? `${adapter.definition.id}:local`,
				providerId: adapter.definition.id,
				name: adapter.definition.name,
				status: connection?.status ?? "disconnected",
				version: connection?.version ?? null,
				authenticated: connection?.authenticated ?? false,
				authCommand:
					connection?.authCommand ?? adapter.definition.authCommand ?? null,
				lastCheckedAt: connection?.lastCheckedAt ?? null,
				capabilities: connection?.capabilities ?? [
					...adapter.definition.capabilities,
				],
				command: adapter.definition.executable,
				install: adapter.definition.homepage ?? null,
				auth: adapter.definition.authStrategy,
				installed: connection?.installed ?? false,
				executablePath: connection?.executablePath ?? null,
			};
		});
	const customProviderInputSchema = z.object({
		name: z.string().trim().min(1).max(80),
		baseUrl: z.string().trim().min(1).max(2048),
		apiKey: z.string().max(4096).default(""),
	});
	const parseCustomProviderInput = (value: unknown) => {
		const input = customProviderInputSchema.parse(value);
		const url = new URL(input.baseUrl);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error(
				"Base URL must be an HTTP(S) endpoint without embedded credentials, query, or fragment",
			);
		return { ...input, baseUrl: url.toString().replace(/\/$/, "") };
	};
	const persistCustomProviders = async (providers: CustomProviderConfig[]) => {
		await mkdir(dirname(customProviderPath), { recursive: true, mode: 0o700 });
		await writeFile(
			customProviderPath,
			`${JSON.stringify(providers, null, 2)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		await chmod(customProviderPath, 0o600).catch(() => {});
		customProviderConfigs = providers;
		persistProviderModelCache();
	};
	app.get("/api/custom-providers", async (c) => {
		await discoverProviders();
		return c.json(
			customProviderConfigs.map((provider) => ({
				id: provider.id,
				name: provider.name,
				baseUrl: provider.baseUrl,
				status: providerManager.get(provider.id)?.status ?? "disconnected",
				models: provider.models,
			})),
		);
	});
	app.post("/api/custom-providers/test", async (c) => {
		try {
			const raw = await jsonBody(c);
			const input = parseCustomProviderInput(raw);
			const providerId =
				raw &&
				typeof raw === "object" &&
				"providerId" in raw &&
				typeof raw.providerId === "string"
					? raw.providerId
					: undefined;
			const existing = customProviderConfigs.find(
				(provider) => provider.id === providerId,
			);
			const models = await discoverCustomModels(
				input.baseUrl,
				input.apiKey || existing?.apiKey || "",
			);
			return c.json({ connected: true, models });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/providers/:providerId/models/test", async (c) => {
		const providerId = c.req.param("providerId");
		let runtime: AgentRuntime | undefined;
		let runtimeModel: RuntimeModel | undefined;
		try {
			const raw = await jsonBody(c);
			const modelId =
				raw &&
				typeof raw === "object" &&
				"modelId" in raw &&
				typeof raw.modelId === "string"
					? raw.modelId.trim()
					: "";
			if (!modelId) return c.json({ error: "A model ID is required" }, 400);

			const adapter = providerManager.registry.get(providerId);
			if (adapter) {
				if (adapter instanceof CustomProviderAdapter) {
					await testCustomModel(
						adapter.config.baseUrl,
						adapter.config.apiKey,
						modelId,
					);
					return c.json({ connected: true, providerId, modelId });
				}
				if (providerManager.get(providerId)?.status !== "connected")
					await providerManager.refresh(providerId, { refreshModels: true });
				const selectedModel = providerManager.catalog
					.listByProvider(providerId)
					.find((model) => {
						const metadata = model.metadata ?? {};
						return [
							model.name,
							model.displayName,
							metadata.modelId,
							`${metadata.upstreamProviderId}/${metadata.providerModelId}`,
						].some((candidate) => candidate === modelId);
					});
				if (!selectedModel)
					return c.json(
						{ error: "Model is not available from this provider" },
						404,
					);
				runtime = adapter.getRuntime?.();
				const metadata = selectedModel.metadata ?? {};
				const upstreamProviderId = metadata.upstreamProviderId;
				const actualModelId = metadata.providerModelId ?? metadata.modelId;
				runtimeModel = {
					providerID:
						typeof upstreamProviderId === "string"
							? upstreamProviderId
							: providerId,
					modelID: typeof actualModelId === "string" ? actualModelId : modelId,
				};
			} else {
				const openCodeCatalog = await openCodeRuntime.request<{
					providers?: Array<{
						id: string;
						models: Record<string, { id?: string }>;
					}>;
				}>("/config/providers");
				const provider = openCodeCatalog.providers?.find(
					(item) => item.id === providerId,
				);
				const matchedModel = Object.entries(provider?.models ?? {}).find(
					([key, model]) => key === modelId || model.id === modelId,
				);
				if (!matchedModel)
					return c.json(
						{ error: "Model is not available from this provider" },
						404,
					);
				const [modelKey, model] = matchedModel;
				runtime = openCodeRuntime;
				runtimeModel = {
					providerID: providerId,
					modelID: model.id ?? modelKey,
				};
			}
			if (!runtime || !runtimeModel)
				return c.json({ error: "Provider runtime is unavailable" }, 409);

			const session = await runtime.createSession({
				cwd: process.cwd(),
				title: "Loom model connectivity check",
				readOnly: true,
			});
			let completed = false;
			try {
				await runtime.prompt({
					sessionId: session.id,
					prompt:
						"Connectivity check. Reply with exactly OK. Do not use tools.",
					system:
						"This is a short model connectivity check. Do not call tools, inspect files, or make changes. Reply with OK.",
					model: runtimeModel,
					permission: { mode: "read-only" },
				});
				const status = await runtime.wait(session.id, {
					timeoutMs: 25_000,
					pollIntervalMs: 300,
				});
				if (status !== "completed") {
					const detail = await runtime.lastError?.(session.id);
					throw new Error(detail || `Model run ended with status: ${status}`);
				}
				completed = true;
				const output = await runtime.readOutput?.(session.id);
				if (!output?.output.trim())
					throw new Error("Model completed without returning a text response");
				return c.json({ connected: true, providerId, modelId });
			} finally {
				if (!completed) await runtime.abort(session.id).catch(() => {});
				if (runtime.deleteSession)
					await runtime.deleteSession(session.id).catch(() => {});
			}
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/custom-providers", async (c) => {
		try {
			const input = parseCustomProviderInput(await jsonBody(c));
			const models = await discoverCustomModels(input.baseUrl, input.apiKey);
			const slug = input.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 28);
			const provider: CustomProviderConfig = {
				id: `loom_custom_${slug || "provider"}_${randomUUID().slice(0, 8)}`,
				name: input.name,
				baseUrl: input.baseUrl,
				apiKey: input.apiKey,
				models,
			};
			const adapter = new CustomProviderAdapter(provider);
			providerRegistry.register(adapter);
			const connection = await providerManager.refresh(provider.id, {
				refreshModels: true,
			});
			if (connection.status !== "connected") {
				providerRegistry.unregister(provider.id);
				throw new Error(connection.error ?? "Provider connection failed");
			}
			await persistCustomProviders([...customProviderConfigs, provider]);
			return c.json(
				{
					provider: {
						id: provider.id,
						name: provider.name,
						baseUrl: provider.baseUrl,
						status: connection.status,
					},
					models: providerManager.getModels(provider.id),
				},
				201,
			);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.put("/api/custom-providers/:id", async (c) => {
		const providerId = c.req.param("id");
		const current = customProviderConfigs.find(
			(provider) => provider.id === providerId,
		);
		if (!current) return c.json({ error: "Custom provider not found" }, 404);
		let swapped = false;
		try {
			const input = parseCustomProviderInput(await jsonBody(c));
			const apiKey = input.apiKey || current.apiKey;
			const models = await discoverCustomModels(input.baseUrl, apiKey);
			const updated: CustomProviderConfig = {
				...current,
				name: input.name,
				baseUrl: input.baseUrl,
				apiKey,
				models,
			};
			providerRegistry.unregister(providerId);
			providerRegistry.register(new CustomProviderAdapter(updated));
			swapped = true;
			const connection = await providerManager.refresh(providerId, {
				refreshModels: true,
			});
			if (connection.status !== "connected")
				throw new Error(connection.error ?? "Provider connection failed");
			await persistCustomProviders(
				customProviderConfigs.map((provider) =>
					provider.id === providerId ? updated : provider,
				),
			);
			return c.json({
				provider: {
					id: updated.id,
					name: updated.name,
					baseUrl: updated.baseUrl,
					status: connection.status,
				},
				models: providerManager.getModels(providerId),
			});
		} catch (error) {
			if (swapped) {
				try {
					providerRegistry.unregister(providerId);
					providerRegistry.register(new CustomProviderAdapter(current));
					await providerManager.refresh(providerId, { refreshModels: true });
				} catch {}
			}
			return errorResponse(c, error);
		}
	});
	app.delete("/api/custom-providers/:id", async (c) => {
		const providerId = c.req.param("id");
		const current = customProviderConfigs.find(
			(provider) => provider.id === providerId,
		);
		if (!current) return c.json({ error: "Custom provider not found" }, 404);
		try {
			await providerManager.disconnect(providerId);
			providerRegistry.unregister(providerId);
			await persistCustomProviders(
				customProviderConfigs.filter((provider) => provider.id !== providerId),
			);
			return c.json({ deleted: true, id: providerId });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/providers", async (c) => {
		await discoverProviders();
		return c.json(serializeProviders());
	});
	app.get("/api/providers/models", async (c) => {
		await loadProviderModels();
		const config = await openCodeRuntime
			.request<{
				providers?: Array<{
					id: string;
					name?: string;
					models: Record<
						string,
						{ id?: string; name?: string; limit?: { context?: number } }
					>;
				}>;
			}>("/config/providers")
			.catch(() => ({ providers: [] }));
		const managedModels = providerManager.catalog
			.listAvailable()
			.map((model) => ({
				providerID: model.providerId,
				modelID:
					typeof model.metadata?.upstreamProviderId === "string" &&
					typeof model.metadata?.providerModelId === "string"
						? `${model.metadata.upstreamProviderId}/${model.metadata.providerModelId}`
						: String(model.metadata?.modelId ?? model.name),
				name: model.displayName,
				provider:
					typeof model.metadata?.providerName === "string"
						? model.metadata.providerName
						: model.providerId,
				contextWindow: model.contextWindow,
			}));
		const managedProviderIds = new Set(
			managedModels.map((model) => model.providerID),
		);
		const openCodeModels = (config.providers ?? []).flatMap((provider) =>
			managedProviderIds.has(provider.id)
				? []
				: Object.entries(provider.models).map(([modelID, model]) => ({
						providerID: provider.id,
						modelID: model.id ?? modelID,
						name: model.name || modelID,
						provider: provider.name || provider.id,
						contextWindow: model.limit?.context,
					})),
		);
		return c.json([...openCodeModels, ...managedModels]);
	});
	app.post("/api/providers/refresh-all", async (c) => {
		const connections = await providerManager.refreshAll();
		void refreshConnectedProviderModels(connections);
		return c.json(serializeProviders());
	});
	app.post("/api/providers/check-updates", async (c) => {
		await discoverProviders();
		const updates = await Promise.all(
			providerManager.registry
				.list()
				.filter((adapter) => !adapter.definition.id.startsWith("loom_custom_"))
				.map(async (adapter) => {
					const connection = providerManager.get(adapter.definition.id);
					return checkProviderUpdate({
						providerId: adapter.definition.id,
						name: adapter.definition.name,
						installed: connection?.installed ?? false,
						currentVersion: connection?.version ?? null,
						executablePath: connection?.executablePath ?? null,
					});
				}),
		);
		return c.json({ checkedAt: new Date().toISOString(), updates });
	});
	app.post("/api/providers/:id/update", async (c) => {
		const providerId = providerManager.normalizeProviderId(c.req.param("id"));
		const adapter = providerManager.registry.get(providerId);
		if (!adapter) return c.json({ error: "Unknown provider" }, 404);
		const connection = await providerManager.refresh(providerId);
		const result = await updateProviderCli({
			providerId,
			name: adapter.definition.name,
			installed: connection.installed,
			currentVersion: connection.version,
			executablePath: connection.executablePath,
		});
		const refreshed = await providerManager.refresh(providerId);
		if (refreshed.status === "connected")
			void refreshConnectedProviderModels([refreshed]);
		return c.json({
			...result,
			version: refreshed.version,
			provider: refreshed,
		});
	});
	app.get("/api/providers/:id", async (c) => {
		const connection = await providerManager.refresh(c.req.param("id"));
		return c.json({
			connection,
			models: providerManager.getModels(connection.providerId),
		});
	});
	app.post("/api/providers/:id/connect", async (c) => {
		const connection = await providerManager.connect(c.req.param("id"));
		return c.json({
			...connection,
			launched: false,
			connected: connection.status === "connected",
			configured: connection.authenticated,
			command: connection.authCommand
				? [
						providerManager.registry.require(connection.providerId).definition
							.executable,
						...connection.authCommand,
					]
				: undefined,
		});
	});
	app.post("/api/providers/:id/disconnect", async (c) => {
		const providerId = providerManager.normalizeProviderId(c.req.param("id"));
		const connection = await providerManager.disconnect(providerId);
		return c.json({
			disconnected: true,
			connection: connection ?? {
				id: `${providerId}:local`,
				providerId,
				status: "disconnected",
			},
		});
	});
	app.post("/api/providers/:id/refresh", async (c) =>
		c.json(await providerManager.refresh(c.req.param("id"))),
	);
	app.get("/api/providers/:id/models", (c) =>
		c.json(providerManager.getModels(c.req.param("id"))),
	);
	app.post("/api/providers/:id/models/refresh", async (c) =>
		c.json(await providerManager.refreshModels(c.req.param("id"))),
	);
	app.get("/api/models", (c) => {
		// Never hold a UI request open while CLIs enumerate their models. The
		// startup refresh updates this catalog and publishes provider.modelsUpdated.
		void loadProviderModels().catch((error) =>
			log(
				"provider",
				"model-refresh-failed",
				{ error: error instanceof Error ? error.message : String(error) },
				"warn",
			),
		);
		return c.json(providerManager.catalog.listAvailable());
	});
	app.get("/api/runtime", (c) =>
		c.json({
			id: "opencode",
			capabilities: { task: true, planner: true, design: true, chat: true },
		}),
	);
	app.post("/api/providers/:id/auth", async (c) => {
		const connection = await providerManager.connect(c.req.param("id"));
		return c.json({
			...connection,
			launched: connection.status === "connected",
			connected: connection.status === "connected",
			configured: connection.authenticated,
			command: connection.authCommand
				? [
						providerManager.registry.require(connection.providerId).definition
							.executable,
						...connection.authCommand,
					]
				: undefined,
		});
	});
	app.post("/api/projects/:id/index/rebuild", async (c) => {
		try {
			const project = await repos.projects.getById(c.req.param("id"));
			if (!project) return errorResponse(c, new Error("Project not found"));
			const entries = await readdir(project.path, { withFileTypes: true });
			const files = entries.filter((entry) => entry.isFile()).length;
			return c.json({
				status: "ready",
				files,
				indexedAt: new Date().toISOString(),
			});
		} catch (error) {
			return errorResponse(c, error);
		}
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
	app.post("/api/projects/:projectId/design/chat", async (c) => {
		try {
			const input = chatDesignSchema.parse(await jsonBody(c));
			return c.json(
				await designs.chat({
					...input,
					projectId: c.req.param("projectId"),
				}),
			);
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
	app.get("/api/designs/:id/steps", async (c) => {
		try {
			return c.json(await designs.getSteps(c.req.param("id")));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/designs/:id/permissions/:permissionId/decision", async (c) => {
		try {
			const input = permissionDecisionInputSchema.parse(await jsonBody(c));
			const decided = await designs.decidePermission(
				c.req.param("id"),
				c.req.param("permissionId"),
				input.decision,
			);
			return c.json({ decided }, decided ? 200 : 404);
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
			const input = createTaskInputSchema.parse(await jsonBody(c));
			if (!input.executor)
				return c.json(
					{
						error: {
							message:
								"Choose a Kanban agent or provider before creating this task",
						},
					},
					400,
				);
			if (!input.acceptanceCriteria?.length)
				return c.json(
					{
						error: {
							message:
								"Add at least one acceptance criterion before creating this task",
						},
					},
					400,
				);
			if (input.targetBranch) {
				const project = await repos.projects.getById(input.projectId);
				if (!project) throw new Error("Project not found");
				const repository = await projectValidation.validate(project.path);
				const valid = await runWorkspaceCommand(
					"git",
					["check-ref-format", "--branch", input.targetBranch],
					repository.path,
				);
				const exists = await runWorkspaceCommand(
					"git",
					["rev-parse", "--verify", `${input.targetBranch}^{commit}`],
					repository.path,
				);
				if (valid.exitCode !== 0 || exists.exitCode !== 0)
					throw new Error(
						`Target branch does not exist or is invalid: ${input.targetBranch}`,
					);
			}
			if (input.executor.kind === "agent") {
				const agent = await db.query.customAgents.findFirst({
					where: eq(customAgents.id, input.executor.agentId),
				});
				if (
					!agent ||
					agent.status !== "active" ||
					!agent.allowKanban ||
					(agent.projectId && agent.projectId !== input.projectId)
				)
					return c.json(
						{
							error: {
								message: "Selected agent is disabled or unavailable for Kanban",
							},
						},
						403,
					);
				if (agent.approvalPolicy === "read_only")
					return c.json(
						{
							error: {
								message: `Agent “${agent.label}” is read-only and cannot implement Kanban tasks. Choose a writable coding agent or a direct provider/model.`,
							},
						},
						400,
					);
			} else {
				const connection = providerManager.get(input.executor.providerId);
				if (connection?.status !== "connected")
					return c.json(
						{
							error: {
								message: `Provider is not connected: ${input.executor.providerId}`,
							},
						},
						409,
					);
				const adapter = providerManager.registry.require(
					input.executor.providerId,
				);
				if (!adapter.getRuntime?.())
					return c.json(
						{
							error: { message: "Selected provider has no execution runtime" },
						},
						409,
					);
				const directExecutor = input.executor;
				if (directExecutor.modelId) {
					const known = providerManager.catalog
						.listByProvider(directExecutor.providerId)
						.some(
							(model) =>
								model.metadata?.modelId === directExecutor.modelId ||
								model.name === directExecutor.modelId ||
								model.id === directExecutor.modelId,
						);
					if (
						!known &&
						!adapter.definition.capabilities.includes("custom-model")
					)
						return c.json(
							{
								error: {
									message: "Selected model is not available for this provider",
								},
							},
							400,
						);
				}
			}
			const task = await orchestrator.create(input);
			return c.json(task, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/projects/:projectId/tasks/batch", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const input = createTaskBatchInputSchema.parse(await jsonBody(c));
			if (input.tasks.some((task) => !task.executor))
				return c.json(
					{
						error: { message: "Every Kanban task needs an explicit executor" },
					},
					400,
				);
			if (input.tasks.some((task) => !task.acceptanceCriteria?.length))
				return c.json(
					{
						error: {
							message:
								"Every Kanban task needs at least one acceptance criterion",
						},
					},
					400,
				);
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
	app.get("/api/tasks/:id/dependencies", async (c) => {
		try {
			const taskId = c.req.param("id");
			if (!(await repos.tasks.getById(taskId)))
				throw new Error("Task not found");
			const edges = await planStore.dependencies(taskId);
			return c.json({
				dependencies: await Promise.all(
					edges.map(async (edge) => ({
						...edge,
						producer: recordToTask(
							await repos.tasks.getById(edge.dependsOnTaskId),
						),
						artifact: edge.artifactId
							? await repos.taskArtifacts.getById(edge.artifactId)
							: null,
					})),
				),
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/tasks/:id/reviews", async (c) => {
		try {
			return c.json({
				reviews: await repos.taskReviews.list(c.req.param("id")),
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/tasks/:id/artifacts", async (c) => {
		try {
			return c.json({
				artifacts: await repos.taskArtifacts.listByTask(c.req.param("id")),
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/tasks/:id/artifacts", async (c) => {
		try {
			const body = await jsonBody(c);
			if (!body || typeof body !== "object")
				throw new Error("Invalid artifact request");
			const input = body as {
				kind?: unknown;
				version?: unknown;
				relativePath?: unknown;
			};
			if (
				!(
					["contract", "generated_client", "schema", "evidence"] as unknown[]
				).includes(input.kind)
			)
				throw new Error("Unsupported artifact kind");
			if (
				typeof input.version !== "string" ||
				typeof input.relativePath !== "string"
			)
				throw new Error("Artifact version and relativePath are required");
			const artifact = await orchestrator.publishArtifact(c.req.param("id"), {
				kind: input.kind as
					| "contract"
					| "generated_client"
					| "schema"
					| "evidence",
				version: input.version,
				relativePath: input.relativePath,
			});
			return c.json({ artifact }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/tasks/:id/review/approve", async (c) => {
		try {
			const review = await orchestrator.approveReview(c.req.param("id"));
			return c.json({ review }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/tasks/:id/review/run", async (c) => {
		try {
			const review = await orchestrator.runTaskReview(c.req.param("id"));
			return c.json({ review }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/tasks/:id/dependencies", async (c) => {
		try {
			const taskId = c.req.param("id");
			const body = await jsonBody(c);
			if (!body || typeof body !== "object")
				throw new Error("Invalid dependency request");
			const input = body as {
				dependsOnTaskId?: unknown;
				requiredMilestone?: unknown;
				artifactId?: unknown;
			};
			if (
				typeof input.dependsOnTaskId !== "string" ||
				!input.dependsOnTaskId.trim()
			)
				throw new Error("dependsOnTaskId is required");
			const milestone = input.requiredMilestone ?? "implementation_ready";
			if (
				![
					"contract_published",
					"artifact_ready",
					"implementation_ready",
					"integrated",
				].includes(String(milestone))
			)
				throw new Error("Unsupported dependency milestone");
			if (
				input.artifactId !== undefined &&
				input.artifactId !== null &&
				typeof input.artifactId !== "string"
			)
				throw new Error("artifactId must be a string");
			const edge = await planStore.addDependency(
				taskId,
				input.dependsOnTaskId,
				milestone as
					| "contract_published"
					| "artifact_ready"
					| "implementation_ready"
					| "integrated",
				input.artifactId as string | null | undefined,
			);
			await orchestrator.refreshEligibility(taskId);
			return c.json({ dependency: edge }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.delete("/api/tasks/:id/dependencies/:producerId", async (c) => {
		try {
			const taskId = c.req.param("id");
			await planStore.removeDependency(taskId, c.req.param("producerId"));
			await orchestrator.refreshEligibility(taskId);
			return c.json({ removed: true });
		} catch (error) {
			return errorResponse(c, error);
		}
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
	const assertTaskProjectRunnable = async (taskId: string) => {
		const task = await repos.tasks.getById(taskId);
		if (!task) throw new Error("Task not found");
		const project = await repos.projects.getById(task.projectId);
		if (!project) throw new Error("Project not found");
		if (task.executorConfig) {
			let selection: ReturnType<typeof taskExecutorSchema.parse> | null = null;
			try {
				selection = taskExecutorSchema.parse(JSON.parse(task.executorConfig));
			} catch {
				// Let executor resolution report malformed legacy configurations.
			}
			if (selection?.kind === "agent") {
				const agent = await db.query.customAgents.findFirst({
					where: eq(customAgents.id, selection.agentId),
				});
				if (agent?.approvalPolicy === "read_only")
					throw new Error(
						`Agent “${agent.label}” is read-only and cannot implement Kanban tasks. Choose a writable coding agent or a direct provider/model, then retry.`,
					);
			}
		}
		let repository;
		try {
			repository = await projectValidation.validate(project.path);
		} catch (error) {
			if (
				error instanceof ProjectValidationError &&
				/ not a git repository/i.test(error.message)
			)
				throw new Error(
					"This project has no Git repository. Kanban tasks can be planned, but running them requires Git and an initial commit.",
				);
			throw error;
		}
		if (!repository.head)
			throw new Error(
				"This Git repository has no commits yet. Create an initial commit before running Kanban tasks.",
			);
	};
	app.post("/api/tasks/:id/retry", async (c) => {
		try {
			await assertTaskProjectRunnable(c.req.param("id"));
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
			await assertTaskProjectRunnable(c.req.param("id"));
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
	app.post("/api/tasks/:id/checkpoint", async (c) => {
		try {
			const { outputSha } = await orchestrator.checkpoint(c.req.param("id"));
			return c.json({ outputSha });
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
	app.post("/api/integration-batches", async (c) => {
		try {
			const body = await jsonBody(c);
			if (!body || typeof body !== "object")
				throw new Error("Invalid integration batch request");
			const input = body as { taskIds?: unknown; requiredChecks?: unknown };
			if (
				!Array.isArray(input.taskIds) ||
				input.taskIds.some((id) => typeof id !== "string")
			)
				throw new Error("taskIds must be an array of task IDs");
			if (
				input.requiredChecks !== undefined &&
				!Array.isArray(input.requiredChecks)
			)
				throw new Error("requiredChecks must be an array");
			const result = await orchestrator.createIntegrationBatch(
				input.taskIds as string[],
				{
					requiredChecks: input.requiredChecks as
						| Array<{
								name: string;
								command: string;
								args: string[];
								timeoutMs?: number;
						  }>
						| undefined,
				},
			);
			return c.json(result, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/integration-batches", async (c) => {
		const projectId = c.req.query("projectId");
		if (!projectId) return errorResponse(c, new Error("projectId is required"));
		const batches = await repos.integrationBatches.listByProject(projectId);
		return c.json({
			batches: await Promise.all(
				batches.map(async (batch) => ({
					...batch,
					checks: await repos.integrationBatches.listChecks(batch.id),
				})),
			),
		});
	});
	app.get("/api/integration-batches/:id", async (c) => {
		try {
			const batch = await repos.integrationBatches.getById(c.req.param("id"));
			if (!batch) throw new Error("Integration batch not found");
			const members = await repos.integrationBatches.listMembers(batch.id);
			return c.json({
				batch,
				checks: await repos.integrationBatches.listChecks(batch.id),
				members: await Promise.all(
					members.map(async (member) => ({
						...member,
						task: recordToTask(await repos.tasks.getById(member.taskId)),
					})),
				),
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.get("/api/integration-batches/:id/diff", async (c) => {
		try {
			return c.json(await orchestrator.integrationBatchDiff(c.req.param("id")));
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/integration-batches/:id/review/approve", async (c) => {
		try {
			const review = await orchestrator.approveIntegrationBatch(
				c.req.param("id"),
			);
			return c.json({ review }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/integration-batches/:id/promote", async (c) => {
		try {
			return c.json(
				await orchestrator.promoteIntegrationBatch(c.req.param("id")),
			);
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
	if (
		options.initializeProviders ??
		(import.meta.main || process.env.LOOM_DAEMON === "true")
	) {
		void loadProviderModels().catch((error) =>
			log(
				"provider",
				"startup-check-failed",
				{ error: error instanceof Error ? error.message : String(error) },
				"warn",
			),
		);
	}
	return {
		app,
		config,
		close: async () => {
			await terminalManager.close();
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
	const daemon = await createApp({ registerAgyHook: true });
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
