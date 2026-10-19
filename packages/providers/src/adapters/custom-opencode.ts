import { randomUUID } from "node:crypto";
import {
	type AgentEvent,
	type AgentModel,
	type AgentRuntime,
	type AgentSession,
	type AuthResult,
	type AuthStatus,
	type CliProviderAdapter,
	type CreateSessionInput,
	connectionId,
	normalizeModel,
	type ProviderDefinition,
	type ProviderDetectionResult,
	type RuntimeOutput,
	type AgentRunStatus,
	type RuntimeModel,
	type SendMessageInput,
} from "../core";

export type ImportedCustomModel = {
	id: string;
	name: string;
	contextWindow?: number;
	outputLimit?: number;
};

export type CustomOpenCodeProviderConfig = {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	models: ImportedCustomModel[];
};

export async function discoverCustomModels(
	baseUrl: string,
	apiKey: string,
): Promise<ImportedCustomModel[]> {
	const url = new URL(baseUrl);
	const root = url.toString().replace(/\/+$/, "");
	const modelsUrl = /\/v1\/*$/i.test(url.pathname)
		? `${root}/models`
		: `${root}/v1/models`;
	const headers = new Headers({ accept: "application/json" });
	if (apiKey.trim()) headers.set("authorization", `Bearer ${apiKey.trim()}`);
	const response = await fetch(modelsUrl, {
		headers,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok)
		throw new Error(`Model endpoint returned HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!payload || typeof payload !== "object" || !("data" in payload))
		throw new Error("The endpoint response must contain a data array of models");
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data))
		throw new Error("The endpoint response must contain a data array of models");
	const models = data.flatMap((item): ImportedCustomModel[] => {
		if (!item || typeof item !== "object") return [];
		const model = item as {
			id?: unknown;
			name?: unknown;
			context_length?: unknown;
			max_output_tokens?: unknown;
			max_completion_tokens?: unknown;
			output_token_limit?: unknown;
		};
		if (typeof model.id !== "string" || !model.id.trim()) return [];
		const contextWindow = Number(model.context_length);
		const outputLimit = Number(
			model.max_output_tokens ??
				model.max_completion_tokens ??
				model.output_token_limit,
		);
		return [
			{
				id: model.id,
				name:
					typeof model.name === "string" && model.name.trim()
						? model.name.trim()
						: model.id,
				...(Number.isSafeInteger(contextWindow) && contextWindow > 0
					? { contextWindow }
					: {}),
			...(Number.isSafeInteger(outputLimit) && outputLimit > 0
				? { outputLimit }
				: {}),
			},
		];
	});
	if (!models.length) throw new Error("No usable models were returned by /v1/models");
	return models;
}

export async function testCustomModel(
	baseUrl: string,
	apiKey: string,
	modelId: string,
): Promise<void> {
	const url = new URL(baseUrl);
	const root = url.toString().replace(/\/+$/, "");
	const completionsUrl = /\/v1\/*$/i.test(url.pathname)
		? `${root}/chat/completions`
		: `${root}/v1/chat/completions`;
	const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
	if (apiKey.trim()) headers.set("authorization", `Bearer ${apiKey.trim()}`);
	const response = await fetch(completionsUrl, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: "Reply with exactly OK." }],
			max_tokens: 8,
			stream: false,
		}),
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
		throw new Error(
			`Model endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
		);
	}
	const payload: unknown = await response.json();
	if (
		!payload ||
		typeof payload !== "object" ||
		!("choices" in payload) ||
		!Array.isArray(payload.choices) ||
		!payload.choices.some(
			(choice) =>
				choice &&
				typeof choice === "object" &&
				"message" in choice &&
				choice.message &&
				typeof choice.message === "object" &&
				"content" in choice.message &&
				typeof choice.message.content === "string" &&
				choice.message.content.trim(),
			)
	)
		throw new Error("Model endpoint returned no text response");
}

export function ensureOpenAiSseTerminator(
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let tail = "";
	let hasDoneMarker = false;
	let hasFinishReason = false;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				const text = decoder.decode(chunk, { stream: true });
				tail = `${tail}${text}`.slice(-8192);
				if (tail.includes("[DONE]")) hasDoneMarker = true;
				if (
					/"finish_reason"\s*:\s*"(?:stop|length|tool_calls|function_call)"/.test(
						tail,
					)
				)
					hasFinishReason = true;
				controller.enqueue(chunk);
			},
			flush(controller) {
				const remaining = decoder.decode();
				if (remaining) controller.enqueue(encoder.encode(remaining));
				if (!hasFinishReason)
					controller.enqueue(
						encoder.encode(
							'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
						),
					);
				if (!hasDoneMarker)
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			},
		}),
	);
}

export function openCodeProviderConfig(
	provider: CustomOpenCodeProviderConfig,
	overrides: { baseUrl?: string; apiKey?: string } = {},
) {
	const baseUrl = overrides.baseUrl ?? provider.baseUrl;
	return {
		provider: {
			[provider.id]: {
				npm: "@ai-sdk/openai-compatible",
				name: provider.name,
				options: {
					baseURL: /\/v1\/*$/i.test(baseUrl)
						? baseUrl
						: `${baseUrl.replace(/\/$/, "")}/v1`,
					apiKey: (overrides.apiKey ?? provider.apiKey) || undefined,
				},
				models: Object.fromEntries(
					provider.models.map((model) => [
						model.id,
						{
							name: model.name,
							...(model.contextWindow
								? {
										limit: {
											context: model.contextWindow,
											output: Math.max(
												1,
												Math.min(
													model.outputLimit ?? 8_192,
													model.contextWindow,
												),
											),
										},
									}
								: {}),
						},
					]),
				),
			},
		},
	};
}

export class CustomOpenCodeProviderAdapter implements CliProviderAdapter {
	readonly definition: ProviderDefinition;
	private readonly runs = new Map<
		string,
		{
			status: "queued" | "running" | "completed" | "failed" | "cancelled";
			output: string;
			tokens?: { total?: number; input?: number; output?: number };
		error?: string;
			controller?: AbortController;
		}
	>();

	constructor(readonly config: CustomOpenCodeProviderConfig) {
		this.definition = {
			id: config.id,
			name: config.name,
			executable: "OpenAI-compatible API",
			capabilities: [
				"chat",
				"coding",
				"streaming",
				"models",
				"sessions",
				"system-prompt",
				"custom-model",
			],
			install: { supported: false },
			authStrategy: "api-key",
		};
	}

	async detect(): Promise<ProviderDetectionResult> {
		try {
			await discoverCustomModels(this.config.baseUrl, this.config.apiKey);
			return { installed: true };
		} catch {
			return { installed: false };
		}
	}

	async getVersion(): Promise<string | null> {
		return null;
	}

	async getAuthStatus(): Promise<AuthStatus> {
		try {
			await discoverCustomModels(this.config.baseUrl, this.config.apiKey);
			return { authenticated: true, strategy: "api-key" };
		} catch (error) {
			return {
				authenticated: false,
				strategy: "api-key",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async authenticate(): Promise<AuthResult> {
		const status = await this.getAuthStatus();
		return { status, launched: false };
	}

	async disconnect(): Promise<void> {}

	async listModels(): Promise<AgentModel[]> {
		const connection = connectionId(this.definition.id);
		const models = await discoverCustomModels(
			this.config.baseUrl,
			this.config.apiKey,
		);
		return models.map((model) =>
			normalizeModel({
				providerId: this.definition.id,
				connectionId: connection,
				modelId: model.id,
				name: model.name,
				displayName: model.name,
				...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
				capabilities: ["text", "coding", "tools"],
				isAvailable: true,
				metadata: { modelId: model.id, providerName: this.definition.name },
			}),
		);
	}

	async createSession(_input: CreateSessionInput): Promise<AgentSession> {
		const id = randomUUID();
		this.runs.set(id, { status: "queued", output: "" });
		return {
			id,
			providerId: this.definition.id,
			connectionId: connectionId(this.definition.id),
			providerSessionId: id,
			createdAt: new Date().toISOString(),
		};
	}

	async prompt(input: {
		sessionId: string;
		prompt: string;
		system?: string;
		model?: RuntimeModel;
		images?: Array<{ mime: string; data: string }>;
	}): Promise<void> {
		const run = this.runs.get(input.sessionId);
		if (!run) throw new Error("Custom provider session was not found");
		if (run.status === "running") throw new Error("Session is already running");
		const controller = new AbortController();
		run.controller = controller;
		run.status = "running";
		run.output = "";
		run.error = undefined;
		const timeout = setTimeout(() => controller.abort("Provider request timed out"), 120_000);
		try {
			const root = this.config.baseUrl.replace(/\/+$/, "");
			const endpoint = /\/v1$/i.test(root)
				? `${root}/chat/completions`
				: `${root}/v1/chat/completions`;
			const headers = new Headers({
				"content-type": "application/json",
				accept: "application/json",
			});
			if (this.config.apiKey.trim())
				headers.set("authorization", `Bearer ${this.config.apiKey.trim()}`);
			const userContent = input.images?.length
				? [
						{ type: "text", text: input.prompt },
						...input.images.map((image) => ({
							type: "image_url",
							image_url: { url: `data:${image.mime};base64,${image.data}` },
						})),
					]
				: input.prompt;
			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				signal: controller.signal,
				body: JSON.stringify({
					model: input.model?.modelID ?? this.config.models[0]?.id,
					messages: [
						...(input.system ? [{ role: "system", content: input.system }] : []),
						{ role: "user", content: userContent },
					],
					stream: false,
				}),
			});
			if (!response.ok) {
				const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 400);
				throw new Error(
					`Provider request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
				);
			}
			const payload = (await response.json()) as {
				choices?: Array<{ message?: { content?: unknown } }>;
				usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
			};
			const content = payload.choices?.[0]?.message?.content;
			const output = typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.flatMap((part) =>
								part && typeof part === "object" && "text" in part && typeof part.text === "string"
									? [part.text]
									: [],
							)
							.join("")
					: "";
			if (!output.trim()) throw new Error("Provider returned no text response");
			run.output = output;
			run.tokens = {
				total: payload.usage?.total_tokens,
				input: payload.usage?.prompt_tokens,
				output: payload.usage?.completion_tokens,
			};
			run.status = "completed";
		} catch (error) {
			run.error = controller.signal.aborted
				? "Provider request timed out or was cancelled"
				: error instanceof Error
					? error.message
					: String(error);
			run.status = controller.signal.aborted ? "cancelled" : "failed";
			throw new Error(run.error);
		} finally {
			clearTimeout(timeout);
			run.controller = undefined;
		}
	}

	async status(sessionId: string): Promise<AgentRunStatus> {
		return this.runs.get(sessionId)?.status ?? "failed";
	}

	async lastError(sessionId: string) {
		return this.runs.get(sessionId)?.error ?? null;
	}

	async readOutput(sessionId: string): Promise<RuntimeOutput | null> {
		const run = this.runs.get(sessionId);
		return run
			? { output: run.output, ...(run.tokens ? { tokens: run.tokens } : {}) }
			: null;
	}

	async wait(
		sessionId: string,
		options: {
			timeoutMs?: number;
			pollIntervalMs?: number;
			onStatus?: (status: AgentRunStatus) => void | Promise<void>;
		} = {},
	): Promise<Exclude<AgentRunStatus, "queued" | "running" | "waiting_permission">> {
		const deadline = Date.now() + (options.timeoutMs ?? 120_000);
		while (Date.now() < deadline) {
			const status = await this.status(sessionId);
			await options.onStatus?.(status);
			if (status === "completed" || status === "failed" || status === "cancelled") return status;
			await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 100));
		}
		return "interrupted";
	}

	async abort(sessionId: string): Promise<void> {
		const run = this.runs.get(sessionId);
		if (!run) return;
		run.status = "cancelled";
		run.controller?.abort();
	}

	async deleteSession(sessionId: string): Promise<void> {
		this.runs.get(sessionId)?.controller?.abort();
		this.runs.delete(sessionId);
	}

	async getDiff(): Promise<unknown> {
		return [];
	}

	async *sendMessage(input: SendMessageInput): AsyncIterable<AgentEvent> {
		yield { type: "session.started", providerSessionId: input.sessionId };
		try {
			await this.prompt({
				sessionId: input.sessionId,
				prompt: input.message,
				model: { providerID: this.definition.id, modelID: input.model.modelId },
			});
			yield { type: "session.completed" };
		} catch (error) {
			yield {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async cancelSession(sessionId: string): Promise<void> {
		await this.abort(sessionId);
	}

	getRuntime(): AgentRuntime {
		return this;
	}
}
