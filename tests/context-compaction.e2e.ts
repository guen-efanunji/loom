import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";

const projectId = "e2e-context-project";
const sessionId = "ses_context_compaction";
const contextManagement = {
	mode: "handoff_only" as const,
	providerId: "agy",
	modelId: "fixture-model",
	contextWindowTokens: null,
	budgetTokens: 22_937,
	estimatedInputTokens: 9_420,
	estimateSource: "characters_divided_by_four" as const,
	budgetSource: "conservative_default" as const,
	compacted: true,
	compactionReason: "Estimated input exceeded the active context budget.",
	checkpointBoundary: {
		coveredMessageCount: 6,
		lastMessageId: "history-5",
		sourceReferences: [
			"history-0",
			"history-1",
			"history-2",
			"history-3",
			"history-4",
			"history-5",
		],
	},
	limitations: [
		"Token usage is estimated from characters divided by four, not an authoritative provider tokenizer.",
		"Loom controls the handoff packet; the provider's internal session context is opaque.",
	],
};

async function stubContextChat(browser: Browser) {
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-context-token");
		} catch {}
	});
	await browser.route("**/api/**", async (route) => {
		const { pathname } = new URL(route.request.url);
		let body: unknown = [];
		if (pathname === "/api/projects") {
			body = [
				{
					id: projectId,
					name: "Context project",
					path: "/tmp/context-project",
					defaultBranch: "main",
					createdAt: "2026-10-21T00:00:00.000Z",
				},
			];
		} else if (pathname === "/api/tasks" || pathname.startsWith("/api/agents"))
			body = [];
		else if (pathname === "/api/mcp/connections")
			body = {
				connections: [
					{
						id: "svelte-e2e",
						label: "Svelte MCP",
						transport: "streamable-http",
						status: "connected",
						endpointHost: "mcp.svelte.dev",
						argumentCount: 0,
						environmentReferenceNames: [],
						headerReferences: [],
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						tools: [],
						toolCount: 4,
						lastConnectedAt: Date.now(),
						lastTestedAt: Date.now(),
						lastError: null,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
				],
			};
		else if (pathname === `/api/projects/${projectId}/git`) body = null;
		else if (pathname === "/api/chat/catalog")
			body = { models: [], defaults: {}, agents: [], commands: [] };
		else if (pathname === "/api/chat/preferences")
			body = { favoriteModels: [] };
		else if (pathname === "/api/chat/sessions")
			body = [
				{
					id: sessionId,
					title: "Compaction evidence",
					directory: "/tmp/context-project",
					projectId,
					time: { updated: 1_800_000_000_000 },
				},
			];
		else if (pathname === `/api/chat/sessions/${sessionId}`) {
			body = {
				session: {
					id: sessionId,
					title: "Compaction evidence",
					directory: "/tmp/context-project",
					projectId,
					time: { updated: 1_800_000_000_000 },
				},
				messages: [
					{
						info: {
							id: "user-now",
							role: "user",
							time: { created: 1_800_000_000_000 },
						},
						parts: [
							{
								id: "user-now-text",
								type: "text",
								text: "Continue with the current request",
							},
						],
					},
					{
						info: {
							id: "assistant-now",
							role: "assistant",
							providerID: "agy",
							modelID: "fixture-model",
							contextManagement,
							time: {
								created: 1_800_000_000_001,
								completed: 1_800_000_000_100,
							},
						},
						parts: [
							{
								id: "assistant-now-text",
								type: "text",
								text: "I will continue using the validated context checkpoint and inspect current workspace evidence before acting.",
							},
						],
					},
				],
				status: { type: "idle" },
				permissions: [],
				questions: [],
			};
		} else if (pathname === "/api/events/replay")
			body = { events: [], cursor: 0, highWaterCursor: 0 };
		else if (pathname === "/api/bootstrap")
			body = { token: "e2e-context-token" };
		else if (pathname === "/api" || pathname === "/api/health")
			body = { ok: true };
		else if (route.request.method !== "GET") {
			await route.fulfill({
				status: 501,
				contentType: "application/json",
				body: JSON.stringify({ error: "Unexpected mutation" }),
			});
			return;
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
}

test("shows the Loom context checkpoint boundary, estimate source, and lossy-handoff limit", async ({
	app,
	browser,
	screen,
}) => {
	await stubContextChat(browser);
	await app.open(`/?project=${projectId}&session=${sessionId}`);
	await expect(screen.getByRole("region", "Context management")).toBeVisible();
	await expect(screen.getByText("Loom context · handoff only")).toBeVisible();
	await expect(
		screen.getByText("~9,420 / 22,937 estimated tokens"),
	).toBeVisible();
	await expect(
		screen.getByText(
			"Checkpoint covers 6 earlier messages. Original chat history is retained.",
		),
	).toBeVisible();
	await expect(
		screen.getByText(
			"Token usage is estimated from characters divided by four, not an authoritative provider tokenizer.",
		),
	).toBeVisible();
	await expect(
		screen.getByText(
			"I will continue using the validated context checkpoint and inspect current workspace evidence before acting.",
		),
	).toBeVisible();
	await expect(screen.getByText("MCP servers")).toBeVisible();
	await expect(screen.getByText("Svelte MCP")).toBeVisible();
	await expect(screen.getByText("connected")).toBeVisible();
	await expect(screen.getByText("Active tasks")).not.toBeVisible();
	await app.screenshot("context-compaction-chat-status");
});
