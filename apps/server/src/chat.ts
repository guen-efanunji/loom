import { randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentRuntime, ProviderManager } from "@loom/providers";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AgyPermissionStore } from "./permissions";

const id = z.string().regex(/^ses_[\w-]+$/);
const promptSchema = z
	.object({
		text: z.string().max(100_000),
		agent: z.string().optional(),
		customAgentId: z.string().min(1).optional(),
		model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
		files: z.array(z.string()).max(50).default([]),
		designNodeIds: z.array(z.string().min(1)).max(5).default([]),
		attachments: z
			.array(
				z.object({
					filename: z.string(),
					mime: z.string(),
					data: z.string().max(10_000_000),
				}),
			)
			.max(10)
			.default([]),
		agents: z.array(z.string()).max(10).default([]),
	})
	.refine(
		(value) =>
			value.text.trim() ||
			value.files.length ||
			value.attachments.length ||
			value.designNodeIds.length,
		"Message cannot be empty",
	);
type Session = {
	id: string;
	directory: string;
	title: string;
	parentID?: string;
	time: { updated: number; archived?: number };
};

type ProviderMessage = {
	info: {
		id: string;
		role: string;
		providerID?: string;
		modelID?: string;
		error?: { name: string; data: { message: string } };
		time: { created: number; completed?: number };
	};
	parts: Array<{
		id: string;
		type: string;
		text?: string;
		filename?: string;
		designId?: string;
		viewport?: string;
		brief?: string;
		tool?: string;
		state?: {
			status: string;
			title?: string;
			input?: Record<string, unknown>;
			output?: string;
			error?: string;
			metadata?: Record<string, unknown>;
		};
	}>;
};
type ProviderTurn = {
	runtime: AgentRuntime;
	id: string;
	loomSessionId: string;
	providerId: string;
	messages: ProviderMessage[];
	assistant: ProviderMessage;
	finished: boolean;
	openCodeActive?: boolean;
	permissionToken?: string;
	agentRunId?: string;
	persistedMessages?: string;
	status: { type: string; message?: string };
};

function mergeMessages(
	previous: ProviderMessage[],
	current: ProviderMessage[],
) {
	return [
		...new Map(
			[...previous, ...current].map((message) => [message.info.id, message]),
		).values(),
	].sort((a, b) => a.info.time.created - b.info.time.created);
}

// Extract the command/path an Agy tool wants to run so the permission card can
// show what is being approved, mirroring the OpenCode permission `patterns` field.
function permissionPatterns(
	toolName: string,
	args: Record<string, unknown>,
): string[] {
	const candidates =
		toolName.toLowerCase().replaceAll("_", "") === "runcommand"
			? ["CommandLine", "command", "cmd", "script"]
			: ["TargetFile", "file_path", "filePath", "path", "filename"];
	for (const key of candidates) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			const description = args.Description ?? args.description;
			return typeof description === "string" && description.trim()
				? [value, description]
				: [value];
		}
	}
	const description = args.Description ?? args.description;
	return typeof description === "string" && description.trim()
		? [description]
		: [];
}

export type ChatRequestOptions = {
	directory?: string;
	body?: unknown;
	method?: string;
};

export type ChatRequestGateway = <T>(
	path: string,
	options?: ChatRequestOptions,
) => Promise<T>;

