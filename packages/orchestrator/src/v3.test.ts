import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, orchestrationRepository, repositories } from "@loom/db";
import { MockAgentRuntime } from "@loom/opencode";
import { WorktreeManager } from "@loom/worktree";
import { git, snapshotWorkspace } from "./commands";
import { ContextBuilder, collectTaskArtifacts } from "./context";
import { EpicService } from "./epics";
import { getBlockedTasks, getRunnableTasks, validatePlan } from "./graph";
import { TaskOrchestrator } from "./index";
import { approveIntegration, IntegrationCoordinator } from "./integration";
import { parsePlannerOutput } from "./planner";

const roots: string[] = [];
function required<T>(value: T | undefined | null): T {
	if (value == null) throw new Error("Fixture value missing");
	return value;
}
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "loom-v3-"));
	roots.push(root);
	const path = join(root, "repo");
	await mkdir(path);
	await git(path, "init", "-b", "main");
	await git(path, "config", "user.name", "Loom test");
	await git(path, "config", "user.email", "test@localhost");
	await writeFile(join(path, "shared.txt"), "initial\n");
	await git(path, "add", ".");
	await git(path, "commit", "-m", "Initial");
	return { root, path, worktree: new WorktreeManager({ home: root }) };
}
const plan = {
	tasks: [
		{ key: "a", title: "A", prompt: "Create A", dependsOn: [] },
		{ key: "b", title: "B", prompt: "Create B", dependsOn: [] },
		{ key: "c", title: "C", prompt: "Verify A and B", dependsOn: ["a", "b"] },
	],
};

test("planner rejects malformed JSON, duplicate keys, missing nodes and cycles", () => {
	expect(() => parsePlannerOutput("not JSON")).toThrow();
	expect(() => validatePlan({ tasks: [plan.tasks[0], plan.tasks[0]] })).toThrow(
		"duplicate",
	);
	expect(() =>
		validatePlan({ tasks: [{ ...plan.tasks[0], dependsOn: ["missing"] }] }),
	).toThrow("missing");
	expect(() =>
		validatePlan({ tasks: [{ ...plan.tasks[0], dependsOn: ["a"] }] }),
	).toThrow("cycle");
	expect(parsePlannerOutput(JSON.stringify(plan))).toEqual(plan);
	const graph = plan.tasks.map((t) => ({
		id: t.key,
		dependsOn: t.dependsOn,
		projectId: "p",
		epicId: "e",
		status: "queued",
	}));
	expect(getRunnableTasks(graph).map((t) => t.id)).toEqual(["a", "b"]);
	required(graph[0]).status = "failed";
	expect(getBlockedTasks(graph)[0]?.blockedBy).toEqual(["a", "b"]);
});

test("artifacts are bounded, validated and cannot read a symlink outside the workspace", async () => {
	const { root, path } = await fixture();
	await mkdir(join(path, ".loom"));
	await writeFile(join(root, "outside.txt"), "private");
	await symlink(join(root, "outside.txt"), join(path, "escape.txt"));
	await writeFile(
		join(path, ".loom/artifacts.json"),
		JSON.stringify([{ type: "custom", path: "escape.txt", summary: "escape" }]),
	);
	await expect(collectTaskArtifacts("t", path)).rejects.toThrow("outside");
	await writeFile(
		join(path, ".loom/artifacts.json"),
		JSON.stringify([
			{ type: "decision", path: "shared.txt", summary: "Use shared state" },
		]),
	);
	expect((await collectTaskArtifacts("t", path))[0]?.path).toBe("shared.txt");
	const prompt = new ContextBuilder().build({
		prompt: "Implement",
		context: { summary: "x".repeat(16000), commands: {} },
		dependencies: [],
		artifacts: [],
	});
	expect(prompt.length).toBeLessThan(8000);
});

