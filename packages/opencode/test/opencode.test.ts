import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	discoverExecutable,
	discoverService,
	MockAgentRuntime,
	OpenCodeError,
	OpenCodeHttpRuntime,
	OpenCodeServerManager,
	requireOpenCodeArray,
	unwrapOpenCodeEnvelope,
} from "../src";

describe("OpenCode discovery", () => {
	test("loads the URL and password from a private service registration", async () => {
		const stateHome = await mkdtemp(join(tmpdir(), "loom-opencode-state-"));
		const serviceDir = join(stateHome, "opencode");
		await mkdir(serviceDir);
		const registrationPath = join(serviceDir, "service.json");
		await writeFile(
			registrationPath,
			JSON.stringify({
				url: "http://127.0.0.1:49374",
				password: "private-test-password",
			}),
		);
		await chmod(registrationPath, 0o600);
		try {
			await expect(discoverService(null, stateHome)).resolves.toEqual({
				url: "http://127.0.0.1:49374",
				password: "private-test-password",
			});
			await chmod(registrationPath, 0o644);
			await expect(discoverService(null, stateHome)).resolves.toBeNull();
		} finally {
			await rm(stateHome, { recursive: true, force: true });
		}
	});
	test("uses the configured executable", async () => {
		await expect(
			discoverExecutable(
				{ OPENCODE_BIN: "/opt/opencode" },
				async () => undefined,
			),
		).resolves.toBe("/opt/opencode");
	});

	test("returns null when no executable exists", async () => {
		await expect(
			discoverExecutable({ PATH: "/bin:/usr/bin" }, async () => {
				throw new Error("missing");
			}),
		).resolves.toBeNull();
	});
});

describe("OpenCode server manager", () => {
	test("checks server info at the configured OpenCode service URL", async () => {
		const manager = new OpenCodeServerManager({
			baseUrl: "http://127.0.0.1:49374",
			fetcher: async (input) => {
				expect(String(input)).toBe("http://127.0.0.1:49374/api/info");
				return Response.json({
					version: "2.2.5",
					urls: ["http://127.0.0.1:49374"],
				});
			},
		});
		await expect(manager.health()).resolves.toBe(true);
	});

	test("gives an actionable missing executable error", async () => {
		const manager = new OpenCodeServerManager({
			executable: null,
			discoverer: async () => null,
			fetcher: async () => new Response(null, { status: 503 }),
		});
		await expect(manager.start()).rejects.toMatchObject({
			code: "NOT_INSTALLED",
		});
	});
});

