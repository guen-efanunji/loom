import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProviderManager } from "@loom/providers";
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
	sessionScope?: (
		sessionId: string,
	) => Promise<{ directory: string; projectId: string } | undefined>;
}) {
	const app = new Hono();
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
		const root = await directory(c.req.query("projectId"));
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
				designSupported:
					model.providerId === "opencode" &&
					typeof model.metadata?.upstreamProviderId === "string" &&
					typeof model.metadata?.providerModelId === "string",
				openCodeProviderID:
					typeof model.metadata?.upstreamProviderId === "string"
						? model.metadata.upstreamProviderId
						: undefined,
				openCodeModelID:
					typeof model.metadata?.providerModelId === "string"
						? model.metadata.providerModelId
						: undefined,
			})) ?? [];
		return c.json({
			models: [
				...providers.providers.flatMap((p) =>
					Object.entries(p.models).map(([key, m]) => ({
						providerID: p.id,
						modelID: key,
						name: m.name || key,
						provider: p.name,
						designSupported: true,
						openCodeProviderID: p.id,
						openCodeModelID: key,
					})),
				),
				...normalizedModels.filter(
					(model) =>
						!providers.providers.some(
							(provider) =>
								provider.id === model.providerID &&
								model.providerID === "opencode",
						),
				),
			],
			defaults: providers.default,
			agents: agents.filter((a) => !a.hidden),
			commands,
		});
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
		const [messages, statuses, permissions, questions] = await Promise.all([
			request(`/session/${current.id}/message`, current.directory),
			request<Record<string, { type: string; message?: string }>>(
				"/session/status",
				current.directory,
			),
			request<Array<{ sessionID: string }>>("/permission", current.directory),
			request<Array<{ sessionID: string }>>("/question", current.directory),
		]);
		return c.json({
			session: current,
			messages,
			status: statuses[current.id] ?? { type: "idle" },
			permissions: permissions.filter((p) => p.sessionID === current.id),
			questions: questions.filter((q) => q.sessionID === current.id),
		});
	});
	app.post("/sessions/:id/messages", async (c) => {
		const current = await session(c.req.param("id"));
		const input = promptSchema.parse(await c.req.json());
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
		return c.body(null, 204);
	});
	app.post("/sessions/:id/abort", async (c) => {
		const current = await session(c.req.param("id"));
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
