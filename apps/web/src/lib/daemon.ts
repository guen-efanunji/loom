import type {
	AgentModelRef,
	DesignActivity,
	DesignAttachment,
	DesignChatResult,
	DesignFrame,
	DesignMessage,
	DesignNode,
	DesignPatch,
	DesignQuestion,
	DesignThread,
	DesignViewport,
} from "@loom/protocol";
import {
	daemonEventSchema,
	type AgentRun as ProtocolAgentRun,
	type DaemonEvent as ProtocolDaemonEvent,
	type PermissionRequest as ProtocolPermissionRequest,
	type TaskExecutor,
} from "@loom/protocol";
import { PUBLIC_SERVER_URL } from "$app/env/public";
import { dev } from "$app/environment";
export type Project = {
	id: string;
	name: string;
	path: string;
	defaultBranch: string;
	autoAccept?: boolean;
	createdAt: string;
};

export type DirectoryListing = {
	path: string;
	parentPath: string | null;
	entries: Array<{ name: string; path: string }>;
};

export type ProjectReviewPolicy = {
	id: string;
	projectId: string;
	mode: "manual" | "automatic" | "hybrid";
	reviewerExecutorJson: string | null;
	autoMerge: boolean;
	requiredChecksJson: string;
	maxRevisionRounds: number;
	version: number;
	updatedAt: string;
};

export type McpInventory = {
	projectId: string | null;
	projectName: string | null;
	generatedAt: string;
	connectionStatus: "not-observed";
	coverage: {
		maxConfigBytes: number;
		maxServersPerSource: number;
		maxServers: number;
		truncated: boolean;
	};
	sources: Array<{
		id: string;
		runtime: string;
		scope: string;
		file: string;
		status: string;
		issue?: string;
	}>;
	servers: Array<{
		id: string;
		name: string;
		runtime: string;
		scope: string;
		source: string;
		ownership: string;
		transport: string;
		connectionState: "unknown";
		enabled: boolean | null;
		command?: string;
		argumentCount: number;
		endpointHost?: string;
		environmentVariableNames: string[];
		headerNames: string[];
	}>;
};

export type ManagedMcpConnection = {
	id: string;
	label: string;
	transport: "stdio" | "streamable-http";
	status:
		| "disconnected"
		| "connecting"
		| "auth_required"
		| "connected"
		| "degraded"
		| "error"
		| "interrupted"
		| string;
	endpointHost?: string;
	command?: string;
	argumentCount: number;
	workingDirectory?: string;
	environmentReferenceNames: string[];
	headerReferences: Array<{ header: string; envRef: string }>;
	protocolVersion: string | null;
	capabilities: Record<string, unknown>;
	tools: Array<{ name: string; description?: string }>;
	toolCount: number;
	lastConnectedAt: number | null;
	lastTestedAt: number | null;
	lastError: string | null;
	createdAt: number;
	updatedAt: number;
};

export type ManagedMcpConnectionInput = {
	label: string;
	transport: "stdio" | "streamable-http";
	endpoint?: string;
	command?: string;
	args?: string[];
	cwd?: string;
	envRefs?: Record<string, string>;
	headerEnvRefs?: Record<string, string>;
};

export type ContextEntry = {
	id: string;
	projectId: string | null;
	kind: "knowledge" | "rule" | "skill" | "memory";
	title: string;
	description: string;
	content: string;
	scope: "global" | "project";
	sourceKind: string;
	sourceRef: string | null;
	nativeRuntime: string | null;
	compatibility: string;
	status: string;
	enabledInLoom: boolean;
	surfaces: string[];
	pathGlobs: string[];
	tags: string[];
	contentHash: string;
	currentVersion: number;
	createdAt: string;
	updatedAt: string;
};

export type NativeContextSkill = {
	id: string;
	name: string;
	description: string;
	content: string;
	valid: boolean;
	issues: string[];
	compatibility: string[];
	origins: Array<{ source: string; runtimeId: string; scope: string }>;
};

export type ContextSkillDiscovery = {
	projectId: string | null;
	coverage: {
		maxDirectoriesPerSource: number;
		maxDiscoveredSkills: number;
		maxSkillBytes: number;
		truncatedSources: number;
	};
	sources: Array<{
		id: string;
		label: string;
		runtimeId: string;
		scope: string;
		status: string;
		issue?: string;
		truncated?: boolean;
	}>;
	skills: NativeContextSkill[];
};

export type ContextMemoryHistory = {
	decisions: Array<{
		id: string;
		version: number;
		proposedBy: string;
		decidedBy: string | null;
		decision: string;
		createdAt: string;
	}>;
	evidence: Array<{
		id: string;
		sourceType: string;
		sourceId: string;
		sourceHash: string | null;
		verificationStatus: string;
		createdAt: string;
	}>;
};

export type ProjectGitOverview = {
	gitAvailable?: boolean;
	gitMessage?: string;
	branch: string;
	defaultBranch: string;
	branches: string[];
	worktrees: Array<{ path: string; branch: string; current: boolean }>;
	remoteUrl: string | null;
	files: Array<{ status: string; path: string }>;
	truncated: boolean;
	diffStat: string;
};

