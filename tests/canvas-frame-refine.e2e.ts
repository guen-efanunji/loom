import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Canvas frame + refine E2E. The daemon-side lifecycle test proves a design
 * generates, refines in place and keeps its animation CSS; this one proves the
 * canvas actually honours the node's own design space (a 9:16 story is drawn as
 * a 9:16 card, not letterboxed into a web viewport) and that the two user
 * actions that change a design - refine and re-pick the canvas - reach the API.
 */

const projectId = "e2e-canvas-frame-project";
const nodeId = "design-e2e-frame-node";
const project = {
	id: projectId,
	name: "Frame fixture",
	path: "/tmp/canvas-frame-project",
	defaultBranch: "main",
	createdAt: "2026-10-22T00:00:00.000Z",
};

const ANIMATED_STORY = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Studio story</title>
<style>
body{margin:0;background:#14160f;color:#f1ecdd;font:14px system-ui}
a{transition:transform .35s cubic-bezier(.2,.8,.2,1)}
a:hover{transform:translateY(-2px)}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
h1{animation:rise .6s ease both}
</style>
</head><body><h1>Suelen Bezerra</h1><a href="#">Agendamento</a></body></html>`;

function storyNode(overrides: Record<string, unknown> = {}) {
	return {
		id: nodeId,
		projectId,
		sessionId: "design-e2e-frame-session",
		parentId: null,
		title: "After Hours Studio",
		brief: "Buatkan story promosi studio nail art 9:16",
		status: "ready",
		viewport: "mobile",
		frameKind: "story",
		frameWidth: 1080,
		frameHeight: 1920,
		html: ANIMATED_STORY,
		errorMessage: null,
		durationMs: 1200,
		x: 48,
		y: 48,
		// 1080x1920 keeps its ratio: 476 tall, 268 wide.
		width: 268,
		height: 476,
		createdAt: "2026-10-22T00:00:01.000Z",
		updatedAt: "2026-10-22T00:00:02.000Z",
		...overrides,
	};
}

const userMessage = {
	id: "design-e2e-frame-user",
	projectId,
	nodeId,
	role: "user",
	text: "Buatkan story promosi studio nail art 9:16",
	model: null,
	errorMessage: null,
	durationMs: null,
	createdAt: "2026-10-22T00:00:01.000Z",
};
const assistantMessage = {
	...userMessage,
	id: "design-e2e-frame-assistant",
	role: "assistant",
	text: "After Hours Studio is ready on the canvas.",
	createdAt: "2026-10-22T00:00:02.000Z",
};

async function stubCanvas(browser: Browser) {
	const state: {
		refined: boolean;
		chat: Record<string, unknown> | null;
		patch: Record<string, unknown> | null;
	} = { refined: false, chat: null, patch: null };
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-canvas-frame-token");
		} catch {}
	});
	await browser.route("**/api/**", async (route) => {
		const { pathname } = new URL(route.request.url);
		const method = route.request.method;
		let body: unknown = [];
		if (pathname === `/api/projects/${projectId}`) body = project;
		else if (pathname === "/api/chat/catalog")
			body = { models: [], defaults: {}, agents: [], commands: [] };
		else if (pathname === "/api/chat/preferences")
			body = { favoriteModels: [] };
		else if (pathname === `/api/projects/${projectId}/designs`)
			body = {
				nodes: [storyNode()],
				messages: [userMessage, assistantMessage],
			};
		else if (pathname === "/api/bootstrap")
			body = { token: "e2e-canvas-frame-token" };
		else if (pathname === "/api/events/replay")
			body = { events: [], cursor: 0, highWaterCursor: 0 };
		else if (
			pathname === `/api/projects/${projectId}/design/chat` &&
			method === "POST"
		) {
			state.chat = JSON.parse(route.request.postData ?? "{}") as Record<
				string,
				unknown
			>;
			state.refined = true;
			body = { kind: "design", nodeId, status: "queued" };
		} else if (pathname === `/api/designs/${nodeId}` && method === "PATCH") {
			state.patch = JSON.parse(route.request.postData ?? "{}") as Record<
				string,
				unknown
			>;
			body = storyNode((state.patch?.frame ?? {}) as Record<string, unknown>);
		} else if (method !== "GET") {
			await route.fulfill({
				status: 501,
				contentType: "application/json",
				body: JSON.stringify({
					error: `Unexpected request: ${method} ${pathname}`,
				}),
			});
			return;
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
	return () => state;
}

test("the canvas draws a node at its own design ratio, not a web viewport", async ({
	app,
	browser,
	screen,
}) => {
	await stubCanvas(browser);
	await app.open(`/project/${projectId}/canvas`);
	const card = screen.getByRole("button", {
		name: "After Hours Studio · Ready",
	});
	await expect(card).toBeVisible();
	// A 1080x1920 story must occupy a 9:16 card - the old code forced 420x263.
	const style = (await card.getAttribute("style")) ?? "";
	expect(style).toContain("width: 268px");
	expect(style).toContain("height: 476px");
	await app.screenshot("canvas-frame-story-ratio");
});

test("refining the selected node sends its id and updates the same card", async ({
	app,
	browser,
	screen,
}) => {
	const getState = await stubCanvas(browser);
	await app.open(`/project/${projectId}/canvas`);
	const card = screen.getByRole("button", {
		name: "After Hours Studio · Ready",
	});
	await expect(card).toBeVisible();
	await card.click();
	// Refine is what marks the selected node as the target of the next message.
	await screen.getByRole("button", { name: "Refine" }).click();
	const composer = screen.getByRole("textbox", { name: "Message agent" });
	await composer.fill("kasih animasi ketika di hover ya");
	await screen.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => getState().chat).not.toBeNull();
	expect(getState().chat).toMatchObject({
		message: "kasih animasi ketika di hover ya",
		nodeId,
	});
	// One card only - a refine never spawns a duplicate.
	await expect(card).toHaveCount(1);
	await app.screenshot("canvas-frame-refine-in-place");
});

test("picking another canvas size patches the node frame", async ({
	app,
	browser,
	screen,
}) => {
	const getState = await stubCanvas(browser);
	await app.open(`/project/${projectId}/canvas`);
	const card = screen.getByRole("button", {
		name: "After Hours Studio · Ready",
	});
	await expect(card).toBeVisible();
	await card.click();
	await screen.getByRole("button", { name: /Story · 1080×1920/ }).click();
	await screen.getByRole("button", { name: /Poster/ }).click();
	await expect.poll(() => getState().patch).not.toBeNull();
	expect(getState().patch).toMatchObject({
		frame: { kind: "poster", width: 1080, height: 1350 },
	});
});
