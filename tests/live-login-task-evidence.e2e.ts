import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const projectId = "bc79e403-04fd-4d7f-a19f-4f340670cf94";
const projectDirectory = "/tmp/loom-login-e2e-project";
const feTitle = "FE: Build responsive login page";
const backendTitle = "BACKEND: Implement demo login API";
const feTaskId = "login-fe-task";
const backendTaskId = "login-backend-task";

async function useLiveLoom(browser: Browser) {
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
		} catch {
			// The script can run before the app origin is available.
		}
	});
}

async function stubLoginWorkspace(browser: Browser, runningTitle?: string) {
	let currentTasks = [feTaskId, backendTaskId].map((id, index) => {
		const title = index === 0 ? feTitle : backendTitle;
		return {
			blockedBy: [],
			projectId,
			planId: null,
			prompt: "Implement the login slice end to end.",
			description: "Implement the login slice end to end.",
			priority: "high",
			acceptanceCriteria: ["The login flow works end to end"],
			suggestedFiles: [],
			source: "manual",
			position: index,
			targetBranch: "main",
			workspaceId: null,
			sessionId: null,
			createdAt: `2026-11-05T00:0${index}:00.000Z`,
			startedAt: title === runningTitle ? "2026-11-05T00:05:00.000Z" : null,
			completedAt: null,
			id,
			title,
			executor: {
				kind: "agent",
				agentId: index === 0 ? "fe-agent" : "backend-agent",
			},
			status: title === runningTitle ? "running" : "queued",
		};
	});
	await browser.route("**/api/**", async (route) => {
		const request = route.request;
		const url = new URL(request.url);
		const path = url.pathname;
		let body: unknown = [];
		let status = 200;

		if (path === "/api/projects") {
			body = [
				{
					id: projectId,
					name: "Login Demo Project",
					path: projectDirectory,
					defaultBranch: "main",
					autoAccept: false,
					createdAt: "2026-11-05T00:00:00.000Z",
				},
			];
		} else if (path === "/api/tasks") {
			body = currentTasks;
		} else if (/^\/api\/tasks\/[^/]+\/start$/.test(path)) {
			const taskId = path.split("/").at(-2);
			currentTasks = currentTasks.map((task) =>
				task.id === taskId
					? {
							...task,
							status: "running",
							startedAt: "2026-11-05T00:05:00.000Z",
							sessionId: "login-task-session",
						}
					: task,
			);
			status = 202;
			body = currentTasks.find((task) => task.id === taskId);
		} else if (/^\/api\/tasks\/[^/]+$/.test(path)) {
			const taskId = path.split("/").at(-1);
			const task = currentTasks.find((item) => item.id === taskId);
			if (task) body = { ...task, sessionId: "login-task-session" };
			else status = 404;
		} else if (/^\/api\/tasks\/[^/]+\/output$/.test(path)) {
			body = { output: "", truncated: false, activities: [] };
		} else if (/^\/api\/tasks\/[^/]+\/runs$/.test(path)) {
			body = [];
		} else if (/^\/api\/tasks\/[^/]+\/reviews$/.test(path)) {
			body = { reviews: [] };
		} else if (/^\/api\/tasks\/[^/]+\/diff$/.test(path)) {
			body = { diff: "" };
		} else if (path === `/api/projects/${projectId}/review-policy`) {
			body = {
				policy: {
					projectId,
					mode: "manual",
					reviewerExecutorJson: null,
					autoMerge: false,
					requiredChecksJson: "[]",
					maxRevisionRounds: 3,
					version: 1,
					updatedAt: "2026-11-05T00:00:00.000Z",
				},
				autoMergeAvailable: false,
			};
		} else if (path === `/api/projects/${projectId}/git`) {
			body = null;
		} else if (path === "/api/integration-batches") {
			body = { batches: [] };
		} else if (path === "/api/automation/settings") {
			body = { automationMode: "review" };
		} else if (path === "/api/chat/catalog") {
			body = {
				models: [
					{
						providerID: "agy",
						modelID: "fixture-model",
						name: "Fixture model",
						provider: "Antigravity",
					},
				],
				defaults: {},
				agents: [{ name: "build", mode: "primary" }],
				commands: [],
			};
		} else if (path === "/api/chat/sessions") {
			body = [];
		} else if (path === "/api/agents") {
			body = [
				{
					id: "fe-agent",
					label: "Frontend Runner",
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
					id: "backend-agent",
					label: "Backend Runner",
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
			];
		} else if (path === "/api/chat/preferences") {
			body = { favoriteModels: [] };
		} else if (path === "/api/events/replay") {
			body = { events: [], cursor: 0, highWaterCursor: 0 };
		} else if (path === "/api/bootstrap") {
			body = { token: "e2e-fixture-token" };
		} else if (path === "/api" || path === "/api/health") {
			body = { ok: true };
		} else if (path === "/api/mcp/connections") {
			body = { connections: [] };
		} else if (path === "/api/permissions") {
			body = [];
		}

		await route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
}

async function openTaskProgress(
	app: {
		open: (url: string) => Promise<unknown>;
		screenshot: (name: string) => Promise<unknown>;
	},
	browser: Browser,
	screen: any,
	runningTitle: string,
	title: string,
	screenshotName: string,
) {
	await useLiveLoom(browser);
	await stubLoginWorkspace(browser, runningTitle);
	await app.open(`/?project=${projectId}`);
	const agentsPanel = screen.getByRole("button", "Agents & tasks");
	await expect(agentsPanel).toBeVisible();
	if ((await agentsPanel.getAttribute("aria-pressed")) !== "true")
		await agentsPanel.tap();
	const progressLink = screen
		.getByRole("article")
		.filter({ hasText: `Working on · ${runningTitle}` })
		.getByRole("button", "View live progress in chat");
	await expect(progressLink).toBeVisible();
	await progressLink.tap();
	await expect(screen.getByRole("heading", title)).toBeVisible();
	await expect(screen.getByText("Agent progress")).toBeVisible();
	await app.screenshot(screenshotName);
}

test("capture both login tasks on the project Kanban board", async ({
	app,
	browser,
	screen,
}) => {
	await useLiveLoom(browser);
	await stubLoginWorkspace(browser);
	await app.open(`/?project=${projectId}&view=kanban`);
	await expect(screen.getByText(feTitle)).toBeVisible();
	await expect(screen.getByText(backendTitle)).toBeVisible();
	await app.screenshot("login-e2e-kanban-tasks");
});

test("capture the FE task running in its Chat progress tab", async ({
	app,
	browser,
	screen,
}) => {
	await openTaskProgress(
		app,
		browser,
		screen,
		feTitle,
		feTitle,
		"login-e2e-fe-chat-progress",
	);
});

test("capture the BACKEND task running in its Chat progress tab", async ({
	app,
	browser,
	screen,
}) => {
	await openTaskProgress(
		app,
		browser,
		screen,
		backendTitle,
		backendTitle,
		"login-e2e-backend-chat-progress",
	);
});

test("capture the registered FE and BACKEND agents and active task panel", async ({
	app,
	browser,
	screen,
}) => {
	await useLiveLoom(browser);
	await stubLoginWorkspace(browser, feTitle);
	await app.open(`/?project=${projectId}`);
	const agentsPanel = screen.getByRole("button", "Agents & tasks");
	await expect(agentsPanel).toBeVisible();
	if ((await agentsPanel.getAttribute("aria-pressed")) !== "true")
		await agentsPanel.tap();
	await expect(screen.getByText("Running tasks")).toBeVisible();
	await expect(screen.getByText("Frontend Runner")).toBeVisible();
	await expect(screen.getByText("Backend Runner")).toBeVisible();
	const frontendCard = screen
		.getByRole("article")
		.filter({ hasText: "Frontend Runner" });
	await expect(
		frontendCard.getByText(`Working on · ${feTitle}`).first(),
	).toBeVisible();
	await expect(
		frontendCard.getByRole("button", "View live progress in chat"),
	).toBeVisible();
	await expect(screen.getByText("Registered agents")).toBeVisible();
	await app.screenshot("login-e2e-running-agents-panel");
});
