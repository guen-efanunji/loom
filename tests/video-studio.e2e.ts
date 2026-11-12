import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const projectId = "e2e-video-studio-project";
const project = {
	id: projectId,
	name: "Video Studio fixture",
	path: "/tmp/video-studio-project",
	defaultBranch: "main",
	createdAt: "2026-11-13T00:00:00.000Z",
};
const catalog = {
	models: [],
	defaults: {},
	agents: [],
	commands: [],
};
const task = {
	id: "e2e-video-task",
	projectId,
	title: "Generate project video",
	status: "completed",
};
let autoDetectRequests = 0;

async function stubVideoStudio(browser: Browser) {
	autoDetectRequests = 0;
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-video-studio-token");
		} catch {}
	});
	await browser.route("**/api/**", async (route) => {
		const { pathname } = new URL(route.request.url);
		let body: unknown = [];
		if (pathname === `/api/projects/${projectId}`) body = project;
		else if (pathname === "/api/chat/catalog") body = catalog;
		else if (pathname === "/api/chat/preferences")
			body = { favoriteModels: [] };
		else if (pathname === "/api/agents")
			body = [];
		else if (pathname === "/api/providers")
			body = [
				{
					id: "opencode:local",
					providerId: "opencode",
					name: "OpenCode",
					command: "opencode",
					install: null,
					auth: "none",
					authCommand: null,
					installed: true,
					executablePath: "/usr/bin/opencode",
					version: "1.0.0",
					status: "connected",
				},
			];
		else if (pathname === "/api/providers/opencode/models")
			body = [
				{
					id: "opencode/beam-free",
					providerId: "opencode",
					name: "Beam Free",
					displayName: "Beam Free",
					isAvailable: true,
					isDefault: true,
				},
			];
		else if (pathname === "/api/tasks") body = [task];
		else if (pathname === `/api/tasks/${task.id}/files`) {
			autoDetectRequests++;
			if (new URL(route.request.url).searchParams.get("path") === "out/video.mp4") {
				await route.fulfill({
					status: 200,
					contentType: "video/mp4",
					body: "e2e-video-fixture",
				});
				return;
			}
			await route.fulfill({ status: 404, body: "Not found" });
			return;
		} else if (pathname === `/api/context/entries`)
			body = [];
		else if (pathname === "/api/bootstrap")
			body = { token: "e2e-video-studio-token" };
		else if (pathname === "/api/events/replay")
			body = { events: [], cursor: 0, highWaterCursor: 0 };
		else if (route.request.method !== "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
			return;
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
}

test("Video Studio renders and captures a screenshot", async ({
	app,
	browser,
	screen,
}) => {
	await stubVideoStudio(browser);
	await app.open(`/project/${projectId}/video`);

	await expect(screen.getByText("Video Studio")).toBeVisible();
	await expect(screen.getByText("Auto-detected: out/video.mp4")).toBeVisible();
	await app.screenshot("video-studio");
	await new Promise((resolve) => setTimeout(resolve, 500));
	if (autoDetectRequests !== 1) {
		throw new Error(`Expected one auto-detect request, got ${autoDetectRequests}`);
	}
});