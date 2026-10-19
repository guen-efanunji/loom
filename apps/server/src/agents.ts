import { randomUUID } from "node:crypto";
import type { Database } from "@loom/db";
import {
	and,
	customAgentAssignmentRuns,
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
		update(id: string, input: { executorConfig: string }): Promise<unknown>;
	};
	startTask(taskId: string): Promise<void>;
	enqueueAndWait(taskId: string): Promise<void>;
	retryTask(taskId: string): Promise<void>;
	cancelTask(taskId: string): Promise<void>;
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
		if (agent?.status !== "active")
			return c.json(
				{ error: { message: "Agent is missing or disabled" } },
				404,
			);
		const surfaceAllowed =
			body.trigger === "kanban" ? agent.allowKanban : agent.allowChat;
		if (!surfaceAllowed)
			return c.json(
				{ error: { message: `Agent is not enabled for ${body.trigger}` } },
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
			: agent.modelId &&
					options.providers.registry
						.require(agent.provider)
						.definition.capabilities.includes("custom-model")
				? agent.modelId
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
					(skill) =>
						skill.enabled &&
						(body.trigger === "kanban" ? skill.allowKanban : skill.allowChat),
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
					...(modelId
						? {
								model: {
									providerID: model?.providerId ?? adapter.definition.id,
									modelID: modelId,
								},
							}
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
				continuousEnabled: z.boolean().default(false),
			})
			.parse(await c.req.json());
		const agent = await load(input.agentId);
		const task = await options.tasks.getById(input.taskId);
		if (agent?.status !== "active")
			return c.json({ error: { message: "Active agent not found" } }, 404);
		if (!agent.allowKanban)
			return c.json(
				{ error: { message: "Agent is not enabled for Kanban" } },
				403,
			);
		if (input.continuousEnabled && agent.executionMode !== "continuous_kanban")
			return c.json(
				{
					error: {
						message:
							"Enable continuous Kanban mode in the agent settings first",
					},
				},
				409,
			);
		if (
			!task ||
			task.projectId !== input.projectId ||
			task.status === "completed" ||
			task.status === "blocked" ||
			["preparing", "running"].includes(task.status) ||
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
		await options.tasks.update(task.id, {
			executorConfig: JSON.stringify({ kind: "agent", agentId: agent.id }),
		});
		await db.insert(customAgentAssignments).values({
			id,
			agentId: agent.id,
			projectId: input.projectId,
			taskId: input.taskId,
			continuousEnabled: input.continuousEnabled,
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
		if (assignment?.status !== "active" || !assignment.taskId)
			return c.json(
				{ error: { message: "Active task assignment not found" } },
				404,
			);
		const seedTaskId = assignment.taskId;
		const parsedInput = z
			.object({
				taskIds: z.array(z.string().min(1)).min(1).max(20).optional(),
				maxTasks: z.number().int().min(1).max(20).default(1),
				concurrency: z.number().int().min(1).max(3).default(1),
				durationMinutes: z.number().int().min(1).max(120).default(30),
				maxRetries: z.number().int().min(0).max(2).default(0),
				idempotencyKey: z.string().trim().min(8).max(128).optional(),
			})
			.safeParse(await c.req.json().catch(() => ({})));
		if (!parsedInput.success) {
			const result = validationError(parsedInput.error);
			return c.json(result.body, result.status);
		}
		const input = parsedInput.data;
		const requestedTaskIds = input.taskIds ?? [seedTaskId];
		const idempotencyKey =
			input.idempotencyKey ?? c.req.header("Idempotency-Key") ?? randomUUID();
		const existing = await db.query.customAgentAssignmentRuns.findFirst({
			where: and(
				eq(customAgentAssignmentRuns.assignmentId, assignment.id),
				eq(customAgentAssignmentRuns.idempotencyKey, idempotencyKey),
			),
		});
		if (
			existing &&
			(existing.taskIdsJson !==
				JSON.stringify(requestedTaskIds.slice(0, input.maxTasks)) ||
				existing.maxTasks !== input.maxTasks ||
				existing.concurrency !== input.concurrency ||
				existing.durationMs !== input.durationMinutes * 60_000)
		)
			return c.json(
				{
					error: {
						message:
							"Idempotency key was already used for a different assignment request",
					},
				},
				409,
			);
		if (existing)
			return c.json(existing, existing.status === "queued" ? 202 : 200);
		const agent = await load(assignment.agentId);
		if (agent?.status !== "active" || !agent.allowKanban)
			return c.json(
				{ error: { message: "Agent is disabled or unavailable" } },
				409,
			);
		if (input.maxTasks > (input.taskIds?.length ?? 1))
			return c.json(
				{
					error: {
						message: "maxTasks cannot exceed the explicitly selected task list",
					},
				},
				400,
			);
		if (input.concurrency > input.maxTasks)
			return c.json(
				{ error: { message: "concurrency cannot exceed maxTasks" } },
				400,
			);
		if (input.maxRetries > 0 && !assignment.continuousEnabled)
			return c.json(
				{
					error: { message: "Retries require an opt-in continuous assignment" },
				},
				409,
			);
		if (
			assignment.continuousEnabled &&
			agent.executionMode !== "continuous_kanban"
		)
			return c.json(
				{
					error: {
						message: "Agent is no longer configured for continuous Kanban",
					},
				},
				409,
			);
		const taskIds = requestedTaskIds;
		if (new Set(taskIds).size !== taskIds.length)
			return c.json(
				{ error: { message: "Task list must not contain duplicates" } },
				400,
			);
		for (const taskId of taskIds) {
			const task = await options.tasks.getById(taskId);
			if (
				!task ||
				task.projectId !== assignment.projectId ||
				[
					"completed",
					"blocked",
					"cancelled",
					"preparing",
					"running",
					"ready_to_merge",
					"merge_conflict",
				].includes(task.status)
			)
				return c.json(
					{
						error: {
							message: `Task ${taskId} is outside the assignment scope or is not eligible`,
						},
					},
					409,
				);
		}
		const activeRun = await db.query.customAgentAssignmentRuns.findFirst({
			where: and(
				eq(customAgentAssignmentRuns.assignmentId, assignment.id),
				or(
					eq(customAgentAssignmentRuns.status, "queued"),
					eq(customAgentAssignmentRuns.status, "running"),
					eq(customAgentAssignmentRuns.status, "cancel_requested"),
				),
			),
		});
		if (activeRun)
			return c.json(
				{
					error: {
						message: "This assignment already has an active bounded run",
					},
				},
				409,
			);
		const runId = randomUUID();
		try {
			await db.insert(customAgentAssignmentRuns).values({
				id: runId,
				assignmentId: assignment.id,
				idempotencyKey,
				taskIdsJson: JSON.stringify(taskIds.slice(0, input.maxTasks)),
				maxTasks: input.maxTasks,
				concurrency: input.concurrency,
				durationMs: input.durationMinutes * 60_000,
			});
		} catch {
			const duplicate = await db.query.customAgentAssignmentRuns.findFirst({
				where: and(
					eq(customAgentAssignmentRuns.assignmentId, assignment.id),
					eq(customAgentAssignmentRuns.idempotencyKey, idempotencyKey),
				),
			});
			if (duplicate) return c.json(duplicate, 202);
			return c.json(
				{
					error: {
						message: "This assignment already has an active bounded run",
					},
				},
				409,
			);
		}
		const updateRun = async (
			patch: Partial<typeof customAgentAssignmentRuns.$inferInsert>,
		) => {
			await db
				.update(customAgentAssignmentRuns)
				.set(patch)
				.where(eq(customAgentAssignmentRuns.id, runId));
		};
		void (async () => {
			const startedAt = Date.now();
			let next = 0;
			let completedTasks = 0;
			let stopScheduling = false;
			let failure: string | undefined;
			const claimed = new Set<string>();
			await db
				.update(customAgentAssignmentRuns)
				.set({ status: "running", startedAt: new Date() })
				.where(
					and(
						eq(customAgentAssignmentRuns.id, runId),
						eq(customAgentAssignmentRuns.status, "queued"),
					),
				);
			const initialRun = await db.query.customAgentAssignmentRuns.findFirst({
				where: eq(customAgentAssignmentRuns.id, runId),
			});
			if (initialRun?.status === "cancel_requested") {
				await updateRun({
					status: "cancelled",
					currentTaskIdsJson: "[]",
					finishedAt: new Date(),
				});
				return;
			}
			const worker = async () => {
				while (
					!stopScheduling &&
					next < Math.min(input.maxTasks, taskIds.length)
				) {
					const runState = await db.query.customAgentAssignmentRuns.findFirst({
						where: eq(customAgentAssignmentRuns.id, runId),
					});
					if (runState?.status === "cancel_requested") {
						stopScheduling = true;
						return;
					}
					if (Date.now() - startedAt >= input.durationMinutes * 60_000) {
						failure = "Continuous assignment reached its duration limit";
						stopScheduling = true;
						return;
					}
					const taskId = taskIds[next++];
					if (!taskId) return;
					const task = await options.tasks.getById(taskId);
					const currentAgent = await load(assignment.agentId);
					if (currentAgent?.status !== "active" || !currentAgent.allowKanban) {
						stopScheduling = true;
						failure = "Agent was disabled; no additional tasks were started";
						return;
					}
					if (
						!task ||
						task.projectId !== assignment.projectId ||
						[
							"completed",
							"blocked",
							"cancelled",
							"preparing",
							"running",
							"ready_to_merge",
							"merge_conflict",
						].includes(task.status)
					) {
						failure = `Task ${taskId} became ineligible before it was claimed`;
						stopScheduling = true;
						return;
					}
					claimed.add(taskId);
					await updateRun({ currentTaskIdsJson: JSON.stringify([...claimed]) });
					await options.tasks.update(taskId, {
						executorConfig: JSON.stringify({
							kind: "agent",
							agentId: agent.id,
						}),
					});
					let attempts = 0;
					while (true) {
						const latest = await options.tasks.getById(taskId);
						if (!latest)
							throw new Error("Task disappeared during continuous assignment");
						if (latest.status === "failed" && attempts >= input.maxRetries)
							throw new Error("Task failed; retry limit exhausted");
						const retrying = latest.status === "failed";
						if (retrying) attempts++;
						const execution = retrying
							? options.retryTask(taskId)
							: options.enqueueAndWait(taskId);
						const remainingMs = Math.max(
							0,
							input.durationMinutes * 60_000 - (Date.now() - startedAt),
						);
						let timeout: ReturnType<typeof setTimeout> | undefined;
						try {
							await Promise.race([
								execution,
								new Promise<never>((_, reject) => {
									timeout = setTimeout(
										() =>
											reject(
												new Error(
													"Continuous assignment duration limit reached",
												),
											),
										remainingMs,
									);
								}),
							]);
						} catch (error) {
							if (Date.now() - startedAt >= input.durationMinutes * 60_000) {
								stopScheduling = true;
								failure = "Continuous assignment reached its duration limit";
								await options.cancelTask(taskId);
								await execution.catch(() => {});
								claimed.delete(taskId);
								await updateRun({
									currentTaskIdsJson: JSON.stringify([...claimed]),
								});
							}
							throw error;
						} finally {
							if (timeout) clearTimeout(timeout);
						}
						const fresh = await options.tasks.getById(taskId);
						if (fresh?.status === "failed") {
							if (attempts < input.maxRetries) continue;
							throw new Error("Task failed; retry limit exhausted");
						}
						break;
					}
					const finished = await options.tasks.getById(taskId);
					claimed.delete(taskId);
					completedTasks++;
					await updateRun({
						completedTasks,
						currentTaskIdsJson: JSON.stringify([...claimed]),
					});
					if (
						finished?.status === "ready_to_merge" ||
						finished?.status === "merge_conflict" ||
						finished?.status === "blocked"
					) {
						stopScheduling = true;
						failure =
							finished.status === "ready_to_merge"
								? "Paused for the required review and integration gates"
								: `Paused because task ${taskId} is ${finished.status}`;
					}
				}
			};
			try {
				await Promise.all(
					Array.from({ length: input.concurrency }, () => worker()),
				);
				const cancelled =
					(
						await db.query.customAgentAssignmentRuns.findFirst({
							where: eq(customAgentAssignmentRuns.id, runId),
						})
					)?.status === "cancel_requested";
				await updateRun({
					status: cancelled ? "cancelled" : failure ? "paused" : "completed",
					errorMessage: failure ?? null,
					currentTaskIdsJson: "[]",
					finishedAt: new Date(),
				});
			} catch (error) {
				await updateRun({
					status: failure ? "paused" : "failed",
					errorMessage:
						failure ??
						(error instanceof Error
							? safeError(error)
							: "Continuous assignment failed"),
					currentTaskIdsJson: JSON.stringify([...claimed]),
					finishedAt: new Date(),
				});
			}
		})();
		return c.json(
			{
				id: runId,
				assignmentId: assignment.id,
				status: "queued",
				taskIds: taskIds.slice(0, input.maxTasks),
			},
			202,
		);
	});
	app.get("/assignments/:id/runs", async (c) => {
		const assignment = await db.query.customAgentAssignments.findFirst({
			where: eq(customAgentAssignments.id, c.req.param("id")),
		});
		if (!assignment)
			return c.json({ error: { message: "Assignment not found" } }, 404);
		return c.json(
			await db
				.select()
				.from(customAgentAssignmentRuns)
				.where(eq(customAgentAssignmentRuns.assignmentId, assignment.id))
				.orderBy(desc(customAgentAssignmentRuns.createdAt))
				.limit(50),
		);
	});
	app.post("/assignments/:id/cancel", async (c) => {
		const assignment = await db.query.customAgentAssignments.findFirst({
			where: eq(customAgentAssignments.id, c.req.param("id")),
		});
		if (!assignment)
			return c.json({ error: { message: "Assignment not found" } }, 404);
		const run = await db.query.customAgentAssignmentRuns.findFirst({
			where: and(
				eq(customAgentAssignmentRuns.assignmentId, assignment.id),
				or(
					eq(customAgentAssignmentRuns.status, "queued"),
					eq(customAgentAssignmentRuns.status, "running"),
				),
			),
		});
		if (!run)
			return c.json({ error: { message: "No active assignment run" } }, 409);
		await db
			.update(customAgentAssignmentRuns)
			.set({ status: "cancel_requested" })
			.where(eq(customAgentAssignmentRuns.id, run.id));
		for (const taskId of JSON.parse(run.currentTaskIdsJson) as string[])
			await options.cancelTask(taskId);
		return c.json({
			accepted: true,
			runId: run.id,
			cancelledTaskIds: JSON.parse(run.currentTaskIdsJson),
		});
	});
	return app;
}
