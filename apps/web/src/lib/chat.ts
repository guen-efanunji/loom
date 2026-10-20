import { request } from "$lib/daemon";
export type ChatSession = {
	id: string;
	title: string;
	directory: string;
	parentID?: string;
	projectId?: string;
	time: { updated: number };
};
export type ChatChildSession = {
	id: string;
	title: string;
	parentID: string;
	time: { updated: number };
	status: { type: string; message?: string };
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
		cost?: number;
		tokens?: {
			total?: number;
			input?: number;
			output?: number;
			reasoning?: number;
			cache?: { read?: number; write?: number };
		};
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
export type WorkspaceFileEntry = {
	name: string;
	path: string;
	type: "file" | "directory";
};
export type WorkspaceFilePreview = {
	path: string;
	content: string | null;
	binary: boolean;
	complete: boolean;
	byteSize: number;
	revision: string;
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
	variants?: string[];
	contextWindow?: number;
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

/** Resolve the selected Loom adapter when a provider reports its upstream vendor. */
export function canonicalProviderID(
	catalog: Catalog,
	providerID?: string,
	modelID?: string,
) {
	if (!providerID || !modelID) return providerID;
	const reportedModel = modelID.toLowerCase();
	const openCodeModel = catalog.models.find((item) => {
		if (item.providerID.toLowerCase() !== "opencode") return false;
		const catalogModel = item.modelID.toLowerCase();
		return (
			catalogModel === reportedModel ||
			catalogModel.endsWith(`/${reportedModel}`) ||
			reportedModel.endsWith(`/${catalogModel}`)
		);
	});
	return openCodeModel ? "opencode" : providerID;
}

/** Resolve a runtime-reported model to the adapter/model key shown in the UI. */
export function canonicalModelSelection(
	catalog: Catalog,
	providerID: string,
	modelID: string,
) {
	const canonicalProvider = canonicalProviderID(catalog, providerID, modelID) ?? providerID;
	const normalizedModel = modelID.toLowerCase();
	const model = catalog.models.find((item) => {
		if (item.providerID.toLowerCase() !== canonicalProvider.toLowerCase()) return false;
		const candidate = item.modelID.toLowerCase();
		return (
			candidate === normalizedModel ||
			candidate.endsWith(`/${normalizedModel}`) ||
			normalizedModel.endsWith(`/${candidate}`)
		);
	});
	return model ? `${model.providerID}/${model.modelID}` : `${canonicalProvider}/${modelID}`;
}

/** Return a user-facing provider name for both built-in and custom providers. */
export function providerDisplayName(
	catalog: Catalog,
	providerID?: string,
	modelID?: string,
) {
	if (!providerID) return "Assistant";
	const normalized = (
		canonicalProviderID(catalog, providerID, modelID) ?? providerID
	).toLowerCase();
	// OpenCode may report the upstream model vendor (for example, Google) in
	// catalog metadata. The user selected the OpenCode adapter, so keep that
	// identity in chat labels instead of exposing the upstream vendor.
	if (normalized === "opencode") return "OpenCode";
	const model = catalog.models.find(
		(item) => item.providerID.toLowerCase() === normalized,
	);
	if (model?.provider?.trim()) return model.provider.trim();
	if (normalized === "agy" || normalized === "antigravity") return "Agy";
	if (normalized === "claude" || normalized === "anthropic") return "Claude";
	if (normalized === "codex" || normalized === "openai") return "Codex";
	if (normalized.startsWith("loom_custom_")) {
		const label = providerID
			.slice("loom_custom_".length)
			.replace(/_[a-f0-9]{8,}$/i, "");
		return label
			.replace(/[_-]+/g, " ")
			.replace(/\b\w/g, (letter) => letter.toUpperCase());
	}
	return providerID;
}

/** Hide internal custom-provider IDs if they appear in a runtime status string. */
export function friendlyProviderStatus(
	catalog: Catalog,
	message?: string,
	providerID?: string,
	modelID?: string,
) {
	if (!message) return "";
	let friendly = message;
	const canonicalProvider = canonicalProviderID(catalog, providerID, modelID);
	if (canonicalProvider === "opencode") {
		const upstreamNames = new Set(
			catalog.models
				.filter((model) => model.providerID.toLowerCase() === "opencode")
				.map((model) => model.provider?.trim())
				.filter((name): name is string => !!name),
		);
		for (const upstreamName of upstreamNames) {
			const escaped = upstreamName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			friendly = friendly.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "OpenCode");
		}
	}
	const providerIDs = new Set(
		catalog.models
			.map((model) => model.providerID)
			.filter((providerID) => providerID.toLowerCase().startsWith("loom_custom_")),
	);
	for (const providerID of providerIDs) {
		const label = providerDisplayName(catalog, providerID);
		const escaped = providerID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		friendly = friendly.replace(new RegExp(escaped, "gi"), label);
	}
	friendly = friendly.replace(
		/loom_custom_(.+?)_([a-f0-9]{8,})(?=\b|$)/gi,
		(_match, rawLabel: string) =>
			rawLabel
				.replace(/[_-]+/g, " ")
				.replace(/\b\w/g, (letter) => letter.toUpperCase()),
	);
	return friendly;
}

const root = "/api/chat";
const catalogCache = new Map<string, Catalog>();
const catalogRequests = new Map<string, Promise<Catalog>>();
const catalogStorageKey = (projectId: string) =>
	`loom.chat.catalog.${projectId}`;
function isCatalog(value: unknown): value is Catalog {
	if (!value || typeof value !== "object") return false;
	const catalog = value as Partial<Catalog>;
	return (
		Array.isArray(catalog.models) &&
		!!catalog.defaults &&
		typeof catalog.defaults === "object" &&
		Array.isArray(catalog.agents) &&
		Array.isArray(catalog.commands)
	);
}
function readCachedCatalog(projectId: string): Catalog | undefined {
	const cached = catalogCache.get(projectId);
	if (cached) return cached;
	if (typeof localStorage === "undefined") return undefined;
	try {
		const value: unknown = JSON.parse(
			localStorage.getItem(catalogStorageKey(projectId)) ?? "null",
		);
		if (!isCatalog(value)) return undefined;
		catalogCache.set(projectId, value);
		return value;
	} catch {
		return undefined;
	}
}
function writeCachedCatalog(projectId: string, value: Catalog) {
	catalogCache.set(projectId, value);
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(catalogStorageKey(projectId), JSON.stringify(value));
	} catch {
		// Browser storage can be disabled or full; the in-memory cache still works.
	}
}
const post = <T>(path: string, body: unknown = {}) =>
	request<T>(root + path, { method: "POST", body: JSON.stringify(body) });