export function createChatRoutes(options: {
	projects: {
		list(): Promise<Array<{ id: string; path: string }>>;
		getById(
			id: string,
		): Promise<{ path: string; autoAccept?: boolean } | null | undefined>;
	};
	request: ChatRequestGateway;
	providerManager?: ProviderManager;
	runtimes?: Map<string, AgentRuntime>;
	permissions?: AgyPermissionStore;
	agyPermissionUrl?: string;
	agyPermissionError?: string;
	providerHistory?: {
		get<T>(sessionId: string): Promise<T | undefined>;
		save(sessionId: string, messages: unknown[]): Promise<unknown>;
		delete(sessionId: string): Promise<unknown>;
	};
	agents?: {
		get(id: string): Promise<
			| {
					id: string;
					projectId: string | null;
					label: string;
					role: string;
					roleDescription: string | null;
					provider: string;
					modelId: string | null;
					systemInstructions: string;
					status: string;
					allowChat: boolean;
					approvalPolicy: string;
					skills: Array<{
						name: string;
						instructions: string;
						enabled: boolean;
						allowChat: boolean;
						canWriteFiles: boolean;
					}>;
			  }
			| undefined
		>;
	};
	agentRunStore?: {
		start(input: {
			id: string;
			agentId: string;
			projectId: string;
			sessionId: string;
			provider: string;
			modelId: string | null;
			inputSummary: string;
		}): Promise<void>;
		finish(input: {
			id: string;
			status: "completed" | "failed" | "cancelled";
			outputSummary: string | null;
			errorMessage: string | null;
		}): Promise<void>;
	};
	designs?: {
		listNodes(projectId: string): Promise<
			Array<{
				id: string;
				projectId: string;
				title: string;
				brief: string;
				viewport: string;
				status: string;
				html: string;
			}>
		>;
	};
	sessionScope?: (
		sessionId: string,
	) => Promise<{ directory: string; projectId: string } | undefined>;
}) {
	const app = new Hono();
	const providerSessions = new Map<string, ProviderTurn>();
	const agyEnabled =
		options.permissions !== undefined && !!options.agyPermissionUrl;
	async function updateProviderTurn(turn: ProviderTurn) {
		if (turn.finished) return;
		const status = await turn.runtime.status(turn.id);
		const output = await turn.runtime.readOutput?.(turn.id);
		const activityParts: Array<{
			id: string;
			part: ProviderMessage["parts"][number];
		}> = (output?.activities ?? []).map((activity) => ({
			id: activity.id,
			part: {
				id: `${turn.assistant.info.id}-${activity.id}`,
				type: "tool",
				tool: activity.tool,
				state: {
					status: activity.status,
					title: activity.tool,
					input: activity.input,
					output: activity.output,
					error: activity.error,
					metadata: activity.metadata,
				},
			},
		}));
		const activityById = new Map(
			activityParts.map(({ id, part }) => [id, part] as const),
		);
		const orderedParts: ProviderMessage["parts"] = output?.parts?.length
			? output.parts.flatMap<ProviderMessage["parts"][number]>((part) => {
					if (part.type === "text")
						return part.text.trim()
							? [
									{
										id: `${turn.assistant.info.id}-${part.id}`,
										type: "text",
										text: part.text,
									},
								]
							: [];
					const activity = activityById.get(part.id);
					return activity ? [activity] : [];
				})
			: [
					...activityParts.map(({ part }) => part),
					...(output?.output
						? [
								{
									id: `${turn.assistant.info.id}-text`,
									type: "text",
									text: output.output,
								},
							]
						: []),
				];
		turn.assistant.parts = orderedParts;
		turn.finished = [
			"completed",
			"failed",
			"cancelled",
			"interrupted",
		].includes(status);
		turn.status = { type: turn.finished ? "idle" : "busy" };
		if (turn.finished) {
			turn.assistant.info.time.completed = Date.now();
			// Release the hook: deny anything still waiting and drop the run token so
			// late hook calls cannot execute after the run finishes.
			options.permissions?.denySession(turn.loomSessionId);
			if (turn.permissionToken) {
				options.permissions?.unregisterRun(turn.permissionToken);
				turn.permissionToken = undefined;
			}
		}
		if (
			status === "failed" ||
			status === "interrupted" ||
			(status === "completed" && !output?.output.trim())
		) {
			const message =
				(await turn.runtime.lastError?.(turn.id)) ||
				(status === "completed"
					? `${turn.providerId} finished without a text response. Check provider permissions and retry.`
					: `${turn.providerId} ${status}`);
			turn.status = { type: "error", message };
			turn.assistant.info.error = { name: "ProviderError", data: { message } };
		}
		if (turn.finished && turn.agentRunId && options.agentRunStore) {
			const outputText = output?.output ?? "";
			const errorMessage =
				turn.status.type === "error"
					? (turn.status.message ?? "Agent failed")
					: null;
			await options.agentRunStore.finish({
				id: turn.agentRunId,
				status: errorMessage
					? "failed"
					: status === "cancelled"
						? "cancelled"
						: "completed",
				outputSummary: outputText ? outputText.slice(-4000) : null,
				errorMessage,
			});
		}
		const serialized = JSON.stringify(turn.messages);
		if (serialized !== turn.persistedMessages) {
			await options.providerHistory?.save(turn.loomSessionId, turn.messages);
			turn.persistedMessages = serialized;
		}
	}
	let cachedCatalog: Awaited<ReturnType<typeof buildCatalog>> | null = null;
	let catalogPromise: Promise<Awaited<ReturnType<typeof buildCatalog>>> | null =
		null;
	async function buildCatalog(projectId: string) {
		const root = await directory(projectId);
		const [providers, agents, commands] = await Promise.all([
			request<{
				providers: Array<{
					id: string;
					name: string;
					models: Record<string, { id: string; name: string }>;
				}>;
				default: Record<string, string>;
			}>("/config/providers", root),
			request<
				Array<{
					name: string;
					description?: string;
					mode: string;
					hidden?: boolean;
				}>
			>("/agent", root),
			request<Array<{ name: string; description?: string }>>("/command", root),
		]);
		const normalizedModels =
			options.providerManager?.catalog.listAvailable().map((model) => ({
				providerID: model.providerId,
				modelID: String(model.metadata?.modelId ?? model.name),
				name: model.displayName,
				provider: model.providerId,
				providerId: model.providerId,
				connectionId: model.connectionId,
				capabilities: model.capabilities,
			})) ?? [];
		const managedProviderIds = new Set(
			normalizedModels.map((model) => model.providerID),
		);
		return {
			models: [
				...providers.providers.flatMap((provider) =>
					managedProviderIds.has(provider.id)
						? []
						: Object.entries(provider.models).map(([modelId, model]) => ({
								providerID: provider.id,
								modelID: modelId,
								name: model.name || modelId,
								provider: provider.name,
							})),
				),
				...normalizedModels,
			],
			defaults: providers.default,
			agents: agents.filter((agent) => !agent.hidden),
			commands,
		};
	}
	const request = <T>(
		path: string,
		directory?: string,
		body?: unknown,
		method = body ? "POST" : "GET",
	) =>
		options.request<T>(path, {
			directory,
			body,
			method,
		});
	async function directory(projectId?: string) {
		const project = projectId
			? await options.projects.getById(projectId)
			: null;
		if (!project)
			throw new HTTPException(404, { message: "Choose an existing project" });
		return project.path;
	}
	async function session(sessionId: string) {
		id.parse(sessionId);
		const scope = await options.sessionScope?.(sessionId);
		const projects = await options.projects.list();
		const candidates = scope
			? [{ directory: scope.directory, projectId: scope.projectId }]
			: projects.map((project) => ({
					directory: project.path,
					projectId: project.id,
				}));
		let notFound = false;
		for (const candidate of candidates) {
			let found: Session;
			try {
				found = await request<Session>(
					`/session/${sessionId}`,
					candidate.directory,
				);
			} catch (error) {
				const details =
					error && typeof error === "object" && "details" in error
						? (error as { details?: { status?: string } }).details
						: undefined;
				if (details?.status === "404") {
					notFound = true;
					continue;
				}
				throw error;
			}

			const project = projects.find(
				(item) => resolve(item.path) === resolve(found.directory),
			);
			const isScopedWorkspace =
				scope && resolve(scope.directory) === resolve(found.directory);
			if (!isScopedWorkspace && !project) continue;
			return {
				...found,
				projectId: scope?.projectId ?? project?.id ?? candidate.projectId,
			};
		}
		throw new HTTPException(404, {
			message: notFound
				? "Session was not found in a Loom project"
				: "Session is not in a Loom project",
		});
	}
	async function filePath(root: string, path: string) {
		const [base, file] = await Promise.all([
			realpath(root),
			realpath(resolve(root, path)),
		]);
		const local = relative(base, file);
		if (local === ".." || local.startsWith("../") || isAbsolute(local))
			throw new HTTPException(400, {
				message: "File must be inside the project",
			});
		return local;
	}
	app.get("/sessions", async (c) => {
		const root = await directory(c.req.query("projectId"));
		const sessions = await request<Session[]>("/session?limit=200", root);
		return c.json(
			sessions.filter(
				(s) =>
					resolve(s.directory) === resolve(root) &&
					!s.parentID &&
					!s.time.archived,
			),
		);
	});
	app.post("/sessions", async (c) => {
		const input = z
			.object({ projectId: z.string(), title: z.string().min(1).max(200) })
			.parse(await c.req.json());
		return c.json(
			await request<Session>("/session", await directory(input.projectId), {
				title: input.title,
			}),
			201,
		);
	});
	app.get("/catalog", async (c) => {
		const projectId = c.req.query("projectId") ?? "";
		if (cachedCatalog) return c.json(cachedCatalog);
		if (!catalogPromise) {
			catalogPromise = (async () => {
				if (options.providerManager)
					await options.providerManager.refreshAll({ refreshModels: true });
				return buildCatalog(projectId);
			})().finally(() => {
				catalogPromise = null;
			});
		}
		cachedCatalog = await catalogPromise;
		return c.json(cachedCatalog);
	});
	app.get("/files", async (c) => {
		const root = await directory(c.req.query("projectId"));
		return c.json(
			await request<string[]>(
				`/find/file?query=${encodeURIComponent(c.req.query("query") ?? "")}&limit=100&dirs=false`,
				root,
			),
		);
	});
	app.get("/file", async (c) => {
		const root = await directory(c.req.query("projectId"));
		const path = await filePath(
			root,
			z.string().min(1).parse(c.req.query("path")),
		);
		return c.json(
			await request(`/file/content?path=${encodeURIComponent(path)}`, root),
		);
	});
	app.get("/sessions/:id", async (c) => {
		const current = await session(c.req.param("id"));
		const providerSession = providerSessions.get(current.id);
		if (providerSession && !providerSession.openCodeActive) {
			await updateProviderTurn(providerSession);
			const pending =
				options.permissions?.pendingFor(current.id).map((request) => ({
					id: request.id,
					permission: request.toolName,
					patterns: permissionPatterns(request.toolName, request.args),
					sessionID: current.id,
				})) ?? [];
			return c.json({
				session: current,
				messages: providerSession.messages,
				status: pending.length
					? { type: "busy", message: "Waiting for permission" }
					: providerSession.status,
				permissions: pending,
				questions: [],
			});
		}
		const [messages, statuses, permissions, questions] = await Promise.all([
			request<ProviderMessage[]>(
				`/session/${current.id}/message`,
				current.directory,
			),
			request<Record<string, { type: string; message?: string }>>(
				"/session/status",
				current.directory,
			),
			request<Array<{ sessionID: string }>>("/permission", current.directory),
			request<Array<{ sessionID: string }>>("/question", current.directory),
		]);
		const providerMessages =
			providerSession?.messages ??
			(await options.providerHistory?.get<ProviderMessage[]>(current.id)) ??
			[];
		return c.json({
			session: current,
			messages: mergeMessages(providerMessages, messages),
			status: statuses[current.id] ?? { type: "idle" },
			permissions: permissions.filter((p) => p.sessionID === current.id),
			questions: questions.filter((q) => q.sessionID === current.id),
		});
	});
	app.post("/sessions/:id/messages", async (c) => {
		const current = await session(c.req.param("id"));
		const input = promptSchema.parse(await c.req.json());
		const customAgent = input.customAgentId
			? await options.agents?.get(input.customAgentId)
			: undefined;
		if (input.customAgentId && !customAgent)
			throw new HTTPException(404, { message: "Custom agent not found" });
		if (customAgent) {
			if (!customAgent.allowChat || customAgent.status !== "active")
				throw new HTTPException(403, {
					message: "This custom agent is disabled for Chat",
				});
			if (customAgent.projectId && customAgent.projectId !== current.projectId)
				throw new HTTPException(403, {
					message: "This custom agent is scoped to another project",
				});
			if (
				options.providerManager?.get(customAgent.provider)?.status !==
				"connected"
			)
				throw new HTTPException(409, {
					message: `Custom agent provider is not connected: ${customAgent.provider}`,
				});
			const supportsCustomModel = options.providerManager?.registry
				.get(customAgent.provider)
				?.definition.capabilities.includes("custom-model");
			if (
				customAgent.modelId &&
				!options.providerManager?.catalog
					.listByProvider(customAgent.provider)
					.some((model) =>
						[model.name, model.displayName, model.metadata?.modelId].some(
							(id) =>
								typeof id === "string" &&
								id.toLowerCase() === customAgent.modelId?.toLowerCase(),
						),
					) &&
				!supportsCustomModel
			) {
				throw new HTTPException(409, {
					message:
						"The custom agent model is no longer available. Update the agent's runtime settings.",
				});
			}
		}
		const customAgentCanWriteFiles =
			customAgent?.approvalPolicy === "ask_before_write" &&
			customAgent.skills.some(
				(skill) => skill.enabled && skill.allowChat && skill.canWriteFiles,
			);
		const designNodes = input.designNodeIds.length
			? await (async () => {
					if (!current.projectId || !options.designs)
						throw new HTTPException(400, {
							message: "Canvas designs are unavailable for this project",
						});
					const nodes = await options.designs.listNodes(current.projectId);
					const byId = new Map(nodes.map((node) => [node.id, node]));
					return input.designNodeIds.map((nodeId) => {
						const node = byId.get(nodeId);
						if (!node || node.projectId !== current.projectId)
							throw new HTTPException(400, {
								message:
									"A selected Canvas design does not belong to this project",
							});
						if (node.status !== "ready" || !node.html.trim())
							throw new HTTPException(409, {
								message: `Canvas design is not ready: ${node.title}`,
							});
						return node;
					});
				})()
			: [];
		const designContext = designNodes
			.map(
				(node, index) =>
					`Canvas design ${index + 1}: ${node.title}\nViewport: ${node.viewport}\nDesign brief: ${node.brief}\nGenerated HTML:\n${node.html}`,
			)
			.join("\n\n---\n\n");
		const designInstruction = designNodes.length
			? `IMPLEMENTATION PRIORITY: The attached Canvas design node(s) are the authoritative visual specification for this request. When the user asks to implement, slice, or recreate them, match their layout, colors, typography, spacing, sizing, and component treatment as closely as possible. Do not replace or restyle the Canvas design to match the existing project's theme; inspect the project only to determine its framework, entry points, and integration needs. Follow the user's requested behavior and scope. Adapt the design to the project theme only if the user explicitly asks for that.`
			: "";
		const promptText = [
			customAgent
				? `You are the custom agent “${customAgent.label}” (${customAgent.role}).\n${customAgent.roleDescription ?? ""}\n${customAgent.systemInstructions}\n${customAgent.skills
						.filter((skill) => skill.enabled && skill.allowChat)
						.map((skill) => `## ${skill.name}\n${skill.instructions}`)
						.join(
							"\n\n",
						)}\n\nFollow the configured agent role and skills while respecting Loom's permission and project-scope policies.`
				: "",
			designInstruction,
			input.text,
			designContext ? `Canvas visual reference(s):\n${designContext}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
		const openCodePromptText = [
			customAgent
				? `Custom agent: ${customAgent.label} (${customAgent.role})\n${customAgent.roleDescription ?? ""}\n${customAgent.systemInstructions}\n${customAgent.skills
						.filter((skill) => skill.enabled && skill.allowChat)
						.map((skill) => `## ${skill.name}\n${skill.instructions}`)
						.join(
							"\n\n",
						)}\n\nRespect the Loom approval policy and project boundary.`
				: "",
			designInstruction,
			input.text ? `User request:\n${input.text}` : "",
			designNodes.length
				? `Attached Canvas nodes: ${designNodes.map((node) => `${node.title} (${node.viewport}): ${node.brief}`).join("; ")}. Inspect the attached HTML files as the visual source of truth.`
				: "",
		]
			.filter(Boolean)
			.join("\n\n");
		const providerId = customAgent?.provider ?? input.model?.providerID;
		const runtime = providerId ? options.runtimes?.get(providerId) : undefined;
		const requestedModel = customAgent
			? customAgent.modelId
				? { providerID: customAgent.provider, modelID: customAgent.modelId }
				: undefined
			: input.model;
		const runtimeModel =
			providerId && requestedModel
				? (() => {
						const requestedId = requestedModel.modelID.toLowerCase();
						const found = options.providerManager?.catalog
							.listByProvider(providerId)
							.find((candidate) => {
								const modelId = candidate.metadata?.modelId;
								return [candidate.name, candidate.displayName, modelId].some(
									(value) =>
										typeof value === "string" &&
										value.toLowerCase() === requestedId,
								);
							});
						const modelId = found?.metadata?.modelId;
						return {
							providerID: providerId,
							modelID:
								typeof modelId === "string"
									? modelId
									: (requestedModel.modelID ?? ""),
						};
					})()
				: requestedModel;
		const existing = providerSessions.get(current.id);
		if (existing) {
			await updateProviderTurn(existing);
			if (!existing.finished)
				throw new HTTPException(409, { message: "Session is already running" });
		}
		if (
			providerId &&
			providerId !== "opencode" &&
			options.providerManager?.registry.get(providerId) &&
			!runtime
		)
			throw new HTTPException(409, {
				message: `Provider runtime is unavailable: ${providerId}`,
			});
		if (runtime && providerId && providerId !== "opencode") {
			const connection = options.providerManager?.get(providerId);
			if (connection?.status !== "connected")
				throw new HTTPException(409, {
					message: `Provider is not connected: ${providerId}`,
				});
			if (input.attachments.length || input.agents.length)
				throw new HTTPException(400, {
					message:
						"This provider does not support attachments or agent mentions in chat yet",
				});
			if ((providerId === "agy" || providerId === "antigravity") && !agyEnabled)
				throw new HTTPException(503, {
					message:
						options.agyPermissionError ??
						"Agy permission approval is unavailable",
				});
			const files = await Promise.all(
				input.files.map((path) => filePath(current.directory, path)),
			);
			const storedHistory =
				existing?.messages ??
				(await options.providerHistory?.get<ProviderMessage[]>(current.id)) ??
				[];
			const history = mergeMessages(
				storedHistory,
				await request<ProviderMessage[]>(
					`/session/${current.id}/message`,
					current.directory,
				),
			);
			const created = await runtime.createSession({
				cwd: current.directory,
				title: current.title,
			});
			const now = Date.now();
			const messageId = `provider-${crypto.randomUUID()}`;
			const assistant: ProviderMessage = {
				info: {
					id: `${messageId}-assistant`,
					role: "assistant",
					providerID: providerId,
					modelID: runtimeModel?.modelID,
					time: { created: now },
				},
				parts: [],
			};
			const user: ProviderMessage = {
				info: { id: `${messageId}-user`, role: "user", time: { created: now } },
				parts: [
					{ id: `${messageId}-text`, type: "text", text: input.text },
					...designNodes.map((node) => ({
						id: `${messageId}-design-${node.id}`,
						type: "design",
						designId: node.id,
						text: node.title,
						filename: `${node.viewport} · ${node.brief}`,
						viewport: node.viewport,
						brief: node.brief,
					})),
				],
			};
			const turn: ProviderTurn = {
				runtime,
				id: created.id,
				loomSessionId: current.id,
				providerId,
				messages: [...history, user, assistant],
				assistant,
				finished: false,
				status: { type: "busy" },
			};
			if (customAgent && options.agentRunStore) {
				turn.agentRunId = randomUUID();
				await options.agentRunStore.start({
					id: turn.agentRunId,
					agentId: customAgent.id,
					projectId: current.projectId ?? "",
					sessionId: current.id,
					provider: providerId,
					modelId: runtimeModel?.modelID ?? null,
					inputSummary: input.text
						.replace(/(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+)/gi, "[redacted]")
						.slice(0, 500),
				});
			}
			turn.persistedMessages = JSON.stringify(turn.messages);
			await options.providerHistory?.save(current.id, turn.messages);
			const isAgy = providerId === "agy" || providerId === "antigravity";
			const permissionToken =
				isAgy && agyEnabled && (!customAgent || customAgentCanWriteFiles)
					? randomBytes(24).toString("hex")
					: undefined;
			const autoAccept =
				!customAgent && permissionToken && current.projectId
					? (await options.projects.getById(current.projectId))?.autoAccept ===
						true
					: false;
			if (permissionToken && options.permissions)
				options.permissions.registerRun({
					token: permissionToken,
					sessionId: current.id,
					autoAccept,
				});
			turn.permissionToken = permissionToken;
			providerSessions.set(current.id, turn);
			// CLI runtimes start a new process each turn; carry forward the conversation.
			const context = history
				.map(
					(message) =>
						`${message.info.role}: ${message.parts
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n")}`,
				)
				.join("\n\n");
			const prompt = [
				context ? `Previous conversation:\n${context}` : "",
				promptText,
				files.length ? `Referenced project files:\n${files.join("\n")}` : "",
			]
				.filter(Boolean)
				.join("\n\n");
			try {
				await runtime.prompt({
					sessionId: created.id,
					prompt,
					model: runtimeModel,
					...(customAgent
						? {
								permission: {
						mode: customAgentCanWriteFiles
							? ("ask" as const)
							: ("read-only" as const),
									...(permissionToken && options.agyPermissionUrl
										? {
												env: {
													LOOM_PERMISSION_URL: options.agyPermissionUrl,
													LOOM_PERMISSION_TOKEN: permissionToken,
												},
											}
										: {}),
								},
							}
						: permissionToken && options.agyPermissionUrl
							? {
									permission: {
										mode: autoAccept ? ("auto" as const) : ("ask" as const),
										env: {
											LOOM_PERMISSION_URL: options.agyPermissionUrl,
											LOOM_PERMISSION_TOKEN: permissionToken,
										},
									},
								}
							: {}),
				});
			} catch (error) {
				if (permissionToken && options.permissions)
					options.permissions.unregisterRun(permissionToken);
				const message = error instanceof Error ? error.message : String(error);
				turn.finished = true;
				turn.permissionToken = undefined;
				turn.status = { type: "error", message };
				if (turn.agentRunId && options.agentRunStore)
					await options.agentRunStore.finish({
						id: turn.agentRunId,
						status: "failed",
						outputSummary: null,
						errorMessage: message.slice(0, 1000),
					});
				assistant.info.time.completed = Date.now();
				assistant.info.error = { name: "ProviderError", data: { message } };
				throw error;
			}
			return c.body(null, 204);
		}
		const files = await Promise.all(
			input.files.map(async (path) => {
				const local = await filePath(current.directory, path);
				const url = new URL("file:///");
				url.pathname = resolve(current.directory, local);
				return {
					type: "file",
					mime: "text/plain",
					filename: local,
					url: url.href,
				};
			}),
		);
		await request(`/session/${current.id}/prompt_async`, current.directory, {
			agent: input.agent,
			model: customAgent?.modelId
				? { providerID: customAgent.provider, modelID: customAgent.modelId }
				: input.model,
			parts: [
				{ type: "text", text: openCodePromptText },
				...designNodes.flatMap((node) => [
					{
						type: "text",
						text: `Canvas design attached: ${node.title} (${node.viewport}) — ${node.brief}`,
					},
					{
						type: "file",
						mime: "text/html",
						filename: `canvas-design:${node.id}.html`,
						url: `data:text/html;base64,${Buffer.from(node.html).toString("base64")}`,
					},
				]),
				...files,
				...input.attachments.map((attachment) => ({
					type: "file",
					mime: attachment.mime,
					filename: attachment.filename,
					url: `data:${attachment.mime};base64,${attachment.data}`,
				})),
				...input.agents.map((name) => ({ type: "agent", name })),
			],
		});
		if (existing) existing.openCodeActive = true;
		return c.body(null, 204);
	});
	app.post("/sessions/:id/abort", async (c) => {
		const current = await session(c.req.param("id"));
		const providerSession = providerSessions.get(current.id);
		if (providerSession && !providerSession.finished) {
			options.permissions?.denySession(current.id);
			if (providerSession.permissionToken)
				options.permissions?.unregisterRun(providerSession.permissionToken);
			await providerSession.runtime.abort(providerSession.id);
			return c.json({ aborted: true });
		}
		await request(
			`/session/${current.id}/abort`,
			current.directory,
			{},
			"POST",
		);
		return c.json({ aborted: true });
	});
	app.delete("/sessions/:id", async (c) => {
		const current = await session(c.req.param("id"));
		const providerSession = providerSessions.get(current.id);
		options.permissions?.denySession(current.id);
		if (providerSession?.permissionToken)
			options.permissions?.unregisterRun(providerSession.permissionToken);
		await request(`/session/${current.id}`, current.directory, {}, "DELETE");
		providerSessions.delete(current.id);
		await options.providerHistory?.delete(current.id);
		return c.body(null, 204);
	});
	app.post("/sessions/:id/rename", async (c) => {
		const current = await session(c.req.param("id"));
		const input = z
			.object({ title: z.string().trim().min(1).max(200) })
			.parse(await c.req.json());
		return c.json(
			await request(
				`/session/${current.id}`,
				current.directory,
				input,
				"PATCH",
			),
		);
	});
	app.get("/sessions/:id/diff", async (c) => {
		const current = await session(c.req.param("id"));
		type Diff = {
			file?: string;
			patch?: string;
			before?: string;
			after?: string;
			additions: number;
			deletions: number;
		};
		const providerTurn = providerSessions.get(current.id);
		if (providerTurn) {
			const activityDiffs = providerTurn.assistant.parts.flatMap((part) => {
				const metadata = part.state?.metadata;
				if (!metadata) return [];
				const filediff = metadata.filediff as Diff | undefined;
				if (filediff?.file) return [filediff];
				const files = metadata.files;
				return Array.isArray(files)
					? files.flatMap((file) => {
							if (!file || typeof file !== "object") return [];
							const item = file as Diff & {
								filePath?: string;
								relativePath?: string;
								diff?: string;
							};
							const path = item.file ?? item.relativePath ?? item.filePath;
							return path
								? [{ ...item, file: path, patch: item.patch ?? item.diff }]
								: [];
						})
					: [];
			});
			return c.json(activityDiffs);
		}
		let diffs = await request<Diff[]>(
			`/session/${current.id}/diff`,
			current.directory,
		);
		// With snapshots disabled, edit tools still persist their exact patches in message metadata.
		if (!diffs.length) {
			const messages = await request<
				Array<{
					parts: Array<{
						type: string;
						state?: {
							status: string;
							metadata?: {
								filediff?: Diff;
								files?: Array<
									Diff & {
										filePath?: string;
										relativePath?: string;
										diff?: string;
									}
								>;
							};
						};
					}>;
				}>
			>(`/session/${current.id}/message`, current.directory);
			diffs = messages.flatMap((m) =>
				m.parts.flatMap((p) => {
					if (p.type !== "tool" || p.state?.status !== "completed") return [];
					const metadata = p.state.metadata;
					return metadata?.filediff
						? [metadata.filediff]
						: (metadata?.files ?? []).map((f) => ({
								...f,
								file: f.file ?? f.relativePath ?? f.filePath,
								patch: f.patch ?? f.diff,
							}));
				}),
			);
		}
		const grouped = new Map<string, Diff>();
		for (const diff of diffs) {
			if (!diff.file) continue;
			const file = relative(
				current.directory,
				resolve(current.directory, diff.file),
			);
			if (file.startsWith("../") || file === "..") continue;
			const previous = grouped.get(file);
			grouped.set(
				file,
				previous
					? {
							...diff,
							file,
							patch: [previous.patch, diff.patch].filter(Boolean).join("\n"),
							additions: previous.additions + diff.additions,
							deletions: previous.deletions + diff.deletions,
						}
					: { ...diff, file },
			);
		}
		return c.json([...grouped.values()]);
	});
	for (const kind of ["permission", "question"] as const) {
		app.post(`/sessions/:id/${kind}/:requestId`, async (c) => {
			const current = await session(c.req.param("id"));
			const requestId = c.req.param("requestId");
			// Agy runs gate tools through the in-memory hook store rather than
			// OpenCode, so resolve those requests locally before proxying.
			if (
				kind === "permission" &&
				options.permissions?.get(requestId)?.sessionId === current.id
			) {
				const input = z
					.object({ reply: z.enum(["once", "always", "reject"]) })
					.parse(await c.req.json());
				if (input.reply === "always")
					options.permissions.enableAutoAccept(current.id);
				const decision = input.reply === "reject" ? "deny" : "allow";
				if (!options.permissions.decide(requestId, decision))
					throw new HTTPException(404, {
						message: "Request no longer pending",
					});
				return c.json({ decided: true });
			}
			const pending = await request<Array<{ id: string; sessionID: string }>>(
				`/${kind}`,
				current.directory,
			);
			if (
				!pending.some((p) => p.id === requestId && p.sessionID === current.id)
			)
				throw new HTTPException(404, { message: "Request no longer pending" });
			const body = await c.req.json();
			const input =
				kind === "permission"
					? z
							.object({ reply: z.enum(["once", "always", "reject"]) })
							.parse(body)
					: z.object({ answers: z.array(z.array(z.string())) }).parse(body);
			return c.json(
				await request(
					`/${kind}/${encodeURIComponent(requestId)}/reply`,
					current.directory,
					input,
				),
			);
		});
	}
	app.onError((error, c) => {
		const status =
			error instanceof HTTPException
				? error.status
				: error instanceof z.ZodError
					? 400
					: 502;
		return c.json(
			{ error: { message: error.message || "OpenCode request failed" } },
			status,
		);
	});
	return app;
}