export type ProjectPullRequests = {
	available: boolean;
	message: string | null;
	pullRequests: Array<{
		number: number;
		title: string;
		url: string;
		state: string;
		headRefName: string;
	}>;
};

export type WalkthroughLanguage = "en" | "id";
export type WalkthroughEvidence = {
	id: string;
	file: string;
	status: string;
	kind: "diff" | "untracked";
	patch: string;
	truncated?: boolean;
};
export type WalkthroughSnapshot = {
	scope: "uncommitted";
	fingerprint: string;
	capturedAt: string;
	files: WalkthroughEvidence[];
	coverage: {
		truncated: boolean;
		excludedFiles: number;
		omittedFiles: number;
		message?: string;
	};
};
export type WalkthroughDocument = {
	schemaVersion: 1;
	title: string;
	summary: string;
	groups: Array<{
		id: string;
		title: string;
		steps: Array<{
			id: string;
			title: string;
			explanation: string;
			evidenceIds: string[];
			observations: string[];
			cautions: Array<{
				kind: "observed" | "inferred" | "unverified";
				message: string;
				evidenceIds: string[];
			}>;
		}>;
	}>;
	limitations: string[];
};
export type WalkthroughGeneration = {
	snapshot: WalkthroughSnapshot;
	document: WalkthroughDocument | null;
	runId: string | null;
	status: "running" | "completed";
	provider: { providerId: string; modelId: string };
};
export type WalkthroughRunProgress = {
	status: "running" | "completed" | "failed";
	document: WalkthroughDocument | null;
	error?: string;
	provider: { providerId: string; modelId: string };
};

export type TaskStatus =
	| "queued"
	| "ready"
	| "blocked"
	| "preparing"
	| "running"
	| "completed"
	| "ready_to_merge"
	| "merge_conflict"
	| "failed"
	| "cancelled";

export type PlanTaskDraft = {
	key: string;
	title: string;
	description: string;
	priority: "low" | "medium" | "high";
	dependencies: string[];
	acceptanceCriteria: string[];
	suggestedFiles: string[];
	parallelGroup?: string;
};

export type AutomationPlan = {
	id: string;
	projectId: string;
	sourceMessageId: string;
	sourceMessage: string;
	sourceSessionId: string | null;
	startedAt: string | null;
	cancelledAt: string | null;
	title: string;
	summary: string;
	status:
		| "draft"
		| "validated"
		| "approved"
		| "executing"
		| "completed"
		| "failed";
	convertedAt: string | null;
	approvedAt: string | null;
	errorMessage: string | null;
	createdAt: string;
};

export type AutomationPlanDetail = {
	plan: AutomationPlan;
	draft: Array<
		PlanTaskDraft & {
			id: string;
			planId: string;
		}
	>;
	tasks: Array<Task & { blockedBy: string[] }>;
	validation: { ok: boolean; issues: Array<{ code: string; message: string }> };
	progress: {
		total: number;
		done: number;
		running: number;
		ready: number;
		blocked: number;
		failed: number;
		percent: number;
	};
};

export type Task = {
	blockedBy?: string[];
	id: string;
	projectId: string;
	planId: string | null;
	title: string;
	prompt: string;
	description: string;
	status: TaskStatus;
	priority: "low" | "medium" | "high";
	acceptanceCriteria: string[];
	suggestedFiles: string[];
	source: "manual" | "planner";
	executor: TaskExecutor | null;
	position: number | null;
	targetBranch: string | null;
	workspaceId: string | null;
	sessionId: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
};
export type TaskDependency = {
	taskId: string;
	dependsOnTaskId: string;
	requiredMilestone:
		| "contract_published"
		| "artifact_ready"
		| "implementation_ready"
		| "integrated";
	artifactId: string | null;
	producer: Task | null;
	artifact?: TaskArtifact | null;
};
export type TaskArtifact = {
	id: string;
	taskId: string;
	producerRunId: string | null;
	kind: string;
	version: string;
	commitSha: string;
	relativePath: string;
	contentHash: string;
	status: string;
	createdAt: string;
};
export type TaskReview = {
	id: string;
	taskId: string;
	runId: string | null;
	reviewerIdentity: string;
	baseSha: string;
	subjectSha: string;
	evidenceHash: string;
	status: string;
	verdictJson: string;
	policyVersion: number;
	createdAt: string;
	decidedAt: string;
};
export type CustomAgentMonitorItem = {
	id: string;
	label: string;
	role: string;
	status: string;
	allowChat: boolean;
	allowCanvas: boolean;
	allowKanban: boolean;
	approvalPolicy: string;
	projectId: string | null;
	provider: string;
	modelId: string | null;
	lastUsedAt: string | number | null;
};
export type CustomAgentRunMonitorItem = {
	id: string;
	agentId: string;
	projectId: string;
	taskId: string | null;
	chatSessionId: string | null;
	status: string;
	trigger: string;
	createdAt: string | number;
	startedAt: string | number | null;
	finishedAt: string | number | null;
};
export type AgentRun = ProtocolAgentRun & {
	startedAt: string | null;
	completedAt: string | null;
};
export type PermissionRequest = ProtocolPermissionRequest & {
	createdAt: string;
	decidedAt: string | null;
};
export type DaemonEvent = ProtocolDaemonEvent;
export type DesignTrace = {
	projectId: string;
	nodeId: string;
	runs: Array<{
		sessionId: string;
		createdAt: string;
		events: Array<{
			type: string;
			text?: string;
			tool?: string;
			status?: string;
			output?: string;
			error?: string;
		}>;
	}>;
};
export type SchedulerTask = {
	taskId: string;
	projectId: string;
	state: string;
};
export type SchedulerState = {
	running: SchedulerTask[];
	queued: SchedulerTask[];
};
export type IntegrationBatch = {
	id: string;
	projectId: string;
	targetBranch: string;
	targetBaseSha: string;
	candidateSha: string | null;
	promotedSha: string | null;
	status: string;
	workspacePath: string | null;
	workspaceBranch: string | null;
	errorMessage: string | null;
	createdAt: string | number;
	updatedAt: string | number;
	checks?: Array<{
		name: string;
		status: string;
		exitCode: number | null;
		evidenceHash: string;
		commandRedacted: string;
	}>;
};

