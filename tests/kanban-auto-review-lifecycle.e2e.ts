import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";

const projectId = "e2e-kanban-review-project";
const projectDirectory = "/tmp/loom-kanban-review-e2e-project";
const backendAgentId = "backend-agent-1";
const frontendAgentId = "frontend-agent-1";
const reviewerAgentId = "reviewer-agent-1";

type FixtureTask = {
	id: string;
	title: string;
	prompt: string;
	status: string;
	executor: { kind: "agent"; agentId: string };
	startedAt: string | null;
	completedAt: string | null;
	blockedBy: string[];
	projectId: string;
	planId: null;
	description: string;
	priority: string;
	acceptanceCriteria: string[];
	suggestedFiles: string[];
	source: string;
	position: number;
	targetBranch: string;
	workspaceId: string | null;
	sessionId: string | null;
	createdAt: string;
};

type Timeline = Record<
	string,
	Array<{ at: number; status: string; repairPrompt?: boolean }>
>;

const titles = {
	beRace: "Backend · fix race condition",
	beApi: "Backend · add API validation",
	feForm: "Frontend · build signup form",
	feMobile: "Frontend · improve mobile layout",
	stalled: "Backend · stalled provider run",
};

function baseTask(
	id: string,
	title: string,
	prompt: string,
	agentId: string,
	status: string,
	index: number,
): FixtureTask {
	return {
		id,
		title,
		prompt,
		status,
		executor: { kind: "agent", agentId },
		startedAt: null,
		completedAt: null,
		blockedBy: [],
		projectId,
		planId: null,
		description: prompt,
		priority: "high",
		acceptanceCriteria: ["Changes are isolated and verified"],
		suggestedFiles: [],
		source: "manual",
		position: index,
		targetBranch: "main",
		workspaceId: null,
		sessionId: null,
		createdAt: `2026-10-20T00:0${index}:00.000Z`,
	};
}

function scenarioTasks(): FixtureTask[] {
	return [
		baseTask(
			"task-backend-race",
			titles.beRace,
			"Fix the race condition in the shared queue and add a regression check.",
			backendAgentId,
			"queued",
			0,
		),
		baseTask(
			"task-backend-api",
			titles.beApi,
			"Implement API validation without editing frontend files.",
			backendAgentId,
			"ready",
			1,
		),
		baseTask(
			"task-frontend-form",
			titles.feForm,
			"Build the signup form and keep changes in frontend files.",
			frontendAgentId,
			"ready",
			2,
		),
		baseTask(
			"task-frontend-mobile",
			titles.feMobile,
			"Improve the mobile layout and add an accessibility check.",
			frontendAgentId,
			"queued",
			3,
		),
	];
}

const repairPromptMarker = "Repair round 1 of 2";

// Automatic review lifecycle driven through polling: the reviewer agent
// approves clean work after the review gate, but the race-condition task gets
// one findings-backed repair round before it may reach Done.
const timeline: Timeline = {
	"task-backend-race": [
		{ at: 1, status: "ready_to_merge" },
		{ at: 2, status: "running", repairPrompt: true },
		{ at: 5, status: "ready_to_merge" },
		{ at: 6, status: "completed" },
	],
	"task-backend-api": [
		{ at: 1, status: "ready_to_merge" },
		{ at: 3, status: "completed" },
	],
	"task-frontend-form": [
		{ at: 2, status: "ready_to_merge" },
		{ at: 4, status: "completed" },
	],
	"task-frontend-mobile": [
		{ at: 3, status: "ready_to_merge" },
		{ at: 5, status: "completed" },
	],
};

const reviewPolicy = {
	projectId,
	mode: "automatic",
	reviewerExecutorJson: JSON.stringify({
		kind: "agent",
		agentId: reviewerAgentId,
	}),
	autoMerge: false,
	requiredChecksJson: "[]",
	maxRevisionRounds: 2,
	version: 1,
	updatedAt: "2026-10-20T00:00:00.000Z",
};

class StubWorkspace {
	currentTasks: FixtureTask[] = scenarioTasks();
	pollsSinceRun = -1;
	startedTaskIds: string[] = [];

