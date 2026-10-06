import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentRuntime, ProviderManager } from "@loom/providers";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const id = z.string().regex(/^ses_[\w-]+$/);
const promptSchema = z
	.object({
		text: z.string().max(100_000),
		agent: z.string().optional(),
		model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
		files: z.array(z.string()).max(50).default([]),
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
			value.text.trim() || value.files.length || value.attachments.length,
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
	parts: Array<{ id: string; type: string; text: string }>;
};
type ProviderTurn = {
	runtime: AgentRuntime;
	id: string;
	providerId: string;
	messages: ProviderMessage[];
	assistant: ProviderMessage;
	finished: boolean;
	openCodeActive?: boolean;
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
		getById(id: string): Promise<{ path: string } | null | undefined>;
	};
	request: ChatRequestGateway;
	providerManager?: ProviderManager;
	runtimes?: Map<string, AgentRuntime>;
	sessionScope?: (
		sessionId: string,
	) => Promise<{ directory: string; projectId: string } | undefined>;
}) {
	const app = new Hono();
	const providerSessions = new Map<string, ProviderTurn>();
	async function updateProviderTurn(turn: ProviderTurn) {
		if (turn.finished) return;
		const status = await turn.runtime.status(turn.id);
		const output = await turn.runtime.readOutput?.(turn.id);
		turn.assistant.parts = output?.output
			? [
					{
						id: `${turn.assistant.info.id}-text`,
						type: "text",
						text: output.output,
					},
				]
			: [];
		turn.finished = [
			"completed",
			"failed",
			"cancelled",
			"interrupted",
		].includes(status);
		turn.status = { type: turn.finished ? "idle" : "busy" };
		if (turn.finished) turn.assistant.info.time.completed = Date.now();
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
		return {
			models: [
				...providers.providers.flatMap((provider) =>
					Object.entries(provider.models).map(([modelId, model]) => ({
						providerID: provider.id,
						modelID: modelId,
						name: model.name || modelId,
						provider: provider.name,
					})),
				),
				...normalizedModels.filter(
					(model) =>
						!providers.providers.some(
							(provider) => provider.id === model.providerID,
						),
				),
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
		const found = await request<Session>(
			`/session/${sessionId}`,
			scope?.directory,
		);
		const projects = await options.projects.list();
		if (
			!(scope && resolve(scope.directory) === resolve(found.directory)) &&
			!projects.some(
				(project) => resolve(project.path) === resolve(found.directory),
			)
		)
			throw new HTTPException(404, {
				message: "Session is not in a Loom project",
			});
		return { ...found, projectId: scope?.projectId };
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
			return c.json({
				session: current,
				messages: providerSession.messages,
				status: providerSession.status,
				permissions: [],
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
		return c.json({
			session: current,
			messages: mergeMessages(providerSession?.messages ?? [], messages),
			status: statuses[current.id] ?? { type: "idle" },
			permissions: permissions.filter((p) => p.sessionID === current.id),
			questions: questions.filter((q) => q.sessionID === current.id),
		});
	});
	app.post("/sessions/:id/messages", async (c) => {
		const current = await session(c.req.param("id"));
		const input = promptSchema.parse(await c.req.json());
		const providerId = input.model?.providerID;
		const runtime = providerId ? options.runtimes?.get(providerId) : undefined;
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
			const files = await Promise.all(
				input.files.map((path) => filePath(current.directory, path)),
			);
			const history = mergeMessages(
				existing?.messages ?? [],
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
					modelID: input.model?.modelID,
					time: { created: now },
				},
				parts: [],
			};
			const user: ProviderMessage = {
				info: { id: `${messageId}-user`, role: "user", time: { created: now } },
				parts: [{ id: `${messageId}-text`, type: "text", text: input.text }],
			};
			const turn: ProviderTurn = {
				runtime,
				id: created.id,
				providerId,
				messages: [...history, user, assistant],
				assistant,
				finished: false,
				status: { type: "busy" },
			};
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
				input.text,
				files.length ? `Referenced project files:\n${files.join("\n")}` : "",
			]
				.filter(Boolean)
				.join("\n\n");
			try {
				await runtime.prompt({
					sessionId: created.id,
					prompt,
					model: input.model,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				turn.finished = true;
				turn.status = { type: "error", message };
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
			model: input.model,
			parts: [
				{ type: "text", text: input.text },
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
		await request(`/session/${current.id}`, current.directory, {}, "DELETE");
		providerSessions.delete(current.id);
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
			const pending = await request<Array<{ id: string; sessionID: string }>>(
				`/${kind}`,
				current.directory,
			);
			const requestId = c.req.param("requestId");
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
