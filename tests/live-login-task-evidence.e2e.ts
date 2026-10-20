import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";

const projectId = "bc79e403-04fd-4d7f-a19f-4f340670cf94";
const feTitle = "FE: Build responsive login page";
const backendTitle = "BACKEND: Implement demo login API";

async function useLiveLoom(browser: Browser) {
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
		} catch {
			// The script can run before the app origin is available.
		}
	});
}

async function openTaskProgress(
	app: { open: (url: string) => Promise<unknown>; screenshot: (name: string) => Promise<unknown> },
	browser: Browser,
	screen: any,
	title: string,
	screenshotName: string,
) {
	await useLiveLoom(browser);
	await app.open(`http://localhost:5173/?project=${projectId}`);
	const agentsPanel = screen.getByRole("button", "Agents & tasks");
	await expect(agentsPanel).toBeVisible();
	if ((await agentsPanel.getAttribute("aria-pressed")) !== "true") await agentsPanel.tap();
	const progressLink = screen.getByRole("button", `Open ${title} progress in chat`);
	await expect(progressLink).toBeVisible();
	await progressLink.tap();
	await expect(screen.getByRole("heading", title)).toBeVisible();
	await expect(screen.getByText("Agent progress")).toBeVisible();
	await app.screenshot(screenshotName);
}

test("capture both login tasks on the project Kanban board", async ({ app, browser, screen }) => {
	await useLiveLoom(browser);
	await app.open(`http://localhost:5173/?project=${projectId}&view=kanban`);
	await expect(screen.getByText(feTitle)).toBeVisible();
	await expect(screen.getByText(backendTitle)).toBeVisible();
	await app.screenshot("login-e2e-kanban-tasks");
});

test("capture the FE task running in its Chat progress tab", async ({ app, browser, screen }) => {
	await openTaskProgress(app, browser, screen, feTitle, "login-e2e-fe-chat-progress");
});

test("capture the BACKEND task running in its Chat progress tab", async ({ app, browser, screen }) => {
	await openTaskProgress(app, browser, screen, backendTitle, "login-e2e-backend-chat-progress");
});

test("capture the registered FE and BACKEND agents and active task panel", async ({ app, browser, screen }) => {
	await useLiveLoom(browser);
	await app.open(`http://localhost:5173/?project=${projectId}`);
	const agentsPanel = screen.getByRole("button", "Agents & tasks");
	await expect(agentsPanel).toBeVisible();
	if ((await agentsPanel.getAttribute("aria-pressed")) !== "true") await agentsPanel.tap();
	await expect(screen.getByText("Active tasks")).toBeVisible();
	await expect(screen.getByRole("button", `Open ${feTitle} progress in chat`)).toBeVisible();
	await expect(screen.getByRole("button", `Open ${backendTitle} progress in chat`)).toBeVisible();
	await expect(screen.getByText("Registered agents")).toBeVisible();
	await app.screenshot("login-e2e-running-agents-panel");
});
