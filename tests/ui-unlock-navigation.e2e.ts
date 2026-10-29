import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const token = "e2e-ui-unlock-token";

test("refreshes the root layout lock state after unlocking without a page reload", async ({
	app,
	browser,
	screen,
}) => {
	let unlocked = false;
	const lockReads: boolean[] = [];
	await browser.addInitScript((sessionToken) => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", sessionToken);
		} catch {}
	}, token);
	await browser.route("**/api/**", async (route) => {
		const { pathname } = new URL(route.request.url);
		let body: unknown = [];
		if (pathname === "/api/ui-lock/state") {
			lockReads.push(unlocked);
			body = { configured: true, notInUse: false, unlocked };
		} else if (
			pathname === "/api/ui-lock/unlock" &&
			route.request.method === "POST"
		) {
			unlocked = true;
			body = { ok: true, unlocked: true };
		} else if (pathname === "/api/bootstrap") {
			body = { token };
		} else if (pathname === "/api/projects") {
			body = [];
		} else if (pathname === "/api/tasks") {
			body = [];
		} else if (pathname === "/api/chat/catalog") {
			body = { models: [], defaults: {}, agents: [], commands: [] };
		} else if (pathname === "/api/chat/preferences") {
			body = { favoriteModels: [] };
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});

	await app.open("/unlock");
	await screen.getByRole("textbox", { name: "Password" }).fill("correct horse");
	await screen.getByRole("button", { name: /Continue/ }).click();
	await expect(screen.getByText("Turn ideas into momentum")).toBeVisible();
	expect(lockReads).toEqual([false, true]);
});
