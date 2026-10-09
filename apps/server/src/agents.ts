import { randomUUID } from "node:crypto";
import type { Database } from "@loom/db";
import {
	and,
	customAgentAssignments,
	customAgentRunEvents,
	customAgentRuns,
	customAgentSkills,
	customAgents,
	desc,
	eq,
	isNull,
	or,
} from "@loom/db";
import type { ProviderManager } from "@loom/providers";
import { readPrompt } from "@loom/providers";
import { Hono } from "hono";
import { z } from "zod";

const surfaces = {
	allowChat: z.boolean().default(true),
	allowCanvas: z.boolean().default(false),
	allowKanban: z.boolean().default(true),
};
const skillInput = z.object({
	id: z.string().optional(),
	name: z.string().trim().min(2).max(80),
	source: z
		.enum(["builtin", "project", "custom", "imported"])
		.default("custom"),
	instructions: z.string().trim().min(1).max(24000),
	enabled: z.boolean().default(true),
	allowChat: z.boolean().default(true),
	allowCanvas: z.boolean().default(false),
	allowKanban: z.boolean().default(true),
	canReadFiles: z.boolean().default(false),
	canWriteFiles: z.boolean().default(false),
	canRunTests: z.boolean().default(false),
	canUseNetwork: z.boolean().default(false),
});
const agentInput = z
	.object({
		projectId: z.string().nullable().optional(),
		label: z.string().trim().min(2).max(60),
		role: z.string().trim().min(2).max(60),
		roleDescription: z.string().max(2000).optional(),
		provider: z.string().min(1),
		modelId: z.string().nullable().optional(),
		effort: z.enum(["low", "medium", "high", "max"]).nullable().optional(),
		systemInstructions: z.string().max(24000).default(""),
		status: z.enum(["active", "disabled", "needs_attention"]).default("active"),
		executionMode: z
			.enum(["on_demand", "continuous_kanban"])
			.default("on_demand"),
		...surfaces,
		approvalPolicy: z
			.enum(["ask_before_write", "task_scoped_write", "read_only"])
			.default("ask_before_write"),
		maxRunDurationMinutes: z.number().int().min(1).max(180).default(30),
		maxRetries: z.number().int().min(0).max(5).default(1),
		maxTaskHops: z.number().int().min(1).max(10).default(3),
		fallbackEnabled: z.boolean().default(false),
		fallbackProvider: z.string().optional(),
		fallbackModelId: z.string().optional(),
		skills: z.array(skillInput).max(20).default([]),
	})
	.superRefine((a, ctx) => {
		if (!a.allowChat && !a.allowCanvas && !a.allowKanban)
			ctx.addIssue({
				code: "custom",
				message: "Choose at least one available surface",
			});
		if (!a.skills.some((s) => s.enabled))
			ctx.addIssue({ code: "custom", message: "Enable at least one skill" });
		if (a.skills.some((s) => s.enabled && s.allowCanvas && s.canWriteFiles))
			ctx.addIssue({
				code: "custom",
				message: "Canvas skills cannot write project files",
			});
		if (
			a.role === "pm" &&
			a.skills.some((s) => s.enabled && s.canWriteFiles) &&
			a.approvalPolicy !== "task_scoped_write"
		)
			ctx.addIssue({
				code: "custom",
				message:
					"Project Manager write skills require an explicit task-scoped write policy",
			});
		if (
			a.skills.reduce(
				(n, s) => n + s.instructions.length,
				a.systemInstructions.length,
			) > 24_000
		)
			ctx.addIssue({
				code: "custom",
				message: "Combined agent instructions must be 24 KB or less",
			});
		if (a.fallbackEnabled && !a.fallbackProvider)
			ctx.addIssue({ code: "custom", message: "Choose a fallback provider" });
	});

type Options = {
	db: Database;
	projects: {
		getById(
			id: string,
		): Promise<{ id: string; path: string } | null | undefined>;
	};
	tasks: {
		getById(id: string): Promise<
			| {
					id: string;
					projectId: string;
					status: string;
					title: string;
					prompt: string;
					description: string;
					acceptanceCriteria: string;
			  }
			| null
			| undefined
		>;
	};
	providers: ProviderManager;
};

function safeError(error: unknown, root?: string): string {
	const message =
		error instanceof Error ? error.message : "Provider run failed";
	return safeText(message, root);
}