describe("OpenCode HTTP runtime", () => {
	test("creates sessions and sends prompts through the modern gateway", async () => {
		const requests: Request[] = [];
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input, init) => {
				requests.push(new Request(input, init));
				// OpenCode 2.2+ wraps every payload in a `{ data: ... }` envelope.
				if (String(input).endsWith("/api/session")) {
					return new Response(JSON.stringify({ data: { id: "session-1" } }), {
						status: 200,
					});
				}
				return new Response(null, { status: 204 });
			},
		});
		await expect(
			runtime.createSession({ cwd: "/tmp/worktree", title: "Task" }),
		).resolves.toEqual({ id: "session-1" });
		await runtime.prompt({ sessionId: "session-1", prompt: "Implement it" });
		// request[0]=create, [1]=the one-time /session/active gateway probe,
		// [2]=the prompt itself.
		expect(requests[2]?.url).toContain("/session/session-1/prompt");
		expect(await requests[2]?.json()).toEqual({ text: "Implement it" });
	});

	test("uses prompt_async when the active endpoint identifies a legacy gateway", async () => {
		const requests: Request[] = [];
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input, init) => {
				requests.push(new Request(input, init));
				const path = new URL(String(input)).pathname;
				if (path.endsWith("/session/active"))
					return new Response("{}", { status: 404 });
				return new Response(null, { status: 204 });
			},
		});
		await runtime.prompt({ sessionId: "session-1", prompt: "Implement it" });
		// Probe classifies the gateway; modern endpoint is never attempted.
		expect(requests[0]?.url).toContain("/session/active");
		expect(requests[1]?.url).toContain("/prompt_async");
		// Subsequent prompts continue using the legacy endpoint.
		await runtime.prompt({ sessionId: "session-1", prompt: "Again" });
		expect(requests[2]?.url).toContain("/prompt_async");
	});

	test("splits a prefixed modelID for the opencode provider", async () => {
		const requests: Request[] = [];
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input, init) => {
				requests.push(new Request(input, init));
				return new Response(null, { status: 204 });
			},
		});
		await runtime.prompt({
			sessionId: "session-1",
			prompt: "Design it",
			model: {
				providerID: "opencode",
				modelID: "opencode/glm-5.3-flash-free",
			},
		});
		// Probe first, then 2.2 selects the model on a dedicated endpoint.
		expect(requests[0]?.url).toContain("/session/active");
		expect(requests[1]?.url).toContain("/session/session-1/model");
		expect(await requests[1]?.json()).toEqual({
			model: { providerID: "opencode", id: "glm-5.3-flash-free" },
		});
		expect(requests[2]?.url).toContain("/session/session-1/prompt");
	});

	test("fails a modern prompt with an unknown model instead of demoting the gateway", async () => {
		const requests: Request[] = [];
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input, init) => {
				requests.push(new Request(input, init));
				const path = new URL(String(input)).pathname;
				if (path.endsWith("/session/session-1/model"))
					return new Response('{"message":"unknown model"}', { status: 404 });
				return new Response(null, { status: 204 });
			},
		});
		await runtime.prompt({
			sessionId: "session-1",
			prompt: "Implement it",
			model: { providerID: "opencode", modelID: "unknown-model" },
		});
		// Probe + rejected model selection, then submit using the configured
		// default. Never fall back to removed prompt_async on a modern server.
		expect(requests[0]?.url).toContain("/session/active");
		expect(requests[1]?.url).toContain("/session/session-1/model");
		expect(requests[2]?.url).toContain("/session/session-1/prompt");
		expect(requests).toHaveLength(3);
		// The gateway stays modern on subsequent prompts too.
		await runtime.prompt({ sessionId: "session-1", prompt: "Again" });
		expect(requests[3]?.url).toContain("/session/session-1/prompt");
	});

	test("does not demote the gateway when abort/interrupt returns 404 on an inactive session", async () => {
		const requests: Request[] = [];
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input, init) => {
				requests.push(new Request(input, init));
				const path = new URL(String(input)).pathname;
				if (path.endsWith("/session/active"))
					return new Response(JSON.stringify({}), { status: 200 });
				if (path.endsWith("/interrupt"))
					return new Response('{"message":"Session not found"}', {
						status: 404,
					});
				return new Response(null, { status: 204 });
			},
		});
		await runtime.abort("ses_inactive");
		// Subsequent prompt must still use modern endpoint /prompt, NOT /prompt_async
		await runtime.prompt({ sessionId: "ses_new", prompt: "Hello" });
		expect(requests.some((r) => r.url.endsWith("/prompt_async"))).toBe(false);
		expect(
			requests.some((r) => r.url.endsWith("/session/ses_new/prompt")),
		).toBe(true);
	});

	test("rejects malformed session responses", async () => {
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async () => new Response(JSON.stringify({}), { status: 200 }),
		});
		await expect(
			runtime.createSession({ cwd: "/tmp", title: "Task" }),
		).rejects.toBeInstanceOf(OpenCodeError);
	});

	test("unwraps the 2.2+ data envelope but keeps bare payloads", async () => {
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input) =>
				String(input).includes("/api/info")
					? new Response(
							JSON.stringify({ version: "2.2.5", hostname: "local" }),
							{ status: 200 },
						)
					: new Response(
							JSON.stringify({
								data: [{ id: "m1", modelID: "m1", providerID: "prov" }],
							}),
							{ status: 200 },
						),
		});
		await expect(runtime.request("/model")).resolves.toEqual([
			{ id: "m1", modelID: "m1", providerID: "prov" },
		]);
		await expect(runtime.request("/info")).resolves.toEqual({
			version: "2.2.5",
			hostname: "local",
		});
	});

	test("requireOpenCodeArray fails loudly for non-array list endpoints", () => {
		expect(() =>
			requireOpenCodeArray(
				{ _tag: "UnauthorizedError", message: "Authentication required" },
				"/api/model",
			),
		).toThrow("/api/model");
		expect(requireOpenCodeArray([1, 2], "/api/model")).toEqual([1, 2]);
	});

	test("unwrapOpenCodeEnvelope only strips objects with a data key", () => {
		expect(unwrapOpenCodeEnvelope({ data: [1, 2] })).toEqual([1, 2]);
		expect(unwrapOpenCodeEnvelope({ data: null })).toBeNull();
		expect(unwrapOpenCodeEnvelope([1, 2])).toEqual([1, 2]);
		expect(unwrapOpenCodeEnvelope(null)).toBeNull();
		expect(unwrapOpenCodeEnvelope({ id: "x" })).toEqual({ id: "x" });
	});

	test("re-exposes location.directory as directory on payloads and list items", async () => {
		const runtime = new OpenCodeHttpRuntime({
			baseUrl: "http://127.0.0.1:4096",
			fetcher: async (input) => {
				if (String(input).endsWith("/session")) {
					return Response.json({
						data: { id: "ses_1", location: { directory: "/tmp/proj" } },
					});
				}
				return Response.json({
					data: [
						{
							id: "ses_2",
							location: { directory: "/tmp/other" },
							title: "T",
						},
					],
				});
			},
		});
		await expect(runtime.request("/session")).resolves.toEqual({
			id: "ses_1",
			location: { directory: "/tmp/proj" },
			directory: "/tmp/proj",
		});
		await expect(runtime.request("/sessions")).resolves.toEqual([
			{
				id: "ses_2",
				title: "T",
				location: { directory: "/tmp/other" },
				directory: "/tmp/other",
			},
		]);
	});

	test("shims flattened 2.2 messages into the legacy info/parts shape", async () => {
		const runtime = new OpenCodeHttpRuntime({
			baseUrl: "http://127.0.0.1:4096",
			fetcher: async () =>
				Response.json({
					data: [
						{
							id: "m_user",
							type: "user",
							text: "hello",
							files: [{ uri: "data:image/png;base64,AAAA", name: "shot.png" }],
							time: { created: 5 },
						},
						{
							id: "meta",
							type: "idle",
							outcome: "succeeded",
							time: { created: 9 },
						},
						{
							id: "m_bg",
							type: "assistant",
							agent: "build",
							model: { id: "glm", providerID: "opencode" },
							content: [{ type: "text", text: "hi" }],
							error: { type: "ProviderError", message: "quota blown" },
							time: { created: 7, completed: 42 },
							cost: 0.5,
						},
					],
				}),
		});
		await expect(runtime.request("/session/ses_1/message")).resolves.toEqual([
			{
				info: { id: "m_user", role: "user", time: { created: 5 } },
				parts: [
					{ id: "m_user-part-0", type: "text", text: "hello" },
					{
						id: "m_user-part-1",
						type: "file",
						url: "data:image/png;base64,AAAA",
						name: "shot.png",
					},
				],
			},
			{
				info: {
					id: "meta",
					role: "idle",
					time: { created: 9 },
					hidden: true,
				},
				parts: [],
			},
			{
				info: {
					id: "m_bg",
					role: "assistant",
					time: { created: 7, completed: 42 },
					modelID: "glm",
					providerID: "opencode",
					cost: 0.5,
					error: { name: "ProviderError", data: { message: "quota blown" } },
				},
				parts: [{ id: "m_bg-part-0", type: "text", text: "hi" }],
			},
		]);
	});

	test("bridges /session/status onto the 2.2 active-run snapshot", async () => {
		const runtime = new OpenCodeHttpRuntime({
			baseUrl: "http://127.0.0.1:4096",
			fetcher: async (url) => {
				const path = new URL(String(url)).pathname;
				if (path.endsWith("/session/status"))
					return new Response("{}", { status: 404 });
				return Response.json({ ses_1: { type: "running" } });
			},
		});
		// First call discovers the modern vocabulary through the bridge…
		await expect(runtime.request("/session/status")).resolves.toEqual({
			ses_1: { type: "busy" },
		});
		// …and the legacy endpoint is never consulted again.
		await expect(runtime.request("/session/status")).resolves.toEqual({
			ses_1: { type: "busy" },
		});
	});

	test("submits modern prompts with OpenCode attachment and agent fields", async () => {
		const requests: Request[] = [];
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				const path = new URL(String(input)).pathname;
				if (path.endsWith("/session/active")) return Response.json({});
				return new Response(null, { status: 204 });
			},
		});
		await runtime.prompt({
			sessionId: "session-1",
			prompt: "Implement the attached design",
			model: { providerID: "anthropic", modelID: "claude-test" },
			variant: "high",
			files: [
				{
					uri: "file:///tmp/design.html",
					name: "design.html",
					mime: "text/html",
				},
				{
					uri: "data:text/plain;base64,SGVsbG8=",
					name: "notes.txt",
					mime: "text/plain",
				},
			],
			agents: [{ name: "reviewer" }],
		});
		const promptRequest = requests.at(-1);
		expect(promptRequest?.url).toContain("/session/session-1/prompt");
		expect(promptRequest?.url).not.toContain("prompt_async");
		expect(requests[1]?.url).toContain("/session/session-1/model");
		expect(await requests[1]?.json()).toMatchObject({
			model: {
				providerID: "anthropic",
				id: "claude-test",
				variant: "high",
			},
		});
		expect(await promptRequest?.json()).toEqual({
			text: "Implement the attached design",
			files: [
				{
					mime: "text/html",
					name: "design.html",
					source: { type: "uri", uri: "file:///tmp/design.html" },
				},
				{
					data: "SGVsbG8=",
					mime: "text/plain",
					name: "notes.txt",
					source: { type: "inline" },
				},
			],
			agents: [{ name: "reviewer" }],
		});
	});

	test("does not classify the whole gateway as legacy when scoped active status returns 404", async () => {
		const requests: Request[] = [];
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				const path = new URL(String(input)).pathname;
				if (
					path.endsWith("/session/active") &&
					request.headers.has("x-opencode-directory")
				)
					return new Response("{}", { status: 404 });
				return new Response(JSON.stringify({ ses_1: { type: "running" } }));
			},
		});

		await expect(
			runtime.request("/session/status", {}, "/tmp/project"),
		).rejects.toThrow("HTTP 404 (GET /api/session/active)");
		await runtime.prompt({ sessionId: "session-1", prompt: "Still modern" });

		expect(
			requests.some((request) =>
				new URL(request.url).pathname.endsWith("/prompt_async"),
			),
		).toBe(false);
		expect(requests.at(-1)?.url).toContain("/session/session-1/prompt");
	});

	test("aborts runs through the 2.2 interrupt endpoint", async () => {
		const requests: Request[] = [];
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input, init) => {
				requests.push(new Request(input, init));
				return new Response(null, { status: 204 });
			},
		});
		await runtime.abort("session-1");
		expect(requests[0]?.url).toContain("/session/active");
		expect(requests[1]?.url).toContain("/session/session-1/interrupt");
		expect(requests[1]?.method).toBe("POST");
	});

	test("falls back to /abort when interrupt is unavailable", async () => {
		const requests: Request[] = [];
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input, init) => {
				requests.push(new Request(input, init));
				if (String(input).endsWith("/session/session-1/interrupt"))
					return new Response("{}", { status: 404 });
				return new Response(null, { status: 204 });
			},
		});
		await runtime.abort("session-1");
		expect(requests[0]?.url).toContain("/session/active");
		expect(requests[1]?.url).toContain("/interrupt");
		expect(requests[2]?.url).toContain("/session/session-1/abort");
	});

	test("degrades removed permission/question endpoints to empty lists", async () => {
		const runtime = new OpenCodeHttpRuntime({
			baseUrl: "http://127.0.0.1:4096",
			fetcher: async (input) => {
				const path = new URL(String(input)).pathname;
				if (path.endsWith("/permission") || path.endsWith("/question"))
					return new Response("{}", { status: 404 });
				throw new Error(`Unexpected endpoint: ${path}`);
			},
		});
		await expect(runtime.request("/permission")).resolves.toEqual([]);
		await expect(runtime.request("/question")).resolves.toEqual([]);
	});

	test("includes OpenCode validation details for rejected config updates", async () => {
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async () =>
				new Response(
					JSON.stringify({
						errors: [
							{
								path: ["provider", "custom", "options", "baseURL"],
								message: "Invalid URL",
							},
						],
					}),
					{ status: 400 },
				),
		});
		await expect(
			runtime.request("/config", {
				method: "PATCH",
				body: JSON.stringify({ provider: {} }),
			}),
		).rejects.toThrow("provider.custom.options.baseURL: Invalid URL");
	});

	test("redacts API keys from OpenCode error details", async () => {
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async () =>
				new Response('{"message":"invalid apiKey: sk-secret-value-123456"}', {
					status: 400,
				}),
		});
		await expect(
			runtime.request("/config", { method: "PATCH", body: "{}" }),
		).rejects.toThrow("[redacted]");
	});

	test("revives the server and retries once when the gateway is unreachable", async () => {
		let attempts = 0;
		let started = 0;
		const runtime = new OpenCodeHttpRuntime({
			ensureServer: async () => {
				started += 1;
			},
			fetcher: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("fetch failed: Connection refused");
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			},
		});
		await expect(runtime.request("/global/event")).resolves.toEqual({
			ok: true,
		});
		expect(started).toBe(1);
		expect(attempts).toBe(2);
	});

	test("never retries timeouts, only genuine connection failures", async () => {
		let attempts = 0;
		let started = 0;
		const runtime = new OpenCodeHttpRuntime({
			ensureServer: async () => {
				started += 1;
			},
			fetcher: async () => {
				attempts += 1;
				const timeout = AbortSignal.timeout(10);
				await new Promise((resolve) => setTimeout(resolve, 50));
				if (timeout.aborted) {
					const error = new Error("The operation was aborted due to timeout");
					error.name = "TimeoutError";
					throw error;
				}
				return new Response(null, { status: 204 });
			},
		});
		await expect(runtime.request("/global/event")).rejects.toThrow(
			"Unable to reach OpenCode server",
		);
		expect(started).toBe(0);
		expect(attempts).toBe(1);
	});

	test("honors a per-request timeout and reports when OpenCode is slow", async () => {
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (_input, init) => {
				const signal = init?.signal;
				if (!signal) return new Response(null, { status: 204 });
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, 60);
					signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							const error = new Error(
								"The operation was aborted due to timeout",
							);
							error.name = "TimeoutError";
							reject(error);
						},
						{ once: true },
					);
				});
				return new Response(null, { status: 204 });
			},
		});
		const slow = await runtime
			.request("/global/event", {}, undefined, { timeoutMs: 10 })
			.catch((error) => error as OpenCodeError);
		expect(slow.message).toBe("Unable to reach OpenCode server");
		expect(slow.details.reason).toBe("OpenCode did not answer within 10ms");
		await expect(
			runtime.request("/global/event", {}, undefined, { timeoutMs: 2_000 }),
		).resolves.toBeUndefined();
	});
});

