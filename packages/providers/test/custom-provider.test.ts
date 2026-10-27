import { expect, test } from "bun:test";
import {
	CustomProviderAdapter,
	ensureOpenAiSseTerminator,
	customProviderConfig,
} from "../src/adapters/custom-provider";

async function normalize(input: string) {
	const response = new Response(
		ensureOpenAiSseTerminator(
			new Response(input).body as ReadableStream<Uint8Array>,
		),
	);
	return response.text();
}

test("adds OpenAI stream completion markers when a gateway omits them", async () => {
	const output = await normalize(
		'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
	);
	expect(output).toContain('"content":"OK"');
	expect(output).toContain("data: [DONE]");
	expect(output.match(/"finish_reason"/g)).toHaveLength(1);
});

test("adds a finish reason when a stream closes without one", async () => {
	const output = await normalize(
		'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n',
	);
	expect(output).toContain('"finish_reason":"stop"');
	expect(output).toContain("data: [DONE]");
});

test("includes both OpenCode model limits when a context window is known", () => {
	const config = customProviderConfig({
		id: "loom_custom_agent_c01a9946",
		name: "agent",
		baseUrl: "http://localhost:20128/v1",
		apiKey: "test-key",
		models: [{ id: "BACKEND", name: "BACKEND", contextWindow: 272_000 }],
	});

	expect(
		config.provider.loom_custom_agent_c01a9946.models.BACKEND.limit,
	).toEqual({ context: 272_000, output: 8_192 });
});

test("uses a discovered output limit without exceeding the model context", () => {
	const config = customProviderConfig({
		id: "loom_custom_agent_c01a9946",
		name: "agent",
		baseUrl: "http://localhost:20128/v1",
		apiKey: "test-key",
		models: [
			{
				id: "small-model",
				name: "Small model",
				contextWindow: 4_096,
				outputLimit: 8_192,
			},
		],
	});

	expect(
		config.provider.loom_custom_agent_c01a9946.models["small-model"].limit,
	).toEqual({ context: 4_096, output: 4_096 });
});

test("does not duplicate a gateway completion marker", async () => {
	const output = await normalize(
		'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
	);
	expect(output.match(/\[DONE\]/g)).toHaveLength(1);
	expect(output.match(/"finish_reason"/g)).toHaveLength(1);
});