test("Epic plan is editable, independent tasks overlap, handoffs reach dependent task, and integration awaits approval", async () => {
	const { root, path, worktree } = await fixture();
	const db = createDb({ DATABASE_URL: `file:${join(root, "state.db")}` });
	const repos = repositories(db);
	const store = orchestrationRepository(db);
	const project = await repos.projects.create({
		name: "Fixture",
		path,
		defaultBranch: "main",
	});
	let active = 0;
	let peak = 0;
	let handedOff = false;
	class Runtime extends MockAgentRuntime {
		override async prompt(input: { sessionId: string; prompt: string }) {
			const session = required(this.sessions.get(input.sessionId));
			if (session.title === "Loom planner") {
				session.output = JSON.stringify(plan);
				session.status = "completed";
				return;
			}
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 30));
			if (session.title === "C") {
				expect(await readFile(join(session.cwd, "a.txt"), "utf8")).toBe("a");
				expect(await readFile(join(session.cwd, "b.txt"), "utf8")).toBe("b");
				handedOff =
					input.prompt.includes("a.txt") && input.prompt.includes("b.txt");
			}
			const key = session.title.toLowerCase();
			await writeFile(join(session.cwd, `${key}.txt`), key);
			await mkdir(join(session.cwd, ".loom"), { recursive: true });
			await writeFile(
				join(session.cwd, ".loom/artifacts.json"),
				JSON.stringify([
					{
						type: "documentation",
						path: `${key}.txt`,
						summary: `Contract ${key}`,
					},
				]),
			);
			session.status = "completed";
			session.output = "Completed";
			active--;
		}
	}
	const runtime = new Runtime();
	const tasks = new TaskOrchestrator({
		...repos,
		runtime,
		worktree,
		outputLog: { write: async () => {} },
	});
	const epics = new EpicService(
		store,
		repos,
		tasks,
		runtime,
		worktree,
		join(root, "context"),
	);
	tasks.setLifecycle(epics.hooks());
	const epic = await epics.create({
		projectId: project.id,
		title: "Feature",
		goal: "Build A and B then verify C",
	});
	await epics.idle(epic.id);
	expect((await store.get(epic.id))?.status).toBe("ready");
	expect(await repos.tasks.list()).toHaveLength(0);
	await epics.save(epic.id, plan, {
		summary: "Fixture",
		commands: {
			test: "test -f a.txt && test -f b.txt && test -f c.txt",
			lint: "git diff --check",
			build: "test -s c.txt",
		},
	});
	await epics.start(epic.id);
	await expect(epics.save(epic.id, plan)).rejects.toThrow("not editable");
	const members = await store.members(epic.id);
	await Promise.all(members.map((m) => tasks.getScheduler().wait(m.taskId)));
	await epics.idle(epic.id);
	expect(peak).toBe(2);
	expect(handedOff).toBe(true);
	const details = await epics.detail(epic.id);
	expect(details.artifacts).toHaveLength(3);
	expect(details.integrations[0]?.status).toBe("review");
	expect(details.integrations[0]?.checks).toHaveLength(3);
	expect(await git(path, "log", "--oneline")).not.toContain("Complete task");
	const integration = required(details.integrations[0]);
	await epics.approve(integration.id, required(integration.head));
	expect((await store.get(epic.id))?.status).toBe("completed");
	expect(await readFile(join(path, "c.txt"), "utf8")).toBe("c");
	expect((await store.events(epic.id)).map((e) => e.type)).toContain(
		"integration.approved",
	);
});

test("conflict resolver proposes a merged diff without changing main and approval rejects modified head", async () => {
	const { path, worktree } = await fixture();
	const base = await git(path, "rev-parse", "HEAD");
	const branches = [];
	for (const key of ["a", "b"]) {
		const w = await worktree.create({
			projectPath: path,
			projectId: "p",
			taskId: key,
		});
		await writeFile(join(w.path, "shared.txt"), key);
		await snapshotWorkspace(w.path, key);
		branches.push(w.branch);
	}
	class Resolver extends MockAgentRuntime {
		override async prompt(input: { sessionId: string; prompt: string }) {
			const session = required(this.sessions.get(input.sessionId));
			expect(input.prompt).toContain("Resolve ONLY");
			await writeFile(join(session.cwd, "shared.txt"), "a and b\n");
			session.status = "completed";
		}
	}
	const result = await new IntegrationCoordinator(
		worktree,
		new Resolver(),
	).integrate({
		id: "conflict",
		title: "Merge",
		project: { id: "p", path },
		branches,
		context: {
			summary: "",
			commands: { test: "grep -q 'a and b' shared.txt" },
		},
		artifacts: [],
	});
	expect(result.errorMessage).toBeNull();
	expect(result.status).toBe("review");
	expect(result.sessionId).toBeTruthy();
	expect(await git(path, "rev-parse", "HEAD")).toBe(base);
	expect(result.diff).toContain("+a and b");
	await expect(
		approveIntegration(worktree, result.workspace, "bad-head"),
	).rejects.toThrow("HEAD changed");
	await approveIntegration(worktree, result.workspace, result.head);
	expect(await readFile(join(path, "shared.txt"), "utf8")).toBe("a and b\n");
});

test("integration retains failing check logs and workspace if repair agent fails", async () => {
	const { path, worktree } = await fixture();
	class Broken extends MockAgentRuntime {
		override async prompt() {
			throw new Error("Agent unavailable");
		}
	}
	const result = await new IntegrationCoordinator(
		worktree,
		new Broken(),
	).integrate({
		id: "failure",
		title: "Fail",
		project: { id: "p", path },
		branches: [],
		context: { summary: "", commands: { test: "echo useful-failure; exit 1" } },
		artifacts: [],
	});
	expect(result.status).toBe("failed");
	expect(result.checks[0]?.output).toContain("useful-failure");
	expect(
		await readFile(join(result.workspace.path, "shared.txt"), "utf8"),
	).toBe("initial\n");
	expect(await readFile(join(path, "shared.txt"), "utf8")).toBe("initial\n");
});

test("integration repair is rechecked and both original failures and final checks are retained", async () => {
	const { path, worktree } = await fixture();
	class Repair extends MockAgentRuntime {
		override async prompt(input: { sessionId: string; prompt: string }) {
			expect(input.prompt).toContain("Failure logs");
			const session = required(this.sessions.get(input.sessionId));
			await writeFile(join(session.cwd, "shared.txt"), "repaired\n");
			session.status = "completed";
		}
	}
	const result = await new IntegrationCoordinator(
		worktree,
		new Repair(),
	).integrate({
		id: "repair",
		title: "Repair",
		project: { id: "p", path },
		branches: [],
		context: { summary: "", commands: { test: "grep -q repaired shared.txt" } },
		artifacts: [],
	});
	expect(result.status).toBe("review");
	expect(result.checks.map((c) => c.exitCode)).toEqual([1, 0]);
	expect(await readFile(join(path, "shared.txt"), "utf8")).toBe("initial\n");
	await writeFile(join(result.workspace.path, "unreviewed.txt"), "new");
	await expect(
		approveIntegration(worktree, result.workspace, result.head),
	).rejects.toThrow("unreviewed changes");
});
