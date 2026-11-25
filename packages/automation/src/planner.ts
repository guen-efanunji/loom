import type { PlannerResult } from "@loom/protocol";
import type { AgentRuntime, RuntimeModel } from "@loom/providers/core";
import type { ProjectContext } from "./context-builder";
import {
	buildPlannerRequest,
	PLANNER_REPAIR_PROMPT,
	PLANNER_SYSTEM_PROMPT,
} from "./prompt";
import { validateAutomationPlan } from "./validator";

export type PlannerPhase = "generating" | "repairing" | "validating";

const DEFAULT_PLANNER_TIMEOUT_MS = 120_000;

export interface Planner {
	createPlan(input: {
		projectId: string;
		message: string;
		context: ProjectContext;
		model?: RuntimeModel;
		timeoutMs?: number;
		onPhase?: (phase: PlannerPhase) => void | Promise<void>;
	}): Promise<PlannerResult>;
}

function extractJson(output: string): unknown {
	const trimmed = output.trim();
	const cleaned = trimmed
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	try {
		return JSON.parse(cleaned);
	} catch {}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fenced?.[1]) {
		try {
			return JSON.parse(fenced[1].trim());
		} catch {}
	}
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
	}
	throw new Error("Planner output was not valid JSON");
}

export class RuntimePlanner implements Planner {
	constructor(
		private readonly runtime: AgentRuntime,
		private readonly cwd: string,
		private readonly title = "Loom planner",
		private readonly onSession?: (id: string) => Promise<void>,
	) {}

	async createPlan(input: {
		projectId: string;
		message: string;
		context: ProjectContext;
		model?: RuntimeModel;
		timeoutMs?: number;
		onPhase?: (phase: PlannerPhase) => void | Promise<void>;
	}): Promise<PlannerResult> {
		const timeoutMs = input.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS;
		const session = await this.runtime.createSession({
			cwd: this.cwd,
			title: this.title,
			readOnly: true,
		});
		try {
			await this.onSession?.(session.id);
			await input.onPhase?.("generating");
			await this.runtime.prompt({
				sessionId: session.id,
				system: PLANNER_SYSTEM_PROMPT,
				prompt: buildPlannerRequest(input),
				model: input.model,
				permission: { mode: "read-only" },
			});
			const status = await this.runtime.wait(session.id, { timeoutMs });
			if (status !== "completed") {
				const detail = await this.runtime
					.lastError?.(session.id)
					.catch(() => null);
				throw new Error(detail || `Planner ended with status: ${status}`);
			}
			await input.onPhase?.("validating");
			const validated = await this.validateResult(session.id);
			if (validated.ok && validated.plan) return validated.plan;
			await input.onPhase?.("repairing");
			const problems = validated.issues
				.map((issue) => `- ${issue.message}`)
				.join("\n");
			await this.runtime.prompt({
				sessionId: session.id,
				system: PLANNER_SYSTEM_PROMPT,
				prompt: `${PLANNER_REPAIR_PROMPT}${problems}`,
				model: input.model,
				permission: { mode: "read-only" },
			});
			const repairStatus = await this.runtime.wait(session.id, { timeoutMs });
			if (repairStatus !== "completed") {
				const detail = await this.runtime
					.lastError?.(session.id)
					.catch(() => null);
				throw new Error(
					detail || `Planner repair ended with status: ${repairStatus}`,
				);
			}
			await input.onPhase?.("validating");
			const repaired = await this.validateResult(session.id);
			if (repaired.ok && repaired.plan) return repaired.plan;
			throw new Error(
				`Planner output invalid after repair: ${repaired.issues.map((issue) => issue.message).join("; ")}`,
			);
		} finally {
			await this.runtime.abort(session.id).catch(() => {});
		}
	}

	private async readResult(sessionId: string): Promise<unknown> {
		const result = await this.runtime.readOutput?.(sessionId);
		if (!result?.output.trim()) {
			const detail = await this.runtime
				.lastError?.(sessionId)
				.catch(() => null);
			throw new Error(detail || "Planner returned no output");
		}
		try {
			return extractJson(result.output);
		} catch {
			throw new Error("Planner output was not valid JSON");
		}
	}

	private async validateResult(sessionId: string) {
		try {
			return validateAutomationPlan(await this.readResult(sessionId));
		} catch (error) {
			return {
				ok: false,
				plan: null,
				issues: [
					{
						message:
							error instanceof Error ? error.message : "Invalid planner output",
					},
				],
			};
		}
	}
}
