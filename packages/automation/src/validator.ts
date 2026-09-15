import { type PlannerResult, plannerResultSchema } from "@loom/protocol";

export type PlanValidationIssue = {
	code:
		| "duplicate-key"
		| "duplicate-dependency"
		| "invalid-key"
		| "missing-dependency"
		| "self-dependency"
		| "dependency-cycle"
		| "missing-acceptance-criteria"
		| "task-count";
	message: string;
};

export type PlanValidation = {
	ok: boolean;
	issues: PlanValidationIssue[];
	plan: PlannerResult | null;
};

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function hasCycle(
	tasks: Array<{ key: string; dependsOn: string[] }>,
): string[] | null {
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const stack: string[] = [];
	const byKey = new Map(tasks.map((task) => [task.key, task]));
	const visit = (key: string): string[] | null => {
		if (visiting.has(key)) return [...stack.slice(stack.indexOf(key)), key];
		if (visited.has(key)) return null;
		visiting.add(key);
		stack.push(key);
		for (const dep of byKey.get(key)?.dependsOn ?? []) {
			const cycle = visit(dep);
			if (cycle) return cycle;
		}
		stack.pop();
		visiting.delete(key);
		visited.add(key);
		return null;
	};
	for (const task of tasks) {
		const cycle = visit(task.key);
		if (cycle) return cycle;
	}
	return null;
}

/** Validates structure (zod) plus graph rules: keys, deps, cycles, counts. */
export function validateAutomationPlan(input: unknown): PlanValidation {
	const parsed = plannerResultSchema.safeParse(input);
	if (!parsed.success) {
		return {
			ok: false,
			issues: parsed.error.issues.map((issue) => ({
				code: "invalid-key" as const,
				message: `${issue.path.join(".") || "plan"}: ${issue.message}`,
			})),
			plan: null,
		};
	}
	const plan = parsed.data;
	const issues: PlanValidationIssue[] = [];
	const seen = new Set<string>();
	for (const task of plan.tasks) {
		if (!KEY_PATTERN.test(task.key))
			issues.push({
				code: "invalid-key",
				message: `Invalid task key: ${task.key}`,
			});
		if (seen.has(task.key))
			issues.push({
				code: "duplicate-key",
				message: `Duplicate task key: ${task.key}`,
			});
		seen.add(task.key);
		if (new Set(task.dependencies).size !== task.dependencies.length)
			issues.push({ code: "duplicate-dependency", message: `Task ${task.key} repeats a dependency` });
		if (!task.acceptanceCriteria.length)
			issues.push({
				code: "missing-acceptance-criteria",
				message: `Task ${task.key} needs at least one acceptance criterion`,
			});
		if (task.dependencies.includes(task.key))
			issues.push({
				code: "self-dependency",
				message: `Task ${task.key} depends on itself`,
			});
		for (const dep of task.dependencies)
			if (!plan.tasks.some((other) => other.key === dep))
				issues.push({
					code: "missing-dependency",
					message: `Task ${task.key} depends on unknown task ${dep}`,
				});
	}
	const cycle = hasCycle(
		plan.tasks.map((task) => ({
			key: task.key,
			dependsOn: task.dependencies,
		})),
	);
	if (cycle)
		issues.push({
			code: "dependency-cycle",
			message: `Dependency cycle detected: ${cycle.join(" -> ")}`,
		});
	return { ok: issues.length === 0, issues, plan: issues.length ? null : plan };
}
