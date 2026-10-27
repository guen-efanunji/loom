import { z } from "zod";

/** Legacy two-value viewport; still derived from the frame for icons and previews. */
export const designViewportSchema = z.enum(["desktop", "mobile"]);

export type DesignViewport = z.infer<typeof designViewportSchema>;

/**
 * What a canvas frame is sized for. `width`/`height` are the design space the
 * document is authored in, so a frame can be any ratio - not just a web page.
 */
export const designFrameKindSchema = z.enum([
	"desktop",
	"laptop",
	"tablet",
	"mobile",
	"story",
	"poster",
	"square",
	"card",
	"email",
	"slide",
	"component",
	"custom",
]);

export type DesignFrameKind = z.infer<typeof designFrameKindSchema>;

export const DESIGN_FRAME_MIN = 120;
export const DESIGN_FRAME_MAX = 8192;

export const designFrameSchema = z.object({
	kind: designFrameKindSchema,
	width: z.number().int().min(DESIGN_FRAME_MIN).max(DESIGN_FRAME_MAX),
	height: z.number().int().min(DESIGN_FRAME_MIN).max(DESIGN_FRAME_MAX),
});

export type DesignFrame = z.infer<typeof designFrameSchema>;

/** Portrait frames read as a phone-shaped node on the canvas. */
export function viewportOfFrame(
	frame: Pick<DesignFrame, "kind" | "width" | "height">,
): DesignViewport {
	return frame.kind === "mobile" ||
		frame.kind === "story" ||
		frame.height > frame.width
		? "mobile"
		: "desktop";
}

/**
 * Frame presets offered by the canvas picker. `width`/`height` are real design
 * pixels; `hint` explains what the frame is normally used for.
 */
export const DESIGN_FRAME_PRESETS: ReadonlyArray<{
	id: DesignFrameKind;
	label: string;
	width: number;
	height: number;
	hint: string;
}> = [
	{
		id: "desktop",
		label: "Desktop",
		width: 1440,
		height: 900,
		hint: "Wide web page",
	},
	{
		id: "laptop",
		label: "Laptop",
		width: 1280,
		height: 800,
		hint: "Common laptop",
	},
	{
		id: "tablet",
		label: "Tablet",
		width: 834,
		height: 1112,
		hint: "Portrait tablet",
	},
	{
		id: "mobile",
		label: "Mobile",
		width: 390,
		height: 844,
		hint: "Phone screen",
	},
	{
		id: "story",
		label: "Story",
		width: 1080,
		height: 1920,
		hint: "9:16 social story",
	},
	{
		id: "poster",
		label: "Poster",
		width: 1080,
		height: 1350,
		hint: "4:5 social post",
	},
	{
		id: "square",
		label: "Square",
		width: 1080,
		height: 1080,
		hint: "1:1 feed tile",
	},
	{
		id: "card",
		label: "Card",
		width: 480,
		height: 640,
		hint: "Link-in-bio / compact card",
	},
	{
		id: "email",
		label: "Email",
		width: 600,
		height: 900,
		hint: "Email template column",
	},
	{
		id: "slide",
		label: "Slide",
		width: 1280,
		height: 720,
		hint: "16:9 presentation",
	},
	{
		id: "component",
		label: "Component",
		width: 720,
		height: 480,
		hint: "Isolated UI part",
	},
];

const DEFAULT_FRAME = DESIGN_FRAME_PRESETS[0] ?? {
	id: "desktop" as const,
	label: "Desktop",
	width: 1440,
	height: 900,
	hint: "",
};

export const DEFAULT_DESIGN_FRAME: DesignFrame = {
	kind: DEFAULT_FRAME.id,
	width: DEFAULT_FRAME.width,
	height: DEFAULT_FRAME.height,
};

