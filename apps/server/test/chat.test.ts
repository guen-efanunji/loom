import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeHttpRuntime } from "@loom/opencode";
import { createChatRoutes } from "../src/chat";

function setup(
	initialGatewayStatus: {
		type: string;
		message?: string;
		attempt?: number;
		next?: number;
		action?: { reason?: string; title?: string; message?: string };
	} = { type: "busy" },
	openCodeSessionActive = true,
	/** Intercept a gateway path before the default fake handlers run. */
	hooks?: (path: string) => Response | undefined,
	extra?: {
		providerHistory?: Parameters<typeof createChatRoutes>[0]["providerHistory"];
		chatCompactions?: Parameters<typeof createChatRoutes>[0]["chatCompactions"];
		logger?: Parameters<typeof createChatRoutes>[0]["logger"];
	},
) {
	let gatewayStatus = initialGatewayStatus;
	const requests: Request[] = [];
	const gatewayMessages: Array<Record<string, unknown>> = [
		{
			info: {
				id: "msg_1",
				role: "assistant",
				time: { created: 1, completed: 2 },
			},
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
	];
	const runtime = new OpenCodeHttpRuntime({
		fetcher: async (url, init) => {
			const req = new Request(url, init);
			requests.push(req);
			const path = new URL(req.url).pathname.replace(/^\/api/, "");
			const injected = hooks?.(path);
			if (injected) return injected;
			if (path === "/session/ses_test")
				return Response.json({
					id: "ses_test",
					directory: "/tmp",
					title: "Chat",
					time: { updated: 1 },
				});
			if (path === "/session/ses_other")
				return Response.json({ id: "ses_other", directory: "/outside" });
			if (path.endsWith("/prompt_async")) {
				const body = (await req.clone().json()) as {
					parts?: Array<{ type: string; text?: string }>;
				};
				const text = body.parts?.find((part) => part.type === "text")?.text;
				if (text)
					gatewayMessages.push({
						info: {
							id: `user-${gatewayMessages.length}`,
							role: "user",
							time: { created: Date.now() },
						},
						parts: [{ type: "text", text }],
					});
				return new Response(null, { status: 204 });
			}
			if (path.endsWith("/abort")) {
				gatewayStatus = { type: "idle" };
				return new Response(null, { status: 204 });
			}
			if (path === "/session?limit=200")
				return Response.json(
					openCodeSessionActive
						? [
								{
									id: "ses_test",
									directory: "/tmp",
									title: "Chat",
									time: { updated: 1 },
								},
							]
						: [],
				);
			if (path === "/session/status")
				return Response.json({ ses_test: gatewayStatus });
			if (path === "/permission")
				return Response.json([
					{ id: "per_one", sessionID: "ses_test" },
					{ id: "per_other", sessionID: "ses_other" },
				]);
			if (path === "/question" || path.endsWith("/diff"))
				return Response.json([]);
			if (path.endsWith("/message")) return Response.json(gatewayMessages);
			return Response.json(true);
		},
	});
	const projects = {
		list: async () => [{ id: "project", path: "/tmp" }],
		getById: async (id: string) => (id === "project" ? { path: "/tmp" } : null),
	};
	const request = <T>(
		path: string,
		options: { directory?: string; body?: unknown; method?: string } = {},
	) =>
		runtime.request<T>(
			path,
			{
				method: options.method ?? (options.body ? "POST" : "GET"),
				...(options.body ? { body: JSON.stringify(options.body) } : {}),
			},
			options.directory,
		);
	const app = createChatRoutes({ projects, request, ...(extra ?? {}) });
	return { app, requests, gatewayMessages };
}
describe("chat gateway", () => {
	test("shows OpenCode quota retry details as a failed assistant turn instead of working forever", async () => {
		const next = Date.now() + 12 * 60 * 60_000 + 25 * 60_000;
		const { app } = setup({
			type: "retry",
			attempt: 1,
			next,
			message: "Free usage exceeded, subscribe to Go",
			action: {
				reason: "free_tier_limit",
				title: "Free limit reached",
				message: "Subscribe to OpenCode Go for reliable access.",
			},
		});
		const response = await app.request("/sessions/ses_test");
		const state = (await response.json()) as {
			status: { type: string; message?: string };
			messages: Array<{
				info: { role: string; error?: { data?: { message?: string } } };
			}>;
		};
		expect(state.status.type).toBe("error");
		expect(state.status.message).toContain("Subscribe to OpenCode Go");
		expect(state.status.message).toContain("Retry scheduled in 12h 25m");
		expect(state.messages.at(-1)?.info.error?.data?.message).toBe(
			state.status.message,
		);

		const summary = await app.request("/sessions/ses_test/status");
		expect(await summary.json()).toMatchObject({
			status: { type: "error" },
			busy: false,
			lastMessagePreview: "Hello",
		});
	});

	test("shows OpenCode retry failures even when the session has no assistant message yet", async () => {
		const { app } = setup(
			{
				type: "retry",
				message: "Free usage exceeded, subscribe to Go",
				action: {
					reason: "free_tier_limit",
					title: "Free limit reached",
					message: "Subscribe to OpenCode Go for reliable access.",
				},
			},
			false,
		);
		const response = await app.request("/sessions/ses_test");
		const state = (await response.json()) as {
			status: { type: string; message?: string };
		};
		expect(state.status.type).toBe("error");
		expect(state.status.message).toContain("Free usage exceeded");
		expect(state.status.message).toContain("Subscribe to OpenCode Go");
	});

	test("keeps short transient OpenCode retries as active work", async () => {
		const { app } = setup({
			type: "retry",
			attempt: 1,
			next: Date.now() + 15_000,
			message: "Temporary provider error",
		});
		const response = await app.request("/sessions/ses_test");
		const state = (await response.json()) as {
			status: { type: string };
		};
		expect(state.status.type).toBe("retry");
	});

	test("accepts a provider-neutral request gateway", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-chat-files-"));
		const git = Bun.spawnSync(["git", "init"], { cwd: root });
		expect(git.exitCode).toBe(0);
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "app.ts"), "export {}\n");
		const calls: Array<{
			path: string;
			options?: { directory?: string; body?: unknown; method?: string };
		}> = [];
		const app = createChatRoutes({
			projects: {
				list: async () => [],
				getById: async (id: string) =>
					id === "project" ? { path: root } : null,
			},
			request: async <T>(
				path: string,
				options?: { directory?: string; body?: unknown; method?: string },
			) => {
				calls.push({ path, options });
				return [] as T;
			},
		});
		try {
			const response = await app.request("/files?projectId=project&query=src");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(["src/", "src/app.ts"]);
			expect(calls).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	test("builds the composer catalog without rescanning providers", async () => {
		const app = createChatRoutes({
			projects: {
				list: async () => [],
				getById: async (id: string) =>
					id === "project" ? { path: "/tmp" } : null,
			},
			request: async <T>(path: string) => {
				if (
					path === "/api/model" ||
					path === "/api/agent" ||
					path === "/api/command"
				)
					return [] as T;
				throw new Error(`Unexpected OpenCode request: ${path}`);
			},
			providerManager: {
				subscribe: () => () => {},
				refreshAll: async () => {
					throw new Error("catalog request must not rescan providers");
				},
				catalog: { listAvailable: () => [] },
			} as never,
		});
		const response = await app.request("/catalog?projectId=project");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			models: [],
			agents: [],
			commands: [],
		});
	});

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
	test("quota recovery with a different model aborts stale retry and preserves the thread", async () => {
		const { app, requests, gatewayMessages } = setup({
			type: "retry",
			message: "Free usage exceeded",
			action: { reason: "free_tier_limit", title: "Limit reached" },
		});
		const failed = await app.request("/sessions/ses_test");
		expect(
			((await failed.json()) as { status: { type: string } }).status.type,
		).toBe("error");
		const response = await app.request("/sessions/ses_test/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: "Continue with another model",
				model: { providerID: "opencode", modelID: "omniroute/BACKEND" },
				files: [],
				agents: [],
			}),
		});
		expect(response.status).toBe(204);
		const prompt = requests.findLast((request) =>
			request.url.endsWith("/prompt_async"),
		);
		expect(await prompt?.json()).toMatchObject({
			model: { providerID: "omniroute", modelID: "BACKEND" },
			system: expect.stringContaining("Adapt execution"),
			parts: [{ type: "text", text: "Continue with another model" }],
		});
		expect(
			requests.some((request) =>
				request.url.endsWith("/session/ses_test/abort"),
			),
		).toBe(true);
		expect(
			gatewayMessages.map(
				(message) => (message.parts as Array<{ text?: string }>)[0]?.text,
			),
		).toContain("Continue with another model");
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
		expect(await prompts[1]?.json()).toMatchObject({
			agent: "plan",
			model: { providerID: "provider", modelID: "model" },
			system: expect.stringContaining("Adapt execution to the user's request"),
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

	test("continues an overflowing OpenCode session after admitting native compaction", async () => {
		let promptAttempts = 0;
		const { app, requests } = setup({ type: "idle" }, true, (path) => {
			if (!path.endsWith("/prompt_async")) return undefined;
			promptAttempts += 1;
			if (promptAttempts === 1)
				return Response.json(
					{ error: "context window exceeded: prompt too long" },
					{ status: 413 },
				);
			return undefined;
		});
		const response = await app.request("/sessions/ses_test/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: "Keep going after the overflow",
				model: { providerID: "provider", modelID: "model" },
				files: [],
				agents: [],
			}),
		});
		expect(response.status).toBe(204);
		const prompts = requests.filter((request) =>
			request.url.endsWith("/prompt_async"),
		);
		expect(prompts).toHaveLength(2);
		expect(requests.some((request) => request.url.endsWith("/compact"))).toBe(
			true,
		);
		const retried = await prompts[1]?.json();
		expect(retried).toMatchObject({
			parts: [{ text: "Keep going after the overflow" }],
		});
	});

	test("falls back to an explicit handoff when native compaction is unavailable", async () => {
		let promptAttempts = 0;
		const { app, requests } = setup({ type: "idle" }, true, (path) => {
			if (path.endsWith("/compact")) return new Response(null, { status: 404 });
			if (path.endsWith("/api/session/ses_test/compact"))
				return new Response(null, { status: 404 });
			if (path.endsWith("/prompt_async")) {
				promptAttempts += 1;
				return Response.json(
					{ error: "context window exceeded: prompt too long" },
					{ status: 413 },
				);
			}
			return undefined;
		});
		const response = await app.request("/sessions/ses_test/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: "Keep going after the overflow",
				model: { providerID: "provider", modelID: "model" },
				files: [],
				agents: [],
			}),
		});
		expect(response.status).toBe(413);
		const body = (await response.json()) as {
			error: { code: string; message: string; handoff: string };
		};
		expect(body.error.code).toBe("CONTEXT_WINDOW_EXCEEDED");
		expect(body.error.handoff.length).toBeGreaterThan(0);
		expect(promptAttempts).toBe(1);
		expect(
			requests.filter((request) => request.url.endsWith("/compact")),
		).toHaveLength(2);
	});

	test("manual compaction triggers native compaction for gateway sessions", async () => {
		const { app } = setup();
		const response = await app.request("/sessions/ses_test/compact", {
			method: "POST",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			native: true,
			compacted: true,
		});
	});

	test("manual compaction schedules the next request when native compaction is unavailable", async () => {
		const { app } = setup(
			{ type: "idle" },
			true,
			(path) =>
				path.endsWith("/compact")
					? new Response(null, { status: 404 })
					: undefined,
			{
				providerHistory: {
					get: async <T>() =>
						[
							{
								info: { id: "m1", role: "user", time: { created: 1 } },
								parts: [{ type: "text", text: "earlier" }],
							},
						] as unknown as T,
					save: async () => {},
					delete: async () => {},
				},
			},
		);
		const response = await app.request("/sessions/ses_test/compact", {
			method: "POST",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			native: false,
			compacted: false,
			scheduled: true,
		});
	});

	test("logs unrecoverable send failures to the daemon logger", async () => {
		const logs: Array<{
			component: string;
			event: string;
			details: Record<string, unknown>;
			level: string;
		}> = [];
		const { app } = setup(
			{ type: "idle" },
			true,
			(path) => {
				if (path.endsWith("/prompt_async"))
					throw new Error("fetch failed: connection refused");
				return undefined;
			},
			{
				logger: (component, event, details, level) => {
					logs.push({
						component,
						event,
						details: details ?? {},
						level: level ?? "info",
					});
				},
			},
		);
		const response = await app.request("/sessions/ses_test/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: "Message that never reaches the gateway",
				model: { providerID: "provider", modelID: "model" },
				files: [],
				agents: [],
			}),
		});
		expect([500, 502]).toContain(response.status);
		const failure = logs.find((entry) => entry.event === "chat.sendFailed");
		expect(failure).toMatchObject({
			component: "chat",
			level: "error",
			details: {
				sessionId: "ses_test",
				code: "HTTP_ERROR",
			},
		});
		expect(String(failure?.details.message)).toContain("Unable to reach");
	});
});
