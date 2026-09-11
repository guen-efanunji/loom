import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
	"BAD_REQUEST",
	"UNAUTHORIZED",
	"FORBIDDEN",
	"NOT_FOUND",
	"CONFLICT",
	"VALIDATION_ERROR",
	"GIT_UNAVAILABLE",
	"OPENCODE_UNAVAILABLE",
	"WORKTREE_ERROR",
	"AGENT_ERROR",
	"MERGE_CONFLICT",
	"INTERNAL_ERROR",
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
	code: apiErrorCodeSchema,
	message: z.string().min(1),
	action: z.string().min(1).nullable(),
	details: z.record(z.string(), z.unknown()).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export function createApiError(
	code: ApiErrorCode,
	message: string,
	action: string | null = null,
	details?: Record<string, unknown>,
): ApiError {
	return apiErrorSchema.parse({ code, message, action, details });
}
