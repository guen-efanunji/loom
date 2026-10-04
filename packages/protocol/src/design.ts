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
});

export type CreateDesignInput = z.infer<typeof createDesignSchema>;

export const refineDesignSchema = z.object({
	message: z.string().trim().min(1).max(8000),
	model: agentModelRefSchema.optional(),
});

export type RefineDesignInput = z.infer<typeof refineDesignSchema>;

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
