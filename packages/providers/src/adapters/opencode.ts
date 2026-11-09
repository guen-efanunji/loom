import {
	OpenCodeHttpRuntime,
	type OpenCodeManager,
	requireOpenCodeArray,
} from "@loom/opencode";
import {
	type AgentEvent,
	type AgentModel,
	type AgentRuntime,
	type AgentSession,
	type AuthenticateInput,
	type AuthResult,
	type AuthStatus,
	type CliProviderAdapter,
	type CreateSessionInput,
	connectionId,
	normalizeModel,
	type ProviderDefinition,
	type ProviderDetectionResult,
	type SendMessageInput,
} from "../core";
import { findExecutable, readVersion } from "./cli";

export const openCodeDefinition: ProviderDefinition = {
	id: "opencode",
	name: "OpenCode CLI",
	executable: "opencode",
	homepage: "https://opencode.ai/docs/",
	authCommand: ["auth", "login"],
	capabilities: [
		"chat",
		"coding",
		"streaming",
		"models",
		"sessions",
		"resume-session",
		"tool-use",
		"permissions",
		"diff",
		"system-prompt",
		"custom-model",
	],
	install: { supported: true, url: "https://opencode.ai/docs/" },
	authStrategy: "provider-managed",
};

export class OpenCodeProviderAdapter implements CliProviderAdapter {
	readonly definition = openCodeDefinition;
	readonly runtime: OpenCodeHttpRuntime;
	private readonly manager: OpenCodeManager;

	constructor(options: {
		manager: OpenCodeManager;
		runtime?: OpenCodeHttpRuntime;
	}) {
		this.manager = options.manager;
		this.runtime = options.runtime ?? new OpenCodeHttpRuntime();
	}

	async detect(): Promise<ProviderDetectionResult> {
		const installed = await this.manager.discover();
		if (!installed) return { installed: false };
		const [serverVersion, executablePath] = await Promise.all([
			this.runtime
				.request<{ version?: string }>("/api/info")
				.then((body) => body.version)
				.catch(() => undefined),
			findExecutable("opencode"),
		]);
		const version = executablePath
			? ((await readVersion(executablePath)) ?? serverVersion)
			: serverVersion;
		return {
			installed: true,
			executablePath: executablePath ?? undefined,
			version,
		};
	}

	async getVersion(): Promise<string | null> {
		return (await this.detect()).version ?? null;
	}

	async getAuthStatus(): Promise<AuthStatus> {
		if (!(await this.manager.health()))
			return {
				authenticated: false,
				strategy: "provider-managed",
				message: "OpenCode server is unavailable",
			};
		try {
			await this.runtime.request("/api/info");
			return { authenticated: true, strategy: "provider-managed" };
		} catch (error) {
			const status = (
				error as { details?: { status?: string } } | null
			)?.details?.status;
			if (status === "401")
				return {
					authenticated: false,
					strategy: "provider-managed",
					message:
						"OpenCode server requires login: run `opencode auth login` in a terminal, then restart OpenCode",
				};
			return {
				authenticated: false,
				strategy: "provider-managed",
				message: "OpenCode server is unavailable",
			};
		}
	}

	async authenticate(_input?: AuthenticateInput): Promise<AuthResult> {
		await this.manager.start();
		const status = await this.getAuthStatus();
		return { status, launched: true };
	}

	async disconnect(): Promise<void> {
		await this.manager.stop();
	}

	async listModels(): Promise<AgentModel[]> {
		const connection = connectionId(this.definition.id);
		const models = requireOpenCodeArray<{
			id?: string;
			modelID?: string;
			providerID?: string;
			name?: string;
			limit?: { context?: number; output?: number };
			capabilities?: { tools?: boolean; input?: string[] };
		}>(await this.runtime.request<unknown>("/api/model"), "/api/model");
		return models.flatMap((model) => {
			const modelId = model.modelID ?? model.id;
			const upstreamProviderId = model.providerID;
			if (!modelId || !upstreamProviderId) return [];
			return [
				normalizeModel({
					providerId: this.definition.id,
					connectionId: connection,
					modelId: `${upstreamProviderId}/${modelId}`,
					name: model.name ?? modelId,
					displayName: model.name ?? modelId,
					contextWindow: model.limit?.context,
					outputLimit: model.limit?.output,
					capabilities: [
						"text",
						"coding",
						...(model.capabilities?.tools ? ["tools" as const] : []),
					],
					isAvailable: true,
					metadata: {
						upstreamProviderId,
						providerModelId: modelId,
						modelId: `${upstreamProviderId}/${modelId}`,
					},
				}),
			];
		});
	}

	async createSession(input: CreateSessionInput): Promise<AgentSession> {
		const session = await this.runtime.createSession({
			cwd: input.cwd,
			title: input.title,
			readOnly: input.readOnly,
		});
		return {
			id: session.id,
			providerId: this.definition.id,
			connectionId: connectionId(this.definition.id),
			providerSessionId: session.id,
			createdAt: new Date().toISOString(),
		};
	}

	async *sendMessage(input: SendMessageInput): AsyncIterable<AgentEvent> {
		yield { type: "session.started", providerSessionId: input.sessionId };
		try {
			const [upstreamProviderId, ...upstreamModelParts] =
				input.model.modelId.split("/");
			await this.runtime.prompt({
				sessionId: input.sessionId,
				prompt: input.message,
				model: {
					providerID: upstreamProviderId || input.model.providerId,
					modelID: upstreamModelParts.join("/") || input.model.modelId,
				},
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
		await this.runtime.abort(sessionId);
	}

	getRuntime(): AgentRuntime {
		return this.runtime;
	}
}

export type OpenCodeChatGateway = Pick<OpenCodeHttpRuntime, "request">;

export function createOpenCodeAdapter(
	manager: OpenCodeManager,
	runtime?: OpenCodeHttpRuntime,
): OpenCodeProviderAdapter {
	return new OpenCodeProviderAdapter({ manager, runtime });
}
