import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const projectId = "e2e-chat-project";
const sessionId = "ses_e2e_chat_lifecycle";
const projectDirectory = "/tmp/loom-e2e-chat-project";

function conversation(
	options: {
		busy?: boolean;
		text?: string;
		questions?: unknown[];
		tool?: boolean;
		permissions?: Array<{ id: string; permission: string; patterns: string[] }>;
	} = {},
) {
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
					...(options.tool
						? [
								{
									id: "assistant-lifecycle-shell",
									type: "tool",
									tool: "bash",
									state: {
										status: "completed",
										input: { command: "printf loom-e2e" },
										output: "loom-e2e-output",
									},
								},
							]
						: []),
				],
			},
		],
		status: options.busy
			? { type: "busy", message: "Working" }
			: { type: "idle" },
		permissions: options.permissions ?? [],
		questions: options.questions ?? [],
	};
}

async function stubWorkspace(
	browser: Browser,
	hooks: {
		state?: () => ReturnType<typeof conversation>;
		workspace?: () => Record<string, unknown>;
		diff?: () => unknown[];
		questionReply?: (body: Record<string, unknown>) => void;
		restoreCheckpoint?: (messageId: string) => void;
		onRoute?: (
			pathname: string,
			method: string,
			postData: string | null,
		) => { status?: number; body: unknown } | undefined;
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

		const overridden = hooks.onRoute?.(
			pathname,
			request.method,
			request.postData ?? null,
		);
		if (overridden) {
			status = overridden.status ?? 200;
			body = overridden.body;
		} else if (pathname === "/api/projects") {
			body = [
				{
					id: projectId,
					name: "E2E Chat Project",
					path: projectDirectory,
					defaultBranch: "main",
					autoAccept: false,
					createdAt: "2026-10-20T00:00:00.000Z",
				},
			];
		} else if (
			pathname === "/api/tasks" ||
			pathname.startsWith("/api/agents")
		) {
			body = [];
		} else if (pathname === "/api/automation/settings") {
			body = { automationMode: "review" };
		} else if (pathname === `/api/projects/${projectId}/git`) {
			body = null;
		} else if (pathname === "/api/chat/catalog") {
			body = {
				models: [
					{
						providerID: "opencode",
						modelID: "fixture-model",
						name: "Fixture Model",
						provider: "OpenCode",
					},
					{
						providerID: "opencode",
						modelID: "alternate-model",
						name: "Alternate Model",
						provider: "OpenCode",
					},
				],
				defaults: {},
				agents: [
					{ name: "build", mode: "primary" },
					{ name: "plan", mode: "primary" },
				],
				commands: [],
			};
		} else if (pathname === "/api/chat/sessions") {
			body = [
				{
					id: sessionId,
					title: "Lifecycle fixture chat",
					directory: projectDirectory,
					projectId,
					time: { updated: 1_800_000_000_200 },
				},
			];
		} else if (pathname === `/api/chat/sessions/${sessionId}/children`) {
			body = [];
		} else if (pathname === `/api/chat/sessions/${sessionId}/workspace`) {
			body = hooks.workspace?.() ?? {
				mode: "shared",
				isolationAvailable: true,
			};
		} else if (pathname === `/api/chat/sessions/${sessionId}`) {
			body = hooks.state?.() ?? conversation();
		} else if (pathname === `/api/chat/sessions/${sessionId}/diff`) {
			body = hooks.diff?.() ?? [];
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
			pathname ===
				`/api/chat/sessions/${sessionId}/conversation-checkpoints/restore` &&
			request.method === "POST"
		) {
			const payload = JSON.parse(request.postData ?? "{}") as {
				messageId: string;
			};
			hooks.restoreCheckpoint?.(payload.messageId);
			body = { ok: true };
		} else if (
			pathname ===
				`/api/chat/sessions/${sessionId}/question/fixture-question` &&
			request.method === "POST"
		) {
			hooks.questionReply?.(
				JSON.parse(request.postData ?? "{}") as Record<string, unknown>,
			);
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

test("restores a conversation checkpoint without invoking workspace actions", async ({
	app,
	browser,
	screen,
}) => {
	let restoredMessageId = "";
	const state = conversation();
	state.messages.push({
		info: {
			id: "user-after-checkpoint",
			role: "user",
			time: { created: 1_800_000_000_200 },
		},
		parts: [
			{
				id: "user-after-checkpoint-text",
				type: "text",
				text: "Message after the checkpoint.",
			},
		],
	});
	await browser.addInitScript(() => {
		window.confirm = () => true;
	});
	await stubWorkspace(browser, {
		state: () => state,
		restoreCheckpoint: (messageId) => {
			restoredMessageId = messageId;
			state.messages.splice(1);
		},
	});
	await app.open(`/?project=${projectId}&session=${sessionId}`);
	await expect(screen.getByText("Initial response text.")).toBeVisible();
	await expect(screen.getByText("Message after the checkpoint.")).toBeVisible();

	await screen
		.getByRole("button", /Return conversation to/)
		.first()
		.tap();
	await expect
		.poll(() => restoredMessageId)
		.toBe("assistant-lifecycle-fixture");
	await expect(
		screen.getByText("Message after the checkpoint."),
	).not.toBeVisible();
});

test("selects a catalog model and thinking mode through the unified model selector", async ({
	app,
	browser,
	screen,
}) => {
	await stubWorkspace(browser);
	await app.open(`/?project=${projectId}&session=${sessionId}`);

	const modelSelector = screen.getByRole(
		"combobox",
		"Selected model: Fixture Model from OpenCode",
	);
	await modelSelector.tap();
	await screen.getByPlaceholder("Search models…").fill("Alternate Model");
	await screen.getByRole("option", /Alternate Model/).tap();
	await expect(
		screen.getByRole(
			"combobox",
			"Selected model: Alternate Model from OpenCode",
		),
	).toBeVisible();

	const thinkingSelector = screen.getByRole(
		"combobox",
		"Thinking mode: default",
	);
	await thinkingSelector.tap();
	await screen.getByRole("option", "High").tap();
	await expect(
		screen.getByRole("combobox", "Thinking mode: high"),
	).toBeVisible();
	await expect(
		screen.getByRole("button", "Browse models, favorites, and recent models"),
	).not.toBeVisible();
});

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
	await expect(
		screen.getByRole("region", "Split chat workspace"),
	).toBeVisible();
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
		state: () =>
			conversation({
				busy: true,
				questions: [
					{
						id: "fixture-question",
						questions: [
							{
								header: "Implementation",
								question: "Which approach should I use?",
								options: [
									{
										label: "Keep it simple",
										value: "simple",
										description: "Smallest change",
									},
									{
										label: "Make it extensible",
										value: "extensible",
										description: "More flexible",
									},
								],
							},
						],
					},
				],
			}),
		questionReply: (body) => {
			submitted = body;
		},
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
	await browser.route(
		`**/api/chat/sessions/${sessionId}/messages`,
		async (route) => {
			if (route.request.method === "POST") sendCount++;
			await route.fulfill({ json: {} });
		},
	);
	await app.open(`/?project=${projectId}&session=${sessionId}`);
	await screen.getByRole("button", "Open split chat").tap();

	const composer = screen.getByRole("textbox", "Message agent").nth(0);
	await composer.fill("Follow-up that should be queued");
	await screen.getByRole("button", "Send message").nth(0).tap();
	await expect(
		screen.getByText(
			"One follow-up is queued and will send when this response finishes.",
		),
	).toBeVisible();
	await expect.poll(() => sendCount).toBe(0);

	await screen.getByRole("button", "Cancel queued message").tap();
	await expect(
		screen.getByText(
			"One follow-up is queued and will send when this response finishes.",
		),
	).not.toBeVisible();
	await expect.poll(() => sendCount).toBe(0);
});

test("renders reasoning, shell output, and native queue through the activity elements", async ({
	app,
	browser,
	screen,
}) => {
	await stubWorkspace(browser, {
		state: () => {
			const state = conversation({ busy: true, tool: true });
			state.messages[0]!.parts.push(
				{
					id: "assistant-lifecycle-reasoning",
					type: "reasoning",
					text: "Checking the fixture.",
				},
				{
					id: "assistant-lifecycle-tool-error",
					type: "tool",
					tool: "custom_tool",
					state: {
						status: "error",
						input: { query: "fixture query" },
						output: "partial tool output",
						error: "fixture tool failure",
					},
				},
				{
					id: "assistant-lifecycle-todos",
					type: "tool",
					tool: "writeTodos",
					state: {
						status: "completed",
						input: {
							todos: [
								{
									id: "todo-e2e",
									content: "Verify output",
									status: "in_progress",
								},
							],
						},
					},
				},
			);
			return state;
		},
	});
	await app.open(`/?project=${projectId}&session=${sessionId}`);
	await screen.getByRole("button", "Open split chat").tap();
	await expect(screen.getByText("Checking the fixture.")).toBeVisible();
	await expect(screen.getByText("Ran printf loom-e2e")).toBeVisible();
	await screen.getByText("Ran printf loom-e2e").tap();
	await expect(screen.getByText("loom-e2e-output")).toBeVisible();
	const toolActivity = screen.getByRole("button", "Failed custom_tool Failed");
	await expect(toolActivity).toBeVisible();
	await expect(screen.getByText("partial tool output")).toBeVisible();
	await expect(screen.getByRole("alert")).toBeVisible();
	await expect(screen.getByText("fixture tool failure")).toBeVisible();
	await expect(screen.getByText("Verify output")).toBeVisible();
});

test("renders chain of thought, changed files, and stack frames from real tool data", async ({
	app,
	browser,
	screen,
}) => {
	await stubWorkspace(browser, {
		state: () => {
			const state = conversation();
			state.messages[0]!.parts.unshift(
				{
					id: "assistant-lifecycle-read-1",
					type: "tool",
					tool: "read",
					state: {
						status: "completed",
						input: { path: "src/app/page.tsx" },
					},
				},
				{
					id: "assistant-lifecycle-search-1",
					type: "tool",
					tool: "grep",
					state: {
						status: "completed",
						input: { pattern: "ThemeProvider" },
					},
				},
				{
					id: "assistant-lifecycle-edit-1",
					type: "tool",
					tool: "edit",
					state: {
						status: "completed",
						input: { path: "src/app/page.tsx" },
						metadata: {
							filediff: {
								file: "src/app/page.tsx",
								patch:
									'@@ -10,2 +10,3 @@\n-const title = "Old";\n+const title = "New";',
								additions: 3,
								deletions: 1,
							},
						},
					},
				},
				{
					id: "assistant-lifecycle-cli-edit-1",
					type: "tool",
					tool: "replace_file_content",
					state: {
						status: "completed",
						input: {
							TargetFile: "src/lib/banner.ts",
							TargetContent: 'export const banner = "old";',
							ReplacementContent:
								'export const banner = "new";\nexport const subtitle = "ok";',
						},
					},
				},
				{
					id: "assistant-lifecycle-stack-1",
					type: "tool",
					tool: "bash",
					state: {
						status: "error",
						input: { command: "bun run seed" },
						error: `TypeError: Cannot read properties of undefined (reading 'email')
    at seedUsers (prisma/seed.ts:27:34)
    at main (prisma/seed.ts:51:9)
    at Module._compile (node:internal/modules/cjs/loader:1554:14)`,
					},
				},
			);
			return state;
		},
	});
	await app.open(`/?project=${projectId}&session=${sessionId}`);

	// Chain of Thought: two research steps fold under one summary.
	await expect(screen.getByText(/Took 2 steps/)).toBeVisible();
	await screen.getByText(/Took 2 steps/).tap();
	// The CoT step repeats the read line below it, so take the first match.
	await expect(screen.getByText("Read page.tsx").first()).toBeVisible();

	// Edit tool: shows +3/-1 stats and expands into CodeBlock diff preview.
	const editRow = screen.getByRole("button", /Edited src\/app\/page\.tsx/);
	await expect(editRow.getByText("+3")).toBeVisible();
	await expect(editRow.getByText("−1")).toBeVisible();
	await editRow.tap();
	await expect(screen.getByText('const title = "New";')).toBeVisible();

	// CLI edit tool without explicit metadata still derives +2/-1 fallback stats & preview.
	const cliEditRow = screen.getByRole("button", /Edited src\/lib\/banner\.ts/);
	await expect(cliEditRow.getByText("+2")).toBeVisible();
	await expect(cliEditRow.getByText("−1")).toBeVisible();
	await cliEditRow.tap();
	await expect(screen.getByText('export const subtitle = "ok";')).toBeVisible();

	// Changed files: from real edit-tool metadata, as a folder tree.
	await expect(screen.getByText("Changed files")).toBeVisible();
	await expect(screen.getByText("page.tsx")).toBeVisible();

	// Stack Trace: only because the error actually contains stack frames.
	await expect(screen.getByText(/Failed: TypeError/)).toBeVisible();
	await expect(
		screen.getByText("seedUsers in prisma/seed.ts:27"),
	).toBeVisible();
	await expect(screen.getByText(/1 framework frame/)).toBeVisible();

	// Sources: no source-url parts in the fixture, so nothing renders.
	await expect(screen.getByText(/Used \d+ sources?/)).not.toBeVisible();
});

test("renders confirmation choices without replying until the user selects one", async ({
	app,
	browser,
	screen,
}) => {
	await stubWorkspace(browser, {
		state: () =>
			conversation({
				busy: true,
				permissions: [
					{
						id: "permission-fixture",
						permission: "shell",
						patterns: ["bun test"],
					},
				],
			}),
	});
	await app.open(`/?project=${projectId}&session=${sessionId}`);
	await screen.getByRole("button", "Open split chat").tap();

	await expect(
		screen.getByRole("group", "Confirmation required"),
	).toBeVisible();
	await expect(screen.getByText(/Allow this action\?/)).toBeVisible();
	await expect(screen.getByRole("button", "Accept once")).toBeVisible();
	await expect(screen.getByRole("button", "Decline")).toBeVisible();
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

test("hydrates +N/-M stats and CodeBlock diff from session /diff for Agy Path-only edit_file tools", async ({
	app,
	browser,
	screen,
}) => {
	const state = conversation();
	state.messages[0].info.providerID = "agy";
	state.messages[0].info.modelID = "gemini-4-hydrogen-high";
	state.messages[0].parts.push({
		id: "assistant-lifecycle-agy-path-edit",
		type: "tool",
		tool: "edit_file",
		state: {
			status: "completed",
			input: { Path: `${projectDirectory}/src/app.css` },
		},
	});
	await stubWorkspace(browser, {
		state: () => state,
		diff: () => [
			{
				file: "src/app.css",
				patch:
					"diff --git a/src/app.css b/src/app.css\n--- a/src/app.css\n+++ b/src/app.css\n@@ -1,2 +1,3 @@\n-font-size: 16px;\n+font-size: 17px;\n+line-height: 1.5;",
				additions: 2,
				deletions: 1,
			},
		],
	});
	await app.open(`/?project=${projectId}&session=${sessionId}`);

	const agyEditRow = screen.getByRole(
		"button",
		new RegExp(`Edited ${projectDirectory}/src/app\\.css`),
	);
	await expect(agyEditRow.getByText("+2")).toBeVisible();
	await expect(agyEditRow.getByText("−1")).toBeVisible();
	await agyEditRow.tap();
	await expect(screen.getByText("font-size: 17px;")).toBeVisible();
	await app.screenshot("chat-lifecycle-agy-path-edit-diff");
});

test("PlanDialog sends active model, shows live progress, supports cancel, and converts validated tasks", async ({
	app,
	browser,
	screen,
}) => {
	const createdPayloads: Array<Record<string, unknown>> = [];
	const cancelledIds: string[] = [];
	let detailPolls = 0;
	let currentPlanId = "plan-1";
	let planStage: "draft" | "validated" | "converted" = "draft";

	await stubWorkspace(browser, {
		onRoute(pathname, method, postData) {
			if (pathname === "/api/plans" && method === "POST") {
				createdPayloads.push(JSON.parse(postData ?? "{}"));
				currentPlanId = `plan-${createdPayloads.length}`;
				detailPolls = 0;
				planStage = "draft";
				return {
					status: 202,
					body: { planId: currentPlanId, status: "draft" },
				};
			}
			if (
				pathname === `/api/plans/${currentPlanId}/cancel` &&
				method === "POST"
			) {
				cancelledIds.push(currentPlanId);
				return { body: { cancelled: true } };
			}
			if (pathname === `/api/plans/${currentPlanId}` && method === "GET") {
				detailPolls += 1;
				if (createdPayloads.length === 2 && detailPolls >= 2) {
					planStage = "validated";
				}
				return {
					body: {
						plan: {
							id: currentPlanId,
							projectId,
							sourceMessageId: "assistant-lifecycle-fixture",
							sourceMessage: "Initial response text.",
							sourceSessionId: sessionId,
							startedAt: null,
							cancelledAt: null,
							title: "Implement feature",
							summary: "Structured tasks from answer.",
							status: planStage === "draft" ? "draft" : "validated",
							convertedAt:
								planStage === "converted" ? "2026-11-25T10:00:00Z" : null,
							approvedAt: null,
							errorMessage: null,
							createdAt: "2026-11-25T10:00:00Z",
						},
						draft:
							planStage === "draft"
								? []
								: [
										{
											id: "pt-1",
											planId: currentPlanId,
											key: "step-1",
											title: "Wire plan runtime",
											description: "Route planner by selected model.",
											priority: "high",
											dependencies: [],
											acceptanceCriteria: ["Planner uses active provider"],
											suggestedFiles: ["apps/server/src/index.ts"],
										},
									],
						tasks: [],
						validation: { ok: true, issues: [] },
						progress: {
							total: 0,
							done: 0,
							running: 0,
							ready: 0,
							blocked: 0,
							failed: 0,
							percent: 0,
						},
						activity:
							planStage === "draft"
								? { phase: "generating", startedAt: Date.now() }
								: null,
					},
				};
			}
			if (pathname === `/api/plans/${currentPlanId}` && method === "PATCH") {
				return { body: { saved: true } };
			}
			if (
				pathname === `/api/plans/${currentPlanId}/validate` &&
				method === "POST"
			) {
				return { body: { ok: true, issues: [] } };
			}
			if (
				pathname === `/api/plans/${currentPlanId}/approve` &&
				method === "POST"
			) {
				return { body: { approved: true } };
			}
			if (
				pathname === `/api/plans/${currentPlanId}/tasks` &&
				method === "POST"
			) {
				planStage = "converted";
				return { status: 201, body: { taskIds: ["task-1"], converted: true } };
			}
			return undefined;
		},
	});

	await app.open(`/?project=${projectId}&session=${sessionId}`);
	await expect(screen.getByText("Initial response text.")).toBeVisible();

	// 1. Open dialog, verify active model + live status, then cancel mid-generation.
	await screen.getByRole("button", "Add to Kanban").tap();
	await expect(screen.getByText("Add to Kanban board")).toBeVisible();
	await expect(screen.getByText("Fixture Model (OpenCode)")).toBeVisible();
	await expect
		.poll(
			() => createdPayloads[0]?.model as Record<string, unknown> | undefined,
		)
		.toEqual({ providerID: "opencode", modelID: "fixture-model" });
	await expect(screen.getByText("Generating structured tasks…")).toBeVisible();
	await screen.getByRole("button", "Cancel").tap();
	await expect.poll(() => cancelledIds).toEqual(["plan-1"]);

	// 2. Re-open dialog and let it validate and convert to Kanban tasks.
	await screen.getByRole("button", "Add to Kanban").tap();
	await expect(screen.getByText("Plan title")).toBeVisible();
	await screen.getByRole("button", "Add to board").tap();
	await expect(screen.getByText("Tasks added to the board")).toBeVisible();
});