	advancePoll() {
		if (this.pollsSinceRun < 0) return;
		this.pollsSinceRun += 1;
		for (const [taskId, steps] of Object.entries(timeline)) {
			const task = this.currentTasks.find((item) => item.id === taskId);
			if (!task) continue;
			for (const step of steps) {
				if (step.at > this.pollsSinceRun) break;
				if (step.repairPrompt && !task.prompt.includes(repairPromptMarker)) {
					task.prompt = `${task.prompt}\n\n${repairPromptMarker} — the reviewer requested changes. Fix only these findings returned by the reviewer:\n- [high] backend-race.txt · BUG_RACE: the shared queue is updated without a lock. Suggested action: protect the update with a mutex before the next checkpoint.`;
				}
				task.status = step.status;
				if (step.status === "running")
					task.startedAt = "2026-10-20T00:06:00.000Z";
				if (step.status === "completed")
					task.completedAt = "2026-10-20T00:12:00.000Z";
			}
		}
	}
}

async function stubWorkspace(browser: Browser) {
	const workspace = new StubWorkspace();
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-fixture-token");
		} catch {
			// The runner may evaluate this script before the app origin exists.
		}
	});

	const agents = [
		{
			id: backendAgentId,
			label: "BACKEND",
			role: "backend",
			status: "active",
			allowChat: true,
			allowCanvas: false,
			allowKanban: true,
			approvalPolicy: "manual",
			projectId,
			provider: "opencode",
			modelId: "opencode/glm-5.3-flash-free",
			lastUsedAt: null,
		},
		{
			id: frontendAgentId,
			label: "FRONTEND",
			role: "frontend",
			status: "active",
			allowChat: true,
			allowCanvas: false,
			allowKanban: true,
			approvalPolicy: "manual",
			projectId,
			provider: "opencode",
			modelId: "opencode/glm-5.3-flash-free",
			lastUsedAt: null,
		},
		{
			id: reviewerAgentId,
			label: "REVIEWER",
			role: "fullstack",
			status: "active",
			allowChat: false,
			allowCanvas: false,
			allowKanban: true,
			approvalPolicy: "read_only",
			projectId,
			provider: "opencode",
			modelId: "opencode/glm-5.3-flash-free",
			lastUsedAt: null,
		},
	];

	await browser.route("**/api/**", async (route) => {
		const request = route.request;
		const url = new URL(request.url);
		const path = url.pathname;
		let body: unknown = [];
		let status = 200;

		if (path === "/api/projects" && request.method === "GET") {
			body = [
				{
					id: projectId,
					name: "Auto review E2E project",
					path: projectDirectory,
					defaultBranch: "main",
					autoAccept: false,
					createdAt: "2026-10-20T00:00:00.000Z",
				},
			];
		} else if (path === "/api/tasks" && request.method === "GET") {
			workspace.advancePoll();
			body = workspace.currentTasks;
		} else if (path === "/api/projects" && request.method !== "GET") {
			status = 501;
		} else if (/^\/api\/tasks\/[^/]+$/.test(path) && request.method === "GET") {
			const id = path.split("/").at(-1) ?? "";
			const task = workspace.currentTasks.find((item) => item.id === id);
			body = task ?? {};
			if (!task) status = 404;
		} else if (
			/^\/api\/tasks\/[^/]+\/start$/.test(path) &&
			request.method === "POST"
		) {
			const id = path.split("/").at(-2) ?? "";
			workspace.startedTaskIds.push(id);
			const task = workspace.currentTasks.find((item) => item.id === id);
			if (task) {
				task.status = "running";
				task.startedAt = "2026-10-20T00:05:00.000Z";
				task.sessionId = `session-${id}`;
				task.workspaceId = `workspace-${id}`;
			}
			if (workspace.pollsSinceRun < 0 && workspace.startedTaskIds.length >= 4)
				workspace.pollsSinceRun = 0;
			body = { accepted: true };
		} else if (/^\/api\/tasks\/[^/]+\/runs$/.test(path)) {
			const id = path.split("/").at(-2) ?? "";
			const task = workspace.currentTasks.find((item) => item.id === id);
			body = task?.startedAt
				? [
						{
							id: `run-${id}`,
							taskId: id,
							status:
								task.status === "completed"
									? "completed"
									: task.status === "running"
										? "running"
										: "queued",
							startedAt: task.startedAt,
							completedAt: task.completedAt,
							errorMessage: null,
							retryOfRunId: null,
						},
					]
				: [];
		} else if (/^\/api\/tasks\/[^/]+\/output$/.test(path)) {
			const id = path.split("/").at(-2) ?? "";
			const task = workspace.currentTasks.find((item) => item.id === id);
			body = {
				output: task?.prompt?.includes(repairPromptMarker)
					? "Repair round 1 of 2: protecting the shared queue update with a lock, then rerun checks.\n"
					: "Agent progress: inspecting the task workspace before editing files.\n",
				truncated: false,
				activities: [
					{
						id: `read-${id}`,
						tool: "read_file",
						status: "completed",
						input: { path: `${projectDirectory}/login.html` },
					},
					{
						id: `edit-${id}`,
						tool: "edit_file",
						status: "completed",
						input: { filePath: `${projectDirectory}/login.html` },
						metadata: {
							filediff: {
								file: `${projectDirectory}/login.html`,
								additions: 4,
								deletions: 1,
							},
						},
					},
				],
			};
		} else if (/^\/api\/tasks\/[^/]+\/diff$/.test(path)) {
			body = {
				diff: "diff --git a/login.html b/login.html\nindex a1..a2\n--- a/login.html\n+++ b/login.html\n@@ -1,1 +1,2 @@\n+<h1>Login</h1>\n",
			};
		} else if (/^\/api\/tasks\/[^/]+\/reviews$/.test(path)) {
			body = { reviews: [] };
		} else if (
			/^\/api\/tasks\/[^/]+\/review\/run$/.test(path) &&
			request.method === "POST"
		) {
			body = { review: { id: "fixture-review", status: "approved" } };
		} else if (/^\/api\/permissions$/.test(path)) {
			body = [];
		} else if (/^\/api\/projects\/[^/]+\/review-policy$/.test(path)) {
			body = { policy: reviewPolicy, autoMergeAvailable: false };
		} else if (/^\/api\/projects\/[^/]+\/git$/.test(path)) {
			body = {
				branch: "master",
				defaultBranch: "main",
				branches: ["main", "master"],
				gitAvailable: true,
			};
		} else if (/^\/api\/integration-batches$/.test(path)) {
			body = { batches: [] };
		} else if (/^\/api\/automation\/settings$/.test(path)) {
			body = { automationMode: "review" };
		} else if (/^\/api\/agents$/.test(path)) {
			body = agents;
		} else if (/^\/api\/chat\/catalog$/.test(path)) {
			body = {
				models: [
					{
						providerID: "opencode",
						modelID: "glm-5.3-flash-free",
						name: "GLM 5.3 Flash",
						provider: "OpenCode",
					},
				],
				defaults: {},
				agents: [{ name: "build", mode: "primary" }],
				commands: [],
			};
		} else if (/^\/api\/chat\/sessions$/.test(path)) {
			body = [];
		} else if (/^\/api\/chat\/preferences$/.test(path)) {
			body = { favoriteModels: [] };
		} else if (/^\/api\/events\/replay$/.test(path)) {
			body = { events: [], cursor: 0, highWaterCursor: 0 };
		} else if (/^\/api\/bootstrap$/.test(path)) {
			body = { token: "e2e-fixture-token" };
		} else if (path === "/api" || path === "/api/health") {
			body = { ok: true };
		} else if (request.method !== "GET") {
			status = 501;
		}

		await route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});

	return workspace;
}

