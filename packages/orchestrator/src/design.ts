import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildAutomationContext, type ProjectContext } from "@loom/automation";
import type {
	DesignMessageRecord,
	DesignNodeRecord,
	DesignRepository,
	ProjectRecord,
	repositories,
} from "@loom/db";
import type {
	DesignActivity,
	DesignAttachment,
	DesignChatResult,
	DesignPatch,
	DesignPermissionRequest,
	DesignViewport,
} from "@loom/protocol";
import type { AgentRuntime, RuntimeModel } from "@loom/providers/core";

type DesignPermissionGate = {
	url: string;
	store: {
		registerRun(input: {
			token: string;
			sessionId: string;
			autoAccept: boolean;
		}): void;
		unregisterRun(token: string): void;
		denySession(sessionId: string): void;
		pendingFor(sessionId: string): Array<{
			id: string;
			token: string;
			sessionId: string;
			conversationId: string;
			toolName: string;
			args: Record<string, unknown>;
			stepIdx: number;
			createdAt: number;
		}>;
		get(id: string): { sessionId: string } | undefined;
		decide(id: string, decision: "allow" | "deny"): boolean;
		enableAutoAccept(sessionId: string): void;
	};
};

import {
	buildDesignAssistantPrompt,
	buildDesignPrompt,
	buildIntentClassifierPrompt,
	buildRefinePrompt,
	chatReplyText,
	deriveDesignTitle,
	designChatSummary,
	extractDesignScreens,
	hasDesignDoc,
	isExplicitNewDesignRequest,
	looksLikeDesignRequest,
	parseDesignQuestions,
	wantsAllNodes,
} from "./design-prompt";

type Repos = ReturnType<typeof repositories>;

const DESIGN_TIMEOUT_MS = 240_000;
const CHAT_TIMEOUT_MS = 120_000;
const COLUMN_COUNT = 3;
const GAP_X = 48;
const GAP_Y = 64;
const ORIGIN_X = 48;
const ORIGIN_Y = 48;

const DESKTOP_NODE = { width: 420, height: 263 };
const MOBILE_NODE = { width: 220, height: 476 };

export function designNodeSize(viewport: DesignViewport) {
	return viewport === "mobile" ? MOBILE_NODE : DESKTOP_NODE;
}

function viewportOf(value: string): DesignViewport {
	return value === "mobile" ? "mobile" : "desktop";
}

function modelLabel(model?: RuntimeModel): string | null {
	return model ? `${model.providerID}/${model.modelID}` : null;
}

function friendlyRuntimeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/unable to reach opencode/i.test(message))
		return `${message}. Check that the selected provider runtime is available, then retry.`;
	if (
		/rejected a provider credential|auth login|invalid api key|unauthorized/i.test(
			message,
		)
	)
		return `${message}. Check authentication for the selected provider, then retry.`;
	if (/did not finish before timeout/i.test(message))
		return "The design agent took too long and was stopped. Retry with a shorter brief or a faster model.";
	return message;
}

const REFERENCE_FILE_LIMIT = 12;
const REFERENCE_PER_FILE = 12_000;
const REFERENCE_TOTAL_BUDGET = 40_000;

