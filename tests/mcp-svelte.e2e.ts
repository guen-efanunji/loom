import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";

const tools = [
	{ name: "list-sections", description: "List Svelte documentation sections." },
	{
		name: "get-documentation",
		description: "Retrieve official Svelte documentation.",
	},
	{
		name: "svelte-autofixer",
		description: "Check and fix Svelte component code.",
	},
	{ name: "playground-link", description: "Create a Svelte playground link." },
];
const connections: Array<Record<string, unknown>> = [];
let createPayload: Record<string, unknown> | undefined;
let testPayload: Record<string, unknown> | undefined;
let connectPayload: Record<string, unknown> | undefined;
let deletePayload: string | undefined;

function connection(status = "disconnected") {
	return {
		id: "svelte-mcp-e2e",
		label: "Svelte MCP",
		transport: "streamable-http",
		status,
		endpointHost: "mcp.svelte.dev",
		argumentCount: 0,
		environmentReferenceNames: [],
		headerReferences: [],
		protocolVersion: "2025-06-18",
		capabilities: { tools: {} },
		tools: status === "disconnected" ? [] : tools,
		toolCount: status === "disconnected" ? 0 : tools.length,
		lastConnectedAt: status === "connected" ? Date.now() : null,
		lastTestedAt: status === "disconnected" ? Date.now() : null,
		lastError: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

async function stubMcpApi(browser: Browser) {
	await browser.addInitScript(() => {
		try {
			localStorage.setItem("loom.ui.trusted", "true");
			localStorage.setItem("loom.daemon.token", "e2e-mcp-token");
		} catch {}
	});
	await browser.route("**/api/**", async (route) => {
		const request = route.request;
		const { pathname } = new URL(request.url);
		let body: unknown = {};
		let status = 200;
		if (pathname === "/api/projects") body = [];
		else if (pathname === "/api/mcp/inventory") {
			body = {
				projectId: null,
				projectName: null,
				generatedAt: new Date().toISOString(),
				connectionStatus: "not-observed",
				coverage: {
					maxConfigBytes: 100000,
					maxServersPerSource: 100,
					maxServers: 500,
					truncated: false,
				},
				sources: [],
				servers: [],
			};
		} else if (
			pathname === "/api/mcp/connections" &&
			request.method === "GET"
		) {
			body = { connections };
		} else if (
			pathname === "/api/mcp/connections" &&
			request.method === "POST"
		) {
			createPayload = JSON.parse(request.postData ?? "{}") as Record<
				string,
				unknown
			>;
			connections.splice(0, connections.length, connection());
			body = { connection: connections[0] };
			status = 201;
		} else if (pathname.endsWith("/test") && request.method === "POST") {
			testPayload = JSON.parse(request.postData ?? "{}") as Record<
				string,
				unknown
			>;
			Object.assign(connections[0], connection("disconnected"), {
				tools,
				toolCount: tools.length,
				lastTestedAt: Date.now(),
			});
			body = {
				ok: true,
				protocolVersion: "2025-06-18",
				server: { name: "svelte-mcp", version: "1.0.0" },
				capabilities: { tools: {} },
				tools,
				toolCount: tools.length,
				status: "disconnected",
			};
		} else if (pathname.endsWith("/connect") && request.method === "POST") {
			connectPayload = JSON.parse(request.postData ?? "{}") as Record<
				string,
				unknown
			>;
			Object.assign(connections[0], connection("connected"));
			body = { connection: connections[0] };
		} else if (
			pathname === "/api/mcp/connections/svelte-mcp-e2e" &&
			request.method === "DELETE"
		) {
			deletePayload = pathname.split("/").at(-1);
			connections.length = 0;
			body = { ok: true };
		} else if (pathname === "/api/bootstrap") body = { token: "e2e-mcp-token" };
		else if (pathname === "/api" || pathname === "/api/health")
			body = { ok: true };
		else if (request.method !== "GET") {
			status = 501;
			body = { error: "Unexpected mutation" };
		}
		await route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
}

test("adds, tests, and connects the official Svelte MCP server in Loom", async ({
	app,
	browser,
	screen,
}) => {
	connections.length = 0;
	createPayload = undefined;
	testPayload = undefined;
	connectPayload = undefined;
	deletePayload = undefined;
	await stubMcpApi(browser);
	await app.open("/settings/mcp?returnTo=%2F");
	await expect(screen.getByRole("heading", "MCP hub")).toBeVisible();
	await screen.getByRole("tab", "Connections").tap();
	await screen.getByRole("button", "Add your first server").tap();
	await screen.getByPlaceholder("e.g. Context7").fill("Svelte MCP");
	await screen.getByRole("button", "stdio").tap();
	await screen.getByText("Streamable HTTP · remote or local endpoint").tap();
	await screen
		.getByPlaceholder("https://mcp.example.com/mcp")
		.fill("https://mcp.svelte.dev/mcp");
	await screen.getByRole("button", "Save connection").tap();
	await expect(screen.getByRole("heading", "Svelte MCP")).toBeVisible();
	expect(createPayload).toMatchObject({
		label: "Svelte MCP",
		transport: "streamable-http",
		endpoint: "https://mcp.svelte.dev/mcp",
	});
	await app.screenshot("mcp-svelte-connection-added");

	await screen.getByRole("button", "Test").tap();
	await expect(screen.getByText("Test MCP connection?")).toBeVisible();
	await app.screenshot("mcp-confirm-test");
	expect(testPayload).toBeUndefined();
	await screen.getByRole("button", "Test connection").tap();
	await expect(
		screen.getByText("Verified tool catalog · 4 tools"),
	).toBeVisible();
	expect(testPayload).toEqual({ approved: true, allowPrivateNetwork: false });
	await screen.getByText("Verified tool catalog · 4 tools").tap();
	await expect(screen.getByText("list-sections")).toBeVisible();
	await expect(screen.getByText("get-documentation")).toBeVisible();
	await expect(screen.getByText("svelte-autofixer")).toBeVisible();
	await expect(screen.getByText("playground-link")).toBeVisible();
	await app.screenshot("mcp-svelte-verified-tools");

	await screen.getByRole("button", "Connect").tap();
	await expect(screen.getByText("Connect MCP server?")).toBeVisible();
	await app.screenshot("mcp-confirm-connect");
	expect(connectPayload).toBeUndefined();
	await screen.getByRole("button", "Start connection").tap();
	await expect(screen.getByText("connected")).toBeVisible();
	expect(connectPayload).toEqual({
		approved: true,
		allowPrivateNetwork: false,
	});
	await app.screenshot("mcp-svelte-connected");

	await screen.getByRole("button", "Remove").tap();
	await expect(screen.getByText("Remove MCP connection?")).toBeVisible();
	await app.screenshot("mcp-confirm-remove");
	await screen.getByRole("button", "Cancel").tap();
	expect(deletePayload).toBeUndefined();
	await screen.getByRole("button", "Remove").tap();
	await screen.getByRole("button", "Remove connection").tap();
	await expect(screen.getByRole("heading", "Svelte MCP")).not.toBeVisible();
	expect(deletePayload).toBe("svelte-mcp-e2e");
});