export const chat = {
	sessions: (projectId: string) =>
		request<ChatSession[]>(
			`${root}/sessions?projectId=${encodeURIComponent(projectId)}`,
		),
	children: (id: string) =>
		request<ChatChildSession[]>(
			`${root}/sessions/${encodeURIComponent(id)}/children`,
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
			customAgentId?: string;
			model?: { providerID: string; modelID: string };
			thinkingMode?: string;
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
	cachedCatalog: (projectId: string) => readCachedCatalog(projectId),
	catalog: (projectId: string) => {
		const pending = catalogRequests.get(projectId);
		if (pending) return pending;
		const result = request<Catalog>(
			`${root}/catalog?projectId=${encodeURIComponent(projectId)}`,
		).then((catalog) => {
			writeCachedCatalog(projectId, catalog);
			return catalog;
		});
		catalogRequests.set(projectId, result);
		void result
			.finally(() => {
				if (catalogRequests.get(projectId) === result)
					catalogRequests.delete(projectId);
			})
			.catch(() => {});
		return result;
	},
	files: (projectId: string, query: string) =>
		request<string[]>(
			`${root}/files?${new URLSearchParams({ projectId, query })}`,
		),
	preferences: () => request<{ favoriteModels: string[] }>(`${root}/preferences`),
	savePreferences: (favoriteModels: string[]) =>
		request<{ favoriteModels: string[] }>(`${root}/preferences`, {
			method: "PUT",
			body: JSON.stringify({ favoriteModels }),
		}),
	file: (projectId: string, path: string) =>
		request<{ type: string; content: string; encoding?: string }>(
			`${root}/file?${new URLSearchParams({ projectId, path })}`,
		),
	workspaceTree: (projectId: string, directory = "", workspaceId = "") =>
		request<{
			context: {
				kind: "project";
				projectId: string;
				workspaceId: string;
				label: string;
			};
			directory: string;
			entries: WorkspaceFileEntry[];
			truncated: boolean;
		}>(
			`${root}/workspace/tree?${new URLSearchParams({ projectId, directory, ...(workspaceId ? { workspaceId } : {}) })}`,
		),
	workspaceFile: (projectId: string, path: string, workspaceId: string) =>
		request<WorkspaceFilePreview>(
			`${root}/workspace/file?${new URLSearchParams({ projectId, path, workspaceId })}`,
		),
	saveWorkspaceFile: (
		projectId: string,
		workspaceId: string,
		path: string,
		content: string,
		expectedRevision: string,
		requestId: string,
	) =>
		request<{ path: string; byteSize: number; revision: string }>(
			`${root}/workspace/file`,
			{
				method: "PUT",
				body: JSON.stringify({
					projectId,
					workspaceId,
					path,
					content,
					expectedRevision,
					requestId,
				}),
			},
		),
	createWorkspaceFile: (
		projectId: string,
		workspaceId: string,
		parent: string,
		name: string,
		requestId: string,
	) =>
		post<{ path: string; type: "file" }>("/workspace/file", {
			projectId,
			workspaceId,
			parent,
			name,
			requestId,
		}),
	createWorkspaceDirectory: (
		projectId: string,
		workspaceId: string,
		parent: string,
		name: string,
		requestId: string,
	) =>
		post<{ path: string; type: "directory" }>("/workspace/directory", {
			projectId,
			workspaceId,
			parent,
			name,
			requestId,
		}),
	permission: (
		id: string,
		requestId: string,
		reply: "once" | "always" | "reject",
	) => post(`/sessions/${id}/permission/${requestId}`, { reply }),
	question: (id: string, requestId: string, answers: string[][]) =>
		post(`/sessions/${id}/question/${requestId}`, { answers }),
};
