import { request } from "$lib/daemon";
export type ChatSession = {
	id: string;
	title: string;
	directory: string;
	projectId?: string;
	time: { updated: number };
};
export type ChatPart = {
	id: string;
	type: string;
	text?: string;
	filename?: string;
	designId?: string;
	viewport?: string;
	brief?: string;
	url?: string;
	tool?: string;
	state?: {
		status: string;
		title?: string;
		input?: Record<string, unknown>;
		output?: string;
		error?: string;
		metadata?: Record<string, unknown>;
	};
};
export type ChatMessage = {
	info: {
		id: string;
		role: string;
		modelID?: string;
		providerID?: string;
		agent?: string;
		error?: { name: string; data?: { message?: string } };
		time: { created: number; completed?: number };
	};
	parts: ChatPart[];
};
export type FileDiff = {
	file: string;
	patch?: string;
	before?: string;
	after?: string;
	additions: number;
	deletions: number;
	status?: string;
};
export type Question = {
	id: string;
	questions: Array<{
		header: string;
		question: string;
		multiple?: boolean;
		options: Array<{ label: string; description: string }>;
	}>;
};
export type ChatAttachment = {
	filename: string;
	mime: string;
	data: string;
};
export type ChatState = {
	session: ChatSession;
	messages: ChatMessage[];
	status: { type: string; message?: string };
	permissions: Array<{ id: string; permission: string; patterns: string[] }>;
	questions: Question[];
};
export type Model = {
	providerID: string;
	modelID: string;
	name: string;
	provider: string;
	providerId?: string;
	connectionId?: string;
	capabilities?: string[];
	designSupported?: boolean;
	openCodeProviderID?: string;
	openCodeModelID?: string;
};
export type Catalog = {
	models: Model[];
	defaults: Record<string, string>;
	agents: Array<{ name: string; description?: string; mode: string }>;
	commands: Array<{ name: string; description?: string }>;
};
const root = "/api/chat";
const catalogCache = new Map<string, Catalog>();
const post = <T>(path: string, body: unknown = {}) =>
	request<T>(root + path, { method: "POST", body: JSON.stringify(body) });
export const chat = {
	sessions: (projectId: string) =>
		request<ChatSession[]>(
			`${root}/sessions?projectId=${encodeURIComponent(projectId)}`,
		),
	create: (projectId: string, title: string) =>
		post<ChatSession>("/sessions", { projectId, title }),
	state: (id: string) =>
		request<ChatState>(`${root}/sessions/${encodeURIComponent(id)}`),
	send: (
		id: string,
		input: {
			text: string;
			agent?: string;
			model?: { providerID: string; modelID: string };
			files: string[];
			attachments?: ChatAttachment[];
			designNodeIds?: string[];
			agents: string[];
		},
	) => post<void>(`/sessions/${encodeURIComponent(id)}/messages`, input),
	abort: (id: string) => post(`/sessions/${encodeURIComponent(id)}/abort`),
	rename: (id: string, title: string) =>
		post(`/sessions/${encodeURIComponent(id)}/rename`, { title }),
	remove: (id: string) =>
		request<void>(`${root}/sessions/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
	diff: (id: string) =>
		request<FileDiff[]>(`${root}/sessions/${encodeURIComponent(id)}/diff`),
	catalog: async (projectId: string) => {
		const cached = catalogCache.get(projectId);
		if (cached) return cached;
		const result = await request<Catalog>(
			`${root}/catalog?projectId=${encodeURIComponent(projectId)}`,
		);
		catalogCache.set(projectId, result);
		return result;
	},
	files: (projectId: string, query: string) =>
		request<string[]>(
			`${root}/files?${new URLSearchParams({ projectId, query })}`,
		),
	file: (projectId: string, path: string) =>
		request<{ type: string; content: string; encoding?: string }>(
			`${root}/file?${new URLSearchParams({ projectId, path })}`,
		),
	permission: (
		id: string,
		requestId: string,
		reply: "once" | "always" | "reject",
	) => post(`/sessions/${id}/permission/${requestId}`, { reply }),
	question: (id: string, requestId: string, answers: string[][]) =>
		post(`/sessions/${id}/question/${requestId}`, { answers }),
};
