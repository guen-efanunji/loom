import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const projectId = "e2e-chat-project";
const sessionId = "ses_e2e_chat_lifecycle";
const projectDirectory = "/tmp/loom-e2e-chat-project";

function conversation(options: { busy?: boolean; text?: string; questions?: unknown[] } = {}) {
	return {
		session: {
			id: sessionId,
			title: "Lifecycle fixture chat",
			directory: projectDirectory,
			projectId,
			time: { updated: 1_800_000_000_200 },
		},
		messages: [
			{
				info: {
					id: "assistant-lifecycle-fixture",
					role: "assistant",
					providerID: "opencode",
					modelID: "fixture-model",
					time: { created: 1_800_000_000_100 },
				},
				parts: [
					{
						id: "assistant-lifecycle-text",
						type: "text",
						text: options.text ?? "Initial response text.",
					},
				],
			},
		],
		status: options.busy ? { type: "busy", message: "Working" } : { type: "idle" },
		permissions: [],
		questions: options.questions ?? [],
	};
}

async function stubWorkspace(
	browser: Browser,
	hooks: {
		state?: () => ReturnType<typeof conversation>;
		workspace?: () => Record<string, unknown>;
		questionReply?: (body: Record<string, unknown>) => void;
	} = {},
) {
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
		const { pathname } = new URL(request.url);
		let body: unknown = [];
		let status = 200;

		if (pathname === "/api/projects") {
			body = [{
				id: projectId,
				name: "E2E Chat Project",
				path: projectDirectory,
				defaultBranch: "main",
				autoAccept: false,
				createdAt: "2026-10-20T00:00:00.000Z",
			}];
		} else if (pathname === "/api/tasks" || pathname.startsWith("/api/agents")) {
			body = [];
		} else if (pathname === "/api/automation/settings") {
			body = { automationMode: "review" };
		} else if (pathname === `/api/projects/${projectId}/git`) {
			body = null;
		} else if (pathname === "/api/chat/catalog") {
			body = {
				models: [{
					providerID: "opencode",
					modelID: "fixture-model",
					name: "Fixture Model",
					provider: "OpenCode",
				}],
				defaults: {},
				agents: [{ name: "build", mode: "primary" }, { name: "plan", mode: "primary" }],
				commands: [],
			};
		} else if (pathname === "/api/chat/sessions") {
			body = [{
				id: sessionId,
				title: "Lifecycle fixture chat",
				directory: projectDirectory,
				projectId,
				time: { updated: 1_800_000_000_200 },
			}];
		} else if (pathname === `/api/chat/sessions/${sessionId}/children`) {
			body = [];
		} else if (pathname === `/api/chat/sessions/${sessionId}/workspace`) {
			body = hooks.workspace?.() ?? { mode: "shared", isolationAvailable: true };
		} else if (pathname === `/api/chat/sessions/${sessionId}`) {
			body = hooks.state?.() ?? conversation();
		} else if (pathname === `/api/chat/sessions/${sessionId}/status`) {
			const current = hooks.state?.() ?? conversation();
			body = {
				status: current.status,
				count: current.messages.length,
				lastMessageId: current.messages.at(-1)?.info.id ?? "",
				lastCompleted: null,
				busy: current.status.type === "busy",
				pendingPermissions: current.permissions.length,
				pendingQuestions: current.questions.length,
			};
		} else if (pathname === "/api/chat/preferences") {
			body = { favoriteModels: [] };
		} else if (pathname === "/api/events/replay") {
			body = { events: [], cursor: 0, highWaterCursor: 0 };
		} else if (pathname === "/api/bootstrap") {
			body = { token: "e2e-fixture-token" };
		} else if (pathname === "/api" || pathname === "/api/health") {
			body = { ok: true };
		} else if (
			pathname === `/api/chat/sessions/${sessionId}/question/fixture-question` &&
			request.method === "POST"
		) {
			hooks.questionReply?.(JSON.parse(request.postData ?? "{}") as Record<string, unknown>);
			body = {};
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

test("hydrates the authoritative isolated workspace when opening split chat", async ({
	app,
	browser,
	screen,
}) => {
	await stubWorkspace(browser, {
		workspace: () => ({
			mode: "isolated",
			sessionId,
			projectId,
			path: "/tmp/loom-worktrees/e2e-chat",
			branch: "loom/chat-e2e-chat",
			state: "ready",
			pendingChanges: true,
			integrated: false,
		}),
	});
	await app.open(`/?project=${projectId}&session=${sessionId}`);
	await expect(screen.getByText("Initial response text.")).toBeVisible();

	await screen.getByRole("button", "Open split chat").tap();
	await expect(screen.getByRole("region", "Split chat workspace")).toBeVisible();
	await expect(screen.getByText("loom/chat-e2e-chat")).toBeVisible();
	await expect(screen.getByText("Uncommitted output")).toBeVisible();
	await expect(screen.getByRole("button", "Merge into project")).toBeVisible();
});

test("renders clickable question choices and submits their selected value", async ({
	app,
	browser,
	screen,
}) => {
	let submitted: Record<string, unknown> | undefined;
	await stubWorkspace(browser, {
		state: () => conversation({
			busy: true,
			questions: [{
				id: "fixture-question",
				questions: [{
					header: "Implementation",
					question: "Which approach should I use?",
					options: [
						{ label: "Keep it simple", value: "simple", description: "Smallest change" },
						{ label: "Make it extensible", value: "extensible", description: "More flexible" },
					],
				}],
			}],
		}),
		questionReply: (body) => { submitted = body; },
	});
	await app.open(`/?project=${projectId}&session=${sessionId}`);
	await screen.getByRole("button", "Open split chat").tap();

	await expect(screen.getByText("Which approach should I use?")).toBeVisible();
	await screen.getByRole("radio", "Keep it simple Smallest change").tap();
	await screen.getByRole("button", "Send answers").tap();
	await expect.poll(() => submitted).toMatchObject({ answers: [["simple"]] });
});

test("shows a visible one-slot follow-up queue and lets the user cancel it", async ({
	app,
	browser,
	screen,
}) => {
	let sendCount = 0;
	await stubWorkspace(browser, {
		state: () => conversation({ busy: true, text: "Run in progress." }),
	});
	await browser.route(`**/api/chat/sessions/${sessionId}/messages`, async (route) => {
		if (route.request.method === "POST") sendCount++;
		await route.fulfill({ json: {} });
	});
	await app.open(`/?project=${projectId}&session=${sessionId}`);
	await screen.getByRole("button", "Open split chat").tap();

	const composer = screen.getByRole("textbox", "Message agent").nth(0);
	await composer.fill("Follow-up that should be queued");
	await screen.getByRole("button", "Send message").nth(0).tap();
	await expect(screen.getByText("One follow-up is queued and will send when this response finishes.")).toBeVisible();
	await expect.poll(() => sendCount).toBe(0);

	await screen.getByRole("button", "Cancel queued message").tap();
	await expect(screen.getByText("One follow-up is queued and will send when this response finishes.")).not.toBeVisible();
	await expect.poll(() => sendCount).toBe(0);
});

test("refreshes streamed assistant text in split chat while the message id stays the same", async ({
	app,
	browser,
	screen,
}) => {
	let streamedText = "Streaming response part one.";
	await stubWorkspace(browser, {
		state: () => conversation({ busy: true, text: streamedText }),
	});
	await app.open(`/?project=${projectId}&session=${sessionId}`);
	await expect(screen.getByText("Streaming response part one.")).toBeVisible();
	await screen.getByRole("button", "Open split chat").tap();
	streamedText = "Streaming response part two.";

	await expect(screen.getByText("Streaming response part two.")).toBeVisible();
});
