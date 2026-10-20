import { describe, expect, test } from "bun:test";

import {
	discoverExecutable,
	MockAgentRuntime,
	OpenCodeError,
	OpenCodeHttpRuntime,
	OpenCodeServerManager,
} from "../src";

describe("OpenCode discovery", () => {
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
	test("reports health from the documented endpoint", async () => {
		const manager = new OpenCodeServerManager({
			fetcher: async () =>
				new Response(JSON.stringify({ healthy: true, version: "1.0.0" }), {
					status: 200,
				}),
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
	test("creates sessions and sends async prompts", async () => {
		const requests: Request[] = [];
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (input, init) => {
				requests.push(new Request(input, init));
				if (String(input).endsWith("/session")) {
					return new Response(JSON.stringify({ id: "session-1" }), {
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
		expect(requests[1]?.url).toContain("/prompt_async");
	});

	test("rejects malformed session responses", async () => {
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async () => new Response(JSON.stringify({}), { status: 200 }),
		});
		await expect(
			runtime.createSession({ cwd: "/tmp", title: "Task" }),
		).rejects.toBeInstanceOf(OpenCodeError);
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
	test("waits through busy and pending user messages before accepting a completed assistant", async () => {
		let phase = 0;
		const runtime = new OpenCodeHttpRuntime({
			fetcher: async (url) => {
				const path = new URL(String(url)).pathname;
				if (path === "/session/status")
					return Response.json(
						phase === 0 ? { ses_test: { type: "busy" } } : {},
					);
				if (path.endsWith("/message"))
					return Response.json([
						{
							info:
								phase === 1
									? { role: "user", time: {} }
									: { role: "assistant", time: { completed: 123 } },
							parts: [],
						},
					]);
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
				if (String(url).endsWith("/session/status")) return Response.json({});
				return Response.json([
					{
						info: { role: "user", time: {} },
						parts: [{ type: "text", text: "prompt" }],
					},
					{
						info: { role: "assistant", time: {}, error: { name: "APIError" } },
						parts: [
							{ type: "text", text: "answer" },
							{ type: "tool", text: "hidden" },
						],
					},
				]);
			},
		});
		expect(await runtime.readOutput("ses_test")).toEqual({ output: "answer" });
		expect(await runtime.status("ses_test")).toBe("failed");
	});
	test("fails an idle session that never produces an assistant response", async () => {
		const runtime = new OpenCodeHttpRuntime({
			idleTimeoutMs: 0,
			fetcher: async (url) => {
				if (String(url).endsWith("/session/status"))
					return Response.json({ ses_idle: { type: "idle" } });
				return Response.json([
					{ info: { role: "user", time: {} }, parts: [] },
				]);
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
				if (String(url).endsWith("/session/status")) {
					statusPollCount.value += 1;
					return Response.json({});
				}
				return Response.json([
					{ info: { role: "user", time: {} }, parts: [] },
				]);
			},
		});

		expect(await runtime.status("ses_gone")).toBe("failed");
		expect(statusPollCount.value).toBe(1);
		await expect(runtime.lastError("ses_gone")).resolves.toContain(
			"stopped reporting status",
		);
	});
	test("keeps reporting running while OpenCode retries a failing provider", async () => {
		const runtime = new OpenCodeHttpRuntime({
			idleTimeoutMs: 0,
			fetcher: async (url) => {
				if (String(url).endsWith("/session/status"))
					return Response.json({ ses_retry: { type: "retry" } });
				return Response.json([
					{ info: { role: "user", time: {} }, parts: [] },
				]);
			},
		});

		expect(await runtime.status("ses_retry")).toBe("running");
		await expect(runtime.lastError("ses_retry")).resolves.toBe(null);
	});
});