test("runs two Backend and two Frontend tasks together, auto-repairs the race bug, and the reviewer agent moves passing work to Done", async ({
	app,
	browser,
	screen,
}) => {
	const workspace = await stubWorkspace(browser);
	await app.open(`/?project=${projectId}&view=kanban`);

	// The review gate is automatic and is bound to the dedicated REVIEWER
	// agent, while BACKEND and FRONTEND carry the implementation work.
	await expect(screen.getByRole("heading", "Backlog")).toBeVisible();
	await screen.getByRole("button", "Task review mode").tap();
	await expect(screen.getByRole("option", "Automatic review")).toBeVisible();
	await screen.getByRole("option", "Automatic review").tap();
	await expect(screen.getByRole("button", "Reviewer agent")).toBeVisible();
	await expect(
		screen.getByText("REVIEWER · opencode / opencode/glm-5.3-flash-free"),
	).toBeVisible();
	await app.screenshot("kanban-auto-review-configured");

	await screen.getByRole("checkbox", `Select ${titles.beRace} to run`).check();
	await screen.getByRole("checkbox", `Select ${titles.beApi} to run`).check();
	await screen.getByRole("checkbox", `Select ${titles.feForm} to run`).check();
	await screen
		.getByRole("checkbox", `Select ${titles.feMobile} to run`)
		.check();
	await expect(screen.getByRole("button", "Run 4 selected")).toBeVisible();
	await screen.getByRole("button", "Run 4 selected").tap();
	await expect(
		screen.getByText(
			"4 tasks queued · Loom will run eligible tasks in parallel",
		),
	).toBeVisible();
	expect(workspace.startedTaskIds.sort()).toEqual([
		"task-backend-api",
		"task-backend-race",
		"task-frontend-form",
		"task-frontend-mobile",
	]);
	await app.screenshot("kanban-four-parallel-queued");

	// The workspace follows the started tasks into chat run tabs; switch back
	// to the board to watch the four runs and the review gate together.
	await screen.getByRole("tab", "Kanban").tap();

	// All four tasks advance together — a run per task in its own session —
	// and the reviewer agent gates each one before it may reach Done.
	const done = screen.getByRole("region", "Done column");
	await expect(done.getByText(titles.beApi)).toBeVisible({ timeout: 20_000 });
	await expect(done.getByText(titles.feForm)).toBeVisible({ timeout: 20_000 });
	await expect(done.getByText(titles.feMobile)).toBeVisible({
		timeout: 20_000,
	});
	// The race task fails review once, comes back with a findings-backed
	// repair prompt, and only then passes review.
	await expect(done.getByText(titles.beRace)).toBeVisible({ timeout: 20_000 });
	await app.screenshot("kanban-reviewed-work-moved-to-done");
});

