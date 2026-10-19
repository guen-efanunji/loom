import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";

const projectId = "e2e-project";
const parentId = "ses_e2e_parent";
const childId = "ses_e2e_child";
const projectDirectory = "/tmp/loom-e2e-project";

const userMessage = {
	info: {
		id: "user-e2e-request",
		role: "user",
		time: { created: 1_800_000_000_000 },
	},
	parts: [{ id: "user-e2e-text", type: "text", text: "Build a small feature" }],
};

const assistantMessage = {
	info: {
		id: "assistant-e2e-response",
		role: "assistant",
		providerID: "agy",
		modelID: "fixture-model",
		time: { created: 1_800_000_000_100, completed: 1_800_000_000_200 },
	},
	parts: [
		{
			id: "todo-event-e2e",
			type: "tool",
			tool: "update_plan",
			state: {
				status: "completed",
				title: "Updated plan",
				input: {
					todos: [
						{ id: "inspect", content: "Inspect the relevant UI", status: "completed" },
						{ id: "implement", content: "Implement the feature", status: "in_progress" },
						{ id: "verify", content: "Verify the result", status: "pending" },
					],
				},
			},
		},
		{ id: "assistant-e2e-text", type: "text", text: "The feature is underway." },
	],
};

function state(sessionId: string, parentID?: string) {
	return {
		session: {
			id: sessionId,
			title: sessionId === parentId ? "Parent chat" : "Explore child",
			directory: projectDirectory,
			projectId,
			...(parentID ? { parentID } : {}),
			time: { updated: 1_800_000_000_200 },
		},
		messages: sessionId === parentId ? [userMessage, assistantMessage] : [],
		status: { type: "idle" },
		permissions: [],
		questions: [],
	};
}

async function stubWorkspace(browser: Browser) {
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-fixture-token");
		} catch {
			// The runner also evaluates init scripts on about:blank before the app origin exists.
		}
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
					name: "E2E Project",
					path: projectDirectory,
					defaultBranch: "main",
					autoAccept: false,
					createdAt: "2026-10-20T00:00:00.000Z",
				},
			];
		} else if (path === "/api/tasks" || path.startsWith("/api/agents")) {
			body = [];
		} else if (path === "/api/automation/settings") {
			body = { automationMode: "review" };
		} else if (path === `/api/projects/${projectId}/git`) {
			body = null;
		} else if (path === "/api/chat/catalog") {
			body = {
				models: [],
				defaults: {},
				agents: [
					{ name: "build", mode: "primary" },
					{ name: "plan", mode: "primary" },
				],
				commands: [],
			};
		} else if (path === "/api/chat/sessions") {
			body = [
				{
					id: parentId,
					title: "Parent chat",
					directory: projectDirectory,
					projectId,
					time: { updated: 1_800_000_000_200 },
				},
			];
		} else if (path === `/api/chat/sessions/${parentId}/children`) {
			body = [
				{
					id: childId,
					title: "Explore child",
					parentID: parentId,
					time: { updated: 1_800_000_000_300 },
					status: { type: "idle" },
				},
			];
		} else if (path === `/api/chat/sessions/${parentId}`) {
			body = state(parentId);
		} else if (path === `/api/chat/sessions/${childId}`) {
			body = state(childId, parentId);
		} else if (path === "/api/plans" && request.method === "POST") {
			body = { planId, status: "draft" };
		} else if (path === "/api/chat/preferences") {
			body = { favoriteModels: [] };
		} else if (path === "/api/events/replay") {
			body = { events: [], cursor: 0, highWaterCursor: 0 };
		} else if (path === "/api/bootstrap") {
			body = { token: "e2e-fixture-token" };
		} else if (path === "/api" || path === "/api/health") {
			body = { ok: true };
		} else {
			// Keep unrelated optional chat panels inert; unexpected mutations still fail loudly.
			if (request.method !== "GET") status = 501;
		}

		await route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
}

