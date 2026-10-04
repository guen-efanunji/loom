import type { AgentModel, AgentRuntime } from "@loom/opencode";
import type { PlannerResult } from "@loom/protocol";
import type { ProjectContext } from "./context-builder";
import { buildPlannerPrompt, PLANNER_REPAIR_PROMPT } from "./prompt";
import { validateAutomationPlan } from "./validator";

export interface Planner {
	createPlan(input: {
		projectId: string;
		message: string;
		context: ProjectContext;
		model?: AgentModel;
	}): Promise<PlannerResult>;
}

function extractJson(output: string): unknown {
	const cleaned = output
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	return JSON.parse(cleaned);
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
		model?: AgentModel;
	}): Promise<PlannerResult> {
		const session = await this.runtime.createSession({
			cwd: this.cwd,
			title: this.title,
			readOnly: true,
		});
		try {
			await this.onSession?.(session.id);
			await this.runtime.prompt({
				sessionId: session.id,
				prompt: buildPlannerPrompt(input),
				model: input.model,
			});
			const status = await this.runtime.wait(session.id, {
				timeoutMs: 300_000,
			});
			if (status !== "completed")
				throw new Error(`Planner ended with status: ${status}`);
			const validated = await this.validateResult(session.id);
			if (validated.ok && validated.plan) return validated.plan;
			const problems = validated.issues
				.map((issue) => `- ${issue.message}`)
				.join("\n");
			await this.runtime.prompt({
				sessionId: session.id,
				prompt: `${PLANNER_REPAIR_PROMPT}${problems}`,
				model: input.model,
			});
			const repairStatus = await this.runtime.wait(session.id, {
				timeoutMs: 300_000,
			});
			if (repairStatus !== "completed")
				throw new Error(`Planner repair ended with status: ${repairStatus}`);
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
		if (!result?.output.trim()) throw new Error("Planner returned no output");
		try {
			return extractJson(result.output);
		} catch {
			throw new Error("Planner output was not valid JSON");
		}
	}

	private async validateResult(sessionId: string) {
		try { return validateAutomationPlan(await this.readResult(sessionId)); }
		catch (error) { return { ok: false, plan: null, issues: [{ message: error instanceof Error ? error.message : "Invalid planner output" }] }; }
	}
}
