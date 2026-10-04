import { randomUUID } from "node:crypto";
import { buildAutomationContext, type ProjectContext } from "@loom/automation";
import type {
	DesignMessageRecord,
	DesignNodeRecord,
	DesignRepository,
	ProjectRecord,
	repositories,
} from "@loom/db";
import type { AgentModel, AgentRuntime } from "@loom/opencode";
import type { DesignPatch, DesignViewport } from "@loom/protocol";
import {
	buildDesignPrompt,
	buildRefinePrompt,
	deriveDesignTitle,
	extractDesignHtml,
} from "./design-prompt";

type Repos = ReturnType<typeof repositories>;

const DESIGN_TIMEOUT_MS = 240_000;
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

function modelLabel(model?: AgentModel): string | null {
	return model ? `${model.providerID}/${model.modelID}` : null;
}

function friendlyRuntimeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/unable to reach opencode/i.test(message))
		return `${message}. The OpenCode server is not running — start Loom with \`loom\` (or restart the daemon) and try again.`;
	if (
		/rejected a provider credential|auth login|invalid api key|unauthorized/i.test(
			message,
		)
	)
		return `${message}. Configure a working provider with \`opencode auth login\`, then retry.`;
	if (/did not finish before timeout/i.test(message))
		return "The design agent took too long and was stopped. Retry with a shorter brief or a faster model.";
	return message;
}

export type DesignThreadRecord = {
	nodes: DesignNodeRecord[];
	messages: DesignMessageRecord[];
};

export class DesignService {
	private readonly busy = new Map<string, Promise<unknown>>();

	constructor(
		private readonly store: DesignRepository,
		private readonly repos: Repos,
		private readonly runtime: AgentRuntime,
	) {}

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
			});
		this.busy.set(id, job);
	}

	async idle(id: string) {
		await this.busy.get(id);
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
		model?: AgentModel;
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
		this.launch(id, () => this.generate(id, project, input.model));
		return { nodeId: id, status: "queued" };
	}

	private async rootBrief(node: DesignNodeRecord): Promise<string> {
		let current = node;
		const seen = new Set<string>([current.id]);
		while (current.parentId) {
			if (seen.has(current.parentId)) break;
			const parent = await this.store
				.getNode(current.parentId)
				.catch(() => null);
			if (!parent) break;
			seen.add(parent.id);
			current = parent;
		}
		return current.brief;
	}

	/**
	 * A node with a parent is a refinement: the prompt carries the previous
	 * document so the agent edits it instead of designing from scratch.
	 */
	private async promptFor(
		node: DesignNodeRecord,
		project: ProjectRecord,
	): Promise<string> {
		const viewport = viewportOf(node.viewport);
		const parent = node.parentId
			? await this.store.getNode(node.parentId).catch(() => null)
			: null;
		if (parent?.html)
			return buildRefinePrompt({
				brief: await this.rootBrief(node),
				message: node.brief,
				viewport,
				previousHtml: parent.html,
			});
		const context: ProjectContext | undefined = await buildAutomationContext(
			project.path,
			project.name,
		).catch(() => undefined);
		return buildDesignPrompt({ brief: node.brief, viewport, context });
	}

	/**
	 * Retrying without an explicit model reuses the one the node was drawn
	 * with, so a failed card does not silently switch provider mid-thread.
	 */
	private async storedModel(
		node: DesignNodeRecord,
	): Promise<AgentModel | undefined> {
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
		model?: AgentModel,
	) {
		const node = await this.requireNode(nodeId);
		await this.store.updateNode(nodeId, {
			status: "generating",
			errorMessage: null,
		});
		const prompt = await this.promptFor(node, project);
		const session = await this.runtime.createSession({
			cwd: project.path,
			title: `Loom design · ${node.title}`,
			readOnly: true,
		});
		await this.store.updateNode(nodeId, { sessionId: session.id });
		await this.render(
			nodeId,
			project,
			session.id,
			prompt,
			model ?? (await this.storedModel(node)),
		);
	}

	private async render(
		nodeId: string,
		project: ProjectRecord,
		sessionId: string,
		prompt: string,
		model?: AgentModel,
	) {
		const startedAt = Date.now();
		await this.runtime.prompt({ sessionId, prompt, model });
		const status = await this.runtime.wait(sessionId, {
			timeoutMs: DESIGN_TIMEOUT_MS,
		});
		if (status === "cancelled")
			throw new Error("Design generation was cancelled");
		if (status !== "completed") {
			const hint =
				status === "failed"
					? " The agent reported an error, usually a missing or rejected provider credential."
					: "";
			throw new Error(`Design agent ended with status: ${status}.${hint}`);
		}
		const output = await this.runtime.readOutput?.(sessionId);
		const html = extractDesignHtml(output?.output ?? "");
		const durationMs = Date.now() - startedAt;
		await this.store.updateNode(nodeId, {
			status: "ready",
			html,
			errorMessage: null,
			durationMs,
		});
		await this.store.addMessage({
			projectId: project.id,
			nodeId,
			role: "assistant",
			text: "Design is ready on the canvas.",
			model: modelLabel(model),
			durationMs,
		});
	}

	async refine(
		nodeId: string,
		input: { message: string; model?: AgentModel },
	): Promise<{ nodeId: string; status: string }> {
		const parent = await this.requireNode(nodeId);
		if (this.busy.has(nodeId))
			throw new Error("This design is still generating");
		const project = await this.requireProject(parent.projectId);
		const message = input.message.trim();
		if (!message) throw new Error("Describe what to change");
		const viewport = viewportOf(parent.viewport);
		const size = designNodeSize(viewport);
		// A refinement keeps the parent's model unless the caller picks another.
		const model = input.model ?? (await this.storedModel(parent));
		const id = randomUUID();
		await this.store.createNode({
			id,
			projectId: project.id,
			title: parent.title,
			brief: message,
			viewport,
			parentId: parent.id,
			status: "queued",
			x: parent.x + parent.width + GAP_X,
			y: parent.y,
			width: size.width,
			height: size.height,
		});
		await this.store.addMessage({
			projectId: project.id,
			nodeId: id,
			role: "user",
			text: message,
			model: modelLabel(model),
		});
		this.launch(id, () => this.generate(id, project, model));
		return { nodeId: id, status: "queued" };
	}

	async retry(
		nodeId: string,
		model?: AgentModel,
	): Promise<{ nodeId: string; status: string }> {
		const node = await this.requireNode(nodeId);
		const project = await this.requireProject(node.projectId);
		if (this.busy.has(nodeId))
			throw new Error("This design is still generating");
		await this.store.updateNode(nodeId, {
			status: "queued",
			errorMessage: null,
			sessionId: null,
		});
		this.launch(nodeId, () => this.generate(nodeId, project, model));
		return { nodeId, status: "queued" };
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
		for (const node of nodes)
			await this.runtime.abort(node.sessionId ?? "").catch(() => undefined);
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
