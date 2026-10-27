import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildDesignFileContext, type ProjectContext } from "@loom/automation";
import type {
	DesignMessageRecord,
	DesignNodeRecord,
	DesignRepository,
	ProjectRecord,
	repositories,
} from "@loom/db";
import {
	type DesignActivity,
	type DesignAttachment,
	type DesignChatResult,
	DEFAULT_DESIGN_FRAME,
	DESIGN_FRAME_MIN,
	type DesignFrame,
	type DesignPatch,
	type DesignPermissionRequest,
	type DesignTrace,
	designFrameKindSchema,
	type DesignViewport,
	viewportOfFrame,
} from "@loom/protocol";
import type {
	AgentRuntime,
	RuntimeModel,
	RuntimePermission,
	RuntimeOutput,
	RuntimeToolAuthorization,
} from "@loom/providers/core";

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
		submit(
			input: {
				token: string;
				conversationId: string;
				toolName: string;
				args: Record<string, unknown>;
				stepIdx: number;
			},
			timeoutMs: number,
		):
			| { status: "unknown" | "auto" }
			| { status: "pending"; decision: Promise<"allow" | "deny"> };
	};
};

import {
	buildDesignAssistantPrompt,
	buildDesignPrompt,
	buildIntentClassifierPrompt,
	buildRefinePrompt,
	chatReplyText,
	DesignOutputError,
	deriveDesignTitle,
	designChatSummary,
	designReferencePaths,
	extractDesignScreens,
	hasDesignDoc,
	isExplicitNewDesignRequest,
	looksLikeDesignRequest,
	parseDesignQuestions,
	wantsAllNodes,
} from "./design-prompt";
import {
	designNodeSizeForFrame,
	designSpaceWidth,
	frameFromMention,
	frameFromReferences,
	frameHintBlock,
	frameOfKind,
	frameReferenceHints,
	imageDimensions,
	mentionsCanvasSize,
	usesDesignSpaceUnit,
} from "./design-frame";

type Repos = ReturnType<typeof repositories>;

const DESIGN_TIMEOUT_MS = 240_000;
const CHAT_TIMEOUT_MS = 120_000;
const COLUMN_COUNT = 3;
const GAP_X = 48;
const GAP_Y = 64;
const ORIGIN_X = 48;
const ORIGIN_Y = 48;

const DESKTOP_NODE = { width: 420, height: 263 };

/** Frames implied by the old two-value viewport column on legacy rows. */
const LEGACY_FRAME: Record<DesignViewport, { width: number; height: number }> =
	{
		desktop: { width: 1440, height: 900 },
		mobile: { width: 390, height: 844 },
	};

/**
 * The design space a node was drawn for. Records created before flexible
 * frames only carry `viewport`, so their size falls back to those two presets.
 */
export function frameOfRecord(node: {
	viewport: string;
	frameKind?: string | null;
	frameWidth?: number | null;
	frameHeight?: number | null;
}): DesignFrame {
	const parsed = designFrameKindSchema.safeParse(node.frameKind);
	const kind = parsed.success
		? parsed.data
		: node.viewport === "mobile"
			? "mobile"
			: "desktop";
	const width = node.frameWidth ?? 0;
	const height = node.frameHeight ?? 0;
	if (width >= DESIGN_FRAME_MIN && height >= DESIGN_FRAME_MIN)
		return { kind, width, height };
	return {
		kind,
		...LEGACY_FRAME[node.viewport === "mobile" ? "mobile" : "desktop"],
	};
}

