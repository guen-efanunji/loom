import { z } from "zod";

export const planStatusSchema = z.enum([
	"draft",
	"validated",
	"approved",
	"executing",
	"completed",
	"failed",
]);

export type PlanStatus = z.infer<typeof planStatusSchema>;

export const planPrioritySchema = z.enum(["low", "medium", "high"]);

export type PlanPriority = z.infer<typeof planPrioritySchema>;

export const automationPlanTaskSchema = z.object({
	key: z
		.string()
		.trim()
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
	title: z.string().trim().min(1).max(200),
	description: z.string().trim().min(1).max(20000),
	priority: planPrioritySchema,
	dependencies: z.array(z.string().min(1)).max(100).default([]),
	acceptanceCriteria: z.array(z.string().trim().min(1)).max(50),
	suggestedFiles: z.array(z.string().min(1).max(1000)).max(100).default([]),
	parallelGroup: z.string().trim().min(1).max(100).optional(),
});

export type AutomationPlanTask = z.infer<typeof automationPlanTaskSchema>;

export const plannerResultSchema = z.object({
	title: z.string().trim().min(1).max(200),
	summary: z.string().trim().min(1).max(5000),
	tasks: z.array(automationPlanTaskSchema).min(1).max(30),
});

export type PlannerResult = z.infer<typeof plannerResultSchema>;

export const planSchema = z.object({
	id: z.string().min(1),
	projectId: z.string().min(1),
	sourceMessageId: z.string(),
	sourceMessage: z.string().default(""),
	sourceSessionId: z.string().nullable().default(null),
	startedAt: z.iso.datetime().nullable().default(null),
	cancelledAt: z.iso.datetime().nullable().default(null),
	title: z.string().min(1),
	summary: z.string(),
	status: planStatusSchema,
	convertedAt: z.iso.datetime().nullable(),
	approvedAt: z.iso.datetime().nullable(),
	errorMessage: z.string().nullable(),
	createdAt: z.iso.datetime(),
});

export type Plan = z.infer<typeof planSchema>;

export const automationModeSchema = z.enum([
	"review",
	"auto-create",
	"auto-start",
]);

export type AutomationMode = z.infer<typeof automationModeSchema>;