const tokenKey = "loom.daemon.token";

export function serverUrl() {
	// Browser API traffic is same-origin in development (Vite proxy) and
	// production. Keep the direct URL for server-side rendering in dev.
	if (dev && typeof window !== "undefined") return "";
	return dev ? (PUBLIC_SERVER_URL || "/").replace(/\/$/, "") : "";
}

export function getDaemonToken() {
	return typeof localStorage === "undefined"
		? ""
		: (localStorage.getItem(tokenKey) ?? "");
}

export function setDaemonToken(token: string) {
	localStorage.setItem(tokenKey, token.trim());
}

export function websocketUrl() {
	const url = new URL(`${serverUrl()}/api/events`, window.location.origin);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

export function websocketProtocols() {
	return ["loom", getDaemonToken()];
}

export async function provisionDaemonToken() {
	const current = getDaemonToken();
	if (current) return current;
	const response = await fetch(`${serverUrl()}/api/bootstrap`, {
		method: "GET",
		headers: { Accept: "application/json" },
	});
	if (!response.ok)
		throw new Error(
			"Loom daemon is unavailable. Start it with `loom`, then retry.",
		);
	const body = (await response.json()) as { token?: string };
	if (!body.token)
		throw new Error(
			"Loom daemon did not provide a token. Restart the daemon and retry.",
		);
	setDaemonToken(body.token);
	return body.token;
}

export function parseDaemonEvent(value: unknown): DaemonEvent {
	return daemonEventSchema.parse(value);
}

export type DaemonEventReplayPage = {
	events: Array<{ cursor: number; event: DaemonEvent }>;
	cursor: number;
	highWaterCursor: number;
};

export async function replayDaemonEvents(after: number, limit = 200) {
	return request<DaemonEventReplayPage>(
		`/api/events/replay?after=${Math.max(0, Math.floor(after))}&limit=${Math.min(500, Math.max(1, Math.floor(limit)))}`,
	);
}

export async function latestDaemonEventCursor() {
	const result = await request<{ cursor: number }>(
		"/api/events/replay?latest=1",
	);
	return result.cursor;
}

/** Raised when the daemon's server-side UI lock rejects a mutating call. */
export class UiLockedError extends Error {
	constructor(message = "Loom is locked. Enter your UI password to continue.") {
		super(message);
		this.name = "UiLockedError";
	}
}

export async function request<T>(path: string, init: RequestInit = {}) {
	await provisionDaemonToken();
	const headers = new Headers(init.headers);
	const token = getDaemonToken();
	if (token) headers.set("Authorization", `Bearer ${token}`);
	if (init.body) headers.set("Content-Type", "application/json");
	const response = await fetch(`${serverUrl()}${path}`, {
		...init,
		headers,
		// The server-side UI lock session is an HttpOnly cookie; cross-origin
		// dev requests must send it explicitly.
		credentials: "include",
	});
	if (!response.ok) {
		let message = `${response.status} ${response.statusText}`;
		let code: string | undefined;
		try {
			const body = (await response.json()) as {
				error?: { message?: string; code?: string };
			};
			message = body.error?.message ?? message;
			code = body.error?.code;
		} catch {}
		if (response.status === 423) throw new UiLockedError(message);
		// Structured codes let callers react (offer isolation, show conflicts) without
		// matching on human-readable message text.
		throw Object.assign(new Error(message), {
			code,
			status: response.status,
		});
	}
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

export const daemon = {
	listProjects: () => request<Project[]>("/api/projects"),
	listDirectories: (path?: string, showHidden = false) => {
		const params = new URLSearchParams();
		if (path) params.set("path", path);
		if (showHidden) params.set("showHidden", "true");
		return request<DirectoryListing>(`/api/filesystem/directories?${params}`);
	},
	getMcpInventory: (projectId?: string) =>
		request<McpInventory>(
			`/api/mcp/inventory${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
		),
	listManagedMcpConnections: () =>
		request<{ connections: ManagedMcpConnection[] }>("/api/mcp/connections"),
	createManagedMcpConnection: (input: ManagedMcpConnectionInput) =>
		request<{ connection: ManagedMcpConnection }>("/api/mcp/connections", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	updateManagedMcpConnection: (id: string, input: ManagedMcpConnectionInput) =>
		request<{ connection: ManagedMcpConnection }>(
			`/api/mcp/connections/${encodeURIComponent(id)}`,
			{
				method: "PUT",
				body: JSON.stringify(input),
			},
		),
	testManagedMcpConnection: (
		id: string,
		options: { approved: true; allowPrivateNetwork: boolean },
	) =>
		request<{
			ok: true;
			protocolVersion: string | null;
			server: unknown;
			capabilities: Record<string, unknown>;
			tools: Array<{ name: string; description?: string }>;
			toolCount: number;
			status: "disconnected";
		}>(`/api/mcp/connections/${encodeURIComponent(id)}/test`, {
			method: "POST",
			body: JSON.stringify(options),
		}),
	connectManagedMcpConnection: (
		id: string,
		options: { approved: true; allowPrivateNetwork: boolean },
	) =>
		request<{ connection: ManagedMcpConnection }>(
			`/api/mcp/connections/${encodeURIComponent(id)}/connect`,
			{
				method: "POST",
				body: JSON.stringify(options),
			},
		),
	disconnectManagedMcpConnection: (id: string) =>
		request<{ connection: ManagedMcpConnection }>(
			`/api/mcp/connections/${encodeURIComponent(id)}/disconnect`,
			{ method: "POST", body: "{}" },
		),
	deleteManagedMcpConnection: (id: string) =>
		request<{ ok: true }>(`/api/mcp/connections/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
	getProject: (id: string) => request<Project>(`/api/projects/${id}`),
	getProjectReviewPolicy: (id: string) =>
		request<{ policy: ProjectReviewPolicy; autoMergeAvailable: boolean }>(
			`/api/projects/${id}/review-policy`,
		),
	setProjectReviewPolicy: (
		id: string,
		policy: Omit<
			ProjectReviewPolicy,
			"id" | "projectId" | "version" | "updatedAt"
		>,
	) =>
		request<{ policy: ProjectReviewPolicy }>(
			`/api/projects/${id}/review-policy`,
			{
				method: "PUT",
				body: JSON.stringify(policy),
			},
		),
	getProjectGit: (id: string) =>
		request<ProjectGitOverview>(`/api/projects/${id}/git`),
	generateProjectCommitMessage: (
		id: string,
		model: { providerId: string; modelId: string },
	) =>
		request<{
			message: string;
			provider: { providerId: string; modelId: string };
		}>(`/api/projects/${id}/git/commit-message`, {
			method: "POST",
			body: JSON.stringify({ model }),
		}),
	commitProjectGit: (id: string, message: string, push = false) =>
		request<{ committed: boolean; synced: boolean; output: string }>(
			`/api/projects/${id}/git/commit`,
			{ method: "POST", body: JSON.stringify({ message, push }) },
		),
	checkoutProjectBranch: (id: string, branch: string) =>
		request<{ branch: string }>(`/api/projects/${id}/git/checkout`, {
			method: "POST",
			body: JSON.stringify({ branch }),
		}),
	createProjectWorktree: (id: string, branch: string) =>
		request<{ path: string; branch: string }>(
			`/api/projects/${id}/git/worktrees`,
			{
				method: "POST",
				body: JSON.stringify({ branch }),
			},
		),
	getProjectPullRequests: (id: string) =>
		request<ProjectPullRequests>(`/api/projects/${id}/pull-requests`),
	createProjectPullRequest: (
		id: string,
		input: { title: string; body: string; base?: string; draft: boolean },
	) =>
		request<{ url: string }>(`/api/projects/${id}/pull-requests`, {
			method: "POST",
			body: JSON.stringify(input),
		}),
	getProjectWalkthroughSnapshot: (id: string) =>
		request<{ snapshot: WalkthroughSnapshot }>(
			`/api/projects/${id}/walkthrough/snapshot`,
		),
	generateProjectWalkthrough: (
		id: string,
		input: {
			language: WalkthroughLanguage;
			model: { providerId: string; modelId: string };
		},
	) =>
		request<WalkthroughGeneration>(`/api/projects/${id}/walkthrough`, {
			method: "POST",
			body: JSON.stringify(input),
		}),
	getProjectWalkthroughRun: (id: string, runId: string) =>
		request<WalkthroughRunProgress>(
			`/api/projects/${id}/walkthrough/runs/${encodeURIComponent(runId)}`,
		),
	updateProject: (
		id: string,
		input: { name?: string; path?: string; autoAccept?: boolean },
	) =>
		request<Project>(`/api/projects/${id}`, {
			method: "PATCH",
			body: JSON.stringify(input),
		}),
	createProject: (path: string) =>
		request<Project>("/api/projects", {
			method: "POST",
			body: JSON.stringify({ path }),
		}),
	deleteProject: (id: string) =>
		request<void>(`/api/projects/${id}`, { method: "DELETE" }),
	listProviders: () =>
		request<
			Array<{
				id: string;
				providerId: string;
				name: string;
				command: string;
				install: string | null;
				auth: string;
				authCommand: string[] | null;
				installed: boolean;
				executablePath?: string | null;
				version: string | null;
				status: string;
				authenticated: boolean;
				capabilities: string[];
			}>
		>("/api/providers"),
	listAvailableProviderModels: () =>
		request<
			Array<{
				providerID: string;
				modelID: string;
				name: string;
				provider: string;
				contextWindow?: number;
			}>
		>("/api/providers/models"),
	refreshProviders: () =>
		request<
			Array<{
				id: string;
				providerId: string;
				name: string;
				command: string;
				install: string | null;
				auth: string;
				authCommand: string[] | null;
				installed: boolean;
				executablePath?: string | null;
				version: string | null;
				status: string;
				authenticated: boolean;
				capabilities: string[];
			}>
		>("/api/providers/refresh-all", { method: "POST" }),
	checkProviderUpdates: () =>
		request<{
			checkedAt: string;
			updates: Array<{
				providerId: string;
				name: string;
				installed: boolean;
				currentVersion: string | null;
				latestVersion: string | null;
				updateAvailable: boolean;
				updateSupported: boolean;
				updateCommand: string | null;
				error: string | null;
			}>;
		}>("/api/providers/check-updates", { method: "POST" }),
	updateProvider: (id: string) =>
		request<{
			providerId: string;
			name: string;
			previousVersion: string | null;
			latestVersion: string;
			version: string | null;
			output: string;
		}>(`/api/providers/${encodeURIComponent(id)}/update`, { method: "POST" }),
	authProvider: (id: string) =>
		request<{
			launched: boolean;
			connected?: boolean;
			configured?: boolean;
			command?: string[];
			authCommand?: string[] | null;
		}>(`/api/providers/${id}/auth`, { method: "POST" }),
	connectProvider: (id: string) =>
		request<{
			launched: boolean;
			connected: boolean;
			configured?: boolean;
			command?: string[];
		}>(`/api/providers/${id}/connect`, { method: "POST" }),
	disconnectProvider: (id: string) =>
		request<{ disconnected: boolean }>(`/api/providers/${id}/disconnect`, {
			method: "POST",
		}),
	refreshProvider: (id: string) =>
		request<{
			id: string;
			providerId: string;
			status: string;
		}>(`/api/providers/${id}/refresh`, { method: "POST" }),
	refreshProviderModels: (id: string) =>
		request<unknown[]>(
			`/api/providers/${encodeURIComponent(id)}/models/refresh`,
			{
				method: "POST",
			},
		),
	listCustomProviders: () =>
		request<
			Array<{
				id: string;
				name: string;
				baseUrl: string;
				status: string;
				models: Array<{ id: string; name: string; contextWindow?: number }>;
			}>
		>("/api/custom-providers"),
	testCustomProvider: (input: {
		name: string;
		baseUrl: string;
		apiKey: string;
		providerId?: string;
	}) =>
		request<{
			connected: boolean;
			models: Array<{ id: string; name: string; contextWindow?: number }>;
		}>("/api/custom-providers/test", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	testProviderModel: (providerId: string, modelId: string) =>
		request<{ connected: boolean; modelId: string }>(
			`/api/providers/${encodeURIComponent(providerId)}/models/test`,
			{
				method: "POST",
				body: JSON.stringify({ modelId }),
			},
		),
	updateCustomProvider: (
		id: string,
		input: { name: string; baseUrl: string; apiKey: string },
	) =>
		request<{
			provider: { id: string; name: string; baseUrl: string; status: string };
			models: Array<{
				id: string;
				providerId: string;
				connectionId: string;
				name: string;
				displayName: string;
				capabilities: string[];
				isAvailable: boolean;
			}>;
		}>(`/api/custom-providers/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify(input),
		}),
	deleteCustomProvider: (id: string) =>
		request<{ deleted: boolean; id: string }>(
			`/api/custom-providers/${encodeURIComponent(id)}`,
			{ method: "DELETE" },
		),
	createCustomProvider: (input: {
		name: string;
		baseUrl: string;
		apiKey: string;
	}) =>
		request<{
			provider: { id: string; name: string; baseUrl: string; status: string };
			models: Array<{
				id: string;
				providerId: string;
				connectionId: string;
				name: string;
				displayName: string;
				capabilities: string[];
				isAvailable: boolean;
			}>;
		}>("/api/custom-providers", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	listModels: () =>
		request<
			Array<{
				id: string;
				providerId: string;
				connectionId: string;
				name: string;
				displayName: string;
				capabilities: string[];
				metadata?: Record<string, unknown>;
			}>
		>("/api/models"),
	listCustomAgents: (projectId?: string) =>
		request<CustomAgentMonitorItem[]>(
			`/api/agents${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
		),
	listContextEntries: (projectId?: string) =>
		request<ContextEntry[]>(
			`/api/context/entries${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
		),
	discoverContextSkills: (projectId?: string) =>
		request<ContextSkillDiscovery>(
			`/api/context/discover${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
		),
	createContextEntry: (input: Record<string, unknown>) =>
		request<ContextEntry>("/api/context/entries", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	updateContextEntry: (id: string, input: Record<string, unknown>) =>
		request<ContextEntry>(`/api/context/entries/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify(input),
		}),
	deleteContextEntry: (id: string) =>
		request<void>(`/api/context/entries/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
	listContextVersions: (id: string) =>
		request<
			Array<{
				id: string;
				version: number;
				content: string;
				contentHash: string;
				metadata: string;
				createdAt: string;
			}>
		>(`/api/context/entries/${encodeURIComponent(id)}/versions`),
	getContextMemoryHistory: (id: string) =>
		request<ContextMemoryHistory>(
			`/api/context/entries/${encodeURIComponent(id)}/memory-history`,
		),
	getAgentPromptPresets: () =>
		request<Record<string, string>>("/api/agents/prompt-presets"),
	createCustomAgent: (input: Record<string, unknown>) =>
		request<Record<string, unknown>>("/api/agents", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	updateCustomAgent: (id: string, input: Record<string, unknown>) =>
		request<Record<string, unknown>>(`/api/agents/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify(input),
		}),
	deleteCustomAgent: (id: string) =>
		request<void>(`/api/agents/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
	runCustomAgent: (input: {
		agentId: string;
		projectId: string;
		chatSessionId?: string;
		message: string;
	}) =>
		request<{ runId: string; status: string }>("/api/agents/runs/chat", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	getCustomAgentRun: (id: string) =>
		request<Record<string, unknown>>(
			`/api/agents/runs/${encodeURIComponent(id)}`,
		),
	listCustomAgentRuns: (projectId?: string) =>
		request<CustomAgentRunMonitorItem[]>(
			`/api/agents/runs${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
		),
	assignCustomAgent: (input: {
		agentId: string;
		projectId: string;
		taskId: string;
		continuousEnabled?: boolean;
	}) =>
		request<Record<string, unknown>>("/api/agents/assignments", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	continueCustomAgentAssignment: (
		id: string,
		input: {
			taskIds?: string[];
			maxTasks?: number;
			concurrency?: number;
			durationMinutes?: number;
			maxRetries?: number;
			idempotencyKey?: string;
		} = {},
	) =>
		request<Record<string, unknown>>(
			`/api/agents/assignments/${encodeURIComponent(id)}/continue`,
			{ method: "POST", body: JSON.stringify(input) },
		),
	listCustomAgentAssignmentRuns: (id: string) =>
		request<Array<Record<string, unknown>>>(
			`/api/agents/assignments/${encodeURIComponent(id)}/runs`,
		),
	cancelCustomAgentAssignment: (id: string) =>
		request<Record<string, unknown>>(
			`/api/agents/assignments/${encodeURIComponent(id)}/cancel`,
			{ method: "POST" },
		),
	rebuildProjectIndex: (id: string) =>
		request<{ status: string; files: number; indexedAt: string }>(
			`/api/projects/${id}/index/rebuild`,
			{ method: "POST" },
		),
	listTasks: () => request<Task[]>("/api/tasks"),
	listIntegrationBatches: (projectId: string) =>
		request<{ batches: IntegrationBatch[] }>(
			`/api/integration-batches?projectId=${encodeURIComponent(projectId)}`,
		),
	createIntegrationBatch: (
		taskIds: string[],
		requiredChecks: Array<{
			name: string;
			command: string;
			args: string[];
			timeoutMs?: number;
		}> = [],
	) =>
		request<{ batch: IntegrationBatch | null; candidateSha: string }>(
			"/api/integration-batches",
			{
				method: "POST",
				body: JSON.stringify({ taskIds, requiredChecks }),
			},
		),
	getIntegrationBatchDiff: (id: string) =>
		request<{ diff: string; baseSha: string; candidateSha: string }>(
			`/api/integration-batches/${encodeURIComponent(id)}/diff`,
		),
	approveIntegrationBatch: (id: string) =>
		request<{ review: unknown }>(
			`/api/integration-batches/${encodeURIComponent(id)}/review/approve`,
			{ method: "POST" },
		),
	promoteIntegrationBatch: (id: string) =>
		request<{ batchId: string; promotedSha: string; memberTaskIds: string[] }>(
			`/api/integration-batches/${encodeURIComponent(id)}/promote`,
			{ method: "POST" },
		),
	getTask: (id: string) => request<Task>(`/api/tasks/${id}`),
	getTaskDependencies: (id: string) =>
		request<{ dependencies: TaskDependency[] }>(
			`/api/tasks/${id}/dependencies`,
		),
	getTaskReviews: (id: string) =>
		request<{ reviews: TaskReview[] }>(`/api/tasks/${id}/reviews`),
	getTaskArtifacts: (id: string) =>
		request<{ artifacts: TaskArtifact[] }>(`/api/tasks/${id}/artifacts`),
	publishTaskArtifact: (
		id: string,
		input: {
			kind: "contract" | "generated_client" | "schema" | "evidence";
			version: string;
			relativePath: string;
		},
	) =>
		request<{ artifact: TaskArtifact }>(`/api/tasks/${id}/artifacts`, {
			method: "POST",
			body: JSON.stringify(input),
		}),
	approveTaskReview: (id: string) =>
		request<{ review: TaskReview }>(`/api/tasks/${id}/review/approve`, {
			method: "POST",
		}),
	runTaskReview: (id: string) =>
		request<{ review: TaskReview }>(`/api/tasks/${id}/review/run`, {
			method: "POST",
		}),
	addTaskDependency: (
		id: string,
		input: {
			dependsOnTaskId: string;
			requiredMilestone: TaskDependency["requiredMilestone"];
			artifactId?: string | null;
		},
	) =>
		request<{ dependency: Omit<TaskDependency, "producer"> }>(
			`/api/tasks/${id}/dependencies`,
			{
				method: "POST",
				body: JSON.stringify(input),
			},
		),
	removeTaskDependency: (id: string, producerId: string) =>
		request<{ removed: boolean }>(
			`/api/tasks/${id}/dependencies/${producerId}`,
			{
				method: "DELETE",
			},
		),
	createTask: (input: {
		projectId: string;
		title: string;
		prompt: string;
		acceptanceCriteria: string[];
		executor: TaskExecutor;
		targetBranch?: string | null;
	}) =>
		request<Task>("/api/tasks", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	listProviderModels: (id: string) =>
		request<
			Array<{
				id: string;
				providerId: string;
				name: string;
				displayName: string;
				isAvailable: boolean;
				isDefault?: boolean;
				metadata?: Record<string, unknown>;
			}>
		>(`/api/providers/${encodeURIComponent(id)}/models`),
	createTaskBatch: (
		projectId: string,
		tasks: Array<{ title: string; prompt: string }>,
	) =>
		request<{
			results: Array<{
				index: number;
				task: Task | null;
				error: string | null;
			}>;
		}>(`/api/projects/${projectId}/tasks/batch`, {
			method: "POST",
			body: JSON.stringify({ tasks }),
		}),
	createPlan: (input: {
		projectId: string;
		sourceMessageId: string;
		message: string;
		mode?: "plan" | "build";
		sourceSessionId?: string;
		model?: { providerID: string; modelID: string };
	}) =>
		request<{ planId: string; status: string }>("/api/plans", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	retryPlan: (
		id: string,
		input: { model?: { providerID: string; modelID: string } } = {},
	) =>
		request<{ accepted: boolean }>(`/api/plans/${id}/retry`, {
			method: "POST",
			body: JSON.stringify(input),
		}),
	listPlans: (projectId: string) =>
		request<
			Array<AutomationPlan & { progress: AutomationPlanDetail["progress"] }>
		>(`/api/projects/${projectId}/plans`),
	getPlanDetail: (id: string) =>
		request<AutomationPlanDetail>(`/api/plans/${id}`),
	savePlan: (
		id: string,
		input: { title?: string; summary?: string; tasks: PlanTaskDraft[] },
	) =>
		request<{ saved: boolean }>(`/api/plans/${id}`, {
			method: "PATCH",
			body: JSON.stringify(input),
		}),
	validatePlan: (id: string) =>
		request<{
			ok: boolean;
			issues: Array<{ code: string; message: string }>;
		}>(`/api/plans/${id}/validate`, { method: "POST" }),
	approvePlan: (id: string) =>
		request<{ approved: boolean }>(`/api/plans/${id}/approve`, {
			method: "POST",
		}),
	convertPlan: (id: string) =>
		request<{ taskIds: string[]; converted: boolean }>(
			`/api/plans/${id}/tasks`,
			{ method: "POST" },
		),
	startPlan: (id: string) =>
		request<{ started: string[] }>(`/api/plans/${id}/start`, {
			method: "POST",
		}),
	cancelPlan: (id: string) =>
		request<{ cancelled: boolean }>(`/api/plans/${id}/cancel`, {
			method: "POST",
		}),
	deletePlan: (id: string) =>
		request<void>(`/api/plans/${id}`, { method: "DELETE" }),
	getAutomationSettings: () =>
		request<{ automationMode: "review" | "auto-create" | "auto-start" }>(
			"/api/automation/settings",
		),
	saveAutomationSettings: (
		automationMode: "review" | "auto-create" | "auto-start",
	) =>
		request<{ automationMode: string }>("/api/automation/settings", {
			method: "PUT",
			body: JSON.stringify({ automationMode }),
		}),
	startTask: (id: string) =>
		request<{ accepted: boolean }>(`/api/tasks/${id}/start`, {
			method: "POST",
		}),
	cancelTask: (id: string) =>
		request<{ cancelled: boolean }>(`/api/tasks/${id}/cancel`, {
			method: "POST",
		}),
	retryTask: (id: string) =>
		request<{ id: string }>(`/api/tasks/${id}/retry`, { method: "POST" }),
	renameTask: (
		id: string,
		input: {
			title?: string;
			prompt?: string;
			executor?: TaskExecutor | null;
		},
	) =>
		request<Task>(`/api/tasks/${id}`, {
			method: "PATCH",
			body: JSON.stringify(input),
		}),
	deleteTask: (id: string) =>
		request<void>(`/api/tasks/${id}`, { method: "DELETE" }),
	reorderTasks: (projectId: string, orderedIds: string[]) =>
		request<{ reordered: boolean }>(
			`/api/projects/${projectId}/tasks/reorder`,
			{ method: "POST", body: JSON.stringify({ orderedIds }) },
		),
	getRuns: (id: string) => request<AgentRun[]>(`/api/tasks/${id}/runs`),
	getOutput: (id: string) =>
		request<{
			output: string;
			truncated: boolean;
			activities?: Array<{
				id: string;
				tool: string;
				status: "running" | "completed" | "error";
				input?: Record<string, unknown>;
				metadata?: Record<string, unknown>;
			}>;
		}>(`/api/tasks/${id}/output`),
	getScheduler: () => request<SchedulerState>("/api/scheduler"),
	getPermissions: () => request<PermissionRequest[]>("/api/permissions"),
	decidePermission: (id: string, decision: "allow_once" | "allow" | "deny") =>
		request<PermissionRequest>(`/api/permissions/${id}/decision`, {
			method: "POST",
			body: JSON.stringify({ decision }),
		}),
	getDiff: (id: string) => request<{ diff: string }>(`/api/tasks/${id}/diff`),
	checkpointTask: (id: string) =>
		request<{ outputSha: string }>(`/api/tasks/${id}/checkpoint`, {
			method: "POST",
		}),
	mergeTask: (id: string) =>
		request<{
			merged: boolean;
			conflict?: { taskId: string; files: string[] };
		}>(`/api/tasks/${id}/merge`, { method: "POST" }),
	discardTask: (id: string) =>
		request<{ discarded: boolean }>(`/api/tasks/${id}/discard`, {
			method: "POST",
		}),
	createDesign: (input: {
		projectId: string;
		brief: string;
		viewport?: DesignViewport;
		frame?: DesignFrame;
		model?: AgentModelRef;
		files?: string[];
		attachments?: DesignAttachment[];
	}) =>
		request<{ nodeId: string; status: string }>("/api/designs", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	listDesigns: (projectId: string) =>
		request<DesignThread>(`/api/projects/${projectId}/designs`),
	designChat: (
		projectId: string,
		input: {
			message: string;
			nodeId?: string;
			model?: AgentModelRef;
			files?: string[];
			attachments?: DesignAttachment[];
		},
	) =>
		request<DesignChatResult>(`/api/projects/${projectId}/design/chat`, {
			method: "POST",
			body: JSON.stringify(input),
		}),
	getDesign: (id: string) =>
		request<DesignNode>(`/api/designs/${encodeURIComponent(id)}`),
	getDesignTrace: (id: string) =>
		request<DesignTrace>(`/api/designs/${encodeURIComponent(id)}/trace`),
	designSteps: (id: string) =>
		request<DesignActivity | null>(`/api/designs/${id}/steps`),
	decideDesignPermission: (
		nodeId: string,
		permissionId: string,
		decision: "allow_once" | "allow" | "deny",
	) =>
		request<{ decided: boolean }>(
			`/api/designs/${nodeId}/permissions/${permissionId}/decision`,
			{ method: "POST", body: JSON.stringify({ decision }) },
		),
	patchDesign: (id: string, patch: DesignPatch) =>
		request<DesignNode>(`/api/designs/${id}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		}),
	refineDesign: (
		id: string,
		input: {
			message: string;
			model?: AgentModelRef;
			files?: string[];
			attachments?: DesignAttachment[];
		},
	) =>
		request<{ nodeId: string; status: string }>(`/api/designs/${id}/refine`, {
			method: "POST",
			body: JSON.stringify(input),
		}),
	retryDesign: (id: string, model?: AgentModelRef) =>
		request<{ nodeId: string; status: string }>(`/api/designs/${id}/retry`, {
			method: "POST",
			body: JSON.stringify(model ? { model } : {}),
		}),
	publishDesign: (id: string, path?: string) =>
		request<{ published: boolean; path: string }>(
			`/api/designs/${id}/publish`,
			{ method: "POST", body: JSON.stringify(path ? { path } : {}) },
		),
	deleteDesign: (id: string) =>
		request<void>(`/api/designs/${id}`, { method: "DELETE" }),
	clearDesigns: (projectId: string) =>
		request<void>(`/api/projects/${projectId}/designs`, { method: "DELETE" }),
};

export type {
	DesignActivity,
	DesignChatResult,
	DesignMessage,
	DesignNode,
	DesignQuestion,
	DesignThread,
	DesignViewport,
};

export function diffStats(diff: string) {
	const files = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(
		(match) => match[2],
	);
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions += 1;
		if (line.startsWith("-")) deletions += 1;
	}
	return { files, additions, deletions };
}

export function formatStatus(status: string) {
	return status
		.replaceAll("_", " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatDuration(
	startedAt: string | null,
	completedAt: string | null,
) {
	if (!startedAt) return "Not started";
	const end = completedAt ? new Date(completedAt).getTime() : Date.now();
	const seconds = Math.max(
		0,
		Math.floor((end - new Date(startedAt).getTime()) / 1000),
	);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