function safeText(value: string, root?: string): string {
	let message = value;
	if (root) message = message.replaceAll(root, "<project>");
	return message
		.replace(
			/(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+|LOOM_[A-Z0-9_]*(?:TOKEN|KEY|SECRET)=\S+|(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*\S+)/gi,
			"[redacted]",
		)
		.slice(0, 1000);
}

function validationError(error: unknown) {
	const message = error instanceof Error ? error.message : "Invalid agent";
	const duplicate = message.includes("UNIQUE constraint failed: custom_agents");
	return {
		body: {
			error: {
				message: duplicate
					? "An agent with this label already exists in this scope"
					: message,
			},
		},
		status: duplicate ? 409 : 400,
	} as const;
}

export function createAgentSettingsRoutes(options: Options) {
	const app = new Hono();
	const db = options.db;
	async function load(id: string) {
		const agent = await db.query.customAgents.findFirst({
			where: eq(customAgents.id, id),
		});
		if (!agent) return undefined;
		const skills = await db
			.select()
			.from(customAgentSkills)
			.where(eq(customAgentSkills.agentId, id))
			.orderBy(customAgentSkills.sortOrder);
		return { ...agent, skills };
	}
	function validateRuntime(provider: string, modelId?: string | null) {
		const connection = options.providers.get(provider);
		if (connection?.status !== "connected")
			throw new Error("Selected provider is not connected");
		if (
			modelId &&
			!options.providers.catalog
				.listByProvider(provider)
				.some(
					(m) =>
						m.metadata?.modelId === modelId ||
						m.name === modelId ||
						m.id === modelId,
				) &&
			!options.providers.registry
				.require(provider)
				.definition.capabilities.includes("custom-model")
		)
			throw new Error("Selected model is not available for this provider");
	}
	app.get("/prompt-presets", async (c) => {
		try {
			const promptFiles = {
				frontend: "agents/frontend.md",
				backend: "agents/backend.md",
				fullstack: "agents/fullstack.md",
				qa: "agents/qa.md",
				pm: "agents/pm.md",
				uiux: "design/system.md",
				custom: "coding.md",
			};
			const presets = Object.fromEntries(
				await Promise.all(
					Object.entries(promptFiles).map(async ([role, file]) => [
						role,
						await readPrompt(file),
					]),
				),
			);
			return c.json(presets);
		} catch {
			return c.json(
				{ error: { message: "Unable to load built-in agent prompts" } },
				500,
			);
		}
	});
	app.get("/", async (c) => {
		const projectId = c.req.query("projectId");
		const rows = await db
			.select()
			.from(customAgents)
			.where(
				projectId
					? or(
							eq(customAgents.projectId, projectId),
							isNull(customAgents.projectId),
						)
					: undefined,
			)
			.orderBy(desc(customAgents.updatedAt));
		return c.json(await Promise.all(rows.map((a) => load(a.id))));
	});
	// Keep the static route before /:id so "runs" is not parsed as an agent ID.
	app.get("/runs", async (c) => {
		const projectId = c.req.query("projectId");
		return c.json(
			await db
				.select()
				.from(customAgentRuns)
				.where(projectId ? eq(customAgentRuns.projectId, projectId) : undefined)
				.orderBy(desc(customAgentRuns.createdAt))
				.limit(100),
		);
	});
	app.get("/:id", async (c) => {
		const agent = await load(c.req.param("id"));
		return agent
			? c.json(agent)
			: c.json({ error: { message: "Agent not found" } }, 404);
	});
	app.post("/", async (c) => {
		try {
			const input = agentInput.parse(await c.req.json());
			if (input.status === "active")
				validateRuntime(input.provider, input.modelId);
			if (input.status === "active" && input.fallbackEnabled)
				validateRuntime(input.fallbackProvider ?? "", input.fallbackModelId);
			if (input.projectId && !(await options.projects.getById(input.projectId)))
				return c.json({ error: { message: "Project not found" } }, 404);
			const id = randomUUID();
			await db.insert(customAgents).values({
				id,
				userId: "local",
				projectId: input.projectId ?? null,
				label: input.label,
				role: input.role,
				roleDescription: input.roleDescription ?? null,
				provider: input.provider,
				modelId: input.modelId ?? null,
				effort: input.effort ?? null,
				systemInstructions: input.systemInstructions,
				status: input.status,
				executionMode: input.executionMode,
				allowChat: input.allowChat,
				allowCanvas: input.allowCanvas,
				allowKanban: input.allowKanban,
				approvalPolicy: input.approvalPolicy,
				maxRunDurationMinutes: input.maxRunDurationMinutes,
				maxRetries: input.maxRetries,
				maxTaskHops: input.maxTaskHops,
				fallbackEnabled: input.fallbackEnabled,
				fallbackProvider: input.fallbackProvider ?? null,
				fallbackModelId: input.fallbackModelId ?? null,
			});
			if (input.skills.length)
				await db.insert(customAgentSkills).values(
					input.skills.map((s, i) => ({
						...s,
						id: s.id ?? randomUUID(),
						agentId: id,
						sortOrder: i,
					})),
				);
			return c.json(await load(id), 201);
		} catch (error) {
			const result = validationError(error);
			return c.json(result.body, result.status);
		}
	});
	app.put("/:id", async (c) => {
		try {
			const input = agentInput.parse(await c.req.json());
			const id = c.req.param("id");
			const current = await load(id);
			if (!current)
				return c.json({ error: { message: "Agent not found" } }, 404);
			if (input.projectId && !(await options.projects.getById(input.projectId)))
				return c.json({ error: { message: "Project not found" } }, 404);
			if (input.status === "active")
				validateRuntime(input.provider, input.modelId);
			if (input.status === "active" && input.fallbackEnabled)
				validateRuntime(input.fallbackProvider ?? "", input.fallbackModelId);
			await db
				.update(customAgents)
				.set({
					projectId: input.projectId ?? null,
					label: input.label,
					role: input.role,
					roleDescription: input.roleDescription ?? null,
					provider: input.provider,
					modelId: input.modelId ?? null,
					effort: input.effort ?? null,
					systemInstructions: input.systemInstructions,
					status: input.status,
					executionMode: input.executionMode,
					allowChat: input.allowChat,
					allowCanvas: input.allowCanvas,
					allowKanban: input.allowKanban,
					approvalPolicy: input.approvalPolicy,
					maxRunDurationMinutes: input.maxRunDurationMinutes,
					maxRetries: input.maxRetries,
					maxTaskHops: input.maxTaskHops,
					fallbackEnabled: input.fallbackEnabled,
					fallbackProvider: input.fallbackProvider ?? null,
					fallbackModelId: input.fallbackModelId ?? null,
					updatedAt: new Date(),
				})
				.where(eq(customAgents.id, id));
			await db
				.delete(customAgentSkills)
				.where(eq(customAgentSkills.agentId, id));
			if (input.skills.length)
				await db.insert(customAgentSkills).values(
					input.skills.map((s, i) => ({
						...s,
						id: s.id ?? randomUUID(),
						agentId: id,
						sortOrder: i,
					})),
				);
			return c.json(await load(id));
		} catch (error) {
			const result = validationError(error);
			return c.json(result.body, result.status);
		}
	});
	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		const exists = await load(id);
		if (!exists) return c.json({ error: { message: "Agent not found" } }, 404);
		await db.delete(customAgents).where(eq(customAgents.id, id));
		return c.body(null, 204);
	});
	app.post("/runs/chat", async (c) => {
		const body = z
			.object({
				agentId: z.string(),
				projectId: z.string(),
				taskId: z.string().optional(),
				trigger: z.enum(["chat", "kanban"]).default("chat"),
				chatSessionId: z.string().optional(),
				message: z.string().trim().min(1).max(20000),
			})
			.parse(await c.req.json());
		const agent = await load(body.agentId);
		if (!agent || agent.status !== "active")
			return c.json(
				{ error: { message: "Agent is missing or disabled" } },
				404,
			);
		if (body.trigger === "chat" ? !agent.allowChat : !agent.allowKanban)
			return c.json(
				{ error: { message: `This agent is not enabled for ${body.trigger}` } },
				403,
			);
		if (agent.approvalPolicy !== "read_only")
			return c.json(
				{
					error: {
						message:
							"Writable custom agent runs must use the Chat composer, where the provider permission flow is attached to the conversation.",
					},
				},
				409,
			);
		const project = await options.projects.getById(body.projectId);
		if (!project || (agent.projectId && agent.projectId !== body.projectId))
			return c.json(
				{ error: { message: "Agent is not available in this project" } },
				404,
			);
		let task: Awaited<ReturnType<Options["tasks"]["getById"]>>;
		if (body.taskId) {
			task = await options.tasks.getById(body.taskId);
			if (
				!task ||
				task.projectId !== body.projectId ||
				["completed", "blocked", "failed", "cancelled"].includes(task.status)
			)
				return c.json(
					{ error: { message: "Task is no longer eligible for agent work" } },
					409,
				);
		}
		try {
			validateRuntime(agent.provider, agent.modelId);
		} catch (error) {
			await db
				.update(customAgents)
				.set({ status: "needs_attention" })
				.where(eq(customAgents.id, agent.id));
			return c.json(
				{
					error: {
						message:
							error instanceof Error ? error.message : "Provider unavailable",
					},
				},
				409,
			);
		}
		const adapter = options.providers.registry.require(agent.provider);
		const runtime = adapter.getRuntime?.();
		if (!runtime)
			return c.json(
				{ error: { message: "Selected provider has no execution runtime" } },
				409,
			);
		const active = await db
			.select()
			.from(customAgentRuns)
			.where(
				and(
					eq(customAgentRuns.projectId, body.projectId),
					eq(customAgentRuns.status, "running"),
				),
			);
		if (active.length)
			return c.json(
				{
					error: {
						message: "A custom agent run is already active for this project",
					},
				},
				409,
			);
		const runId = randomUUID();
		const model = agent.modelId
			? options.providers.catalog
					.listByProvider(agent.provider)
					.find(
						(m) =>
							m.metadata?.modelId === agent.modelId ||
							m.name === agent.modelId ||
							m.id === agent.modelId,
					)
			: undefined;
		const modelId = model
			? String(model.metadata?.modelId ?? model.name)
			: undefined;
		await db.insert(customAgentRuns).values({
			id: runId,
			agentId: agent.id,
			projectId: body.projectId,
			taskId: body.taskId ?? null,
			chatSessionId: body.chatSessionId ?? null,
			provider: agent.provider,
			modelId: modelId ?? null,
			status: "queued",
			trigger: body.trigger,
			inputSummary: body.message.slice(0, 500),
		});
		await db
			.update(customAgents)
			.set({ lastUsedAt: new Date() })
			.where(eq(customAgents.id, agent.id));
		const event = async (type: string, message: string) => {
			await db.insert(customAgentRunEvents).values({
				id: randomUUID(),
				runId,
				type,
				message: message.slice(0, 1000),
			});
		};
		await event("queued", "Run queued by user");
		void (async () => {
			try {
				await db
					.update(customAgentRuns)
					.set({ status: "running", startedAt: new Date() })
					.where(eq(customAgentRuns.id, runId));
				await event(
					"started",
					`Started ${agent.provider}${modelId ? ` / ${modelId}` : " default model"}`,
				);
				const created = await runtime.createSession({
					cwd: project.path,
					title: agent.label,
					readOnly: true,
				});
				const enabledSkills = agent.skills.filter(
					(skill) => skill.enabled && skill.allowChat,
				);
				const instructions = [
					`You are ${agent.label}, a ${agent.role} agent.`,
					agent.roleDescription ?? "",
					agent.systemInstructions,
					...enabledSkills.map(
						(skill) => `## Skill: ${skill.name}\n${skill.instructions}`,
					),
					"Security: follow Loom's system permission policy. Never access paths outside the selected project. Never commit, push, merge, deploy, or delete branches without an explicit user action.",
					`Approval policy: ${agent.approvalPolicy}.`,
				]
					.filter(Boolean)
					.join("\n\n");
				const taskContext = task
					? `Kanban task: ${task.title}\n${task.description || task.prompt}\nAcceptance criteria: ${task.acceptanceCriteria}`
					: "";
				await runtime.prompt({
					sessionId: created.id,
					prompt: `${instructions}\n\n${taskContext}\n\nUser request:\n${body.message}`,
					...(model && modelId
						? { model: { providerID: model.providerId, modelID: modelId } }
						: {}),
					permission: { mode: "read-only" },
				});
				const result = await runtime.wait(created.id, {
					timeoutMs: agent.maxRunDurationMinutes * 60_000,
				});
				if (result !== "completed")
					throw new Error(
						result === "cancelled"
							? "Run cancelled"
							: ((await runtime.lastError?.(created.id)) ??
									"Provider run did not complete"),
					);
				const output = (await runtime.readOutput?.(created.id))?.output ?? "";
				const summary = safeText(output, project.path).slice(-4000);
				await db
					.update(customAgentRuns)
					.set({
						status: "completed",
						outputSummary: summary,
						finishedAt: new Date(),
					})
					.where(eq(customAgentRuns.id, runId));
				await event("completed", summary || "Agent completed");
			} catch (error) {
				const message = safeError(error, project.path);
				await db
					.update(customAgentRuns)
					.set({
						status: "failed",
						errorClass: "provider_error",
						errorMessage: message,
						finishedAt: new Date(),
					})
					.where(eq(customAgentRuns.id, runId));
				await event("failed", message);
			}
		})();
		return c.json({ runId, status: "queued" }, 202);
	});
	app.get("/runs/:id", async (c) => {
		const run = await db.query.customAgentRuns.findFirst({
			where: eq(customAgentRuns.id, c.req.param("id")),
		});
		if (!run) return c.json({ error: { message: "Agent run not found" } }, 404);
		const events = await db
			.select()
			.from(customAgentRunEvents)
			.where(eq(customAgentRunEvents.runId, run.id))
			.orderBy(customAgentRunEvents.createdAt);
		return c.json({ ...run, events });
	});
	app.post("/assignments", async (c) => {
		const input = z
			.object({
				agentId: z.string(),
				projectId: z.string(),
				taskId: z.string(),
				continuousEnabled: z.literal(false).default(false),
			})
			.parse(await c.req.json());
		const agent = await load(input.agentId);
		const task = await options.tasks.getById(input.taskId);
		if (!agent || agent.status !== "active" || !agent.allowKanban)
			return c.json(
				{ error: { message: "Active Kanban agent not found" } },
				404,
			);
		if (
			!task ||
			task.projectId !== input.projectId ||
			task.status === "completed" ||
			task.status === "blocked" ||
			!`${task.title} ${task.description ?? ""} ${task.prompt}`.trim()
		)
			return c.json(
				{
					error: {
						message:
							"Task is missing, outside the project, or cannot be assigned",
					},
				},
				400,
			);
		const id = randomUUID();
		await db.insert(customAgentAssignments).values({
			id,
			agentId: agent.id,
			projectId: input.projectId,
			taskId: input.taskId,
			continuousEnabled: false,
		});
		return c.json(
			await db.query.customAgentAssignments.findFirst({
				where: eq(customAgentAssignments.id, id),
			}),
			201,
		);
	});
	app.post("/assignments/:id/continue", async (c) => {
		const assignment = await db.query.customAgentAssignments.findFirst({
			where: eq(customAgentAssignments.id, c.req.param("id")),
		});
		if (!assignment || assignment.status !== "active" || !assignment.taskId)
			return c.json(
				{ error: { message: "Active task assignment not found" } },
				404,
			);
		const task = await options.tasks.getById(assignment.taskId);
		const agent = await load(assignment.agentId);
		if (
			!task ||
			!agent ||
			!agent.allowKanban ||
			task.projectId !== assignment.projectId ||
			["completed", "blocked", "failed", "cancelled"].includes(task.status)
		)
			return c.json(
				{ error: { message: "Task is no longer eligible for agent work" } },
				409,
			);
		let criteria: string[] = [];
		try {
			criteria = JSON.parse(task.acceptanceCriteria) as string[];
		} catch {
			/* malformed historical criteria are omitted */
		}
		const prompt = [
			"Review the assigned task and report the next implementation steps. Do not modify files from this read-only continuation.",
			`Kanban task: ${task.title}`,
			task.description || task.prompt,
			criteria.length
				? `Acceptance criteria:\n${criteria.map((s) => `- ${s}`).join("\n")}`
				: "",
		]
			.filter(Boolean)
			.join("\n\n");
		return app.request("/runs/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: agent.id,
				projectId: assignment.projectId,
				taskId: task.id,
				trigger: "kanban",
				message: prompt,
			}),
		});
	});
	return app;
}