test("runs a custom model directly against its OpenAI-compatible endpoint", async () => {
	const originalFetch = globalThis.fetch;
	let request: Request | undefined;
	globalThis.fetch = async (input, init) => {
		request = new Request(input, init);
		return Response.json({
			choices: [{ message: { content: "OK" } }],
			usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
		});
	};
	try {
		const adapter = new CustomProviderAdapter({
			id: "loom_custom_agent_test",
			name: "AGENT",
			baseUrl: "http://localhost:20128/v1",
			apiKey: "test-secret",
			models: [{ id: "BACKEND", name: "BACKEND" }],
		});
		const session = await adapter.createSession({ cwd: "/tmp", title: "test" });
		await adapter.getRuntime().prompt({
			sessionId: session.id,
			prompt: "Reply with exactly OK.",
			model: { providerID: adapter.definition.id, modelID: "BACKEND" },
		});

		expect(request?.url).toBe("http://localhost:20128/v1/chat/completions");
		expect(request?.headers.get("authorization")).toBe("Bearer test-secret");
		expect(await adapter.wait(session.id)).toBe("completed");
		expect(await adapter.getRuntime().readOutput?.(session.id)).toMatchObject({
			output: "OK",
			tokens: { total: 13, input: 12, output: 1 },
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("read-only design requests omit tools and preserve system instructions and images", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<Record<string, unknown>> = [];
	globalThis.fetch = async (input, init) => {
		const body = (await new Request(input, init).json()) as Record<string, unknown>;
		requests.push(body);
		return Response.json({
			choices: [{ message: { content: "A visual design proposal" } }],
		});
	};
	try {
		const adapter = new CustomProviderAdapter({
			id: "loom_custom_design_test",
			name: "DESIGN",
			baseUrl: "http://localhost:20128/v1",
			apiKey: "",
			models: [{ id: "DESIGN", name: "DESIGN" }],
		});
		const session = await adapter.createSession({ cwd: "/tmp", title: "design" });
		let approvals = 0;
		await adapter.prompt({
			sessionId: session.id,
			prompt: "Design this screen",
			system: "Return a design proposal.",
			permission: { mode: "read-only" },
			images: [{ mime: "image/png", data: "aGVsbG8=" }],
			authorizeTool: async () => {
				approvals += 1;
				return true;
			},
		});
		expect(await adapter.wait(session.id)).toBe("completed");
		expect(requests).toHaveLength(1);
		expect(requests[0]).not.toHaveProperty("tools");
		expect(requests[0]).not.toHaveProperty("tool_choice");
		expect(requests[0]?.messages).toEqual([
			{ role: "system", content: "Return a design proposal." },
			{
				role: "user",
				content: [
					{ type: "text", text: "Design this screen" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
				],
			},
		]);
		expect(approvals).toBe(0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("read-only requests do not execute unsolicited tool calls", async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	let approvals = 0;
	globalThis.fetch = async () => {
		requests += 1;
		return Response.json({
			choices: [{ message: {
				content: "Safe response",
				tool_calls: [{ id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"true"}' } }],
			} }],
		});
	};
	try {
		const adapter = new CustomProviderAdapter({
			id: "loom_custom_design_test",
			name: "DESIGN",
			baseUrl: "http://localhost:20128/v1",
			apiKey: "",
			models: [{ id: "DESIGN", name: "DESIGN" }],
		});
		const session = await adapter.createSession({ cwd: "/tmp", title: "design" });
		await adapter.prompt({
			sessionId: session.id,
			prompt: "Design this screen",
			permission: { mode: "read-only" },
			authorizeTool: async () => {
				approvals += 1;
				return true;
			},
		});
		expect(await adapter.wait(session.id)).toBe("completed");
		expect(requests).toBe(1);
		expect(approvals).toBe(0);
		expect(await adapter.readOutput(session.id)).toMatchObject({ output: "Safe response", activities: [] });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("coding requests retain tool invitations and declarations", async () => {
	const originalFetch = globalThis.fetch;
	let body: Record<string, unknown> | undefined;
	globalThis.fetch = async (input, init) => {
		body = (await new Request(input, init).json()) as Record<string, unknown>;
		return Response.json({ choices: [{ message: { content: "Done" } }] });
	};
	try {
		const adapter = new CustomProviderAdapter({
			id: "loom_custom_code_test",
			name: "CODE",
			baseUrl: "http://localhost:20128/v1",
			apiKey: "",
			models: [{ id: "CODE", name: "CODE" }],
		});
		const session = await adapter.createSession({ cwd: "/tmp", title: "code" });
		await adapter.prompt({ sessionId: session.id, prompt: "Edit a file", permission: { mode: "ask" } });
		expect(await adapter.wait(session.id)).toBe("completed");
		expect(body?.tool_choice).toBe("auto");
		expect(body?.tools).toBeArray();
		expect((body?.messages as Array<{ content: string }> | undefined)?.[0]?.content).toContain("write_file");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("surfaces direct custom provider HTTP failures as failed runs", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response("upstream unavailable", { status: 503 });
	try {
		const adapter = new CustomProviderAdapter({
			id: "loom_custom_agent_test",
			name: "AGENT",
			baseUrl: "http://localhost:20128/v1",
			apiKey: "test-secret",
			models: [{ id: "BACKEND", name: "BACKEND" }],
		});
		const session = await adapter.createSession({ cwd: "/tmp", title: "test" });
		await adapter.getRuntime().prompt({
			sessionId: session.id,
			prompt: "hello",
			model: { providerID: adapter.definition.id, modelID: "BACKEND" },
		});
		expect(await adapter.wait(session.id)).toBe("failed");
		expect(await adapter.getRuntime().lastError?.(session.id)).toContain(
			"upstream unavailable",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
