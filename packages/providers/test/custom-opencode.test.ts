import { expect, test } from "bun:test";
import {
	CustomOpenCodeProviderAdapter,
	ensureOpenAiSseTerminator,
	openCodeProviderConfig,
} from "../src/adapters/custom-opencode";

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
	const config = openCodeProviderConfig({
		id: "loom_custom_agent_c01a9946",
		name: "agent",
		baseUrl: "http://localhost:20128/v1",
		apiKey: "test-key",
		models: [
			{ id: "BACKEND", name: "BACKEND", contextWindow: 272_000 },
		],
	});

	expect(
		config.provider.loom_custom_agent_c01a9946.models.BACKEND.limit,
	).toEqual({ context: 272_000, output: 8_192 });
});

test("uses a discovered output limit without exceeding the model context", () => {
	const config = openCodeProviderConfig({
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
		const adapter = new CustomOpenCodeProviderAdapter({
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
		expect(await adapter.getRuntime().status(session.id)).toBe("completed");
		expect(await adapter.getRuntime().readOutput?.(session.id)).toEqual({
			output: "OK",
			tokens: { total: 13, input: 12, output: 1 },
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("surfaces direct custom provider HTTP failures as failed runs", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
	try {
		const adapter = new CustomOpenCodeProviderAdapter({
			id: "loom_custom_agent_test",
			name: "AGENT",
			baseUrl: "http://localhost:20128/v1",
			apiKey: "test-secret",
			models: [{ id: "BACKEND", name: "BACKEND" }],
		});
		const session = await adapter.createSession({ cwd: "/tmp", title: "test" });
		await expect(
			adapter.getRuntime().prompt({
				sessionId: session.id,
				prompt: "hello",
				model: { providerID: adapter.definition.id, modelID: "BACKEND" },
			}),
		).rejects.toThrow("HTTP 503");
		expect(await adapter.getRuntime().status(session.id)).toBe("failed");
		expect(await adapter.getRuntime().lastError?.(session.id)).toContain(
			"upstream unavailable",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