describe("mock runtime", () => {
	test("supports the internal lifecycle", async () => {
		const runtime = new MockAgentRuntime();
		const session = await runtime.createSession({ cwd: "/tmp", title: "Task" });
		await runtime.prompt({ sessionId: session.id, prompt: "Do work" });
		await expect(runtime.wait(session.id)).resolves.toBe("completed");
		await runtime.abort(session.id);
		await expect(runtime.getDiff(session.id)).resolves.toEqual([]);
		expect(runtime.sessions.get(session.id)?.aborted).toBe(true);
	});

	test("fails clearly when the server never becomes healthy", async () => {
		const manager = new OpenCodeServerManager({
			executable: "/opt/opencode",
			healthTimeoutMs: 1,
			pollIntervalMs: 1,
			fetcher: async () => new Response(null, { status: 503 }),
			processRunner: () => ({
				kill: () => true,
				once: () => undefined as never,
			}),
		});
		await expect(manager.start()).rejects.toMatchObject({
			code: "HEALTH_TIMEOUT",
		});
	});
});

describe("documented session lifecycle", () => {
	test("waits through the active run and a pending user turn before accepting a completed assistant", async () => {
		let phase = 0;
		const runtime = new OpenCodeHttpRuntime({
			baseUrl: "http://127.0.0.1:4096",
			fetcher: async (url) => {
				const path = new URL(String(url)).pathname.replace(/^\/api/, "");
				if (path === "/session/active")
					return Response.json(
						phase === 0 ? { ses_test: { type: "running" } } : {},
					);
				if (path.endsWith("/message"))
					return Response.json(
						phase === 1
							? [
									{
										id: "u1",
										type: "user",
										text: "go",
										time: { created: 10 },
									},
								]
							: [
									{
										id: "a1",
										type: "assistant",
										content: [{ type: "text", text: "done" }],
										time: { created: 11, streamed: 12, completed: 123 },
									},
								],
					);
				throw new Error(`Unexpected endpoint: ${path}`);
			},
		});
		expect(await runtime.status("ses_test")).toBe("running");
		phase = 1;
		expect(await runtime.status("ses_test")).toBe("running");
		phase = 2;
		expect(await runtime.status("ses_test")).toBe("completed");
	});
	test("returns assistant text from message parts and detects provider errors", async () => {
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (url) => {
				if (String(url).endsWith("/session/active")) return Response.json({});
				return Response.json([
					{
						info: { role: "user", time: {} },
						parts: [{ type: "text", text: "prompt" }],
					},
					{
						info: { role: "assistant", time: {}, error: { name: "APIError" } },
						parts: [
							{ type: "text", text: "answer" },
							{
								type: "tool",
								tool: "run_command",
								state: { status: "error", input: { cmd: "ls" } },
								text: "hidden",
							},
						],
					},
				]);
			},
		});
		expect(await runtime.readOutput("ses_test")).toEqual({
			output: "answer",
			parts: [
				{ type: "text", id: "msg-0", text: "answer" },
				{ type: "activity", id: "msg-1" },
			],
			activities: [
				{
					id: "msg-1",
					tool: "run_command",
					status: "error",
					input: { cmd: "ls" },
				},
			],
		});
		expect(await runtime.status("ses_test")).toBe("failed");
	});
	test("fails an idle session that never produces an assistant response", async () => {
		const runtime = new OpenCodeHttpRuntime({
			idleTimeoutMs: 0,
			fetcher: async (url) => {
				if (String(url).endsWith("/session/active"))
					return Response.json({ ses_idle: { type: "idle" } });
				return Response.json([{ info: { role: "user", time: {} }, parts: [] }]);
			},
		});

		expect(await runtime.status("ses_idle")).toBe("failed");
		await expect(runtime.lastError("ses_idle")).resolves.toContain(
			"became idle without an assistant response",
		);
	});
	test("fails when OpenCode stops reporting the session status entirely", async () => {
		const statusPollCount = { value: 0 };
		const runtime = new OpenCodeHttpRuntime({
			idleTimeoutMs: 0,
			fetcher: async (url) => {
				if (String(url).endsWith("/session/active")) {
					statusPollCount.value += 1;
					return Response.json({});
				}
				return Response.json([{ info: { role: "user", time: {} }, parts: [] }]);
			},
		});

		expect(await runtime.status("ses_gone")).toBe("failed");
		// One status() call: the probe plus the bridged active snapshot.
		expect(statusPollCount.value).toBe(2);
		await expect(runtime.lastError("ses_gone")).resolves.toContain(
			"stopped reporting status",
		);
	});
	test("fails long free-tier retries with the gateway's quota details", async () => {
		const next = Date.now() + 12 * 60 * 60_000 + 25 * 60_000;
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (url) => {
				if (String(url).endsWith("/session/active"))
					// Older gateways only know the legacy status map.
					return new Response("{}", { status: 404 });
				if (String(url).endsWith("/session/status"))
					return Response.json({
						ses_quota: {
							type: "retry",
							attempt: 1,
							next,
							message: "Free usage exceeded, subscribe to Go",
							action: {
								reason: "free_tier_limit",
								message: "Subscribe to OpenCode Go",
							},
						},
					});
				throw new Error("A quota retry should fail without reading messages");
			},
		});

		expect(await runtime.status("ses_quota")).toBe("failed");
		await expect(runtime.lastError("ses_quota")).resolves.toContain(
			"Subscribe to OpenCode Go",
		);
		await expect(runtime.lastError("ses_quota")).resolves.toContain(
			"Retry scheduled in 12h 25m (attempt 1)",
		);
	});
	test("keeps reporting running while OpenCode retries a failing provider", async () => {
		const runtime = new OpenCodeHttpRuntime({
			idleTimeoutMs: 0,
			fetcher: async (url) => {
				if (String(url).endsWith("/session/active"))
					return new Response("{}", { status: 404 });
				if (String(url).endsWith("/session/status"))
					return Response.json({ ses_retry: { type: "retry" } });
				return Response.json([{ info: { role: "user", time: {} }, parts: [] }]);
			},
		});

		expect(await runtime.status("ses_retry")).toBe("running");
		await expect(runtime.lastError("ses_retry")).resolves.toBe(null);
	});
});