test("sends reviewer findings back to the Backend agent as a repair prompt for the next round", async ({
	app,
	browser,
	screen,
}) => {
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-fixture-token");
		} catch {
			// The runner may evaluate this script before the app origin exists.
		}
	});
	await browser.route("**/api/**", async (route) => {
		const path = new URL(route.request.url).pathname;
		if (path === "/api/tasks/task-backend-race") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					id: "task-backend-race",
					title: titles.beRace,
					prompt: `Fix the race condition in the shared queue and add a regression check.\n\n${repairPromptMarker} of 2 — fix only these findings returned by the reviewer:\n- [high] backend-race.txt · BUG_RACE: the shared queue is updated without a lock.`,
					status: "running",
					executor: { kind: "agent", agentId: backendAgentId },
					startedAt: "2026-10-20T00:06:00.000Z",
					completedAt: null,
					blockedBy: [],
					projectId,
					planId: null,
					description: "repair",
					priority: "high",
					acceptanceCriteria: [],
					suggestedFiles: [],
					source: "manual",
					position: 0,
					targetBranch: "main",
					workspaceId: "workspace-race",
					sessionId: "session-race",
					createdAt: "2026-10-20T00:00:00.000Z",
				}),
			});
			return;
		}
		if (/^\/api\/tasks\/[^/]+\/output$/.test(path)) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					output:
						"Repair round 1 of 2: protecting the shared queue update with a lock before the next checkpoint.\n",
					truncated: false,
					activities: [],
				}),
			});
			return;
		}
		if (/^\/api\/tasks\/[^/]+\/runs$/.test(path)) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([
					{
						id: "run-race",
						taskId: "task-backend-race",
						status: "running",
						startedAt: "2026-10-20T00:06:00.000Z",
						completedAt: null,
						errorMessage: null,
						retryOfRunId: null,
					},
				]),
			});
			return;
		}
		if (/^\/api\/tasks\/[^/]+\/reviews$/.test(path)) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ reviews: [] }),
			});
			return;
		}
		if (/^\/api\/tasks\/[^/]+\/diff$/.test(path)) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ diff: "" }),
			});
			return;
		}
		if (/^\/api\/tasks\/[^/]+\/artifacts$/.test(path)) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ artifacts: [] }),
			});
			return;
		}
		if (/^\/api\/tasks\/[^/]+\/dependencies$/.test(path)) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ dependencies: [] }),
			});
			return;
		}
		if (path === "/api/agents") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([
					{
						id: backendAgentId,
						label: "BACKEND",
						role: "backend",
						status: "active",
						allowChat: false,
						allowCanvas: false,
						allowKanban: true,
						approvalPolicy: "manual",
						projectId,
						provider: "opencode",
						modelId: "opencode/glm-5.3-flash-free",
						lastUsedAt: null,
					},
				]),
			});
			return;
		}
		if (path === "/api/events/replay") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ events: [], cursor: 0, highWaterCursor: 0 }),
			});
			return;
		}
		if (path === "/api/bootstrap") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ token: "e2e-fixture-token" }),
			});
			return;
		}
		if (path === "/api" || path === "/api/health") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify([]),
		});
	});
	await app.open("/task/task-backend-race");

	await expect(screen.getByRole("heading", titles.beRace)).toBeVisible();
	await expect(screen.getByText(/Repair round 1 of 2/).first()).toBeVisible();
	await expect(screen.getByText(/BUG_RACE/).first()).toBeVisible();
	await expect(
		screen.getByText("Agent is running this task").first(),
	).toBeVisible();
	await app.screenshot("kanban-repair-prompt-round-1");
});

