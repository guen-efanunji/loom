import {
	daemonEventSchema,
	type DaemonEvent as ProtocolDaemonEvent,
} from "@loom/protocol";
import { ENV } from "../env";

export type Project = {
	id: string;
	name: string;
	path: string;
	defaultBranch: string;
	createdAt: string;
};

export type TaskStatus =
	| "queued"
	| "preparing"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type Task = {
	id: string;
	projectId: string;
	title: string;
	prompt: string;
	status: TaskStatus;
	workspaceId: string | null;
	sessionId: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
};

export type DaemonEvent = ProtocolDaemonEvent;

const tokenKey = "loom.daemon.token";

export function serverUrl() {
	return ENV.PUBLIC_SERVER_URL.replace(/\/$/, "");
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
	const url = new URL(`${serverUrl()}/api/events`);
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

async function request<T>(path: string, init: RequestInit = {}) {
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
	listProjects: async () => {
		await provisionDaemonToken();
		return request<Project[]>("/api/projects");
	},
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
	startTask: (id: string) =>
		request<{ accepted: boolean }>(`/api/tasks/${id}/start`, {
			method: "POST",
		}),
	cancelTask: (id: string) =>
		request<{ cancelled: boolean }>(`/api/tasks/${id}/cancel`, {
			method: "POST",
		}),
	getDiff: (id: string) => request<{ diff: string }>(`/api/tasks/${id}/diff`),
	mergeTask: (id: string) =>
		request<{ merged: boolean }>(`/api/tasks/${id}/merge`, { method: "POST" }),
	discardTask: (id: string) =>
		request<{ discarded: boolean }>(`/api/tasks/${id}/discard`, {
			method: "POST",
		}),
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

export function formatStatus(status: TaskStatus) {
	return status.charAt(0).toUpperCase() + status.slice(1);
}
