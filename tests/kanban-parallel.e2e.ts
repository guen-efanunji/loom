import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";

const projectId = "e2e-kanban-project";
const projectDirectory = "/tmp/loom-kanban-e2e-project";
const reviewerAgentId = "516de927-f55e-4787-9150-c81cfd61dc36";

const tasks = [
	{
		id: "backend-api-task",
		title: "Backend · add API validation",
		prompt: "Implement API validation without editing frontend files.",
		executor: { kind: "agent", agentId: "backend-agent" },
		status: "ready",
	},
	{
		id: "backend-race-task",
		title: "Backend · fix race condition",
		prompt: "Fix the race condition and add a regression check.",
		executor: { kind: "agent", agentId: "backend-agent" },
		status: "queued",
	},
	{
		id: "frontend-form-task",
		title: "Frontend · build signup form",
		prompt: "Build the signup form and keep changes in frontend files.",
		executor: { kind: "agent", agentId: "frontend-agent" },
		status: "ready",
	},
	{
		id: "frontend-mobile-task",
		title: "Frontend · improve mobile layout",
		prompt: "Improve the mobile layout and add an accessibility check.",
		executor: { kind: "agent", agentId: "frontend-agent" },
		status: "queued",
	},
	{
		id: "review-race-task",
		title: "Backend · race condition repair candidate",
		prompt: "A reviewer should verify the repaired locking behavior.",
		executor: { kind: "agent", agentId: "backend-agent" },
		status: "ready_to_merge",
	},
].map((task, index) => ({
	blockedBy: [],
	projectId,
	planId: null,
	description: task.prompt,
	priority: "high",
	acceptanceCriteria: ["Changes are isolated and verified"],
	suggestedFiles: [],
	source: "manual",
	position: index,
	targetBranch: "main",
	workspaceId: null,
	sessionId: null,
	createdAt: `2026-10-20T00:0${index}:00.000Z`,
	startedAt: null,
	completedAt: null,
	...task,
}));

const reviewPolicy = {
	projectId,
	mode: "automatic",
	reviewerExecutorJson: JSON.stringify({ kind: "agent", agentId: reviewerAgentId }),
	autoMerge: false,
	requiredChecksJson: "[]",
	maxRevisionRounds: 3,
	version: 1,
	updatedAt: "2026-10-20T00:00:00.000Z",
};

