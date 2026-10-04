import type {
	AgentModelRef,
	DesignMessage,
	DesignNode,
	DesignPatch,
	DesignThread,
	DesignViewport,
} from "@loom/protocol";
import {
	daemonEventSchema,
	type AgentRun as ProtocolAgentRun,
	type DaemonEvent as ProtocolDaemonEvent,
	type PermissionRequest as ProtocolPermissionRequest,
} from "@loom/protocol";
import { dev } from "$app/environment";
import { PUBLIC_SERVER_URL } from "$app/env/public";
export type Project = {
	id: string;
	name: string;
	path: string;
	defaultBranch: string;
	createdAt: string;
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
	position: number | null;
	workspaceId: string | null;
	sessionId: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
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
export type SchedulerTask = {
	taskId: string;
	projectId: string;
	state: string;
};
export type SchedulerState = {
	running: SchedulerTask[];
	queued: SchedulerTask[];
};

const tokenKey = "loom.daemon.token";

export function serverUrl() {
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

export async function request<T>(path: string, init: RequestInit = {}) {
	await provisionDaemonToken();
	const headers = new Headers(init.headers);
	const token = getDaemonToken();
	if (token) headers.set("Authorization", `Bearer ${token}`);
	if (init.body) headers.set("Content-Type", "application/json");
	const response = await fetch(`${serverUrl()}${path}`, { ...init, headers });
	if (!response.ok) {
		let message = `${response.status} ${response.statusText}`;
		try {
			const body = (await response.json()) as { error?: { message?: string } };
			message = body.error?.message ?? message;
		} catch {}
		throw new Error(message);
	}
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

export const daemon = {
	listProjects: () => request<Project[]>("/api/projects"),
	getProject: (id: string) => request<Project>(`/api/projects/${id}`),
	createProject: (path: string) =>
		request<Project>("/api/projects", {
			method: "POST",
			body: JSON.stringify({ path }),
		}),
	deleteProject: (id: string) =>
		request<void>(`/api/projects/${id}`, { method: "DELETE" }),
	listTasks: () => request<Task[]>("/api/tasks"),
	getTask: (id: string) => request<Task>(`/api/tasks/${id}`),
	createTask: (input: { projectId: string; title: string; prompt: string }) =>
		request<Task>("/api/tasks", {
			method: "POST",
			body: JSON.stringify(input),
		}),
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
	renameTask: (id: string, input: { title?: string; prompt?: string }) =>
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
		request<{ output: string; truncated: boolean }>(`/api/tasks/${id}/output`),
	getScheduler: () => request<SchedulerState>("/api/scheduler"),
	getPermissions: () => request<PermissionRequest[]>("/api/permissions"),
	decidePermission: (id: string, decision: "allow_once" | "allow" | "deny") =>
		request<PermissionRequest>(`/api/permissions/${id}/decision`, {
			method: "POST",
			body: JSON.stringify({ decision }),
		}),
	getDiff: (id: string) => request<{ diff: string }>(`/api/tasks/${id}/diff`),
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
		model?: AgentModelRef;
	}) =>
		request<{ nodeId: string; status: string }>("/api/designs", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	listDesigns: (projectId: string) =>
		request<DesignThread>(`/api/projects/${projectId}/designs`),
	getDesign: (id: string) => request<DesignNode>(`/api/designs/${id}`),
	patchDesign: (id: string, patch: DesignPatch) =>
		request<DesignNode>(`/api/designs/${id}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		}),
	refineDesign: (
		id: string,
		input: { message: string; model?: AgentModelRef },
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

export type { DesignMessage, DesignNode, DesignThread, DesignViewport };

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
