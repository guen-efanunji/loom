import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Canvas design chat across every provider kind in the catalog:
 * the builtin OpenCode gateway (including a double-prefixed catalog id, the
 * historical ModelNotFoundError shape), an Agy CLI model, and a custom
 * connection model. The composer must keep the ref faithful over the wire -
 * the orchestration layer owns normalization.
 */

const projectId = "e2e-canvas-models-project";
const project = {
	id: projectId,
	name: "Canvas models fixture",
	path: "/tmp/canvas-models-project",
	defaultBranch: "main",
	createdAt: "2026-10-27T00:00:00.000Z",
};
const catalog = {
	models: [
		{
			providerID: "opencode",
			modelID: "opencode/glm-5.3-flash-free",
			name: "GLM-5.3-Flash Free",
			provider: "OpenCode",
			connectionId: "opencode:local",
		},
		{
			providerID: "agy",
			modelID: "gemini-3.8-flash-high",
			name: "Gemini 3.8 Flash (High)",
			provider: "Agy",
			connectionId: "agy:local",
		},
		{
			providerID: "loom_custom_c194aec3",
			modelID: "BACKEND",
			name: "BACKEND",
			provider: "Agent",
			connectionId: "agent-x",
		},
	],
	defaults: {},
	agents: [],
	commands: [],
};

let counter = 0;
function addMessages(
	messages: unknown[],
	text: string,
	modelRef: unknown,
	reply: string,
) {
	const stamp = new Date(Date.UTC(2026, 9, 27, 0, 0, counter++)).toISOString();
	const id = `design-e2e-message-${counter}`;
	messages.push({
		id,
		projectId,
		nodeId: null,
		role: "user",
		text,
		model: modelRef,
		errorMessage: null,
		durationMs: null,
		createdAt: stamp,
	});
	messages.push({
		id: `${id}-assistant`,
		projectId,
		nodeId: null,
		role: "assistant",
		text: reply,
		model: "agent/model",
		errorMessage: null,
		durationMs: 900,
		createdAt: stamp,
	});
}

async function stubCanvas(browser: Browser) {
	const messages: unknown[] = [];
	const submitted: Array<Record<string, unknown>> = [];
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-canvas-models-token");
		} catch {}
	});
	await browser.route("**/api/**", async (route) => {
		const { pathname } = new URL(route.request.url);
		let body: unknown = [];
		if (pathname === `/api/projects/${projectId}`) body = project;
		else if (pathname === "/api/chat/catalog") body = catalog;
		else if (pathname === "/api/chat/preferences")
			body = { favoriteModels: [] };
		else if (pathname === `/api/projects/${projectId}/designs`)
			body = { nodes: [], messages };
		else if (pathname === "/api/chat/files") body = [];
		else if (
			pathname === `/api/projects/${projectId}/design/chat` &&
			route.request.method === "POST"
		) {
			const input = JSON.parse(route.request.postData ?? "{}") as Record<
				string,
				unknown
			>;
			submitted.push(input);
			const text = String(input.message ?? "");
			const model = input.model ?? null;
			addMessages(
				messages,
				text,
				model,
				`${model ? `${(model as { providerID: string }).providerID}:` : ""} ${text} answered`,
			);
			body = { kind: "chat", text: `ok: ${text}` };
		} else if (pathname === "/api/bootstrap")
			body = { token: "e2e-canvas-models-token" };
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

test("Canvas design chat keeps provider and model faithful for builtin, Agy, and custom models", async ({
	app,
	browser,
	screen,
}) => {
	const getSubmitted = await stubCanvas(browser);
	await app.open(`/project/${projectId}/canvas`);

	// Builtin OpenCode gateway: catalog id keeps the legacy double prefix
	// ("opencode/opencode/...") and must round-trip untouched.
	await screen.getByRole("button", { name: "Select model" }).click();
	await screen.getByPlaceholder("Search models…").fill("GLM-5.3-Flash Free");
	await screen.getByRole("option", { name: /GLM-5\.3-Flash Free/ }).click();
	await expect(
		screen.getByRole("button", {
			name: /Selected model: GLM-5\.3-Flash Free/,
		}),
	).toBeVisible();
	const composer = screen.getByRole("textbox", { name: "Message agent" });
	await composer.fill("hallo GLM");
	await screen.getByRole("button", { name: "Send message" }).click();
	await expect(screen.getByText("opencode: hallo GLM answered")).toBeVisible();

	// Agy CLI model.
	await screen
		.getByRole("button", { name: /Selected model: GLM-5\.3-Flash Free/ })
		.click();
	await screen.getByPlaceholder("Search models…").fill("Gemini");
	await screen.getByRole("option", { name: /Gemini 3\.8 Flash/ }).click();
	await composer.fill("halo Agy");
	await screen.getByRole("button", { name: "Send message" }).click();
	await expect(screen.getByText("agy: halo Agy answered")).toBeVisible();

	// Custom connection model (loom_custom_*).
	await screen
		.getByRole("button", { name: /Selected model: Gemini 3\.8 Flash/ })
		.click();
	await screen.getByPlaceholder("Search models…").fill("BACKEND");
	await screen.getByRole("option", { name: /BACKEND/ }).click();
	await composer.fill("halo BACKEND");
	await screen.getByRole("button", { name: "Send message" }).click();
	await expect(
		screen.getByText("loom_custom_c194aec3: halo BACKEND answered"),
	).toBeVisible();

	const submitted = getSubmitted();
	expect(submitted).toHaveLength(3);
	expect(submitted[0]?.model).toEqual({
		providerID: "opencode",
		modelID: "opencode/glm-5.3-flash-free",
	});
	expect(submitted[1]?.model).toEqual({
		providerID: "agy",
		modelID: "gemini-3.8-flash-high",
	});
	expect(submitted[2]?.model).toEqual({
		providerID: "loom_custom_c194aec3",
		modelID: "BACKEND",
	});
	expect(new Set(submitted.map((body) => body.message))).toEqual(
		new Set(["hallo GLM", "halo Agy", "halo BACKEND"]),
	);
	await app.screenshot("canvas-design-models-chat");
});