export function designNodeSize(frame: DesignFrame) {
	return designNodeSizeForFrame(frame);
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
const ATTACHMENT_TEXT_LIMIT = 12_000;
const ATTACHMENT_TEXT_BUDGET = 40_000;
const REFERENCE_IMAGE_LIMIT = 8_000_000;

function isTextAttachment(attachment: DesignAttachment): boolean {
	if (attachment.mime.startsWith("text/")) return true;
	if (
		/^(application\/(json|xml|javascript|typescript|x-sh|yaml)|image\/svg\+xml)$/i.test(
			attachment.mime,
		)
	)
		return true;
	return /\.(txt|md|mdx|json|ya?ml|xml|html?|css|[cm]?[jt]sx?|svelte|vue|svg|sh|sql|toml|ini|csv)$/i.test(
		attachment.filename,
	);
}

function attachmentReferencesBlock(
	attachments: DesignAttachment[] = [],
): string {
	let budget = ATTACHMENT_TEXT_BUDGET;
	const chunks: string[] = [];
	const images: string[] = [];
	for (const attachment of attachments) {
		if (attachment.mime.startsWith("image/")) {
			images.push(attachment.filename);
			continue;
		}
		if (!isTextAttachment(attachment) || budget <= 0) continue;
		let content = "";
		try {
			content = Buffer.from(attachment.data, "base64")
				.toString("utf8")
				.slice(0, Math.min(ATTACHMENT_TEXT_LIMIT, budget));
		} catch {
			continue;
		}
		if (!content.trim()) continue;
		budget -= content.length;
		chunks.push(`--- attached file: ${attachment.filename} ---\n${content}`);
	}
	const parts: string[] = [];
	if (chunks.length)
		parts.push(
			`Attached text files (use their actual contents as design references):\n\n${chunks.join("\n\n")}`,
		);
	if (images.length)
		parts.push(
			`Attached images (provided to you as visual inputs): ${images.join(", ")}. Inspect their layout, colors, typography, and flow and use them as references for this design.`,
		);
	return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

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
): Promise<{
	block: string;
	images: Array<{ mime: string; data: string; filename: string }>;
	files: string[];
	imageSizes: Array<{ filename: string; width: number; height: number }>;
	styles: Array<{ filename: string; text: string }>;
}> {
	const root = resolve(projectPath);
	const chunks: string[] = [];
	const images: Array<{ mime: string; data: string; filename: string }> = [];
	const files: string[] = [];
	const imageSizes: Array<{ filename: string; width: number; height: number }> =
		[];
	const styles: Array<{ filename: string; text: string }> = [];
	let budget = REFERENCE_TOTAL_BUDGET;
	const pending = [...paths];
	const visited = new Set<string>();
	while (pending.length && visited.size < REFERENCE_FILE_LIMIT && budget > 0) {
		const rel = pending.shift();
		if (!rel || visited.has(rel)) continue;
		visited.add(rel);
		const target = resolve(root, rel);
		const local = relative(root, target);
		if (
			!local ||
			local === ".." ||
			local.startsWith(`..${sep}`) ||
			isAbsolute(local)
		)
			continue;
		const info = await stat(target).catch(() => null);
		if (!info) continue;
		if (info.isDirectory()) {
			try {
				const entries = await readdir(target, { withFileTypes: true });
				for (const entry of entries.sort((a, b) =>
					a.name.localeCompare(b.name),
				)) {
					if (entry.name.startsWith(".")) continue;
					if (entry.isDirectory()) pending.push(join(rel, entry.name));
					else if (entry.isFile()) pending.push(join(rel, entry.name));
					if (pending.length + visited.size >= REFERENCE_FILE_LIMIT) break;
				}
			} catch {}
			continue;
		}
		if (!info.isFile()) continue;
		const extension = extname(local).toLowerCase();
		const imageMime: Record<string, string> = {
			".avif": "image/avif",
			".bmp": "image/bmp",
			".gif": "image/gif",
			".jpeg": "image/jpeg",
			".jpg": "image/jpeg",
			".png": "image/png",
			".webp": "image/webp",
		};
		const imageMimeType = imageMime[extension];
		if (imageMimeType) {
			if (info.size <= REFERENCE_IMAGE_LIMIT) {
				try {
					const raw = await readFile(target);
					const filename = local.split(sep).join("/");
					images.push({
						mime: imageMimeType,
						data: raw.toString("base64"),
						filename,
					});
					const dimensions = imageDimensions(raw);
					if (dimensions) imageSizes.push({ filename, ...dimensions });
					files.push(filename);
				} catch {}
			}
			continue;
		}
		let text = "";
		try {
			text = await readBounded(target, Math.min(REFERENCE_PER_FILE, budget));
		} catch {
			continue;
		}
		if (!text.trim()) continue;
		budget -= text.length;
		const textName = local.split(sep).join("/");
		files.push(textName);
		// Stylesheets and component files carry the canvas the design was built for.
		if (/\.(css|scss|sass|less|svelte|vue|tsx|jsx|html)$/i.test(extension))
			styles.push({ filename: textName, text });
		chunks.push(`--- ${textName} ---\n${text}`);
		const links = [
			...text.matchAll(/(?:src|href)=["']([^"']+)["']/gi),
			...text.matchAll(
				/(?:@import\s+(?:url\()?\s*|\bfrom\s*)["']([^"']+)["']/gi,
			),
		];
		for (const match of links) {
			const link = match[1]?.split(/[?#]/, 1)[0];
			if (!link || link.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(link))
				continue;
			const related = resolve(target, "..", link);
			const relatedPath = relative(root, related);
			if (
				relatedPath &&
				relatedPath !== ".." &&
				!relatedPath.startsWith(`..${sep}`) &&
				!isAbsolute(relatedPath) &&
				!visited.has(relatedPath)
			)
				pending.push(relatedPath);
		}
	}
	const parts: string[] = [];
	if (chunks.length)
		parts.push(
			`Reference files from the project (match their markup, design tokens and component patterns):\n\n${chunks.join("\n\n")}`,
		);
	if (images.length)
		parts.push(
			`Project images attached as visual references: ${images.map((image) => image.filename).join(", ")}. Inspect their layout, colors, typography, and flow.`,
		);
	return {
		block: parts.length ? `\n\n${parts.join("\n\n")}` : "",
		images,
		files,
		imageSizes,
		styles,
	};
}

/** Paths the user typed or picked, normalised for prefix matching. */
function mentionPaths(text: string, selected: string[] = []): string[] {
	const typed = text.match(/[\w@.-]+(?:\/[\w@.-]+)+\/?/g) ?? [];
	return [
		...new Set(
			[...typed, ...selected]
				.map((path) => path.replace(/^@/, "").replace(/\/$/, ""))
				.filter(Boolean),
		),
	];
}

const TRACE_PREFIX = "\u0000loom-design-trace:";
const TRACE_LIMIT = 12_000;

function traceText(value: string, limit = 1_200): string {
	if (/<(?:!doctype|html|script|style)\b/i.test(value)) return "[document omitted]";
	return value
		.replace(/data:image\/[^\s"']+/gi, "[image omitted]")
		.replace(/[A-Za-z0-9+/]{160,}={0,2}/g, "[encoded data omitted]")
		.replace(/(?:sk-[\w-]{12,}|gh[pousr]_[\w-]{12,}|Bearer\s+\S+)/gi, "[credential omitted]")
		.replace(/(["']?(?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, "$1[redacted]")
		.slice(0, limit);
}

function traceEvents(output: RuntimeOutput | null) {
	const activities = new Map(output?.activities?.map((item) => [item.id, item]) ?? []);
	const parts = output?.parts?.length
		? output.parts
		: [
				...(output?.activities?.map((item) => ({ type: "activity" as const, id: item.id })) ?? []),
				...(output?.output ? [{ type: "text" as const, id: "output", text: output.output }] : []),
			];
	const events: DesignTrace["runs"][number]["events"] = [];
	for (const part of parts) {
		if (events.length >= 40) break;
		if (part.type === "text") {
			if (/<(?:!doctype|html|script|style)\b/i.test(part.text)) continue;
			const text = traceText(part.text.trim());
			if (text) events.push({ type: "text", text });
		} else {
			const activity = activities.get(part.id);
			if (!activity) continue;
			events.push({
				type: "tool",
				tool: traceText(activity.tool, 100),
				status: activity.status,
				...(activity.output ? { output: traceText(activity.output) } : {}),
				...(activity.error ? { error: traceText(activity.error) } : {}),
			});
		}
	}
	return events;
}

export type DesignThreadRecord = {
	nodes: DesignNodeRecord[];
	messages: DesignMessageRecord[];
};

export class DesignService {
	private readonly busy = new Map<string, Promise<unknown>>();
	/** Keep transient user references available when a failed node is retried. */
	private readonly generationContext = new Map<
		string,
		{ files: string[]; attachments: DesignAttachment[] }
	>();
	/** Separate conversation sessions per project and selected provider. */
	private readonly chatSessions = new Map<
		string,
		{ id: string; runtime: AgentRuntime }
	>();
	private readonly chatTurns = new Map<string, Promise<void>>();
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

	async create(
		input: {
			projectId: string;
			brief: string;
			viewport?: DesignViewport;
			frame?: DesignFrame;
			model?: RuntimeModel;
			files?: string[];
			attachments?: DesignAttachment[];
		},
		recordUser = true,
	): Promise<{ nodeId: string; status: string }> {
		const project = await this.requireProject(input.projectId);
		const brief = input.brief.trim();
		if (!brief) throw new Error("A design brief is required");
		// A size written into the brief is a request, not a suggestion.
		const frame =
			input.frame ??
			frameFromMention(brief) ??
			(input.viewport ? frameOfKind(input.viewport) : DEFAULT_DESIGN_FRAME);
		const size = designNodeSize(frame);
		const slot = await this.nextSlot(project.id);
		const id = randomUUID();
		this.generationContext.set(id, {
			files: input.files ?? [],
			attachments: input.attachments ?? [],
		});
		await this.store.createNode({
			id,
			projectId: project.id,
			title: deriveDesignTitle(brief),
			brief,
			viewport: viewportOfFrame(frame),
			frameKind: frame.kind,
			frameWidth: frame.width,
			frameHeight: frame.height,
			status: "queued",
			x: slot.x,
			y: slot.y,
			width: size.width,
			height: size.height,
		});
		if (recordUser)
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
		attachments?: DesignAttachment[],
	): Promise<{
		prompt: string;
		images: Array<{ mime: string; data: string; filename: string }>;
	}> {
		const storedFrame = frameOfRecord(node);
		// Mentioned paths steer the token scrape, so a @mentioned theme folder wins.
		const focus = mentionPaths([node.brief, message ?? ""].join("\n"), files);
		const context: ProjectContext | undefined = await buildDesignFileContext(
			project.path,
			project.name,
			focus,
		).catch(() => undefined);
		const read = new Set(context?.readFiles ?? []);
		const referencePaths = designReferencePaths(
			[node.brief, message ?? ""].join("\n"),
			context?.files ?? [],
			files,
		);
		const references = referencePaths.length
			? await referenceFilesBlock(project.path, referencePaths)
			: {
					block: "",
					images: [],
					files: [],
					imageSizes: [],
					styles: [],
				};
		for (const file of references.files) read.add(file);
		const attachmentReferences = attachmentReferencesBlock(attachments);
		// The user's own references decide the canvas: a screenshot's pixel size,
		// or the design space a mentioned stylesheet is authored in.
		const attachmentImages = (attachments ?? [])
			.filter((attachment) => attachment.mime.startsWith("image/"))
			.map((attachment) => {
				try {
					return {
						filename: attachment.filename,
						dimensions: imageDimensions(Buffer.from(attachment.data, "base64")),
					};
				} catch {
					return { filename: attachment.filename, dimensions: null };
				}
			})
			.filter(
				(
					item,
				): item is {
					filename: string;
					dimensions: { width: number; height: number };
				} => Boolean(item.dimensions),
			)
			.map((item) => ({ filename: item.filename, ...item.dimensions }));
		const cssWidths = references.styles
			.map((style) => ({
				file: style.filename,
				width: designSpaceWidth(style.text),
			}))
			.filter((entry): entry is { file: string; width: number } =>
				Boolean(entry.width),
			);
		const designSpaceFiles = references.styles
			.filter((style) => usesDesignSpaceUnit(style.text))
			.map((style) => style.filename);
		const frameHints = frameReferenceHints({
			images: [...attachmentImages, ...references.imageSizes],
			cssWidths,
			designSpaceFiles,
		});
		// What the user said wins, then what their references show, then the
		// frame the node already has.
		const frame =
			frameFromMention([message, node.brief].filter(Boolean).join("\n")) ??
			frameFromReferences({
				imageSizes: [...attachmentImages, ...references.imageSizes],
				cssWidths: cssWidths.map((entry) => entry.width),
			}) ??
			storedFrame;
		this.setActivity(node.id, {
			phase: "reading",
			files: [...read].slice(0, 80),
		});
		if (mode === "refine" && message && node.html)
			return {
				prompt:
					buildRefinePrompt({
						brief: node.brief,
						message,
						frame,
						resizeRequested:
							frame !== storedFrame || mentionsCanvasSize(message),
						previousHtml: node.html,
						projectName: project.name,
						projectPath: project.path,
					}) +
					frameHintBlock(frameHints) +
					references.block +
					attachmentReferences,
				images: references.images,
			};
		return {
			prompt:
				buildDesignPrompt({
					brief: node.brief,
					frame,
					context,
					projectName: project.name,
					projectPath: project.path,
					frameHints,
				}) +
				references.block +
				attachmentReferences,
			images: references.images,
		};
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
		const built = await this.buildPrompt(
			node,
			project,
			mode,
			message,
			files,
			attachments,
		);
		const prompt = built.prompt;
		this.setActivity(nodeId, {
			phase: "drafting",
			files: this.activity.get(nodeId)?.files ?? [],
		});
		const images = [
			...built.images.map(({ mime, data }) => ({ mime, data })),
			...(attachments ?? [])
				.filter((attachment) => attachment.mime.startsWith("image/"))
				.map((attachment) => ({
					mime: attachment.mime,
					data: attachment.data,
				})),
		];
		const runtime = this.runtimeFor(model);
		const selectedModel = model ?? (await this.storedModel(node));
		const isCustomProvider =
			selectedModel?.providerID.startsWith("loom_custom_") === true;
		const workdir = isCustomProvider
			? project.path
			: join(tmpdir(), "loom-design", project.id, nodeId);
		mkdirSync(workdir, { recursive: true });
		const session = await runtime.createSession({
			cwd: workdir,
			title: `Loom design · ${node.title}`,
			readOnly: true,
		});
		await this.store.updateNode(nodeId, { sessionId: session.id });
		const startedAt = Date.now();
		let lastOutput: RuntimeOutput | null = null;
		try {
			const run = (request: string) =>
				this.runSession(
					runtime,
					session.id,
					request,
					selectedModel,
					images,
					{ mode: "read-only" },
					undefined,
					(output) => { lastOutput = output; },
				);
			let reply = await run(prompt);
			try {
				extractDesignScreens(reply);
			} catch (error) {
				if (!(error instanceof DesignOutputError)) throw error;
				const previous = reply.trim().slice(0, 8_000);
				reply = await run(
					`${prompt}\n\nThe previous answer did not contain usable HTML. Use the same brief, project references, attached files, and visual inputs above. Return only one complete HTML document beginning with <!doctype html> and ending with </html>. Do not explain, ask questions, or call tools.${previous ? `\n\nPrevious answer to correct:\n${previous}` : ""}`,
				);
			}
			await this.persist(
				nodeId,
				project,
				node,
				reply,
				mode,
				Date.now() - startedAt,
			);
		} finally {
			const events = traceEvents(lastOutput);
			const saved: typeof events = [];
			for (const event of events) {
				if (JSON.stringify({ sessionId: session.id, events: [...saved, event] }).length > TRACE_LIMIT) break;
				saved.push(event);
			}
			await this.store.addMessage({
					projectId: project.id,
					nodeId,
					role: "assistant",
					text: `${TRACE_PREFIX}${JSON.stringify({ sessionId: session.id, events: saved })}`,
				}).catch(() => undefined);
			this.permissionGate?.store.denySession(session.id);
		}
	}

	private async runSession(
		runtime: AgentRuntime,
		sessionId: string,
		prompt: string,
		model?: RuntimeModel,
		images?: Array<{ mime: string; data: string }>,
		permission?: RuntimePermission,
		authorizeTool?: RuntimeToolAuthorization,
		onOutput?: (output: RuntimeOutput | null) => void,
	): Promise<string> {
		await runtime.prompt({
			sessionId,
			prompt,
			model,
			images: images?.length ? images : undefined,
			permission,
			authorizeTool,
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
		const output = (await runtime.readOutput?.(sessionId)) ?? null;
		onOutput?.(output);
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
		const storedFrame = frameOfRecord(node);
		const primaryFrame = primary.frame ?? storedFrame;
		// Re-fit the card only when the canvas itself changed, so a card the user
		// resized by hand keeps its size across refinements.
		const resized =
			primaryFrame.width !== storedFrame.width ||
			primaryFrame.height !== storedFrame.height;
		await this.store.updateNode(nodeId, {
			status: "ready",
			html: primary.html,
			title: primary.title || node.title,
			viewport: viewportOfFrame(primaryFrame),
			frameKind: primaryFrame.kind,
			frameWidth: primaryFrame.width,
			frameHeight: primaryFrame.height,
			...(resized ? designNodeSize(primaryFrame) : {}),
			errorMessage: null,
			durationMs,
		});
		if (mode === "create") {
			for (let index = 1; index < screens.length; index += 1) {
				const screen = screens[index];
				if (!screen) continue;
				const id = randomUUID();
				const screenFrame = screen.frame ?? primaryFrame;
				const screenSize = designNodeSize(screenFrame);
				await this.store.createNode({
					projectId: project.id,
					id,
					title: screen.title || `${node.title} ${index + 1}`,
					brief: node.brief,
					viewport: viewportOfFrame(screenFrame),
					frameKind: screenFrame.kind,
					frameWidth: screenFrame.width,
					frameHeight: screenFrame.height,
					status: "ready",
					x: node.x + index * (screenSize.width + GAP_X),
					y: node.y,
					width: screenSize.width,
					height: screenSize.height,
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
		recordUser = true,
	): Promise<{ nodeId: string; status: string }> {
		const node = await this.requireNode(nodeId);
		if (this.busy.has(nodeId))
			throw new Error("This design is still generating");
		const project = await this.requireProject(node.projectId);
		const message = input.message.trim();
		if (!message) throw new Error("Describe what to change");

		const model = input.model ?? (await this.storedModel(node));
		this.generationContext.set(nodeId, {
			files: input.files ?? [],
			attachments: input.attachments ?? [],
		});
		if (recordUser)
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
		const context = this.generationContext.get(nodeId);
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
				context?.files,
				context?.attachments,
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

		const userTurn = await this.store.addMessage({
			projectId: project.id,
			nodeId: target?.html ? target.id : null,
			role: "user",
			text: message,
			model: modelLabel(input.model),
		});
		try {
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
						for (const node of readyNodes) {
							const model = input.model ?? (await this.storedModel(node));
							this.generationContext.set(node.id, {
								files: input.files ?? [],
								attachments: input.attachments ?? [],
							});
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
					const refined = await this.refine(
						target.id,
						{
							message,
							model: input.model,
							files: input.files,
							attachments: input.attachments,
						},
						false,
					);
					return { kind: "design", nodeId: refined.nodeId, status: "queued" };
				}
				const created = await this.create(
					{
						projectId: project.id,
						brief: message,
						model: input.model,
						files: input.files,
						attachments: input.attachments,
					},
					false,
				);
				return { kind: "design", nodeId: created.nodeId, status: "queued" };
			}

			const images = (input.attachments ?? [])
				.filter((attachment) => attachment.mime.startsWith("image/"))
				.map((attachment) => ({
					mime: attachment.mime,
					data: attachment.data,
				}));
			const context = await buildDesignFileContext(
				project.path,
				project.name,
				mentionPaths(message, input.files),
			).catch(() => undefined);
			const referencePaths = designReferencePaths(
				message,
				context?.files ?? [],
				input.files,
			);
			const references = referencePaths.length
				? await referenceFilesBlock(project.path, referencePaths)
				: {
						block: "",
						images: [],
						files: [],
						imageSizes: [],
						styles: [],
					};
			images.push(
				...references.images.map(({ mime, data }) => ({ mime, data })),
			);
			const reply = await this.runChatTurn(
				project,
				message +
					references.block +
					attachmentReferencesBlock(input.attachments),
				input.model,
				images,
				userTurn.id,
			);

			const question = parseDesignQuestions(reply);
			if (question) {
				const note =
					chatReplyText(reply) || "I need a little more detail first.";
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
				role: "assistant",
				text,
				model: modelLabel(input.model),
			});
			return { kind: "chat", text };
		} catch (error) {
			await this.store
				.addMessage({
					projectId: project.id,
					nodeId: target?.html ? target.id : null,
					role: "assistant",
					text: "",
					errorMessage: friendlyRuntimeError(error),
					model: modelLabel(input.model),
				})
				.catch(() => undefined);
			throw error;
		}
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
		userTurnId: string,
	): Promise<string> {
		const conversationKey = `${project.id}\0${model?.providerID ?? "default"}\0${model?.modelID ?? "default"}`;
		const previous = this.chatTurns.get(conversationKey);
		const turn = (async () => {
			if (previous) await previous;
			return this.executeChatTurn(
				project,
				userText,
				model,
				images,
				userTurnId,
				conversationKey,
			);
		})();
		const settled = turn.then(
			() => undefined,
			() => undefined,
		);
		this.chatTurns.set(conversationKey, settled);
		void settled.then(() => {
			if (this.chatTurns.get(conversationKey) === settled)
				this.chatTurns.delete(conversationKey);
		});
		return turn;
	}

	private async executeChatTurn(
		project: ProjectRecord,
		userText: string,
		model: RuntimeModel | undefined,
		images: Array<{ mime: string; data: string }>,
		userTurnId: string,
		conversationKey: string,
	): Promise<string> {
		const isCustomProvider =
			model?.providerID.startsWith("loom_custom_") === true;
		const workdir = isCustomProvider
			? project.path
			: join(tmpdir(), "loom-design", "chat", project.id);
		mkdirSync(workdir, { recursive: true });
		const runtime = this.runtimeFor(model);
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
		try {
			let prompt = userText;
			const isStatelessProvider = Boolean(model && runtime !== this.runtime);
			if (isStatelessProvider) {
				const context = await buildDesignFileContext(
					project.path,
					project.name,
				).catch(() => undefined);
				const messages = await this.store.listMessages(project.id);
				const previous = messages
					.slice(
						0,
						messages.findIndex((item) => item.id === userTurnId),
					)
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
				const context = await buildDesignFileContext(
					project.path,
					project.name,
				).catch(() => undefined);
				prompt = `${buildDesignAssistantPrompt({
					context,
					projectName: project.name,
					projectPath: project.path,
				})}\n\nUser message:\n${userText}`;
			}
			return await this.runChatPrompt(
				conversation.runtime,
				conversation.id,
				prompt,
				model,
				images,
			);
		} catch (error) {
			if (this.chatSessions.get(conversationKey) === conversation)
				this.chatSessions.delete(conversationKey);
			throw error;
		}
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
		const primaryFrame =
			primary.frame ?? frameFromMention(brief) ?? DEFAULT_DESIGN_FRAME;
		const size = designNodeSize(primaryFrame);
		const slot = await this.nextSlot(project.id);
		const id = randomUUID();
		await this.store.createNode({
			id,
			projectId: project.id,
			title: primary.title || deriveDesignTitle(brief),
			brief,
			viewport: viewportOfFrame(primaryFrame),
			frameKind: primaryFrame.kind,
			frameWidth: primaryFrame.width,
			frameHeight: primaryFrame.height,
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
			const screenFrame = screen.frame ?? primaryFrame;
			const screenSize = designNodeSize(screenFrame);
			await this.store.createNode({
				id: extra,
				projectId: project.id,
				title: screen.title || `${primary.title} ${index + 1}`,
				brief,
				viewport: viewportOfFrame(screenFrame),
				frameKind: screenFrame.kind,
				frameWidth: screenFrame.width,
				frameHeight: screenFrame.height,
				status: "ready",
				x: slot.x + index * (screenSize.width + GAP_X),
				y: slot.y,
				width: screenSize.width,
				height: screenSize.height,
			});
			await this.store.updateNode(extra, { html: screen.html });
		}
		await this.store.addMessage({
			projectId: project.id,
			nodeId: id,
			role: "assistant",
			text: designChatSummary(reply, screens),
			model: modelLabel(model),
		});
		return id;
	}

	async trace(nodeId: string): Promise<DesignTrace> {
		const node = await this.requireNode(nodeId);
		const messages = await this.store.listMessages(node.projectId);
		return {
			projectId: node.projectId,
			nodeId,
			runs: messages.filter((message) => message.nodeId === nodeId && message.text.startsWith(TRACE_PREFIX)).flatMap((message) => {
				try {
					const value = JSON.parse(message.text.slice(TRACE_PREFIX.length));
					if (typeof value.sessionId !== "string" || !Array.isArray(value.events)) return [];
					return [{ sessionId: value.sessionId, createdAt: message.createdAt.toISOString(), events: value.events }];
				} catch {
					return [];
				}
			}),
		};
	}

	async list(projectId: string): Promise<DesignThreadRecord> {
		await this.requireProject(projectId);
		return {
			nodes: await this.store.listNodes(projectId),
			messages: (await this.store.listMessages(projectId)).filter((message) => !message.text.startsWith(TRACE_PREFIX)),
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
			const frame = frameOfKind(patch.viewport);
			input.frameKind = frame.kind;
			input.frameWidth = frame.width;
			input.frameHeight = frame.height;
			const size = designNodeSize(frame);
			input.width = size.width;
			input.height = size.height;
		}
		if (patch.frame !== undefined) {
			const frame = patch.frame;
			input.frameKind = frame.kind;
			input.frameWidth = frame.width;
			input.frameHeight = frame.height;
			input.viewport = viewportOfFrame(frame);
			const size = designNodeSize(frame);
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
		this.generationContext.delete(nodeId);
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
		for (const node of nodes) this.generationContext.delete(node.id);
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
