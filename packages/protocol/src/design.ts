import { z } from "zod";

export const designViewportSchema = z.enum(["desktop", "mobile"]);

export type DesignViewport = z.infer<typeof designViewportSchema>;

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

export const designThreadSchema = z.object({
	nodes: z.array(designNodeSchema),
	messages: z.array(designMessageSchema),
});

export type DesignThread = z.infer<typeof designThreadSchema>;

export const createDesignSchema = z.object({
	projectId: z.string().min(1),
	brief: z.string().trim().min(1).max(8000),
	viewport: designViewportSchema.default("desktop"),
	model: agentModelRefSchema.optional(),
	files: z.array(z.string().min(1).max(400)).max(50).default([]),
	attachments: z.array(designAttachmentSchema).max(10).default([]),
});

export type CreateDesignInput = z.infer<typeof createDesignSchema>;

export const refineDesignSchema = z.object({
	message: z.string().trim().min(1).max(8000),
	model: agentModelRefSchema.optional(),
	files: z.array(z.string().min(1).max(400)).max(50).default([]),
	attachments: z.array(designAttachmentSchema).max(10).default([]),
});

export type RefineDesignInput = z.infer<typeof refineDesignSchema>;

/** A conversational turn sent to the design agent chat. */
export const chatDesignSchema = z.object({
	message: z.string().trim().min(1).max(8000),
	nodeId: z.string().optional(),
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
});

export type DesignActivity = z.infer<typeof designActivitySchema>;

export const designPatchSchema = z
	.object({
		title: z.string().trim().min(1).max(200).optional(),
		viewport: designViewportSchema.optional(),
		x: z.number().int().min(-40000).max(40000).optional(),
		y: z.number().int().min(-40000).max(40000).optional(),
		width: z.number().int().min(160).max(4096).optional(),
		height: z.number().int().min(120).max(4096).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Nothing to update",
	});

export type DesignPatch = z.infer<typeof designPatchSchema>;