test("surfaces a stalled provider run as failed with the watchdog reason instead of running forever", async ({
	app,
	browser,
	screen,
}) => {
	const stalledTask = baseTask(
		"task-backend-stalled",
		titles.stalled,
		"Follow the project theme on the login page.",
		backendAgentId,
		"failed",
		4,
	);
	stalledTask.startedAt = "2026-10-20T00:05:00.000Z";
	stalledTask.completedAt = "2026-10-20T00:11:00.000Z";
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-fixture-token");
		} catch {
			// The runner may evaluate this script before the app origin exists.
		}
	});
	await browser.route("**/api/**", async (route) => {
		const path = new URL(route.request.url).pathname;
		if (path === "/api/tasks/task-backend-stalled") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(stalledTask),
			});
			return;
		}
		if (path === "/api/tasks/task-backend-stalled/runs") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([
					{
						id: "run-stalled",
						taskId: "task-backend-stalled",
						status: "failed",
						startedAt: "2026-10-20T00:05:00.000Z",
						completedAt: "2026-10-20T00:11:00.000Z",
						errorMessage:
							"OpenCode stopped reporting status for this session without an assistant response. Check that the selected provider and model are available in OpenCode, then retry the task.",
						retryOfRunId: null,
					},
				]),
			});
			return;
		}
		if (path === "/api/tasks/task-backend-stalled/reviews") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ reviews: [] }),
			});
			return;
		}
		if (path === "/api/tasks/task-backend-stalled/diff") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ diff: "" }),
			});
			return;
		}
		if (path === "/api/agents") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([
					{
						id: backendAgentId,
						label: "BACKEND",
						role: "backend",
						status: "active",
						allowChat: false,
						allowCanvas: false,
						allowKanban: true,
						approvalPolicy: "manual",
						projectId,
						provider: "opencode",
						modelId: "opencode/glm-5.3-flash-free",
						lastUsedAt: null,
					},
				]),
			});
			return;
		}
		if (path === "/api/events/replay") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ events: [], cursor: 0, highWaterCursor: 0 }),
			});
			return;
		}
		if (path === "/api/bootstrap") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ token: "e2e-fixture-token" }),
			});
			return;
		}
		if (path === "/api" || path === "/api/health") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify([]),
		});
	});
	await app.open("/task/task-backend-stalled");

	await expect(screen.getByRole("heading", titles.stalled)).toBeVisible();
	await expect(screen.getByText("Failed").first()).toBeVisible();
	await expect(
		screen.getByText(/OpenCode stopped reporting status/).first(),
	).toBeVisible({ timeout: 10_000 });
	await expect(screen.getByRole("button", "Retry").first()).toBeVisible();
	await app.screenshot("kanban-stalled-run-failed-with-watchdog-reason");
});