async function stubKanbanWorkspace(browser: Browser) {
	let currentTasks = tasks;
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-fixture-token");
		} catch {
			// The runner may evaluate this script before the app origin exists.
		}
	});

	await browser.route("**/api/**", async (route) => {
		const request = route.request;
		const url = new URL(request.url);
		const path = url.pathname;
		let body: unknown = [];
		let status = 200;

		if (path === "/api/projects") {
			body = [{
				id: projectId,
				name: "Parallel E2E Project",
				path: projectDirectory,
				defaultBranch: "main",
				autoAccept: false,
				createdAt: "2026-10-20T00:00:00.000Z",
			}];
		} else if (path === "/api/tasks") {
			body = currentTasks;
		} else if (path === `/api/tasks/${tasks[1].id}`) {
			body = {
				...tasks[1],
				status: "running",
				startedAt: "2026-10-20T00:05:00.000Z",
				sessionId: "task-detail-session",
			};
		} else if (path === `/api/tasks/${tasks[1].id}/reviews`) {
			body = { reviews: [] };
		} else if (path === `/api/tasks/${tasks[1].id}/diff`) {
			body = { diff: "diff --git a/login.html b/login.html\\n" };
		} else if (path === `/api/tasks/${tasks[1].id}/runs`) {
			body = [];
		} else if (path === `/api/projects/${projectId}/review-policy`) {
			body = { policy: reviewPolicy, autoMergeAvailable: false };
		} else if (path === `/api/projects/${projectId}/git`) {
			body = null;
		} else if (path === "/api/integration-batches") {
			body = { batches: [] };
		} else if (path === "/api/automation/settings") {
			body = { automationMode: "review" };
		} else if (path === "/api/chat/catalog") {
			body = {
				models: [{ providerID: "agy", modelID: "fixture-model", name: "Fixture model", provider: "Antigravity" }],
				defaults: {},
				agents: [{ name: "build", mode: "primary" }],
				commands: [],
			};
		} else if (path === "/api/chat/sessions") {
			body = [];
		} else if (path === "/api/agents") {
			body = [{
				id: reviewerAgentId,
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
			}];
		} else if (path === "/api/chat/preferences") {
			body = { favoriteModels: [] };
		} else if (path === "/api/events/replay") {
			body = { events: [], cursor: 0, highWaterCursor: 0 };
		} else if (path === "/api/bootstrap") {
			body = { token: "e2e-fixture-token" };
		} else if (path === "/api" || path === "/api/health") {
			body = { ok: true };
		} else if (/^\/api\/tasks\/[^/]+\/start$/.test(path) && request.method === "POST") {
			const taskId = path.split("/").at(-2);
			currentTasks = currentTasks.map((task) => task.id === taskId ? { ...task, status: "running", startedAt: "2026-10-20T00:05:00.000Z" } : task);
			body = { accepted: true };
		} else if (/^\/api\/tasks\/[^/]+\/output$/.test(path)) {
			body = {
				output: "Agent progress: inspecting the task workspace\nFound the relevant files; implementing the requested change now.\n",
				truncated: false,
				activities: [
					{ id: "read-login", tool: "read_file", status: "completed", input: { path: "/tmp/loom-kanban-e2e-project/login.html" } },
					{ id: "edit-login", tool: "edit_file", status: "completed", input: { filePath: "/tmp/loom-kanban-e2e-project/login.html" }, metadata: { filediff: { file: "/tmp/loom-kanban-e2e-project/login.html", additions: 12, deletions: 3 } } },
					{ id: "run-check", tool: "run_command", status: "running", input: { command: "bun test", cwd: "/tmp/loom-kanban-e2e-project" } },
				],
			};
		} else if (/^\/api\/tasks\/[^/]+\/review\/run$/.test(path) && request.method === "POST") {
			body = { review: { id: "approved-fixture-review", status: "approved" } };
		} else if (request.method !== "GET") {
			status = 501;
		}

		await route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
}

test("queues two Backend and two Frontend tasks together from Kanban", async ({ app, browser, screen }) => {
	const startedTaskIds: string[] = [];
	await stubKanbanWorkspace(browser);
	await browser.route("**/api/tasks/*/start", async (route) => {
		if (route.request.method === "POST") {
			startedTaskIds.push(new URL(route.request.url).pathname.split("/").at(-2) ?? "");
		}
		return route.fallback();
	});
	await app.open(`/?project=${projectId}&view=kanban`);

	await expect(screen.getByRole("heading", "Backlog")).toBeVisible();
	await expect(screen.getByRole("heading", "Ready")).not.toBeVisible();
	await expect(screen.getByText("Backend · add API validation")).toBeVisible();
	await expect(screen.getByText("Backend · fix race condition")).toBeVisible();
	await expect(screen.getByText("Frontend · build signup form")).toBeVisible();
	await expect(screen.getByText("Frontend · improve mobile layout")).toBeVisible();
	await screen.getByRole("checkbox", "Select Backend · add API validation to run").check();
	await screen.getByRole("checkbox", "Select Backend · fix race condition to run").check();
	await screen.getByRole("checkbox", "Select Frontend · build signup form to run").check();
	await screen.getByRole("checkbox", "Select Frontend · improve mobile layout to run").check();
	await expect(screen.getByRole("button", "Run 4 selected")).toBeVisible();
	await app.screenshot("kanban-parallel-four-tasks-selected");

	await screen.getByRole("button", "Run 4 selected").tap();
	await expect(screen.getByText("4 tasks queued · Loom will run eligible tasks in parallel")).toBeVisible();
	expect(startedTaskIds.sort()).toEqual([
		"backend-api-task",
		"backend-race-task",
		"frontend-form-task",
		"frontend-mobile-task",
	]);
	await app.screenshot("kanban-parallel-tasks-queued");
});

test("offers an automated review action for a task awaiting review", async ({ app, browser, screen }) => {
	let reviewedTaskId = "";
	await stubKanbanWorkspace(browser);
	await browser.route("**/api/tasks/*/review/run", async (route) => {
		if (route.request.method === "POST") {
			reviewedTaskId = new URL(route.request.url).pathname.split("/").at(-3) ?? "";
		}
		return route.fallback();
	});
	await app.open(`/?project=${projectId}&view=kanban`);

	await expect(screen.getByText("BACKEND · opencode / opencode/glm-5.3-flash-free")).toBeVisible();
	await expect(screen.getByText(reviewerAgentId)).toBeHidden();
	await expect(screen.getByText("Backend · race condition repair candidate")).toBeVisible();
	await expect(screen.getByRole("button", "Review & fix")).toBeVisible();
	await app.screenshot("kanban-automatic-review-available");
	await screen.getByRole("button", "Review & fix").tap();
	await expect(screen.getByText("Review passed · task is ready for integration")).toBeVisible();
	expect(reviewedTaskId).toBe("review-race-task");
	await app.screenshot("kanban-automatic-review-passed");
});

test("opens a live task run in a Chat tab and preserves the user's chat draft", async ({ app, browser, screen }) => {
	await stubKanbanWorkspace(browser);
	await app.open(`/?project=${projectId}`);
	const composer = screen.getByPlaceholder("Ask anything… @ for files and agents");
	await composer.fill("Keep this draft while I check the task run.");
	await screen.getByRole("tab", "Kanban").tap();
	await screen.getByRole("button", "Run").nth(1).tap();

	await expect(screen.getByRole("heading", "Agent progress")).toBeVisible();
	await expect(screen.getByRole("heading", "Backend · fix race condition")).toBeVisible();
	await expect(screen.getByText("Fix the race condition and add a regression check.")).toBeVisible();
	await expect(screen.getByText(/Found the relevant files; implementing the requested change now\./).first()).toBeVisible();
	const toolActivity = screen.getByRole("list", "Agent tool activity");
	await expect(toolActivity).toBeVisible();
	await expect(screen.getByText("/tmp/loom-kanban-e2e-project/login.html").first()).toBeVisible();
	await expect(screen.getByText("+12")).toBeVisible();
	await expect(screen.getByText("−3")).toBeVisible();
	await expect(screen.getByText("bun test").first()).toBeVisible();
	await app.screenshot("kanban-task-run-chat-progress");

	await screen.getByRole("tab", "New chat").tap();
	await expect(screen.getByPlaceholder("Ask anything… @ for files and agents")).toHaveValue("Keep this draft while I check the task run.");
	await app.screenshot("kanban-task-run-parent-chat-draft-preserved");
});

test("shows live tool activity on the task detail page without orchestration jargon", async ({ app, browser, screen }) => {
	await stubKanbanWorkspace(browser);
	await app.open(`/task/${tasks[1].id}`);

	await expect(screen.getByRole("heading", "Backend · fix race condition")).toBeVisible();
	await expect(screen.getByRole("heading", "Agent progress")).toBeVisible();
	await expect(screen.getByRole("list", "Agent tool activity")).toBeVisible();
	await expect(screen.getByText("/tmp/loom-kanban-e2e-project/login.html").first()).toBeVisible();
	await expect(screen.getByText("+12")).toBeVisible();
	await expect(screen.getByText("−3")).toBeVisible();
	await expect(screen.getByText("bun test").first()).toBeVisible();
	await expect(screen.getByText("Task dependencies")).toBeHidden();
	await expect(screen.getByText("Published artifacts")).toBeHidden();
	await app.screenshot("task-detail-live-agent-progress");
});

test("opens the Kanban view and live task progress from the Agents & tasks panel", async ({ app, browser, screen }) => {
	await stubKanbanWorkspace(browser);
	await app.open(`/?project=${projectId}`);
	const agentsPanel = screen.getByRole("button", "Agents & tasks");
	if ((await agentsPanel.getAttribute("aria-pressed")) !== "true") await agentsPanel.tap();
	await expect(screen.getByText("Tasks")).toBeVisible();
	await screen.getByRole("button", "Open board").last().tap();
	await expect(screen.getByRole("tab", "Kanban")).toHaveAttribute("aria-selected", "true");
	await expect(screen.getByText("Tasks · Parallel E2E Project")).toBeVisible();
	await expect(browser).toHaveURL(new RegExp(`project=${projectId}.*view=kanban`));

	await screen.getByRole("button", "Run").nth(1).tap();
	await expect(screen.getByRole("heading", "Agent progress")).toBeVisible();
	if ((await agentsPanel.getAttribute("aria-pressed")) !== "true") await agentsPanel.tap();
	await screen.getByRole("button", "Open Backend · fix race condition progress in chat").tap();
	await expect(screen.getByRole("heading", "Backend · fix race condition")).toBeVisible();
	await expect(browser).toHaveURL(/\?project=e2e-kanban-project/);
	await app.screenshot("kanban-agent-panel-opens-live-chat-tab");
});
