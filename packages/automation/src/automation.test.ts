import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAutomationContext } from "./context-builder";
import { convertPlanTasks } from "./converter";
import { RuntimePlanner } from "./planner";
import { buildPlannerPrompt } from "./prompt";
import { validateAutomationPlan } from "./validator";

const task = (overrides: Record<string, unknown> = {}) => ({
	key: "hero",
	title: "Implement hero section",
	description: "Create the hero layout.",
	priority: "high" as const,
	dependencies: [],
	acceptanceCriteria: ["Hero uses min-height 72vh"],
	suggestedFiles: ["index.html"],
	...overrides,
});

const plan = (tasks: unknown[]) => ({
	title: "Landing page",
	summary: "Build the landing page.",
	tasks,
});

test("accepts a valid plan", () => {
	const result = validateAutomationPlan(
		plan([
			task(),
			task({
				key: "styles",
				title: "Design tokens",
				dependencies: ["hero"],
			}),
		]),
	);
	expect(result.ok).toBe(true);
	expect(result.plan?.tasks).toHaveLength(2);
});

test("rejects duplicate keys, missing deps, self-deps, and cycles", () => {
	expect(
		validateAutomationPlan(plan([task(), task()])).issues.some(
			(issue) => issue.code === "duplicate-key",
		),
	).toBe(true);
	expect(
		validateAutomationPlan(
			plan([task({ dependencies: ["ghost"] })]),
		).issues.some((issue) => issue.code === "missing-dependency"),
	).toBe(true);
	expect(
		validateAutomationPlan(
			plan([task({ dependencies: ["hero"] })]),
		).issues.some((issue) => issue.code === "self-dependency"),
	).toBe(true);
	const cyclic = validateAutomationPlan(
		plan([
			task({ key: "a", dependencies: ["b"] }),
			task({ key: "b", dependencies: ["a"] }),
		]),
	);
	expect(cyclic.issues.some((issue) => issue.code === "dependency-cycle")).toBe(
		true,
	);
	expect(
		validateAutomationPlan(
			plan([task({ acceptanceCriteria: [] })]),
		).issues.some((issue) => issue.code === "missing-acceptance-criteria"),
	).toBe(true);
	expect(validateAutomationPlan(plan([])).ok).toBe(false);
	expect(validateAutomationPlan("not json shaped").ok).toBe(false);
});

test("maps plan tasks to persistable inputs", () => {
	const [converted] = convertPlanTasks([
		{
			...task(),
			dependencies: ["tokens"],
			parallelGroup: "sections",
		},
	]);
	expect(converted?.key).toBe("hero");
	expect(converted?.dependsOn).toEqual(["tokens"]);
	expect(converted?.prompt).toBe(converted?.description);
	expect(converted?.acceptanceCriteria).toEqual(["Hero uses min-height 72vh"]);
});

test("builds a bounded planner prompt", () => {
	const prompt = buildPlannerPrompt({
		message: "Build the landing page. Do not add dark mode.",
		context: {
			projectName: "aroma",
			stack: ["node", "sveltekit"],
			packageManager: "bun",
			files: ["package.json", "src/routes/+page.svelte"],
			scripts: { test: "bun test" },
			currentBranch: "main",
		},
	});
	expect(prompt).toContain("Do not add dark mode");
	expect(prompt).toContain("sveltekit");
	expect(prompt).toContain("src/routes/+page.svelte");
});

test("builds project context without dumping the repository", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-automation-"));
	try {
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				packageManager: "bun@1.2.0",
				scripts: { test: "bun test" },
				dependencies: { svelte: "^5.0.0" },
			}),
		);
		await writeFile(join(root, ".gitignore"), "node_modules\n");
		const context = await buildAutomationContext(root, "aroma");
		expect(context.projectName).toBe("aroma");
		expect(context.packageManager).toBe("bun");
		expect(context.stack).toContain("svelte");
		expect(context.scripts.test).toBe("bun test");
		expect(context.files.length).toBeLessThanOrEqual(200);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

type FakeSession = { prompts: string[]; output: string; status: string };
function fakeRuntime(responses: string[]) {
	const sessions = new Map<string, FakeSession & { id: string }>();
	let next = 0;
	return {
		sessions,
		async createSession() {
			const id = `session-${++next}`;
			sessions.set(id, { id, prompts: [], output: "", status: "running" });
			return { id };
		},
		async prompt(input: { sessionId: string; prompt: string }) {
			const session = sessions.get(input.sessionId);
			if (!session) throw new Error("missing session");
			session.prompts.push(input.prompt);
			const response =
				responses[Math.min(session.prompts.length - 1, responses.length - 1)] ??
				"";
			session.output = response;
			session.status = "completed";
		},
		async status(sessionId: string) {
			return (sessions.get(sessionId)?.status ?? "failed") as "completed";
		},
		async readOutput(sessionId: string) {
			return { output: sessions.get(sessionId)?.output ?? "" };
		},
		async wait() {
			return "completed" as const;
		},
		async abort() {},
		async getDiff() {
			return [];
		},
	};
}

const context = {
	projectName: "aroma",
	stack: ["node"],
	files: [],
	scripts: {},
};

test("planner returns validated output directly", async () => {
	const runtime = fakeRuntime([JSON.stringify(plan([task()]))]);
	const planner = new RuntimePlanner(runtime, "/tmp/aroma");
	const result = await planner.createPlan({
		projectId: "project-1",
		message: "Build it",
		context,
	});
	expect(result.tasks).toHaveLength(1);
	expect([...runtime.sessions.values()][0]?.prompts).toHaveLength(1);
});

test("planner repairs invalid output once, then fails", async () => {
	const runtime = fakeRuntime([
		JSON.stringify(plan([task(), task()])),
		JSON.stringify(plan([task()])),
	]);
	const planner = new RuntimePlanner(runtime, "/tmp/aroma");
	const result = await planner.createPlan({
		projectId: "project-1",
		message: "Build it",
		context,
	});
	expect(result.tasks).toHaveLength(1);
	expect([...runtime.sessions.values()][0]?.prompts).toHaveLength(2);
	const broken = fakeRuntime([
		JSON.stringify(plan([task(), task()])),
		JSON.stringify(plan([task(), task()])),
	]);
	await expect(
		new RuntimePlanner(broken, "/tmp/aroma").createPlan({
			projectId: "project-1",
			message: "Build it",
			context,
		}),
	).rejects.toThrow("after repair");
});