/** Closest preset for a measured ratio, used when a mention implies the size. */
export function frameForRatio(width: number, height: number): DesignFrame {
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	)
		return DEFAULT_DESIGN_FRAME;
	const ratio = width / height;
	const ranked = DESIGN_FRAME_PRESETS.slice()
		.sort(
			(a, b) =>
				Math.abs(Math.log(a.width / a.height) - Math.log(ratio)) -
				Math.abs(Math.log(b.width / b.height) - Math.log(ratio)),
		)
		.filter((preset) => preset.id !== "custom");
	const best = ranked[0] ?? DEFAULT_FRAME;
	// Keep the reference's own proportions, but at a sane design-space scale.
	const scale = Math.min(1, 1440 / Math.max(width, height));
	return {
		kind: best.id,
		width: Math.max(DESIGN_FRAME_MIN, Math.round(width * scale)),
		height: Math.max(DESIGN_FRAME_MIN, Math.round(height * scale)),
	};
}

export const designStatusSchema = z.enum([
	"queued",
	"generating",
	"ready",
	"failed",
]);

export type DesignStatus = z.infer<typeof designStatusSchema>;

export const agentModelRefSchema = z.object({
	providerID: z.string().min(1),
	modelID: z.string().min(1),
});

export type AgentModelRef = z.infer<typeof agentModelRefSchema>;

/** A pasted or uploaded file (photo, mockup, doc) sent to the design agent. */
export const designAttachmentSchema = z.object({
	filename: z.string().min(1).max(300),
	mime: z.string().min(1).max(120),
	data: z.string().min(1).max(10_000_000),
});

export type DesignAttachment = z.infer<typeof designAttachmentSchema>;

/** One selectable option inside a clarifying question the design agent asks. */
export const designQuestionOptionSchema = z.object({
	label: z.string().min(1).max(200),
	description: z.string().max(500).default(""),
});

export type DesignQuestionOption = z.infer<typeof designQuestionOptionSchema>;

/** A single clarifying question (theme, style, which screen, ...). */
export const designQuestionItemSchema = z.object({
	header: z.string().min(1).max(60),
	question: z.string().min(1).max(500),
	multiple: z.boolean().optional(),
	options: z.array(designQuestionOptionSchema).min(1).max(12),
});

export type DesignQuestionItem = z.infer<typeof designQuestionItemSchema>;

/**
 * A questionnaire the agent returns instead of generating, when a build request
 * is too vague to start. Mirrors the web QuestionCard `Question` shape.
 */
export const designQuestionSchema = z.object({
	id: z.string().min(1).max(120),
	questions: z.array(designQuestionItemSchema).min(1).max(3),
});

export type DesignQuestion = z.infer<typeof designQuestionSchema>;

