import type { ProjectContext } from "./context-builder";

export const PLANNER_SYSTEM_PROMPT = `You are the planning engine for a coding agent orchestrator.

Your job is to convert a user's development request into a small, high-quality implementation plan.

Rules:

- Produce implementation tasks, not conversational advice.
- Preserve explicit constraints from the user.
- Do not invent requirements.
- Do not add features explicitly excluded by the user.
- Prefer independently executable tasks where practical.
- Identify dependencies explicitly.
- Avoid micro-tasks.
- Avoid tasks that are too broad.
- Every task must have measurable acceptance criteria.
- Respect the project's actual technology stack.
- Respect requested files and architecture.
- Prefer parallelizable work where safe.
- Final QA tasks should depend on implementation tasks.
- Do not include deployment unless requested.
- Do not include documentation unless needed by the request.
- Return only structured output matching the provided schema.`;

export function buildPlannerPrompt(input: {
	message: string;
	context: ProjectContext;
}): string {
	const lines = [
		PLANNER_SYSTEM_PROMPT,
		"",
		"## Development request",
		"",
		input.message.trim(),
		"",
		"## Project context",
		"",
		`Project: ${input.context.projectName}`,
		`Stack: ${input.context.stack.join(", ") || "unknown"}`,
	];
	if (input.context.packageManager)
		lines.push(`Package manager: ${input.context.packageManager}`);
	if (input.context.currentBranch)
		lines.push(`Current branch: ${input.context.currentBranch}`);
	const scripts = Object.entries(input.context.scripts);
	if (scripts.length)
		lines.push(
			`Scripts: ${scripts.map(([name, command]) => `${name}=${command}`).join(", ")}`,
		);
	if (input.context.files.length) {
		lines.push("", "Relevant files (bounded, depth-limited):");
		for (const file of input.context.files) lines.push(`- ${file}`);
	}
	if (input.context.conventions)
		lines.push("", "Project conventions:", input.context.conventions);
	lines.push("", OUTPUT_SHAPE);
	return lines.join("\n");
}

export const PLANNER_REPAIR_PROMPT = `Your previous output was rejected. Fix ONLY the reported problems and return the complete corrected plan in the same structured shape. Do not change valid tasks, and do not add explanation outside the structured output.

Problems:
`;

const OUTPUT_SHAPE = `Return ONLY a JSON object with this exact shape, no markdown fences, no commentary:
{"title": string, "summary": string, "tasks": [{"key": string (unique, short, slug-like), "title": string, "description": string, "priority": "low" | "medium" | "high", "dependencies": string[] (keys of other tasks, may be empty), "acceptanceCriteria": string[] (at least one concrete, measurable check per task), "suggestedFiles": string[] (may be empty), "parallelGroup"?: string}]}`;