test("shows runtime todos and lets a user focus a child then return to its parent", async ({ app, browser, screen }) => {
	await stubWorkspace(browser);
	await app.open(`/?project=${projectId}&session=${parentId}`);

	await expect(screen.getByText("Todo progress")).toBeVisible();
	await expect(screen.getByText("Reported by runtime")).toBeVisible();
	await expect(screen.getByText("Inspect the relevant UI")).toBeVisible();
	await expect(screen.getByText("completed")).toBeVisible();
	await expect(screen.getByText("Implement the feature")).toBeVisible();
	await expect(screen.getByText("in progress")).toBeVisible();
	await expect(screen.getByText("Child sessions (1)")).toBeVisible();
	await app.screenshot("adaptive-todos-parent");
	const composer = screen.getByRole("textbox", "Message agent");
	await composer.fill("Keep this parent draft while I inspect the child");
	await screen.getByText("Child sessions (1)").tap();

	await screen.getByRole("button", "Focus").tap();
	await expect(screen.getByText("Focused child session")).toBeVisible();
	await expect(screen.getByRole("button", "Back to parent chat")).toBeVisible();
	await app.screenshot("adaptive-child-focused");

	await screen.getByRole("button", "Back to parent chat").tap();
	await expect(screen.getByText("Todo progress")).toBeVisible();
	await expect(screen.getByText("Child sessions (1)")).toBeVisible();
	await expect(composer).toHaveValue("Keep this parent draft while I inspect the child");
	await app.screenshot("adaptive-child-return-parent-draft");
});

test("does not invent todo progress when the runtime reports no structured todos", async ({ app, browser, screen }) => {
	await stubWorkspace(browser);
	await browser.route(`**/api/chat/sessions/${parentId}`, async (route) => {
		const noTodoState = state(parentId);
		noTodoState.messages = [
			userMessage,
			{
				...assistantMessage,
				parts: [{ id: "assistant-e2e-text-only", type: "text", text: "A direct answer." }],
			},
		];
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(noTodoState),
		});
	});
	await app.open(`/?project=${projectId}&session=${parentId}`);

	await expect(screen.getByText("A direct answer.")).toBeVisible();
	await expect(screen.getByText("Todo progress")).not.toBeVisible();
	await app.screenshot("adaptive-no-runtime-todos");
});

test("keeps planning in chat when the user selects Plan mode", async ({ app, browser, screen }) => {
	let chatRequest: Record<string, unknown> | undefined;
	let taskMutationCount = 0;
	await stubWorkspace(browser);
	await browser.route("**/api/tasks", async (route) => {
		if (route.request.method === "POST") taskMutationCount++;
		return route.fallback();
	});
	await browser.route(`**/api/chat/sessions/${parentId}/messages`, async (route) => {
		if (route.request.method !== "POST") return route.fallback();
		chatRequest = JSON.parse(route.request.postData ?? "{}") as Record<string, unknown>;
		await route.fulfill({ json: {} });
	});
	await app.open(`/?project=${projectId}&session=${parentId}`);

	await screen.getByRole("button", "Chat mode: build").tap();
	await screen.getByRole("option", "plan").tap();
	await expect(screen.getByRole("button", "Chat mode: plan")).toBeVisible();
	await expect(screen.getByText("plan", { exact: true })).toBeVisible();
	const composer = screen.getByRole("textbox", "Message agent");
	await composer.fill("Build a small feature");
	await app.screenshot("adaptive-plan-mode-stays-in-chat");
	await screen.getByRole("button", "Send message").tap();
	expect(chatRequest).toMatchObject({
		text: "Build a small feature",
		agent: "plan",
	});
	await expect(browser).toHaveURL(new RegExp(`session=${parentId}`));
	await expect(screen.getByText("Review proposed plan")).not.toBeVisible();
	expect(taskMutationCount).toBe(0);
});
