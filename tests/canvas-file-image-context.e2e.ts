import { writeFile } from "node:fs/promises";
import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const projectId = "e2e-canvas-context-project";
const project = {
	id: projectId,
	name: "Canvas context fixture",
	path: "/tmp/canvas-context-project",
	defaultBranch: "main",
	createdAt: "2026-10-21T00:00:00.000Z",
};
const readyNode = {
	id: "design-e2e-ready",
	projectId,
	sessionId: "design-e2e-session",
	parentId: null,
	title: "Sign in screen",
	brief: "Create a sign in screen inspired by the referenced flow",
	status: "ready",
	viewport: "desktop",
	html: `<!doctype html><html><head><title>Sign in</title><style>
		*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;background:#eef4f2;font:14px system-ui;color:#183b37}
		main{width:290px;padding:25px;border-radius:18px;background:white;box-shadow:0 16px 40px #183b3720}small{color:#56817a;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
		h1{font-size:25px;margin:10px 0 5px}p{margin:0 0 20px;color:#65817d}label{display:block;margin:12px 0 5px;font-size:12px;font-weight:650}
		input{width:100%;padding:10px;border:1px solid #d5e2df;border-radius:8px}button{width:100%;margin-top:18px;padding:11px;border:0;border-radius:8px;background:#147d70;color:white;font-weight:700}
		</style></head><body><main><small>Welcome back</small><h1>Sign in</h1><p>Continue to your workspace</p><label>Email</label><input value="you@example.com"><label>Password</label><input value="••••••••"><button>Sign in</button></main></body></html>`,
	errorMessage: null,
	durationMs: 1250,
	x: 48,
	y: 48,
	width: 420,
	height: 263,
	createdAt: "2026-10-21T00:00:01.000Z",
	updatedAt: "2026-10-21T00:00:02.000Z",
};
const userMessage = {
	id: "design-e2e-user-message",
	projectId,
	nodeId: readyNode.id,
	role: "user",
	text: readyNode.brief,
	model: null,
	errorMessage: null,
	durationMs: null,
	createdAt: "2026-10-21T00:00:01.000Z",
};
const assistantMessage = {
	...userMessage,
	id: "design-e2e-assistant-message",
	role: "assistant",
	text: "Sign in screen is ready on the canvas.",
	createdAt: "2026-10-21T00:00:02.000Z",
};

async function stubCanvas(browser: Browser) {
	let submitted: Record<string, unknown> | null = null;
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-canvas-context-token");
		} catch {}
	});
	await browser.route("**/api/**", async (route) => {
		const { pathname, searchParams } = new URL(route.request.url);
		let body: unknown = [];
		if (pathname === `/api/projects/${projectId}`) body = project;
		else if (pathname === "/api/chat/catalog")
			body = { models: [], defaults: {}, agents: [], commands: [] };
		else if (pathname === "/api/chat/preferences")
			body = { favoriteModels: [] };
		else if (pathname === `/api/projects/${projectId}/designs`) {
			body = submitted
				? { nodes: [readyNode], messages: [userMessage, assistantMessage] }
				: { nodes: [], messages: [] };
		} else if (pathname === "/api/chat/files") {
			body = searchParams.get("query") ? ["login.html"] : [];
		} else if (
			pathname === `/api/projects/${projectId}/design/chat` &&
			route.request.method === "POST"
		) {
			submitted = JSON.parse(route.request.postData ?? "{}") as Record<
				string,
				unknown
			>;
			body = { kind: "design", nodeId: readyNode.id, status: "queued" };
		} else if (pathname === "/api/bootstrap")
			body = { token: "e2e-canvas-context-token" };
		else if (pathname === "/api/events/replay")
			body = { events: [], cursor: 0, highWaterCursor: 0 };
		else if (route.request.method !== "GET") {
			await route.fulfill({
				status: 501,
				contentType: "application/json",
				body: JSON.stringify({
					error: `Unexpected request: ${route.request.method} ${pathname}`,
				}),
			});
			return;
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
	return () => submitted;
}

test("Canvas sends @mentioned file contents and an uploaded image with its design request", async ({
	app,
	browser,
	screen,
}) => {
	const getSubmitted = await stubCanvas(browser);
	await app.open(`/project/${projectId}/canvas`);
	const composer = screen.getByRole("textbox", { name: "Message agent" });
	await composer.fill("Create a sign in screen inspired by @login");
	const fileOption = screen.getByRole("option", { name: /login\.html/ });
	await expect(fileOption).toBeVisible();
	await fileOption.click();
	const imagePath = "/tmp/reference-screen.png";
	await writeFile(imagePath, Buffer.from("canvas-reference-image"));
	await screen.getByLabel("Attach files or images").setInputFiles([imagePath]);
	await expect(screen.getByText("reference-screen.png")).toBeVisible();
	await composer.fill(
		"Create a sign in screen inspired by the referenced flow",
	);
	await screen.getByRole("button", { name: "Send message" }).click();
	await expect(
		screen.getByText("Sign in screen is ready on the canvas."),
	).toBeVisible();
	const submitted = getSubmitted();
	expect(submitted).not.toBeNull();
	expect(submitted?.message).toBe(
		"Create a sign in screen inspired by the referenced flow",
	);
	expect(submitted?.files).toEqual(["login.html"]);
	expect(submitted?.attachments).toEqual([
		{
			filename: "reference-screen.png",
			mime: "image/png",
			data: Buffer.from("canvas-reference-image").toString("base64"),
		},
	]);
	await expect(screen.getByText("Sign in screen").first()).toBeVisible();
	await app.screenshot("canvas-file-image-reference-ready");
});
