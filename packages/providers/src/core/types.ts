import type { AgentRuntime } from "./runtime";

export type {
	AgentRunStatus,
	AgentRuntime,
	RuntimeAgentModel,
	RuntimeModel,
	RuntimeOutput,
} from "./runtime";

export type ProviderCapability =
	| "chat"
	| "coding"
	| "streaming"
	| "models"
	| "sessions"
	| "resume-session"
	| "tool-use"
	| "permissions"
	| "diff"
	| "structured-output"
	| "image-input"
	| "reasoning-effort"
	| "system-prompt"
	| "custom-model";

export type ProviderDefinition = {
	id: string;
	name: string;
	executable: string;
	homepage?: string;
	capabilities: ProviderCapability[];
	minimumVersion?: string;
	install: { supported: boolean; url?: string };
	authStrategy: AuthStrategy;
	authCommand?: readonly string[];
};

export type ProviderConnectionStatus =
	| "disconnected"
	| "checking"
	| "connected"
	| "auth-required"
	| "error";

export type ProviderConnection = {
	id: string;
	providerId: string;
	name: string;
	status: ProviderConnectionStatus;
	executablePath: string | null;
	version: string | null;
	authenticated: boolean;
	authCommand: readonly string[] | null;
	lastCheckedAt: string | null;
	error?: string;
	capabilities: ProviderCapability[];
};

export type ModelCapability =
	| "text"
	| "image"
	| "tools"
	| "reasoning"
	| "coding"
	| "structured-output";

export type ModelRef = {
	providerId: string;
	connectionId: string;
	modelId: string;
};

export type AgentRuntimeSelection = ModelRef;

export type AgentModel = {
	id: string;
	providerId: string;
	connectionId: string;
	name: string;
	displayName: string;
	description?: string;
	contextWindow?: number;
	capabilities: ModelCapability[];
	isDefault?: boolean;
	isAvailable: boolean;
	metadata?: Record<string, unknown>;
};

export type AuthStrategy =
	| "none"
	| "browser"
	| "device-code"
	| "terminal"
	| "api-key"
	| "provider-managed";

export type AuthStatus = {
	authenticated: boolean;
	strategy: AuthStrategy;
	accountLabel?: string;
	message?: string;
};

export type AuthenticateInput = {
	cwd?: string;
};

export type AuthResult = {
	status: AuthStatus;
	launched: boolean;
	command?: readonly string[];
};

export type ProviderDetectionResult = {
	installed: boolean;
	executablePath?: string;
	version?: string;
	authenticated?: boolean;
	error?: string;
};

export type AgentAttachment = {
	filename: string;
	mime: string;
	url: string;
};

export type CreateSessionInput = {
	cwd: string;
	title: string;
	readOnly?: boolean;
	model?: ModelRef;
};

export type AgentSession = {
	id: string;
	providerId: string;
	connectionId: string;
	providerSessionId?: string;
	createdAt: string;
};

export type AgentPermissionRequest = {
	id: string;
	sessionId: string;
	tool: string;
	input?: unknown;
};

export type SendMessageInput = {
	sessionId: string;
	model: ModelRef;
	message: string;
	cwd: string;
	attachments?: AgentAttachment[];
};

export type AgentEvent =
	| { type: "message.delta"; text: string }
	| { type: "message.completed" }
	| { type: "tool.started"; tool: string; input?: unknown }
	| { type: "tool.completed"; tool: string; output?: unknown }
	| { type: "permission.requested"; request: AgentPermissionRequest }
	| { type: "session.started"; providerSessionId?: string }
	| { type: "session.completed" }
	| { type: "error"; message: string };

export type ProviderErrorCode =
	| "NOT_INSTALLED"
	| "AUTH_REQUIRED"
	| "AUTH_FAILED"
	| "MODEL_NOT_FOUND"
	| "PROCESS_FAILED"
	| "RATE_LIMITED"
	| "CONTEXT_LIMIT"
	| "PERMISSION_DENIED"
	| "UNSUPPORTED"
	| "UNKNOWN";

export class ProviderError extends Error {
	readonly code: ProviderErrorCode;
	readonly providerId?: string;
	readonly details: Record<string, string>;

	constructor(
		code: ProviderErrorCode,
		message: string,
		options: { providerId?: string; details?: Record<string, string> } = {},
	) {
		super(message);
		this.name = "ProviderError";
		this.code = code;
		this.providerId = options.providerId;
		this.details = options.details ?? {};
	}
}

export type ProviderUpdateInfo = {
	supported: boolean;
	currentVersion?: string;
	latestVersion?: string;
	updateAvailable?: boolean;
};

export type CliProviderAdapter = {
	readonly definition: ProviderDefinition;
	detect(): Promise<ProviderDetectionResult>;
	getVersion(): Promise<string | null>;
	getAuthStatus(): Promise<AuthStatus>;
	authenticate(input?: AuthenticateInput): Promise<AuthResult>;
	disconnect(): Promise<void>;
	listModels(): Promise<AgentModel[]>;
	createSession(input: CreateSessionInput): Promise<AgentSession>;
	sendMessage(input: SendMessageInput): AsyncIterable<AgentEvent>;
	cancelSession(sessionId: string): Promise<void>;
	resumeSession?(sessionId: string): Promise<AgentSession>;
	getRuntime?(): AgentRuntime;
	getUpdateInfo?(): Promise<ProviderUpdateInfo>;
};
