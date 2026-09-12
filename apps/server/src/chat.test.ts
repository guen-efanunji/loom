import { describe, expect, test } from "bun:test";
import { OpenCodeHttpRuntime } from "@loom/opencode";
import { createChatRoutes } from "./chat";

function setup() {
	const requests: Request[] = [];
	const runtime = new OpenCodeHttpRuntime({
		fetcher: async (url, init) => {
			const req = new Request(url, init);
			requests.push(req);
			const path = new URL(req.url).pathname;
			if (path === "/session/ses_test")
				return Response.json({
					id: "ses_test",
					directory: "/tmp",
					title: "Chat",
					time: { updated: 1 },
				});
			if (path === "/session/ses_other")
				return Response.json({ id: "ses_other", directory: "/outside" });
			if (path.endsWith("/prompt_async"))
				return new Response(null, { status: 204 });
			if (path === "/session/status")
				return Response.json({ ses_test: { type: "busy" } });
			if (path === "/permission")
				return Response.json([
					{ id: "per_one", sessionID: "ses_test" },
					{ id: "per_other", sessionID: "ses_other" },
				]);
			if (path === "/question" || path.endsWith("/diff"))
				return Response.json([]);
			if (path.endsWith("/message"))
				return Response.json([
					{
						info: { id: "msg_1", role: "assistant" },
						parts: [
							{ type: "text", text: "Hello" },
							{
								type: "tool",
								state: {
									status: "completed",
									metadata: {
										filediff: {
											file: "/tmp/README.md",
											patch: "@@ -1 +1 @@\n-old\n+new",
											additions: 1,
											deletions: 1,
										},
									},
								},
							},
						],
					},
				]);
			return Response.json(true);
		},
	});
	const projects = {
		list: async () => [{ id: "project", path: "/tmp" }],
		getById: async (id: string) => (id === "project" ? { path: "/tmp" } : null),
	};
	return { app: createChatRoutes({ projects, runtime }), requests };
}
describe("chat gateway", () => {
	test("reads recorded edit patches when session snapshots are disabled", async () => {
		const { app } = setup();
		const response = await app.request("/sessions/ses_test/diff");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([
			{
				file: "README.md",
				patch: "@@ -1 +1 @@\n-old\n+new",
				additions: 1,
				deletions: 1,
			},
		]);
	});
	test("reads message parts and scopes permission requests to the selected session", async () => {
		const { app, requests } = setup();
		const response = await app.request("/sessions/ses_test");
		expect(response.status).toBe(200);
		const result = (await response.json()) as {
			messages: Array<{ parts: Array<{ text: string }> }>;
			status: { type: string };
			permissions: Array<{ id: string }>;
		};
		expect(result.messages[0]?.parts[0]?.text).toBe("Hello");
		expect(result.status.type).toBe("busy");
		expect(result.permissions.map((p: { id: string }) => p.id)).toEqual([
			"per_one",
		]);
		expect(
			requests
				.find((r) => r.url.endsWith("/message"))
				?.headers.get("x-opencode-directory"),
		).toBe(encodeURIComponent("/tmp"));
	});
	test("sends model, agent and subsequent prompts to the same OpenCode session", async () => {
		const { app, requests } = setup();
		for (const text of ["Hello", "Follow up"]) {
			const response = await app.request("/sessions/ses_test/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text,
					agent: "plan",
					model: { providerID: "provider", modelID: "model" },
					files: [],
					agents: ["explore"],
				}),
			});
			expect(response.status).toBe(204);
		}
		const prompts = requests.filter((r) => r.url.endsWith("/prompt_async"));
		expect(prompts).toHaveLength(2);
		expect(await prompts[1]?.json()).toEqual({
			agent: "plan",
			model: { providerID: "provider", modelID: "model" },
			parts: [
				{ type: "text", text: "Follow up" },
				{ type: "agent", name: "explore" },
			],
		});
	});
	test("rejects unknown projects, out-of-project sessions and foreign permissions", async () => {
		const { app } = setup();
		expect((await app.request("/files?projectId=missing&query=x")).status).toBe(
			404,
		);
		expect((await app.request("/sessions/ses_other")).status).toBe(404);
		expect(
			(
				await app.request("/sessions/ses_test/permission/per_other", {
					method: "POST",
					body: JSON.stringify({ reply: "always" }),
				})
			).status,
		).toBe(404);
	});
	test("rejects empty messages and file traversal", async () => {
		const { app } = setup();
		expect(
			(
				await app.request("/sessions/ses_test/messages", {
					method: "POST",
					body: JSON.stringify({ text: " " }),
				})
			).status,
		).toBe(400);
		expect(
			(await app.request("/file?projectId=project&path=/etc/passwd")).status,
		).toBe(400);
	});
});