export const designNodeSchema = z.object({
	id: z.string().min(1),
	projectId: z.string().min(1),
	sessionId: z.string().nullable().default(null),
	parentId: z.string().nullable().default(null),
	title: z.string().min(1),
	brief: z.string(),
	status: designStatusSchema,
	viewport: designViewportSchema,
	frameKind: designFrameKindSchema.default("desktop"),
	frameWidth: z.number().int().default(1440),
	frameHeight: z.number().int().default(900),
	html: z.string(),
	errorMessage: z.string().nullable(),
	durationMs: z.number().int().nullable(),
	x: z.number().int(),
	y: z.number().int(),
	width: z.number().int(),
	height: z.number().int(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export type DesignNode = z.infer<typeof designNodeSchema>;

export const designMessageSchema = z.object({
	id: z.string().min(1),
	projectId: z.string().min(1),
	nodeId: z.string().nullable().default(null),
	role: z.enum(["user", "assistant"]),
	text: z.string(),
	model: z.string().nullable(),
	errorMessage: z.string().nullable(),
	durationMs: z.number().int().nullable(),
	createdAt: z.iso.datetime(),
});

export type DesignMessage = z.infer<typeof designMessageSchema>;

export const designPermissionRequestSchema = z.object({
	id: z.string().min(1),
	toolName: z.string().min(1),
	args: z.record(z.string(), z.unknown()),
	stepIdx: z.number().int().nonnegative(),
	createdAt: z.number().int().nonnegative(),
});

export type DesignPermissionRequest = z.infer<
	typeof designPermissionRequestSchema
>;

export const designThreadSchema = z.object({
	nodes: z.array(designNodeSchema),
	messages: z.array(designMessageSchema),
});

export type DesignThread = z.infer<typeof designThreadSchema>;

export const createDesignSchema = z.object({
	projectId: z.string().min(1),
	brief: z.string().trim().min(1).max(8000),
	viewport: designViewportSchema.default("desktop"),
	frame: designFrameSchema.optional(),
	model: agentModelRefSchema.optional(),
	files: z.array(z.string().min(1).max(400)).max(50).default([]),
	attachments: z.array(designAttachmentSchema).max(10).default([]),
});

export type CreateDesignInput = z.infer<typeof createDesignSchema>;

export const refineDesignSchema = z.object({
	message: z.string().trim().min(1).max(8000),
	frame: designFrameSchema.optional(),
	model: agentModelRefSchema.optional(),
	files: z.array(z.string().min(1).max(400)).max(50).default([]),
	attachments: z.array(designAttachmentSchema).max(10).default([]),
});

export type RefineDesignInput = z.infer<typeof refineDesignSchema>;

/** A conversational turn sent to the design agent chat. */
export const chatDesignSchema = z.object({
	message: z.string().trim().min(1).max(8000),
	nodeId: z.string().optional(),
	frame: designFrameSchema.optional(),
	model: agentModelRefSchema.optional(),
	files: z.array(z.string().min(1).max(400)).max(50).default([]),
	attachments: z.array(designAttachmentSchema).max(10).default([]),
});

export type ChatDesignInput = z.infer<typeof chatDesignSchema>;

/**
 * What a design-chat turn decided to do: answer as chat, ask a questionnaire,
 * or kick off (async) a canvas generation.
 */
export const designChatResultSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("chat"), text: z.string() }),
	z.object({ kind: z.literal("question"), question: designQuestionSchema }),
	z.object({
		kind: z.literal("design"),
		nodeId: z.string().min(1),
		status: designStatusSchema,
	}),
]);

export type DesignChatResult = z.infer<typeof designChatResultSchema>;

/**
 * Live progress for a generating design node: which phase the agent is in and
 * the real project files it read to ground the design (theme, config, @mentions).
 */
export const designActivitySchema = z.object({
	phase: z.enum(["reading", "drafting"]),
	files: z.array(z.string().max(400)).max(80).default([]),
	permissions: z.array(designPermissionRequestSchema).optional(),
});

export type DesignActivity = z.infer<typeof designActivitySchema>;

export const designTraceEventSchema = z.object({
	type: z.enum(["text", "tool"]),
	text: z.string().optional(),
	tool: z.string().optional(),
	status: z.enum(["running", "completed", "error"]).optional(),
	output: z.string().optional(),
	error: z.string().optional(),
});

export const designTraceRunSchema = z.object({
	sessionId: z.string(),
	createdAt: z.iso.datetime(),
	events: z.array(designTraceEventSchema),
});

export const designTraceSchema = z.object({
	projectId: z.string(),
	nodeId: z.string(),
	runs: z.array(designTraceRunSchema),
});

export type DesignTrace = z.infer<typeof designTraceSchema>;

export const designPatchSchema = z
	.object({
		title: z.string().trim().min(1).max(200).optional(),
		viewport: designViewportSchema.optional(),
		frame: designFrameSchema.optional(),
		x: z.number().int().min(-40000).max(40000).optional(),
		y: z.number().int().min(-40000).max(40000).optional(),
		width: z.number().int().min(160).max(4096).optional(),
		height: z.number().int().min(120).max(4096).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Nothing to update",
	});

export type DesignPatch = z.infer<typeof designPatchSchema>;
