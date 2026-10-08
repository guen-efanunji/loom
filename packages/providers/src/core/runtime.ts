export type AgentRunStatus =
	| "queued"
	| "running"
	| "waiting_permission"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export type RuntimeOutput = {
	output: string;
	truncated?: boolean;
	activities?: RuntimeActivity[];
};

/** A normalized provider tool invocation that can be shown in chat. */
export type RuntimeActivity = {
	id: string;
	tool: string;
	status: "running" | "completed" | "error";
	input?: Record<string, unknown>;
	output?: string;
	error?: string;
	metadata?: Record<string, unknown>;
};

export type RuntimeModel = {
	providerID: string;
	modelID: string;
};

export type RuntimeAgentModel = RuntimeModel;

/**
 * How a CLI run should gate tool permissions.
 * - `auto`: approve every tool without asking (maps to the provider's skip-permissions flag).
 * - `ask`: gate tools through an interactive hook; `env` carries the callback secret so the
 *   provider's PreToolUse hook can reach the Loom daemon and hold a tool until the user decides.
 */
export type RuntimePermission = {
	mode: "auto" | "ask";
	env?: Record<string, string>;
};

export type AgentRuntime = {
	createSession(input: {
		cwd: string;
		title: string;
		readOnly?: boolean;
	}): Promise<{ id: string }>;
	prompt(input: {
		sessionId: string;
		prompt: string;
		model?: RuntimeModel;
		/** Base64 images (pasted photos, mockups) sent alongside the text. */
		images?: Array<{ mime: string; data: string }>;
		/** Tool-permission policy for this run; CLI providers only. */
		permission?: RuntimePermission;
	}): Promise<void>;
	status(sessionId: string): Promise<AgentRunStatus>;
	lastError?(sessionId: string): Promise<string | null>;
	readOutput?(sessionId: string): Promise<RuntimeOutput | null>;
	wait(
		sessionId: string,
		options?: {
			timeoutMs?: number;
			pollIntervalMs?: number;
			onStatus?: (status: AgentRunStatus) => void | Promise<void>;
		},
	): Promise<
		Exclude<AgentRunStatus, "queued" | "running" | "waiting_permission">
	>;
	abort(sessionId: string): Promise<void>;
	getDiff(sessionId: string): Promise<unknown>;
};