async function readBounded(path: string, limit: number): Promise<string> {
	const info = await stat(path);
	if (!info.isFile() || info.size === 0) return "";
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(Math.min(limit, info.size));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

/**
 * Reads the files a user @mentioned so the design agent can mirror their markup
 * and tokens. Every path is confined to the project root and bounded in size.
 */
async function referenceFilesBlock(
	projectPath: string,
	paths: string[],
): Promise<string> {
	const root = resolve(projectPath);
	const chunks: string[] = [];
	let budget = REFERENCE_TOTAL_BUDGET;
	for (const rel of paths.slice(0, REFERENCE_FILE_LIMIT)) {
		if (budget <= 0) break;
		const target = resolve(root, rel);
		const local = relative(root, target);
		if (
			!local ||
			local === ".." ||
			local.startsWith(`..${sep}`) ||
			isAbsolute(local)
		)
			continue;
		let text = "";
		try {
			text = await readBounded(target, Math.min(REFERENCE_PER_FILE, budget));
		} catch {
			continue;
		}
		if (!text.trim()) continue;
		budget -= text.length;
		chunks.push(`--- ${local.split(sep).join("/")} ---\n${text}`);
	}
	if (!chunks.length) return "";
	return `\n\nReference files from the project (match their markup, design tokens and component patterns):\n\n${chunks.join("\n\n")}`;
}

export type DesignThreadRecord = {
	nodes: DesignNodeRecord[];
	messages: DesignMessageRecord[];
};

export class DesignService {
	private readonly busy = new Map<string, Promise<unknown>>();
	/** Separate conversation sessions per project and selected provider. */
	private readonly chatSessions = new Map<
		string,
		{ id: string; runtime: AgentRuntime }
	>();
	/** Transient "what is it doing" feed per generating node (never persisted). */
	private readonly activity = new Map<string, DesignActivity>();

	constructor(
		private readonly store: DesignRepository,
		private readonly repos: Repos,
		private readonly runtime: AgentRuntime,
		private readonly providerRuntimes: Map<string, AgentRuntime> = new Map(),
		private readonly permissionGate?: DesignPermissionGate,
	) {}

	private runtimeFor(model?: RuntimeModel): AgentRuntime {
		if (!model) return this.runtime;
		return this.providerRuntimes.get(model.providerID) ?? this.runtime;
	}

	private async requireProject(projectId: string): Promise<ProjectRecord> {
		const project = await this.repos.projects.getById(projectId);
		if (!project) throw new Error("Project not found");
		return project;
	}

	private async requireNode(id: string): Promise<DesignNodeRecord> {
		const node = await this.store.getNode(id);
		if (!node) throw new Error("Design not found");
		return node;
	}

	private launch(id: string, work: () => Promise<unknown>) {
		if (this.busy.has(id))
			throw new Error("Design operation is already active");
		const job = Promise.resolve()
			.then(work)
			.catch(async (error) => {
				const message = friendlyRuntimeError(error);
				const node = await this.store.getNode(id).catch(() => null);
				if (!node || node.status === "ready") return;
				await this.store
					.updateNode(id, { status: "failed", errorMessage: message })
					.catch(() => undefined);
				await this.store
					.addMessage({
						projectId: node.projectId,
						nodeId: id,
						role: "assistant",
						text: "",
						errorMessage: message,
					})
					.catch(() => undefined);
			})
			.finally(() => {
				this.busy.delete(id);
				this.activity.delete(id);
			});
		this.busy.set(id, job);
	}

	async idle(id: string) {
		await this.busy.get(id);
	}

	private setActivity(nodeId: string, activity: DesignActivity): void {
		this.activity.set(nodeId, activity);
	}

	async getSteps(nodeId: string): Promise<DesignActivity | null> {
		const node = await this.requireNode(nodeId);
		const activity = this.activity.get(nodeId);
		if (!activity) return null;
		const permissions = node.sessionId
			? this.permissionGate?.store.pendingFor(node.sessionId).map(
					({
						id,
						toolName,
						args,
						stepIdx,
						createdAt,
					}): DesignPermissionRequest => ({
						id,
						toolName,
						args,
						stepIdx,
						createdAt,
					}),
				)
			: [];
		return { ...activity, permissions: permissions ?? [] };
	}

	async decidePermission(
		nodeId: string,
		permissionId: string,
		decision: "allow_once" | "allow" | "deny",
	): Promise<boolean> {
		const node = await this.requireNode(nodeId);
		if (!node.sessionId || !this.permissionGate) return false;
		if (
			this.permissionGate.store.get(permissionId)?.sessionId !== node.sessionId
		)
			return false;
		if (decision === "allow")
			this.permissionGate.store.enableAutoAccept(node.sessionId);
		return this.permissionGate.store.decide(
			permissionId,
			decision === "deny" ? "deny" : "allow",
		);
	}

	private async nextSlot(projectId: string) {
		const nodes = await this.store.listNodes(projectId);
		const index = nodes.length;
		const column = index % COLUMN_COUNT;
		const row = Math.floor(index / COLUMN_COUNT);
		const tallestInRows = new Map<number, number>();
		for (let position = 0; position < index; position += 1) {
			const node = nodes[position];
			if (!node) continue;
			const nodeRow = Math.floor(position / COLUMN_COUNT);
			tallestInRows.set(
				nodeRow,
				Math.max(tallestInRows.get(nodeRow) ?? 0, node.height),
			);
		}
		let y = ORIGIN_Y;
		for (let previousRow = 0; previousRow < row; previousRow += 1)
			y += (tallestInRows.get(previousRow) ?? DESKTOP_NODE.height) + GAP_Y;
		let x = ORIGIN_X;
		for (let previousColumn = 0; previousColumn < column; previousColumn += 1)
			x += DESKTOP_NODE.width + GAP_X;
		return { x, y };
	}

	async create(input: {
		projectId: string;
		brief: string;
		viewport?: DesignViewport;
		model?: RuntimeModel;
		files?: string[];
		attachments?: DesignAttachment[];
	}): Promise<{ nodeId: string; status: string }> {
		const project = await this.requireProject(input.projectId);
		const brief = input.brief.trim();
		if (!brief) throw new Error("A design brief is required");
		const viewport = input.viewport ?? "desktop";
		const size = designNodeSize(viewport);
		const slot = await this.nextSlot(project.id);
		const id = randomUUID();
		await this.store.createNode({
			id,
			projectId: project.id,
			title: deriveDesignTitle(brief),
			brief,
			viewport,
			status: "queued",
			x: slot.x,
			y: slot.y,
			width: size.width,
			height: size.height,
		});
		await this.store.addMessage({
			projectId: project.id,
			nodeId: id,
			role: "user",
			text: brief,
			model: modelLabel(input.model),
		});
		this.launch(id, () =>
			this.generate(
				id,
				project,
				input.model,
				"create",
				undefined,
				input.files,
				input.attachments,
			),
		);
		return { nodeId: id, status: "queued" };
	}

	/**
	 * A node keeps its original brief; every later user message is a refinement.
	 * The latest instruction that differs from the brief is the pending change.
	 */
	private async lastInstruction(
		node: DesignNodeRecord,
	): Promise<string | null> {
		const messages = await this.store.listMessages(node.projectId);
		const brief = node.brief.trim();
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.nodeId !== node.id || message.role !== "user") continue;
			const text = message.text.trim();
			return text && text !== brief ? text : null;
		}
		return null;
	}

	private async buildPrompt(
		node: DesignNodeRecord,
		project: ProjectRecord,
		mode: "create" | "refine",
		message?: string,
		files?: string[],
	): Promise<string> {
		const viewport = viewportOf(node.viewport);
		let prompt: string;
		const read = new Set<string>();
		if (mode === "refine" && message && node.html)
			prompt = buildRefinePrompt({
				brief: node.brief,
				message,
				viewport,
				previousHtml: node.html,
			});
		else {
			const context: ProjectContext | undefined = await buildAutomationContext(
				project.path,
				project.name,
			).catch(() => undefined);
			for (const file of context?.readFiles ?? []) read.add(file);
			prompt = buildDesignPrompt({ brief: node.brief, viewport, context });
		}
		if (files?.length) for (const file of files) read.add(file);
		this.setActivity(node.id, {
			phase: "reading",
			files: [...read].slice(0, 80),
		});
		const references = files?.length
			? await referenceFilesBlock(project.path, files)
			: "";
		return prompt + references;
	}

	/**
	 * Retrying without an explicit model reuses the one the node was drawn
	 * with, so a failed card does not silently switch provider mid-thread.
	 */
	private async storedModel(
		node: DesignNodeRecord,
	): Promise<RuntimeModel | undefined> {
		const messages = await this.store.listMessages(node.projectId);
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.nodeId !== node.id || !message.model) continue;
			const separator = message.model.indexOf("/");
			if (separator < 1) return undefined;
			return {
				providerID: message.model.slice(0, separator),
				modelID: message.model.slice(separator + 1),
			};
		}
		return undefined;
	}

	private async generate(
		nodeId: string,
		project: ProjectRecord,
		model: RuntimeModel | undefined,
		mode: "create" | "refine",
		message?: string,
		files?: string[],
		attachments?: DesignAttachment[],
	) {
		const node = await this.requireNode(nodeId);
		this.setActivity(nodeId, { phase: "reading", files: [] });
		await this.store.updateNode(nodeId, {
			status: "generating",
			errorMessage: null,
		});
		const prompt = await this.buildPrompt(node, project, mode, message, files);
		this.setActivity(nodeId, {
			phase: "drafting",
			files: this.activity.get(nodeId)?.files ?? [],
		});
		const images = (attachments ?? []).map((attachment) => ({
			mime: attachment.mime,
			data: attachment.data,
		}));
		const runtime = this.runtimeFor(model);
		// Draft the design in a temporary working directory. Agy tool calls are
		// gated through Loom's permission hook; publishing remains a separate,
		// explicit action after the user reviews the mockup.
		const workdir = join(tmpdir(), "loom-design", project.id, nodeId);
		mkdirSync(workdir, { recursive: true });
		const session = await runtime.createSession({
			cwd: workdir,
			title: `Loom design · ${node.title}`,
			readOnly: true,
		});
		await this.store.updateNode(nodeId, { sessionId: session.id });
		const selectedModel = model ?? (await this.storedModel(node));
		if (selectedModel?.providerID === "agy" && !this.permissionGate?.url)
			throw new Error(
				"Agy permission approval is unavailable. Restart Loom and check that its Agy permission hook is configured, then retry.",
			);
		const permissionToken =
			selectedModel?.providerID === "agy" && this.permissionGate?.url
				? randomUUID()
				: undefined;
		if (permissionToken && this.permissionGate)
			this.permissionGate.store.registerRun({
				token: permissionToken,
				sessionId: session.id,
				autoAccept: false,
			});
		const startedAt = Date.now();
		try {
			const reply = await this.runSession(
				runtime,
				session.id,
				prompt,
				selectedModel,
				images,
				permissionToken && this.permissionGate
					? {
							mode: "ask",
							env: {
								LOOM_PERMISSION_URL: this.permissionGate.url,
								LOOM_PERMISSION_TOKEN: permissionToken,
							},
						}
					: undefined,
			);
			await this.persist(
				nodeId,
				project,
				node,
				reply,
				mode,
				Date.now() - startedAt,
			);
		} finally {
			this.permissionGate?.store.denySession(session.id);
			if (permissionToken)
				this.permissionGate?.store.unregisterRun(permissionToken);
		}
	}

	private async runSession(
		runtime: AgentRuntime,
		sessionId: string,
		prompt: string,
		model?: RuntimeModel,
		images?: Array<{ mime: string; data: string }>,
		permission?: { mode: "auto" | "ask"; env?: Record<string, string> },
	): Promise<string> {
		await runtime.prompt({
			sessionId,
			prompt,
			model,
			images: images?.length ? images : undefined,
			permission,
		});
		const status = await runtime.wait(sessionId, {
			timeoutMs: DESIGN_TIMEOUT_MS,
		});
		if (status === "cancelled")
			throw new Error("Design generation was cancelled");
		if (status !== "completed") {
			const detail =
				status === "failed"
					? await runtime.lastError?.(sessionId).catch(() => null)
					: null;
			if (detail)
				throw new Error(
					`The design agent could not finish: ${detail}. If this model works in chat, retry with a shorter brief or a different model.`,
				);
			const hint =
				status === "failed"
					? " The agent reported an error, usually a missing or rejected provider credential."
					: "";
			throw new Error(`Design agent ended with status: ${status}.${hint}`);
		}
		const output = await runtime.readOutput?.(sessionId);
		return output?.output ?? "";
	}

	/**
	 * Writes the agent reply back to the canvas. A fresh generation may return
	 * several screens (one node each); a refinement updates the node in place so
	 * iterating on a design never spawns a duplicate card.
	 */
	private async persist(
		nodeId: string,
		project: ProjectRecord,
		node: DesignNodeRecord,
		reply: string,
		mode: "create" | "refine",
		durationMs: number,
	) {
		const screens = extractDesignScreens(reply);
		const primary = screens[0];
		if (!primary) throw new Error("Design agent returned no usable document");
		const model = await this.storedModel(node);
		await this.store.updateNode(nodeId, {
			status: "ready",
			html: primary.html,
			title: primary.title || node.title,
			errorMessage: null,
			durationMs,
		});
		if (mode === "create") {
			for (let index = 1; index < screens.length; index += 1) {
				const screen = screens[index];
				if (!screen) continue;
				const id = randomUUID();
				await this.store.createNode({
					projectId: project.id,
					id,
					title: screen.title || `${node.title} ${index + 1}`,
					brief: node.brief,
					viewport: node.viewport,
					status: "ready",
					x: node.x + index * (node.width + GAP_X),
					y: node.y,
					width: node.width,
					height: node.height,
				});
				await this.store.updateNode(id, {
					html: screen.html,
					durationMs,
				});
			}
		}
		await this.store.addMessage({
			projectId: project.id,
			nodeId,
			role: "assistant",
			text: designChatSummary(reply, screens),
			model: modelLabel(model),
			durationMs,
		});
	}

	private launchRefine(
		node: DesignNodeRecord,
		project: ProjectRecord,
		message: string,
		model: RuntimeModel | undefined,
		files?: string[],
		attachments?: DesignAttachment[],
	): void {
		void this.store.updateNode(node.id, {
			status: "queued",
			errorMessage: null,
		});
		this.launch(node.id, () =>
			this.generate(
				node.id,
				project,
				model,
				"refine",
				message,
				files,
				attachments,
			),
		);
	}

	async refine(
		nodeId: string,
		input: {
			message: string;
			model?: RuntimeModel;
			files?: string[];
			attachments?: DesignAttachment[];
		},
	): Promise<{ nodeId: string; status: string }> {
		const node = await this.requireNode(nodeId);
		if (this.busy.has(nodeId))
			throw new Error("This design is still generating");
		const project = await this.requireProject(node.projectId);
		const message = input.message.trim();
		if (!message) throw new Error("Describe what to change");

		const model = input.model ?? (await this.storedModel(node));
		await this.store.addMessage({
			projectId: project.id,
			nodeId,
			role: "user",
			text: message,
			model: modelLabel(model),
		});

		this.launchRefine(
			node,
			project,
			message,
			model,
			input.files,
			input.attachments,
		);
		return { nodeId, status: "queued" };
	}

	async retry(
		nodeId: string,
		model?: RuntimeModel,
	): Promise<{ nodeId: string; status: string }> {
		const node = await this.requireNode(nodeId);
		const project = await this.requireProject(node.projectId);
		if (this.busy.has(nodeId))
			throw new Error("This design is still generating");
		const selectedModel = model ?? (await this.storedModel(node));
		const instruction = node.html ? await this.lastInstruction(node) : null;
		const mode: "create" | "refine" =
			instruction && node.html ? "refine" : "create";
		await this.store.updateNode(nodeId, {
			status: "queued",
			errorMessage: null,
			sessionId: null,
		});
		this.launch(nodeId, () =>
			this.generate(
				nodeId,
				project,
				selectedModel,
				mode,
				instruction ?? undefined,
			),
		);
		return { nodeId, status: "queued" };
	}

	/**
	 * The design agent's conversational entry point. Every chat-panel message
	 * goes through here: a fast intent turn decides whether to answer as chat,
	 * ask a clarifying questionnaire, or kick off a canvas generation. This is
	 * what stops a plain "halo" from drawing a node.
	 */
	async chat(input: {
		projectId: string;
		message: string;
		nodeId?: string;
		model?: RuntimeModel;
		files?: string[];
		attachments?: DesignAttachment[];
	}): Promise<DesignChatResult> {
		const project = await this.requireProject(input.projectId);
		const message = input.message.trim();
		if (!message) throw new Error("A message is required");
		const target = input.nodeId
			? await this.store.getNode(input.nodeId).catch(() => null)
			: null;

		const intent =
			target?.html || isExplicitNewDesignRequest(message)
				? "design"
				: await this.classifyIntent(project, message, false, input.model);

		if (intent === "design") {
			// A change request that names the whole set ("pada keduanya", "ubah warna
			// di semua canvas") refines every ready node at once - one message, one
			// shared turn - instead of forcing the user to iterate card by card.
			const readyNodes = (await this.store.listNodes(project.id)).filter(
				(node) =>
					node.html && node.status === "ready" && !this.busy.has(node.id),
			);
			if (readyNodes.length >= 2 && wantsAllNodes(message)) {
				const primary =
					readyNodes.find((node) => node.id === target?.id) ?? readyNodes[0];
				if (primary) {
					await this.store.addMessage({
						projectId: project.id,
						nodeId: primary.id,
						role: "user",
						text: message,
						model: modelLabel(input.model),
					});
					for (const node of readyNodes) {
						const model = input.model ?? (await this.storedModel(node));
						this.launchRefine(
							node,
							project,
							message,
							model,
							input.files,
							input.attachments,
						);
					}
					return { kind: "design", nodeId: primary.id, status: "queued" };
				}
			}
			if (target?.html) {
				const refined = await this.refine(target.id, {
					message,
					model: input.model,
					files: input.files,
					attachments: input.attachments,
				});
				return { kind: "design", nodeId: refined.nodeId, status: "queued" };
			}
			const created = await this.create({
				projectId: project.id,
				brief: message,
				model: input.model,
				files: input.files,
				attachments: input.attachments,
			});
			return { kind: "design", nodeId: created.nodeId, status: "queued" };
		}

		const images = (input.attachments ?? []).map((attachment) => ({
			mime: attachment.mime,
			data: attachment.data,
		}));
		const references = input.files?.length
			? await referenceFilesBlock(project.path, input.files)
			: "";
		const reply = await this.runChatTurn(
			project,
			message + references,
			input.model,
			images,
		);

		const question = parseDesignQuestions(reply);
		if (question) {
			const note = chatReplyText(reply) || "I need a little more detail first.";
			await this.store.addMessage({
				projectId: project.id,
				nodeId: null,
				role: "user",
				text: message,
				model: modelLabel(input.model),
			});
			await this.store.addMessage({
				projectId: project.id,
				nodeId: null,
				role: "assistant",
				text: note,
				model: modelLabel(input.model),
			});
			return { kind: "question", question };
		}

		// Defensive: the classifier said chat but the model produced a design
		// anyway - honour it so the work is never lost to a misclassification.
		if (hasDesignDoc(reply)) {
			const nodeId = await this.materializeReplyAsDesign(
				project,
				message,
				reply,
				input.model,
			);
			return { kind: "design", nodeId, status: "ready" };
		}

		const text = chatReplyText(reply) || reply.trim();
		await this.store.addMessage({
			projectId: project.id,
			nodeId: null,
			role: "user",
			text: message,
			model: modelLabel(input.model),
		});
		await this.store.addMessage({
			projectId: project.id,
			nodeId: null,
			role: "assistant",
			text,
			model: modelLabel(input.model),
		});
		return { kind: "chat", text };
	}

	/** DESIGN vs CHAT. Model answer wins; regex is the safety net. */
	private async classifyIntent(
		project: ProjectRecord,
		message: string,
		hasSelectedNode: boolean,
		model?: RuntimeModel,
	): Promise<"design" | "chat"> {
		try {
			const workdir = join(tmpdir(), "loom-design", "intent", project.id);
			mkdirSync(workdir, { recursive: true });
			const runtime = this.runtimeFor(model);
			const session = await runtime.createSession({
				cwd: workdir,
				title: "Loom design intent",
				readOnly: true,
			});
			const reply = await this.runChatPrompt(
				runtime,
				session.id,
				buildIntentClassifierPrompt(message, { hasSelectedNode }),
				model,
			);
			const token = reply.toUpperCase();
			const design = /\bDESIGN\b/.test(token);
			const chat = /\bCHAT\b/.test(token);
			if (design && !chat) return "design";
			if (chat && !design) return "chat";
		} catch {
			// fall through to the heuristic
		}
		return looksLikeDesignRequest(message) ? "design" : "chat";
	}

	/** Reuses one conversation session per project and selected provider. */
	private async runChatTurn(
		project: ProjectRecord,
		userText: string,
		model: RuntimeModel | undefined,
		images: Array<{ mime: string; data: string }>,
	): Promise<string> {
		const workdir = join(tmpdir(), "loom-design", "chat", project.id);
		mkdirSync(workdir, { recursive: true });
		const runtime = this.runtimeFor(model);
		const conversationKey = `${project.id}\0${model?.providerID ?? "default"}`;
		let conversation = this.chatSessions.get(conversationKey);
		let seed = false;
		if (!conversation) {
			const created = await runtime.createSession({
				cwd: workdir,
				title: `Loom design chat \u00b7 ${project.name}`,
				readOnly: true,
			});
			conversation = { id: created.id, runtime };
			this.chatSessions.set(conversationKey, conversation);
			seed = true;
		}
		let prompt = userText;
		const isStatelessProvider = Boolean(model && runtime !== this.runtime);
		if (isStatelessProvider) {
			const context = await buildAutomationContext(
				project.path,
				project.name,
			).catch(() => undefined);
			const previous = (await this.store.listMessages(project.id))
				.filter((item) => item.nodeId === null && item.text.trim())
				.slice(-20)
				.map((item) => `${item.role}: ${item.text}`)
				.join("\n\n");
			prompt = `${buildDesignAssistantPrompt({
				context,
				projectName: project.name,
				projectPath: project.path,
			})}\n\n${previous ? `Conversation so far:\n${previous}\n\n` : ""}User message:\n${userText}`;
		} else if (seed) {
			const context = await buildAutomationContext(
				project.path,
				project.name,
			).catch(() => undefined);
			prompt = `${buildDesignAssistantPrompt({
				context,
				projectName: project.name,
				projectPath: project.path,
			})}\n\nUser message:\n${userText}`;
		}
		return this.runChatPrompt(
			conversation.runtime,
			conversation.id,
			prompt,
			model,
			images,
		);
	}

	/** One blocking assistant turn; returns raw text without requiring HTML. */
	private async runChatPrompt(
		runtime: AgentRuntime,
		sessionId: string,
		prompt: string,
		model?: RuntimeModel,
		images?: Array<{ mime: string; data: string }>,
	): Promise<string> {
		await runtime.prompt({
			sessionId,
			prompt,
			model,
			images: images?.length ? images : undefined,
		});
		const status = await runtime.wait(sessionId, {
			timeoutMs: CHAT_TIMEOUT_MS,
		});
		if (status === "cancelled")
			throw new Error("The design agent was cancelled.");
		if (status !== "completed") {
			const detail =
				status === "failed"
					? await runtime.lastError?.(sessionId).catch(() => null)
					: null;
			throw new Error(
				detail
					? `The design agent could not answer: ${detail}`
					: `Design agent ended with status: ${status}.`,
			);
		}
		const output = await runtime.readOutput?.(sessionId);
		return output?.output ?? "";
	}

	/** Turns an unexpected design doc in a chat reply into ready canvas node(s). */
	private async materializeReplyAsDesign(
		project: ProjectRecord,
		brief: string,
		reply: string,
		model?: RuntimeModel,
	): Promise<string> {
		const screens = extractDesignScreens(reply);
		const primary = screens[0];
		if (!primary) throw new Error("Design agent returned no usable document");
		const size = designNodeSize("desktop");
		const slot = await this.nextSlot(project.id);
		const id = randomUUID();
		await this.store.createNode({
			id,
			projectId: project.id,
			title: primary.title || deriveDesignTitle(brief),
			brief,
			viewport: "desktop",
			status: "ready",
			x: slot.x,
			y: slot.y,
			width: size.width,
			height: size.height,
		});
		await this.store.updateNode(id, { html: primary.html });
		for (let index = 1; index < screens.length; index += 1) {
			const screen = screens[index];
			if (!screen) continue;
			const extra = randomUUID();
			await this.store.createNode({
				id: extra,
				projectId: project.id,
				title: screen.title || `${primary.title} ${index + 1}`,
				brief,
				viewport: "desktop",
				status: "ready",
				x: slot.x + index * (size.width + GAP_X),
				y: slot.y,
				width: size.width,
				height: size.height,
			});
			await this.store.updateNode(extra, { html: screen.html });
		}
		await this.store.addMessage({
			projectId: project.id,
			nodeId: id,
			role: "user",
			text: brief,
			model: modelLabel(model),
		});
		await this.store.addMessage({
			projectId: project.id,
			nodeId: id,
			role: "assistant",
			text: designChatSummary(reply, screens),
			model: modelLabel(model),
		});
		return id;
	}

	async list(projectId: string): Promise<DesignThreadRecord> {
		await this.requireProject(projectId);
		return {
			nodes: await this.store.listNodes(projectId),
			messages: await this.store.listMessages(projectId),
		};
	}

	async detail(nodeId: string): Promise<DesignNodeRecord> {
		return this.requireNode(nodeId);
	}

	async save(nodeId: string, patch: DesignPatch): Promise<DesignNodeRecord> {
		const node = await this.requireNode(nodeId);
		const input: Partial<DesignNodeRecord> = {};
		if (patch.title !== undefined) input.title = patch.title;
		if (patch.viewport !== undefined) {
			input.viewport = patch.viewport;
			const size = designNodeSize(patch.viewport);
			input.width = size.width;
			input.height = size.height;
		}
		if (patch.x !== undefined) input.x = patch.x;
		if (patch.y !== undefined) input.y = patch.y;
		if (patch.width !== undefined) input.width = patch.width;
		if (patch.height !== undefined) input.height = patch.height;
		await this.store.updateNode(nodeId, input);
		const updated = await this.requireNode(node.id);
		return updated;
	}

	async remove(nodeId: string): Promise<void> {
		await this.requireNode(nodeId);
		if (this.busy.has(nodeId))
			throw new Error("This design is still generating");
		await this.store.deleteNode(nodeId);
	}

	async clear(projectId: string): Promise<void> {
		await this.requireProject(projectId);
		const nodes = await this.store.listNodes(projectId);
		for (const node of nodes) {
			const model = await this.storedModel(node);
			await this.runtimeFor(model)
				.abort(node.sessionId ?? "")
				.catch(() => undefined);
		}
		const conversationPrefix = `${projectId}\0`;
		for (const [key, conversation] of this.chatSessions) {
			if (!key.startsWith(conversationPrefix)) continue;
			await conversation.runtime.abort(conversation.id).catch(() => undefined);
			this.chatSessions.delete(key);
		}
		await this.store.clearProject(projectId);
	}

	/** A daemon restart kills in-flight agent sessions; surface that as a retryable failure. */
	async recover(): Promise<void> {
		const pending = await this.store.listPendingNodes();
		const orphaned = pending.filter((node) => !this.busy.has(node.id));
		if (!orphaned.length) return;
		for (const node of orphaned) {
			await this.store
				.addMessage({
					projectId: node.projectId,
					nodeId: node.id,
					role: "assistant",
					text: "",
					errorMessage: "Design generation was interrupted by a restart.",
				})
				.catch(() => undefined);
		}
		await this.store.markInterrupted(orphaned.map((node) => node.id));
	}
}

export {
	buildDesignPrompt,
	buildRefinePrompt,
	deriveDesignTitle,
	extractDesignHtml,
} from "./design-prompt";
