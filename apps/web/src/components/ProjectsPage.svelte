<script lang="ts">
import {
	Activity,
	Bot,
	Check,
	ChevronDown,
	CircleHelp,
	Columns3,
	EllipsisVertical,
	FileCode,
	FileDiff as FileDiffIcon,
	Folder,
	FolderPlus,
	GitBranch,
	GitPullRequest,
	Globe,
	ListTodo,
	ListTree,
	LoaderCircle,
	MessageSquare,
	MessageSquarePlus,
	PanelLeft,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	Settings,
	ShieldCheck,
	SlidersHorizontal,
	Sparkles,
	Star,
	Trash2,
	TriangleAlert,
	X,
} from "@lucide/svelte";
import { onMount, tick } from "svelte";
import { toast } from "svelte-sonner";
import { goto, replaceState } from "$app/navigation";
import { page } from "$app/state";
import {
	type Catalog,
	type ChatChildSession,
	type ChatMessage,
	type ChatSession,
	type ChatState,
	canonicalModelSelection,
	chat,
	type FileDiff,
	groupTurns,
	supersededIds,
	userMessageText,
} from "$lib/chat";
import {
	type ChatPanelId,
	chatPanelRegistry,
	defaultRailPanelPreferences,
	isChatPanelVisible,
	parseRailPanelPreferences,
	type RailPanelPreferences,
	railPanelPreferencesKey,
	withChatPanelVisibility,
} from "$lib/chat-panels";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
import { Badge } from "$lib/components/ui/badge";
import { Button, buttonVariants } from "$lib/components/ui/button";
import * as Checkbox from "$lib/components/ui/checkbox";
import * as Command from "$lib/components/ui/command";
import * as Dialog from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import * as Marker from "$lib/components/ui/marker";
import * as Popover from "$lib/components/ui/popover";
import * as Resizable from "$lib/components/ui/resizable";
import * as ScrollArea from "$lib/components/ui/scroll-area";
import * as Select from "$lib/components/ui/select";
import * as Tabs from "$lib/components/ui/tabs";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import {
	type CustomAgentMonitorItem,
	type CustomAgentRunMonitorItem,
	type DaemonEvent,
	type DesignNode,
	type DesignTrace,
	daemon,
	type ManagedMcpConnection,
	type PermissionRequest,
	type Project,
	type ProjectGitOverview,
	type ProjectPullRequests,
	parseDaemonEvent,
	provisionDaemonToken,
	type Task,
	type WalkthroughDocument,
	type WalkthroughLanguage,
	type WalkthroughSnapshot,
	websocketProtocols,
	websocketUrl,
} from "$lib/daemon";
import AddProjectForm from "./AddProjectForm.svelte";
import CodeBlock from "./chat/CodeBlock.svelte";
import Composer from "./chat/Composer.svelte";
import QuestionCard from "./chat/QuestionCard.svelte";
import SplitChatWorkspace from "./chat/SplitChatWorkspace.svelte";
import TaskRunChat from "./chat/TaskRunChat.svelte";
import Turn from "./chat/Turn.svelte";
import KanbanBoard from "./KanbanBoard.svelte";
import TerminalPanel from "./TerminalPanel.svelte";
import WorkspaceCodePreview from "./WorkspaceCodePreview.svelte";

let projects = $state<Project[]>([]);
let sessions = $state<ChatSession[]>([]);
let childSessions = $state<ChatChildSession[]>([]);
let legacyTasks = $state<Task[]>([]);
let monitorAgents = $state<CustomAgentMonitorItem[]>([]);
let monitorRuns = $state<CustomAgentRunMonitorItem[]>([]);
let monitorMcpConnections = $state<ManagedMcpConnection[]>([]);
let monitorError = $state("");
let monitorRequest = 0;
let monitorTimer: ReturnType<typeof setInterval> | undefined;
let panelSyncRequest = 0;
let lastPanelSyncAt = 0;
let monitorSocket: WebSocket | undefined;
let monitorReconnectTimer: ReturnType<typeof setTimeout> | undefined;
let monitorTaskOutput = $state<Record<string, string>>({});
type MonitorTaskActivity = {
	id: string;
	tool: string;
	status: "running" | "completed" | "error";
	input?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
};
let monitorTaskActivities = $state<Record<string, MonitorTaskActivity[]>>({});
let monitorTaskProgress = $state<
	Record<
		string,
		Array<{
			id: string;
			stage: string;
			message: string;
			timestamp: string;
		}>
	>
>({});
let monitorPermissions = $state<PermissionRequest[]>([]);
let selectedProjectId = $state("");
let sessionId = $state("");
const designId = $derived(page.url.searchParams.get("design") ?? "");
const designProjectId = $derived(page.url.searchParams.get("project") ?? "");
let designNode = $state<DesignNode | null>(null);
let designTrace = $state<DesignTrace | null>(null);
let designTraceLoading = $state(false);
let designTraceError = $state("");
$effect(() => {
	const nodeId = designId;
	const projectId = designProjectId;
	if (!nodeId) {
		designNode = null;
		designTrace = null;
		return;
	}
	let active = true;
	let polling = false;
	designNode = null;
	designTrace = null;
	designTraceError = "";
	designTraceLoading = true;
	const refresh = async () => {
		if (polling) return;
		polling = true;
		try {
			const [thread, trace] = await Promise.all([
				daemon.listDesigns(projectId),
				daemon.getDesignTrace(nodeId),
			]);
			if (!active) return;
			if (trace.projectId !== projectId || trace.nodeId !== nodeId)
				throw new Error("Design trace does not belong to this project.");
			const node = thread.nodes.find((item) => item.id === nodeId);
			if (!node) throw new Error("Design node not found in this project.");
			designNode = node;
			designTrace = trace;
			designTraceError = "";
		} catch (reason) {
			if (active)
				designTraceError =
					reason instanceof Error
						? reason.message
						: "Unable to load design trace";
		} finally {
			polling = false;
			if (active) designTraceLoading = false;
		}
	};
	if (projectId) void refresh();
	else {
		designTraceError = "Select a project to view this design trace.";
		designTraceLoading = false;
	}
	const interval = window.setInterval(() => {
		if (
			projectId &&
			(designNode?.status === "queued" ||
				designNode?.status === "generating" ||
				designTraceError)
		)
			void refresh();
	}, 1500);
	return () => {
		active = false;
		window.clearInterval(interval);
	};
});
let conversation = $state<ChatState | null>(null);
let optimistic = $state<ChatMessage | null>(null);
let loading = $state(true);
let sessionLoading = $state(false);
let error = $state("");
let connected = $state(false);
let ready = $state(false);
let sidebarOpen = $state(true);
let searchOpen = $state(false);
let search = $state("");
let collapsed = $state<string[]>([]);
let addProjectOpen = $state(false);
let worktreeDialogOpen = $state(false);
let worktreeBranchName = $state("");
let worktreeCreating = $state(false);
let aboutOpen = $state(false);
let renameOpen = $state(false);
let renameTitle = $state("");
let renameTarget = $state("");
let projectRenameOpen = $state(false);
let projectRenameTarget = $state<Project | null>(null);
let projectRenameName = $state("");
let projectDeleteOpen = $state(false);
let projectDeleteTarget = $state<Project | null>(null);
let deleteTarget = $state<ChatSession | null>(null);
let deleteSessionOpen = $state(false);
type ViewMode = "chat" | "kanban";
type WorkspaceChatTab = {
	id: string;
	sessionId: string;
	taskId?: string;
	projectId: string;
	label: string;
	draft: string;
	model: string;
	agent: string;
	customAgentId: string;
};
function initialView(): ViewMode {
	return page.url.searchParams.get("view") === "kanban" ? "kanban" : "chat";
}
let viewMode = $state<ViewMode>(initialView());
let splitChat = $state(false);
let splitPreviousPanel = $state<ChatPanelId | null>(null);
let chatTabs = $state<WorkspaceChatTab[]>([
	{
		id: "chat-tab-1",
		sessionId: "",
		projectId: "",
		label: "New chat",
		draft: "",
		model: "",
		agent: "build",
		customAgentId: "",
	},
]);
let activeChatTabId = $state("chat-tab-1");
const chatTabsStorageKey = "loom:workspace-chat-tabs";
function persistChatTabs() {
	if (!ready) return;
	try {
		sessionStorage.setItem(
			chatTabsStorageKey,
			JSON.stringify({ tabs: chatTabs, activeId: activeChatTabId }),
		);
	} catch {}
}
function restoreChatTabs(routeSession: string) {
	try {
		const stored = JSON.parse(
			sessionStorage.getItem(chatTabsStorageKey) ?? "null",
		);
		if (stored && Array.isArray(stored.tabs)) {
			const valid = stored.tabs.filter(
				(tab: WorkspaceChatTab) =>
					tab &&
					typeof tab.id === "string" &&
					typeof tab.sessionId === "string" &&
					typeof tab.projectId === "string" &&
					projects.some((project) => project.id === tab.projectId),
			);
			if (valid.length) {
				chatTabs = valid;
				activeChatTabId = valid.some(
					(tab: WorkspaceChatTab) => tab.id === stored.activeId,
				)
					? stored.activeId
					: valid[0].id;
			}
		}
	} catch {}
	if (routeSession) {
		let tab = chatTabs.find((item) => item.sessionId === routeSession);
		if (!tab) {
			const existing = sessions.find((item) => item.id === routeSession);
			tab = {
				id: `chat-tab-${crypto.randomUUID()}`,
				sessionId: routeSession,
				projectId: existing?.projectId ?? selectedProjectId,
				label: existing?.title ?? "Chat",
				draft: "",
				model: preferredModel(existing?.projectId ?? selectedProjectId),
				agent: "build",
				customAgentId: "",
			};
			chatTabs =
				chatTabs.length === 1 &&
				chatTabs[0]?.id === "chat-tab-1" &&
				!chatTabs[0]?.sessionId &&
				!chatTabs[0]?.draft
					? [tab]
					: [...chatTabs, tab];
		}
		activeChatTabId = tab.id;
	}
}
const activeChatTab = $derived(
	chatTabs.find((item) => item.id === activeChatTabId),
);
const activeTaskRun = $derived(
	activeChatTab?.taskId
		? legacyTasks.find((task) => task.id === activeChatTab.taskId)
		: undefined,
);
let draggedChatTabId = $state("");
let lastSyncedRouteSession = page.url.searchParams.get("session") ?? "";
let draft = $state("");
let model = $state("");
let agent = $state("build");
let customAgentId = $state("");
let customAgents = $state<
	Array<{
		id: string;
		label: string;
		allowChat: boolean;
		status: string;
		provider: string;
		modelId: string | null;
	}>
>([]);
let automationMode = $state<"review" | "auto-create" | "auto-start">("review");
let catalog = $state<Catalog>({
	models: [],
	defaults: {},
	agents: [
		{ name: "build", mode: "primary" },
		{ name: "plan", mode: "primary" },
	],
	commands: [],
});
let catalogLoaded = $state(false);
let catalogNonce = $state(0);
let fileOpen = $state(false);
let fileLoading = $state(false);
let fileError = $state("");
let fileName = $state("");
let fileContent = $state("");
let diffs = $state<FileDiff[]>([]);
let activePanel = $state<ChatPanelId | null>("agents");
let panelPreferences = $state<RailPanelPreferences>(
	defaultRailPanelPreferences(),
);
let panelPreferencesReady = $state(false);
let panelPreferencesSaveError = $state(false);
let configurePanelsOpen = $state(false);
let previewExpanded = $state(false);
let previewHasUnsavedChanges = $state(false);
let gitOverview = $state<ProjectGitOverview | null>(null);
let gitCommitMessage = $state("");
let gitBusy = $state(false);
let gitGeneratingMessage = $state(false);
const commitModelSelection = $derived(model);
let pullRequestTitle = $state("");
let pullRequestBody = $state("");
let pullRequestBase = $state("");
let pullRequestDraft = $state(false);
let pullRequestBusy = $state(false);
let createdPullRequestUrl = $state("");
let workspaceOverview = $state<ProjectGitOverview | null>(null);
let workspaceLoading = $state(false);
let pullRequestData = $state<ProjectPullRequests | null>(null);
let walkthroughSnapshot = $state<WalkthroughSnapshot | null>(null);
let walkthroughProjectId = $state("");
let walkthroughDocument = $state<WalkthroughDocument | null>(null);
let walkthroughDocumentFingerprint = $state("");
let walkthroughLanguage = $state<WalkthroughLanguage>("en");
let walkthroughStepId = $state("");
let walkthroughModelOpen = $state(false);
let walkthroughModelSearch = $state("");
const walkthroughFavoritesKey = "loom.chat.favoriteModels";
const walkthroughRecentsKey = "loom.chat.recentModels";
function readWalkthroughModelKeys(key: string) {
	if (typeof localStorage === "undefined") return [];
	try {
		const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
		return Array.isArray(value)
			? [
					...new Set(
						value.filter((item): item is string => typeof item === "string"),
					),
				].slice(0, 12)
			: [];
	} catch {
		return [];
	}
}
let walkthroughFavoriteModelIds = $state(
	readWalkthroughModelKeys(walkthroughFavoritesKey),
);
let walkthroughRecentModelIds = $state(
	readWalkthroughModelKeys(walkthroughRecentsKey),
);
let walkthroughGenerating = $state(false);
let walkthroughError = $state("");
let panelLoading = $state(false);
let panelError = $state("");
let panelRequest = 0;
let fileTab = $state("changes");
let scroller = $state<HTMLDivElement>();
let follow = true;
let disposed = false;
let timer: ReturnType<typeof setTimeout>;
let projectRequest = 0;
let panelProjectId = "";
let fileRequest = 0;
let editorOpenRequest = $state(0);
let editorRequestedPath = $state("");
let sendingChatTabIds = $state<string[]>([]);
const sending = $derived(sendingChatTabIds.includes(activeChatTabId));
let permissionReplying = $state<string | null>(null);
const selectedProject = $derived(
	projects.find((p) => p.id === selectedProjectId),
);
function settingsUrl(path: string, params: Record<string, string> = {}) {
	const query = new URLSearchParams(params);
	query.set(
		"returnTo",
		`${page.url.pathname}${page.url.search}${page.url.hash}`,
	);
	return `${path}?${query.toString()}`;
}
$effect(() => {
	const projectId = selectedProjectId;
	const panel = activePanel;
	if (!projectId || projectId === panelProjectId) return;
	panelProjectId = projectId;
	panelRequest += 1;
	panelLoading = false;
	panelError = "";
	gitOverview = null;
	gitCommitMessage = "";
	pullRequestData = null;
	pullRequestTitle = "";
	pullRequestBody = "";
	pullRequestBase = "";
	createdPullRequestUrl = "";
	diffs = [];
	walkthroughProjectId = "";
	walkthroughSnapshot = null;
	walkthroughDocument = null;
	walkthroughDocumentFingerprint = "";
	walkthroughStepId = "";
	if (panel === "agents") void refreshAgentMonitor();
	if (panel === "git" || panel === "pull-requests" || panel === "walkthrough")
		void showPanel(panel, true);
});
$effect(() => {
	const panel = activePanel;
	const currentSession = sessionId;
	const projectId = selectedProjectId;
	if (panel !== "changes") return;
	const request = ++panelRequest;
	diffs = [];
	if (!currentSession) {
		panelLoading = false;
		return;
	}
	panelLoading = true;
	void chat
		.diff(currentSession)
		.then((result) => {
			if (
				!disposed &&
				request === panelRequest &&
				activePanel === "changes" &&
				currentSession === sessionId &&
				projectId === selectedProjectId
			)
				diffs = result;
		})
		.catch((reason) => {
			if (request === panelRequest)
				panelError =
					reason instanceof Error
						? reason.message
						: "Unable to load session changes";
		})
		.finally(() => {
			if (request === panelRequest) panelLoading = false;
		});
});
$effect(() => {
	const id = selectedProjectId;
	if (!id) {
		workspaceOverview = null;
		return;
	}
	let active = true;
	workspaceLoading = true;
	void daemon
		.getProjectGit(id)
		.then((result) => {
			if (active && id === selectedProjectId) workspaceOverview = result;
		})
		.catch(() => {
			if (active) workspaceOverview = null;
		})
		.finally(() => {
			if (active) workspaceLoading = false;
		});
	return () => {
		active = false;
	};
});
const availableChatPanels = $derived(
	chatPanelRegistry.filter((panel) =>
		panel.isAvailable({ projectId: selectedProjectId }),
	),
);
const visibleChatPanels = $derived(
	panelPreferencesReady
		? availableChatPanels.filter((panel) =>
				isChatPanelVisible(panel, panelPreferences),
			)
		: [],
);
const messages = $derived([
	...(conversation?.messages ?? []),
	...(optimistic ? [optimistic] : []),
]);
$effect(() => {
	const currentSessionId = sessionId;
	const currentProjectId = selectedProjectId;
	if (!currentSessionId) {
		childSessions = [];
		return;
	}
	let active = true;
	const refresh = async () => {
		try {
			const children = await chat.children(currentSessionId);
			if (
				active &&
				currentSessionId === sessionId &&
				currentProjectId === selectedProjectId
			)
				childSessions = children;
		} catch {
			if (active && currentSessionId === sessionId) childSessions = [];
		}
	};
	void refresh();
	const timer = window.setInterval(() => void refresh(), busy ? 2_500 : 15_000);
	return () => {
		active = false;
		window.clearInterval(timer);
	};
});
let visibleTurnCount = $state(80);
// Shared turn grouping lives in $lib/chat so the split pane and this page
// render identically (P3-12).
const turns = $derived(groupTurns(messages));
const visibleTurns = $derived(turns.slice(-visibleTurnCount));
const lastAssistantTurnKey = $derived(
	turns.findLast((turn) => turn.role === "assistant")?.key ?? "",
);
const assistantMessages = $derived(
	(conversation?.messages ?? []).filter(
		(message) => message.info.role === "assistant",
	),
);
const latestUsageMessage = $derived(
	assistantMessages.findLast((message) => message.info.tokens),
);
const hasProviderUsage = $derived(
	assistantMessages.some((message) => message.info.tokens !== undefined),
);
const hasProviderCost = $derived(
	assistantMessages.some((message) => typeof message.info.cost === "number"),
);
const sessionUsage = $derived.by(() => {
	const total = {
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	for (const message of assistantMessages) {
		const usage = message.info.tokens;
		if (usage) {
			total.input += usage.input ?? 0;
			total.output += usage.output ?? 0;
			total.reasoning += usage.reasoning ?? 0;
			total.cacheRead += usage.cache?.read ?? 0;
			total.cacheWrite += usage.cache?.write ?? 0;
		}
		total.cost += message.info.cost ?? 0;
	}
	return total;
});
const contextModel = $derived(
	latestUsageMessage
		? catalog.models.find(
				(item) =>
					item.providerID === latestUsageMessage.info.providerID &&
					item.modelID === latestUsageMessage.info.modelID,
			)
		: undefined,
);
const contextTokens = $derived(
	(latestUsageMessage?.info.tokens?.input ?? 0) +
		(latestUsageMessage?.info.tokens?.cache?.read ?? 0) +
		(latestUsageMessage?.info.tokens?.cache?.write ?? 0),
);
const contextPercent = $derived(
	contextModel?.contextWindow
		? Math.min(100, (contextTokens / contextModel.contextWindow) * 100)
		: null,
);
$effect(() => {
	const selected = model;
	const models = catalog.models;
	if (!selected || !models.length) return;
	const [providerID, ...modelParts] = selected.split("/");
	const selectedId = modelParts.join("/");
	const providerModels = models.filter(
		(item) => item.providerID === providerID,
	);
	if (!providerModels.length) {
		const openCodeModel = models.find(
			(item) =>
				item.providerID === "opencode" &&
				item.modelID === `${providerID}/${selectedId}`,
		);
		if (openCodeModel) model = `opencode/${openCodeModel.modelID}`;
		return;
	}
	if (providerModels.some((item) => item.modelID === selectedId)) return;
	const canonical = providerModels.find(
		(item) =>
			item.name.toLowerCase() === selectedId.toLowerCase() ||
			item.modelID.toLowerCase() === selectedId.toLowerCase(),
	);
	model = canonical ? `${providerID}/${canonical.modelID}` : "";
});
const busy = $derived(
	sending ||
		!!optimistic ||
		conversation?.status.type === "busy" ||
		conversation?.status.type === "retry",
);
const filteredSessions = $derived(
	sessions
		.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()))
		.sort((a, b) => b.time.updated - a.time.updated),
);
const selectedDiff = $derived(
	diffs.find((d) => d.file === fileName || fileName.endsWith(`/${d.file}`)),
);
const walkthroughSteps = $derived.by(() =>
	(walkthroughDocument?.groups ?? []).flatMap((group) =>
		group.steps.map((step) => ({ ...step, groupTitle: group.title })),
	),
);
const selectedWalkthroughStep = $derived(
	walkthroughSteps.find((step) => step.id === walkthroughStepId) ??
		walkthroughSteps[0],
);
const walkthroughEvidence = $derived.by(() => {
	const ids = new Set([
		...(selectedWalkthroughStep?.evidenceIds ?? []),
		...(selectedWalkthroughStep?.cautions ?? []).flatMap(
			(item) => item.evidenceIds,
		),
	]);
	return (walkthroughSnapshot?.files ?? []).filter((item) => ids.has(item.id));
});
type WalkthroughModel = Catalog["models"][number];
function walkthroughModelKey(item: WalkthroughModel) {
	return `${item.providerID}/${item.modelID}`;
}
function walkthroughProviderTone(providerID: string) {
	const id = providerID.toLowerCase();
	if (["agy", "antigravity", "gemini"].includes(id)) return "agy";
	if (["claude", "anthropic"].includes(id)) return "claude";
	if (["codex", "openai"].includes(id)) return "codex";
	if (id === "opencode") return "opencode";
	return "default";
}
const walkthroughModelsByKey = $derived(
	new Map(catalog.models.map((item) => [walkthroughModelKey(item), item])),
);
function walkthroughModelsFor(keys: string[]) {
	return keys
		.map((key) => walkthroughModelsByKey.get(key))
		.filter((item): item is WalkthroughModel => !!item);
}
const walkthroughFavoriteModels = $derived(
	walkthroughModelsFor(walkthroughFavoriteModelIds),
);
const walkthroughRecentModels = $derived(
	walkthroughModelsFor(walkthroughRecentModelIds),
);
const walkthroughProviderGroups = $derived.by(() => {
	const groups = new Map<
		string,
		{ id: string; label: string; models: WalkthroughModel[] }
	>();
	for (const item of catalog.models) {
		let group = groups.get(item.providerID);
		if (!group) {
			const label = item.provider?.trim();
			group = {
				id: item.providerID,
				label:
					label && label.toLowerCase() !== item.providerID.toLowerCase()
						? `${label} · ${item.providerID}`
						: item.providerID,
				models: [],
			};
			groups.set(item.providerID, group);
		}
		if (
			!group.models.some(
				(modelItem) =>
					walkthroughModelKey(modelItem) === walkthroughModelKey(item),
			)
		)
			group.models.push(item);
	}
	const matches = (item: WalkthroughModel, section: string) => {
		const query = walkthroughModelSearch.trim().toLowerCase();
		return (
			!query ||
			`${section} ${item.name} ${item.provider} ${item.providerID} ${item.modelID} ${walkthroughModelKey(item)}`
				.toLowerCase()
				.includes(query)
		);
	};
	return [...groups.values()]
		.map((group) => ({
			...group,
			models: group.models.filter((item) => matches(item, group.id)),
		}))
		.filter((group) => group.models.length)
		.sort((a, b) => a.label.localeCompare(b.label));
});
const visibleWalkthroughFavorites = $derived(
	walkthroughFavoriteModels.filter((item) => {
		const query = walkthroughModelSearch.trim().toLowerCase();
		return (
			!query ||
			`${item.name} ${item.provider} ${item.providerID} ${item.modelID}`
				.toLowerCase()
				.includes(query)
		);
	}),
);
const visibleWalkthroughRecents = $derived(
	walkthroughRecentModels.filter((item) => {
		const query = walkthroughModelSearch.trim().toLowerCase();
		return (
			!query ||
			`${item.name} ${item.provider} ${item.providerID} ${item.modelID}`
				.toLowerCase()
				.includes(query)
		);
	}),
);
function chooseWalkthroughModel(item: WalkthroughModel) {
	const key = walkthroughModelKey(item);
	model = key;
	walkthroughRecentModelIds = [
		key,
		...walkthroughRecentModelIds.filter((id) => id !== key),
	].slice(0, 8);
	try {
		localStorage.setItem(
			walkthroughRecentsKey,
			JSON.stringify(walkthroughRecentModelIds),
		);
	} catch {}
	walkthroughModelSearch = "";
	walkthroughModelOpen = false;
}
function toggleWalkthroughFavorite(item: WalkthroughModel) {
	const key = walkthroughModelKey(item);
	walkthroughFavoriteModelIds = walkthroughFavoriteModelIds.includes(key)
		? walkthroughFavoriteModelIds.filter((id) => id !== key)
		: [key, ...walkthroughFavoriteModelIds].slice(0, 12);
	try {
		localStorage.setItem(
			walkthroughFavoritesKey,
			JSON.stringify(walkthroughFavoriteModelIds),
		);
	} catch {}
}
const walkthroughStale = $derived(
	!!walkthroughDocument &&
		!!walkthroughSnapshot &&
		walkthroughDocumentFingerprint !== walkthroughSnapshot.fingerprint,
);
const prompts = [
	{
		label: "Explore the codebase",
		text: "Explore this codebase and explain its architecture and main entry points.",
	},
	{
		label: "Catch me up",
		text: "Review recent changes in this repository and summarize the current conversation.",
	},
	{
		label: "Plan a feature",
		text: "Help me plan a feature. Ask me what I want to build before making changes.",
	},
	{
		label: "Review my changes",
		text: "Review the current git diff for bugs and suggest improvements.",
	},
];
function report(reason: unknown) {
	error = reason instanceof Error ? reason.message : "Something went wrong";
}
async function refreshProjects() {
	projects = await daemon.listProjects();
	if (!projects.some((p) => p.id === selectedProjectId))
		selectedProjectId = projects[0]?.id ?? "";
	const results = await Promise.allSettled(
		projects.map(async (p) =>
			(await chat.sessions(p.id)).map((s) => ({
				...s,
				projectId: p.id,
			})),
		),
	);
	sessions = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
	const failed = results.find((r) => r.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
	connected = true;
}
async function refreshSession(id: string) {
	const result = await chat.state(id);
	if (disposed || sessionId !== id) return;
	const changed =
		JSON.stringify(result.messages) !==
			JSON.stringify(conversation?.messages) ||
		JSON.stringify(result.permissions) !==
			JSON.stringify(conversation?.permissions);
	if (
		changed ||
		conversation?.status.type !== result.status.type ||
		conversation?.session.title !== result.session.title ||
		JSON.stringify(conversation?.questions) !== JSON.stringify(result.questions)
	)
		conversation = result;
	connected = true;
	const project = projects.find(
		(p) =>
			p.id === result.session.projectId ||
			p.path.replace(/\/$/, "") === result.session.directory.replace(/\/$/, ""),
	);
	if (project) selectedProjectId = project.id;
	saveActiveChatTab();
	sessions = [
		{ ...result.session, projectId: project?.id },
		...sessions.filter((s) => s.id !== id),
	];
	const pending = optimistic;
	if (
		pending &&
		result.messages.some(
			(m) =>
				m.info.role === "user" &&
				m.info.time.created >= pending.info.time.created - 2000 &&
				m.parts.some(
					(p) => p.type === "text" && p.text === pending.parts[0]?.text,
				),
		)
	)
		optimistic = null;
	if (changed && follow) {
		await tick();
		scroller?.scrollTo({
			top: scroller.scrollHeight,
			behavior: "instant",
		});
	}
	return result;
}
async function showEarlierTurns() {
	const node = scroller;
	const previousHeight = node?.scrollHeight ?? 0;
	visibleTurnCount += 80;
	await tick();
	if (node) node.scrollTop += node.scrollHeight - previousHeight;
}
async function selectSession(id: string) {
	if (previewHasUnsavedChanges && id !== sessionId) {
		toast.error("Save or discard file edits before switching sessions.");
		return;
	}
	panelRequest += 1;
	sessionId = id;
	visibleTurnCount = 80;
	conversation = null;
	optimistic = null;
	diffs = [];
	panelLoading = false;
	error = "";
	sessionLoading = !!id;
	follow = true;
	if (!id) {
		sessionLoading = false;
		return;
	}
	try {
		if (!id.startsWith("ses_")) {
			const task = await daemon.getTask(id);
			if (task.sessionId) {
				await goto(homeUrl(task.sessionId), {
					replaceState: true,
				});
				return;
			}
			await goto(`/task/${encodeURIComponent(task.id)}`);
			return;
		}
		const updated = await refreshSession(id);
		const recent = updated?.messages.findLast(
			(message) => message.info.role === "assistant",
		)?.info;
		if (recent?.providerID && recent.modelID) {
			model = canonicalModelSelection(
				catalog,
				recent.providerID,
				recent.modelID,
			);
		} else model = preferredModel(selectedProjectId);
		if (recent?.agent) agent = recent.agent;
	} catch (reason) {
		if (id === sessionId) report(reason);
	} finally {
		if (id === sessionId) sessionLoading = false;
	}
}
$effect(() => {
	const id = page.url.searchParams.get("session") ?? "";
	const browserId =
		new URL(window.location.href).searchParams.get("session") ?? "";
	// A tab change updates history before SvelteKit publishes its shallow route
	// state. Ignore that stale route snapshot so it cannot reactivate an older tab.
	if (id !== browserId || id === lastSyncedRouteSession) return;
	lastSyncedRouteSession = id;
	if (ready && id !== sessionId) {
		if (id) {
			let tab = chatTabs.find((item) => item.sessionId === id);
			if (!tab) {
				saveActiveChatTab();
				const existing = sessions.find((item) => item.id === id);
				tab = {
					id: `chat-tab-${crypto.randomUUID()}`,
					sessionId: id,
					projectId: existing?.projectId ?? selectedProjectId,
					label: existing?.title ?? "Chat",
					draft: "",
					model: preferredModel(existing?.projectId ?? selectedProjectId),
					agent: "build",
					customAgentId: "",
				};
				chatTabs = [...chatTabs, tab];
			}
			activeChatTabId = tab.id;
			selectedProjectId = tab.projectId;
			draft = tab.draft;
			model = tab.model;
			agent = tab.agent;
			customAgentId = tab.customAgentId;
		} else {
			const tab = chatTabs.find((item) => item.id === activeChatTabId);
			if (tab && tab.sessionId === sessionId) {
				tab.sessionId = "";
				tab.label = "New chat";
			}
		}
		void selectSession(id).then(() => persistChatTabs());
	}
});
$effect(() => {
	if (viewMode !== "chat" && ready) void refreshBoard();
});
function syncViewParam(mode: ViewMode) {
	// Only called from user interaction (tab switch), when the router is ready.
	// Must not run during mount: SvelteKit throws if replaceState is called
	// before router initialization, which breaks workspace loading.
	const url = new URL(window.location.href);
	if (mode === "chat") url.searchParams.delete("view");
	else url.searchParams.set("view", mode);
	try {
		replaceState(url.toString(), {});
	} catch {
		// Non-fatal: the view state itself is already updated.
	}
}
function openKanbanBoard(projectId = selectedProjectId) {
	saveActiveChatTab();
	if (projectId && projects.some((project) => project.id === projectId))
		selectedProjectId = projectId;
	viewMode = "kanban";
	splitChat = false;
	const url = new URL(window.location.href);
	if (selectedProjectId) url.searchParams.set("project", selectedProjectId);
	else url.searchParams.delete("project");
	url.searchParams.set("view", "kanban");
	try {
		replaceState(url.toString(), {});
	} catch {
		// The selected project and view state remain active if shallow routing fails.
	}
	void refreshBoard();
}
function modelKey(projectId: string) {
	return `loom.model.${projectId}`;
}
function preferredModel(projectId: string) {
	if (!projectId || typeof localStorage === "undefined") return "";
	return localStorage.getItem(modelKey(projectId)) ?? "";
}
$effect(() => {
	const value = model;
	const projectId = selectedProjectId;
	if (!ready || !projectId || typeof localStorage === "undefined") return;
	if (value) localStorage.setItem(modelKey(projectId), value);
	else localStorage.removeItem(modelKey(projectId));
});
$effect(() => {
	const projectId = selectedProjectId;
	void catalogNonce;
	void refreshAgentMonitor();
	if (!projectId) return;
	const request = ++projectRequest;
	const cachedCatalog = chat.cachedCatalog(projectId);
	if (cachedCatalog) {
		catalog = cachedCatalog;
		catalogLoaded = true;
	} else {
		catalogLoaded = false;
	}
	chat
		.catalog(projectId)
		.then((result) => {
			if (disposed || request !== projectRequest) return;
			catalog = result;
			catalogLoaded = true;
		})
		.catch((reason) => {
			if (!disposed && request === projectRequest) report(reason);
		});
	void daemon
		.listCustomAgents(projectId)
		.then((items) => {
			if (disposed || request !== projectRequest) return;
			customAgents = (items as typeof customAgents).filter(
				(item) => item.status === "active",
			);
			if (
				customAgentId &&
				!customAgents.some((item) => item.id === customAgentId)
			)
				customAgentId = "";
		})
		.catch(() => {
			customAgents = [];
			customAgentId = "";
		});
});
const noModels = $derived(
	ready &&
		connected &&
		catalogLoaded &&
		!!selectedProjectId &&
		catalog.models.length === 0,
);
const agentMonitorRows = $derived.by(() =>
	monitorAgents.map((agent) => {
		const agentTasks = legacyTasks.filter(
			(item) =>
				item.projectId === selectedProjectId &&
				item.executor?.kind === "agent" &&
				item.executor.agentId === agent.id,
		);
		const task =
			agentTasks.find((item) => item.status === "running") ??
			agentTasks.find((item) => item.status === "preparing") ??
			agentTasks.find(
				(item) => item.status === "queued" || item.status === "ready",
			) ??
			agentTasks.find((item) => item.status === "failed");
		const recentRuns = monitorRuns
			.filter((item) => item.agentId === agent.id)
			.sort(
				(a, b) =>
					monitorTimestamp(b.startedAt ?? b.createdAt) -
					monitorTimestamp(a.startedAt ?? a.createdAt),
			);
		const run =
			recentRuns.find(
				(item) => item.status === "queued" || item.status === "running",
			) ?? (recentRuns[0]?.status === "failed" ? recentRuns[0] : undefined);
		const chatTask = run?.taskId
			? legacyTasks.find((item) => item.id === run.taskId)
			: undefined;
		const kanbanTask = task && task.status !== "failed" ? task : undefined;
		const runActive = run?.status === "queued" || run?.status === "running";
		return {
			agent,
			run,
			task: kanbanTask ?? chatTask,
			kanbanTask,
			failed:
				!runActive && (task?.status === "failed" || run?.status === "failed"),
		};
	}),
);
const activeMonitorTasks = $derived(
	legacyTasks
		.filter(
			(task) =>
				(!selectedProjectId || task.projectId === selectedProjectId) &&
				(task.status === "running" || task.status === "preparing"),
		)
		.slice()
		.sort(
			(a, b) =>
				monitorTimestamp(b.startedAt ?? b.createdAt) -
				monitorTimestamp(a.startedAt ?? a.createdAt),
		),
);
const monitorRunningCount = $derived(
	activeMonitorTasks.length +
		monitorRuns.filter(
			(run) =>
				run.status === "running" &&
				!legacyTasks.some((task) => task.id === run.taskId),
		).length,
);
const monitorIdleCount = $derived(
	agentMonitorRows.filter(
		({ run, kanbanTask, agent, failed }) =>
			agent.status === "active" && !run && !kanbanTask && !failed,
	).length,
);
const visibleMonitorTasks = $derived(
	legacyTasks
		.filter(
			(task) => !selectedProjectId || task.projectId === selectedProjectId,
		)
		.slice()
		.sort(
			(a, b) => monitorTimestamp(b.createdAt) - monitorTimestamp(a.createdAt),
		)
		.slice(0, 8),
);
function monitorTimestamp(value: string | number | null | undefined) {
	if (typeof value === "number") return value;
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
function applyMonitorEvent(event: DaemonEvent) {
	// P1-7: an in-flight provider turn pushed a status change — refresh the
	// open conversation immediately instead of waiting for the next poll tick.
	if (event.type === "chat.updated") {
		if (event.sessionId === sessionId && !sessionLoading)
			void refreshSession(sessionId).catch(() => {});
		return;
	}
	if (
		event.type === "permission.requested" ||
		event.type === "permission.updated"
	) {
		monitorPermissions = [
			...monitorPermissions.filter(
				(request) => request.id !== event.request.id,
			),
			event.request,
		];
		return;
	}
	if (event.type === "task.created" || event.type === "task.updated") {
		const exists = legacyTasks.some((task) => task.id === event.task.id);
		legacyTasks = exists
			? legacyTasks.map((task) =>
					task.id === event.task.id ? { ...task, ...event.task } : task,
				)
			: [...legacyTasks, event.task];
		return;
	}
	if (event.type === "run.started") {
		monitorTaskOutput = { ...monitorTaskOutput, [event.taskId]: "" };
		monitorTaskActivities = {
			...monitorTaskActivities,
			[event.taskId]: [],
		};
		monitorTaskProgress = {
			...monitorTaskProgress,
			[event.taskId]: [],
		};
		return;
	}
	if (event.type === "run.progress") {
		const current = monitorTaskProgress[event.taskId] ?? [];
		monitorTaskProgress = {
			...monitorTaskProgress,
			[event.taskId]: [
				...current,
				{
					id: `${event.runId}:${event.sequence}`,
					stage: event.stage,
					message: event.message,
					timestamp: event.timestamp,
				},
			].slice(-30),
		};
		return;
	}
	if (event.type === "run.output") {
		if (event.output) {
			const current = monitorTaskOutput[event.taskId] ?? "";
			monitorTaskOutput = {
				...monitorTaskOutput,
				[event.taskId]: `${current}${event.output}`.slice(-4000),
			};
		}
		if (event.activities)
			monitorTaskActivities = {
				...monitorTaskActivities,
				[event.taskId]: event.activities,
			};
		return;
	}
	if (
		[
			"task.started",
			"task.completed",
			"task.failed",
			"task.cancelled",
		].includes(event.type)
	)
		void refreshAgentMonitor();
}
async function connectMonitorSocket() {
	if (disposed) return;
	try {
		await provisionDaemonToken();
		if (disposed) return;
		const socket = new WebSocket(websocketUrl(), websocketProtocols());
		monitorSocket = socket;
		socket.onmessage = (message) => {
			try {
				applyMonitorEvent(parseDaemonEvent(JSON.parse(String(message.data))));
			} catch {
				// Ignore unrelated or malformed daemon events.
			}
		};
		socket.onclose = () => {
			if (monitorSocket === socket) monitorSocket = undefined;
			if (!disposed)
				monitorReconnectTimer = setTimeout(
					() => void connectMonitorSocket(),
					2000,
				);
		};
		socket.onerror = () => socket.close();
	} catch {
		if (!disposed)
			monitorReconnectTimer = setTimeout(
				() => void connectMonitorSocket(),
				2000,
			);
	}
}
function monitorOutputPreview(taskId: string) {
	const lines = (monitorTaskOutput[taskId] ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.at(-1)?.slice(-180) ?? "Loom is working…";
}
function activityToolLabel(tool = "") {
	const normalized = tool.toLowerCase().replace(/[^a-z]/g, "");
	if (/read|view|open|cat/.test(normalized)) return "Read file";
	if (/edit|write|patch|apply|create|delete|replace/.test(normalized))
		return "Edited file";
	if (/shell|bash|command|exec|terminal/.test(normalized)) return "Ran command";
	if (/search|grep|glob|find|list/.test(normalized)) return "Searched files";
	return tool.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
}
async function reloadModels() {
	catalogNonce += 1;
	await retryConnection();
}
let lastSessionPollAt = 0;
async function poll() {
	if (disposed) return;
	try {
		if (
			sessionId &&
			!sessionLoading &&
			!sending &&
			(busy || Date.now() - lastSessionPollAt >= 15_000)
		) {
			lastSessionPollAt = Date.now();
			await refreshSession(sessionId);
		}
		if (viewMode !== "chat" && ready) await refreshBoard();
		if (
			activePanel &&
			["git", "changes", "pull-requests", "walkthrough"].includes(activePanel)
		) {
			const now = Date.now();
			const interval = activePanel === "pull-requests" ? 15_000 : 2_000;
			if (now - lastPanelSyncAt >= interval) {
				lastPanelSyncAt = now;
				void refreshVisiblePanel();
			}
		}
	} catch (reason) {
		connected = false;
		report(reason);
	} finally {
		if (!disposed) timer = setTimeout(poll, 1200);
	}
}
async function refreshVisiblePanel() {
	const panel = activePanel;
	const projectId = selectedProjectId;
	const currentSession = sessionId;
	if (!panel) return;
	if (panel === "changes") {
		if (!currentSession) return;
		const result = await chat.diff(currentSession).catch(() => null);
		if (result && activePanel === panel && sessionId === currentSession)
			diffs = result;
		return;
	}
	if (!projectId) return;
	if (panel === "git" || panel === "pull-requests") {
		const request = ++panelSyncRequest;
		const [git, prs] = await Promise.all([
			daemon.getProjectGit(projectId),
			panel === "pull-requests"
				? daemon.getProjectPullRequests(projectId)
				: Promise.resolve(null),
		]).catch(() => [null, null] as const);
		if (
			request !== panelSyncRequest ||
			projectId !== selectedProjectId ||
			activePanel !== panel
		)
			return;
		if (git) {
			gitOverview = git;
		}
		if (prs) pullRequestData = prs;
		return;
	}
	if (panel === "walkthrough") {
		const result = await daemon
			.getProjectWalkthroughSnapshot(projectId)
			.catch(() => null);
		if (result && projectId === selectedProjectId && activePanel === panel)
			walkthroughSnapshot = result.snapshot;
	}
}
async function refreshAgentMonitor() {
	const request = ++monitorRequest;
	const projectId = selectedProjectId;
	try {
		const [agents, runs, tasks, permissions, mcpConnections] =
			await Promise.all([
				daemon.listCustomAgents(projectId || undefined),
				daemon.listCustomAgentRuns(projectId || undefined),
				daemon.listTasks(),
				daemon.getPermissions(),
				daemon.listManagedMcpConnections(),
			]);
		if (
			disposed ||
			request !== monitorRequest ||
			projectId !== selectedProjectId
		)
			return;
		monitorAgents = agents;
		monitorRuns = runs;
		legacyTasks = tasks;
		monitorPermissions = permissions;
		monitorMcpConnections = mcpConnections.connections;
		monitorError = "";
		const activeTasks = tasks.filter(
			(task) =>
				(!projectId || task.projectId === projectId) &&
				(task.status === "running" || task.status === "preparing"),
		);
		void Promise.all(
			activeTasks.map(async (task) => {
				try {
					const result = await daemon.getOutput(task.id);
					if (disposed || request !== monitorRequest || !result.output) return;
					const current = monitorTaskOutput[task.id] ?? "";
					if (result.output.length >= current.length)
						monitorTaskOutput = {
							...monitorTaskOutput,
							[task.id]: result.output.slice(-4000),
						};
				} catch {
					// Output may not be available for every runtime until it responds.
				}
			}),
		);
	} catch (reason) {
		if (!disposed && request === monitorRequest)
			monitorError =
				reason instanceof Error
					? reason.message
					: "Unable to load agent activity.";
	}
}
async function decideTaskPermission(
	requestId: string,
	decision: "allow_once" | "allow" | "deny",
) {
	try {
		const updated = await daemon.decidePermission(requestId, decision);
		monitorPermissions = [
			...monitorPermissions.filter((request) => request.id !== updated.id),
			updated,
		];
		toast.success(
			decision === "deny" ? "Permission denied" : "Permission granted",
		);
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to update permission",
		);
		void refreshAgentMonitor();
	}
}
onMount(() => {
	sidebarOpen = window.innerWidth >= 768;
	try {
		panelPreferences = parseRailPanelPreferences(
			window.localStorage.getItem(railPanelPreferencesKey),
		);
	} catch {
		panelPreferences = defaultRailPanelPreferences();
		panelPreferencesSaveError = true;
	}
	panelPreferencesReady = true;
	const agentsPanel = chatPanelRegistry.find((panel) => panel.id === "agents");
	if (agentsPanel && !isChatPanelVisible(agentsPanel, panelPreferences))
		activePanel = null;
	const syncPanelPreferences = (event: StorageEvent) => {
		if (event.key !== railPanelPreferencesKey && event.key !== null) return;
		panelPreferences = parseRailPanelPreferences(
			event.key === null ? null : event.newValue,
		);
		panelPreferencesSaveError = false;
	};
	window.addEventListener("storage", syncPanelPreferences);
	const refreshProviders = () => {
		catalogNonce += 1;
	};
	window.addEventListener("loom:providers-changed", refreshProviders);
	void connectMonitorSocket();
	void (async () => {
		try {
			await refreshProjects();
			const sourceProject = page.url.searchParams.get("project");
			if (sourceProject && projects.some((p) => p.id === sourceProject))
				selectedProjectId = sourceProject;
			legacyTasks = await daemon.listTasks();
			void refreshAgentMonitor();
			model = preferredModel(selectedProjectId);
			try {
				automationMode = (await daemon.getAutomationSettings()).automationMode;
			} catch {
				automationMode = "review";
			}
			const routeSession = page.url.searchParams.get("session") ?? "";
			restoreChatTabs(routeSession);
			const restored = chatTabs.find((item) => item.id === activeChatTabId);
			if (restored) {
				selectedProjectId = designId
					? selectedProjectId
					: restored.projectId || selectedProjectId;
				draft = restored.draft;
				model = restored.model || preferredModel(selectedProjectId);
				agent = restored.agent;
				customAgentId = restored.customAgentId;
			}
			ready = true;
			if (!designId)
				await selectSession(
					restored?.taskId ? "" : (restored?.sessionId ?? ""),
				);
			if (!designId)
				updateChatUrl(restored?.taskId ? "" : (restored?.sessionId ?? ""));
			saveActiveChatTab();
			persistChatTabs();
		} catch (reason) {
			report(reason);
			ready = true;
		} finally {
			loading = false;
			void poll();
			monitorTimer = setInterval(() => void refreshAgentMonitor(), 5000);
		}
	})();
	return () => {
		saveActiveChatTab();
		disposed = true;
		window.removeEventListener("storage", syncPanelPreferences);
		window.removeEventListener("loom:providers-changed", refreshProviders);
		clearTimeout(timer);
		if (monitorTimer) clearInterval(monitorTimer);
		if (monitorReconnectTimer) clearTimeout(monitorReconnectTimer);
		monitorSocket?.close();
	};
});
function homeUrl(session = "") {
	const params = new URLSearchParams();
	if (session) params.set("session", session);
	if (viewMode !== "chat") params.set("view", viewMode);
	const query = params.toString();
	return `/${query ? `?${query}` : ""}`;
}
function leaveDesignTrace() {
	if (!designId) return;
	const url = new URL(window.location.href);
	url.searchParams.delete("design");
	replaceState(url.toString(), {});
}
function updateChatUrl(session = "") {
	persistChatTabs();
	const url = new URL(window.location.href);
	if (session) url.searchParams.set("session", session);
	else url.searchParams.delete("session");
	url.searchParams.delete("design");
	lastSyncedRouteSession = session;
	try {
		// Shallow routing avoids a pending SvelteKit navigation racing with the
		// active composer when a new tab is submitted immediately after opening.
		replaceState(url.toString(), {});
	} catch {
		// The tab state is already updated; URL synchronization is best effort.
	}
}
function beginChatTabDrag(event: DragEvent, id: string) {
	draggedChatTabId = id;
	event.dataTransfer?.setData("text/plain", id);
	if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
function dropChatTab(event: DragEvent, targetId: string) {
	event.preventDefault();
	const sourceId =
		draggedChatTabId || event.dataTransfer?.getData("text/plain");
	const from = chatTabs.findIndex((tab) => tab.id === sourceId);
	const to = chatTabs.findIndex((tab) => tab.id === targetId);
	draggedChatTabId = "";
	if (from < 0 || to < 0 || from === to) return;
	const reordered = [...chatTabs];
	const [moved] = reordered.splice(from, 1);
	reordered.splice(to, 0, moved!);
	chatTabs = reordered;
	persistChatTabs();
}
function saveActiveChatTab() {
	const tab = chatTabs.find((item) => item.id === activeChatTabId);
	if (!tab || tab.taskId) return;
	tab.sessionId = sessionId;
	tab.projectId = selectedProjectId;
	tab.draft = draft;
	tab.model = model;
	tab.agent = agent;
	tab.customAgentId = customAgentId;
	if (conversation?.session.title) tab.label = conversation.session.title;
	persistChatTabs();
}
function newChatTab(projectId = selectedProjectId) {
	if (previewHasUnsavedChanges && projectId !== selectedProjectId) {
		toast.error("Save or discard file edits before switching projects.");
		return;
	}
	saveActiveChatTab();
	const tab: WorkspaceChatTab = {
		id: `chat-tab-${crypto.randomUUID()}`,
		sessionId: "",
		projectId,
		label: "New chat",
		draft: "",
		model: preferredModel(projectId),
		agent: "build",
		customAgentId: "",
	};
	chatTabs = [...chatTabs, tab];
	activeChatTabId = tab.id;
	selectedProjectId = projectId;
	sessionId = "";
	conversation = null;
	optimistic = null;
	diffs = [];
	draft = "";
	model = tab.model;
	agent = tab.agent;
	customAgentId = "";
	sessionLoading = false;
	error = "";
	if (window.innerWidth < 768) sidebarOpen = false;
	updateChatUrl();
	persistChatTabs();
}
function startNewChatFromAnswer(answer: string) {
	const projectId = selectedProjectId;
	const selectedModelId = model;
	const selectedAgent = agent;
	const selectedCustomAgent = customAgentId;
	newChatTab(projectId);
	draft = `Continue from this answer:\n\n${answer.trim()}\n\n`;
	model = selectedModelId;
	agent = selectedAgent;
	customAgentId = selectedCustomAgent;
	saveActiveChatTab();
}
async function switchChatTab(id: string) {
	const next = chatTabs.find((item) => item.id === id);
	if (!next || (id === activeChatTabId && !designId)) return;
	if (previewHasUnsavedChanges) {
		toast.error("Save or discard file edits before switching chat tabs.");
		return;
	}
	saveActiveChatTab();
	activeChatTabId = next.id;
	if (next.taskId) splitChat = false;
	selectedProjectId = next.projectId;
	sessionId = next.taskId ? "" : next.sessionId;
	draft = next.draft;
	model = next.model || preferredModel(next.projectId);
	agent = next.agent;
	customAgentId = next.customAgentId;
	updateChatUrl(next.taskId ? "" : next.sessionId);
	await selectSession(next.taskId ? "" : next.sessionId);
	saveActiveChatTab();
	persistChatTabs();
}
async function openTaskRunTab(taskId: string) {
	const task = legacyTasks.find((item) => item.id === taskId);
	if (!task) return;
	const existing = chatTabs.find((item) => item.taskId === taskId);
	viewMode = "chat";
	syncViewParam("chat");
	splitChat = false;
	if (existing) {
		await switchChatTab(existing.id);
		return;
	}
	saveActiveChatTab();
	const tab: WorkspaceChatTab = {
		id: `task-tab-${task.id}`,
		sessionId: "",
		taskId: task.id,
		projectId: task.projectId,
		label: task.title,
		draft: "",
		model: preferredModel(task.projectId),
		agent: "build",
		customAgentId: "",
	};
	chatTabs = [...chatTabs, tab];
	activeChatTabId = tab.id;
	selectedProjectId = task.projectId;
	sessionId = "";
	conversation = null;
	optimistic = null;
	diffs = [];
	draft = "";
	model = tab.model;
	agent = tab.agent;
	customAgentId = "";
	error = "";
	sessionLoading = false;
	updateChatUrl();
	persistChatTabs();
	if (window.innerWidth < 768) sidebarOpen = false;
	void daemon
		.getOutput(task.id)
		.then((result) => {
			if (result.output.length >= (monitorTaskOutput[task.id]?.length ?? 0))
				monitorTaskOutput = {
					...monitorTaskOutput,
					[task.id]: result.output.slice(-4000),
				};
			if (result.activities?.length)
				monitorTaskActivities = {
					...monitorTaskActivities,
					[task.id]: result.activities,
				};
		})
		.catch(() => {});
}
async function cancelTaskRun(taskId: string) {
	try {
		await daemon.cancelTask(taskId);
		await refreshBoard();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to cancel task",
		);
	}
}
async function closeChatTab(id: string) {
	const index = chatTabs.findIndex((item) => item.id === id);
	if (index < 0) return;
	const wasActive = id === activeChatTabId;
	if (wasActive && previewHasUnsavedChanges) {
		toast.error("Save or discard file edits before closing this chat tab.");
		return;
	}
	chatTabs = chatTabs.filter((item) => item.id !== id);
	if (!wasActive) {
		persistChatTabs();
		return;
	}
	if (!chatTabs.length) {
		activeChatTabId = "";
		newChatTab(selectedProjectId);
		return;
	}
	const next = chatTabs[Math.min(index, chatTabs.length - 1)]!;
	activeChatTabId = "";
	await switchChatTab(next.id);
}
async function openSession(id: string) {
	leaveDesignTrace();
	let tab = chatTabs.find((item) => item.sessionId === id);
	if (!tab) {
		saveActiveChatTab();
		const existing = sessions.find((item) => item.id === id);
		tab = {
			id: `chat-tab-${crypto.randomUUID()}`,
			sessionId: id,
			projectId: existing?.projectId ?? selectedProjectId,
			label: existing?.title ?? "Chat",
			draft: "",
			model: preferredModel(existing?.projectId ?? selectedProjectId),
			agent: "build",
			customAgentId: "",
		};
		chatTabs = [...chatTabs, tab];
	}
	await switchChatTab(tab.id);
	if (window.innerWidth < 768) sidebarOpen = false;
}
async function newSession(projectId = selectedProjectId) {
	newChatTab(projectId);
}
function openSplitChat() {
	if (previewHasUnsavedChanges) {
		toast.error("Save or discard file edits before opening split chat.");
		return;
	}
	splitPreviousPanel = activePanel;
	activePanel = null;
	splitChat = true;
}
function registerSplitSession(session: ChatSession, projectId: string) {
	sessions = [
		{ ...session, projectId },
		...sessions.filter((item) => item.id !== session.id),
	];
}
async function leaveSplitChat(state: {
	sessionId: string;
	projectId: string;
	model: string;
	agent: string;
	customAgentId: string;
	draft: string;
	title: string;
}) {
	splitChat = false;
	activePanel = splitPreviousPanel;
	splitPreviousPanel = null;
	if (!state.projectId) return;
	saveActiveChatTab();
	let tab = state.sessionId
		? chatTabs.find((item) => item.sessionId === state.sessionId)
		: chatTabs.find(
				(item) =>
					item.id === activeChatTabId &&
					!item.sessionId &&
					item.projectId === state.projectId,
			);
	if (!tab) {
		tab = {
			id: `chat-tab-${crypto.randomUUID()}`,
			sessionId: state.sessionId,
			projectId: state.projectId,
			label: state.title || "New chat",
			draft: state.draft,
			model: state.model,
			agent: state.agent,
			customAgentId: state.customAgentId,
		};
		chatTabs = [...chatTabs, tab];
	} else {
		tab.sessionId = state.sessionId;
		tab.projectId = state.projectId;
		tab.label = state.title || (state.sessionId ? "Chat" : "New chat");
		tab.draft = state.draft;
		tab.model = state.model;
		tab.agent = state.agent;
		tab.customAgentId = state.customAgentId;
	}
	activeChatTabId = tab.id;
	selectedProjectId = state.projectId;
	draft = state.draft;
	model = state.model;
	agent = state.agent;
	customAgentId = state.customAgentId;
	sessionId = state.sessionId;
	conversation = null;
	optimistic = null;
	error = "";
	updateChatUrl(state.sessionId);
	await selectSession(state.sessionId);
	saveActiveChatTab();
}
async function showPanel(panel: ChatPanelId, force = false) {
	if (activePanel === "files" && previewHasUnsavedChanges) {
		toast.error("Save or discard file edits before leaving the file preview.");
		return;
	}
	if (activePanel === panel && !force) {
		activePanel = null;
		panelRequest += 1;
		panelLoading = false;
		return;
	}
	activePanel = panel;
	panelError = "";
	const request = ++panelRequest;
	const projectId = selectedProjectId;
	const currentSession = sessionId;
	panelLoading = false;
	if (
		panel === "context" ||
		panel === "files" ||
		panel === "terminal" ||
		panel === "agents"
	) {
		if (panel === "agents") void refreshAgentMonitor();
		if (panel === "terminal" && !projectId)
			panelError = "Choose a project before opening a terminal.";
		return;
	}
	if (
		(panel === "git" || panel === "pull-requests" || panel === "walkthrough") &&
		!projectId
	) {
		panelError = "Choose a project to inspect repository details.";
		return;
	}
	panelLoading = true;
	try {
		if (panel === "git") {
			gitOverview = null;
			const result = await daemon.getProjectGit(projectId);
			if (request === panelRequest && projectId === selectedProjectId)
				gitOverview = result;
		} else if (panel === "pull-requests") {
			pullRequestData = null;
			const [git, result] = await Promise.all([
				daemon.getProjectGit(projectId),
				daemon.getProjectPullRequests(projectId),
			]);
			if (request === panelRequest && projectId === selectedProjectId) {
				gitOverview = git;
				pullRequestData = result;
			}
		} else if (panel === "walkthrough") {
			if (walkthroughProjectId !== projectId) {
				walkthroughProjectId = projectId;
				walkthroughSnapshot = null;
				walkthroughDocument = null;
				walkthroughDocumentFingerprint = "";
				walkthroughStepId = "";
			}
			const result = await daemon.getProjectWalkthroughSnapshot(projectId);
			if (request === panelRequest && projectId === selectedProjectId)
				walkthroughSnapshot = result.snapshot;
		} else {
			diffs = [];
			const result = currentSession ? await chat.diff(currentSession) : [];
			if (
				request === panelRequest &&
				currentSession === sessionId &&
				projectId === selectedProjectId
			)
				diffs = result;
		}
	} catch (reason) {
		if (request === panelRequest)
			panelError =
				reason instanceof Error ? reason.message : "Unable to load panel data";
	} finally {
		if (request === panelRequest) panelLoading = false;
	}
}
async function generateCommitMessage() {
	if (!selectedProjectId || !gitOverview?.files.length || gitGeneratingMessage)
		return;
	const separator = commitModelSelection.indexOf("/");
	if (separator < 1 || separator === commitModelSelection.length - 1) {
		toast.error("Choose a model to generate a commit message.");
		return;
	}
	gitGeneratingMessage = true;
	try {
		const result = await daemon.generateProjectCommitMessage(
			selectedProjectId,
			{
				providerId: commitModelSelection.slice(0, separator),
				modelId: commitModelSelection.slice(separator + 1),
			},
		);
		gitCommitMessage = result.message;
		toast.success(
			`Commit message generated with ${result.provider.providerId}`,
		);
	} catch (reason) {
		toast.error(
			reason instanceof Error
				? reason.message
				: "Unable to generate commit message",
		);
	} finally {
		gitGeneratingMessage = false;
	}
}

async function commitChanges(push: boolean) {
	if (!selectedProjectId || !gitCommitMessage.trim() || gitBusy) return;
	gitBusy = true;
	try {
		const result = await daemon.commitProjectGit(
			selectedProjectId,
			gitCommitMessage,
			push,
		);
		toast.success(
			result.synced ? "Changes committed and synced" : "Changes committed",
		);
		gitCommitMessage = "";
		gitOverview = await daemon.getProjectGit(selectedProjectId);
		if (activePanel === "walkthrough") {
			const snapshot =
				await daemon.getProjectWalkthroughSnapshot(selectedProjectId);
			walkthroughSnapshot = snapshot.snapshot;
			walkthroughDocument = null;
			walkthroughDocumentFingerprint = "";
		}
	} catch (reason) {
		try {
			gitOverview = await daemon.getProjectGit(selectedProjectId);
		} catch {
			// Keep the original commit/push error visible in the toast.
		}
		toast.error(
			reason instanceof Error ? reason.message : "Unable to commit changes",
		);
	} finally {
		gitBusy = false;
	}
}

async function createPullRequest() {
	if (!selectedProjectId || !pullRequestTitle.trim() || pullRequestBusy) return;
	pullRequestBusy = true;
	try {
		const result = await daemon.createProjectPullRequest(selectedProjectId, {
			title: pullRequestTitle,
			body: pullRequestBody,
			...(pullRequestBase.trim() ? { base: pullRequestBase.trim() } : {}),
			draft: pullRequestDraft,
		});
		toast.success("Pull request created");
		pullRequestTitle = "";
		pullRequestBody = "";
		createdPullRequestUrl = result.url;
		await showPanel("pull-requests", true);
	} catch (reason) {
		toast.error(
			reason instanceof Error
				? reason.message
				: "Unable to create pull request",
		);
	} finally {
		pullRequestBusy = false;
	}
}

function saveRailPanelPreferences() {
	try {
		window.localStorage.setItem(
			railPanelPreferencesKey,
			JSON.stringify(panelPreferences),
		);
		panelPreferencesSaveError = false;
	} catch {
		// Keep the in-memory choice and offer a retry in the dialog.
		panelPreferencesSaveError = true;
	}
}
function setRailPanelVisibility(panelId: ChatPanelId, visible: boolean) {
	const panel = chatPanelRegistry.find((item) => item.id === panelId);
	if (!panel) return;
	panelPreferences = withChatPanelVisibility(panelPreferences, panel, visible);
	saveRailPanelPreferences();
}
function resetRailPanelPreferences() {
	panelPreferences = defaultRailPanelPreferences();
	saveRailPanelPreferences();
}
function openRegisteredPanel(panelId: ChatPanelId) {
	const panel = chatPanelRegistry.find((item) => item.id === panelId);
	panel?.open({
		projectId: selectedProjectId,
		openPanel: (id) => void showPanel(id),
	});
}
async function generateWalkthrough() {
	if (!selectedProjectId || !model || walkthroughGenerating) return;
	const projectId = selectedProjectId;
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) {
		walkthroughError = "Choose a provider model in the chat composer first.";
		return;
	}
	const selected = {
		providerId: model.slice(0, slash),
		modelId: model.slice(slash + 1),
	};
	walkthroughGenerating = true;
	walkthroughError = "";
	try {
		const result = await daemon.generateProjectWalkthrough(projectId, {
			language: walkthroughLanguage,
			model: selected,
		});
		walkthroughProjectId = projectId;
		walkthroughSnapshot = result.snapshot;
		let document = result.document;
		if (result.status === "running" && result.runId) {
			while (true) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				const progress = await daemon.getProjectWalkthroughRun(
					projectId,
					result.runId,
				);
				if (progress.status === "failed")
					throw new Error(progress.error || "Unable to generate walkthrough.");
				if (progress.status === "completed") {
					document = progress.document;
					break;
				}
			}
		}
		walkthroughDocument = document;
		walkthroughDocumentFingerprint = document
			? result.snapshot.fingerprint
			: "";
		walkthroughStepId = document?.groups[0]?.steps[0]?.id ?? "";
	} catch (reason) {
		walkthroughError =
			reason instanceof Error
				? reason.message
				: "Unable to generate walkthrough.";
	} finally {
		walkthroughGenerating = false;
	}
}
function moveWalkthroughStep(direction: -1 | 1) {
	const index = walkthroughSteps.findIndex(
		(step) => step.id === (selectedWalkthroughStep?.id ?? ""),
	);
	const next = walkthroughSteps[index + direction];
	if (next) walkthroughStepId = next.id;
}
async function send(input: Parameters<typeof chat.send>[1]) {
	if (!selectedProjectId || sending) return false;
	const tabId = activeChatTabId;
	const projectId = selectedProjectId;
	sendingChatTabIds = [...sendingChatTabIds, tabId];
	if (activeChatTabId === tabId) error = "";
	try {
		let id = sessionId;
		if (!id) {
			const created = await chat.create(
				projectId,
				input.text.split("\n")[0].slice(0, 80) || "File discussion",
			);
			id = created.id;
			const tab = chatTabs.find((item) => item.id === tabId);
			if (tab) {
				tab.sessionId = id;
				tab.label = created.title;
			}
			sessions = [{ ...created, projectId }, ...sessions];
			if (activeChatTabId === tabId) {
				sessionId = id;
				conversation = {
					session: created,
					messages: [],
					status: { type: "idle" },
					permissions: [],
					questions: [],
				};
				saveActiveChatTab();
				updateChatUrl(id);
			}
		}
		if (activeChatTabId === tabId) {
			optimistic = {
				info: {
					id: `pending-${Date.now()}`,
					role: "user",
					time: { created: Date.now() },
				},
				parts: [
					{ id: "pending-text", type: "text", text: input.text },
					...input.files.map((filename, i) => ({
						id: `pending-file-${i}`,
						type: "file",
						filename,
					})),
				],
			};
			follow = true;
			await tick();
			scroller?.scrollTo({ top: scroller.scrollHeight });
		}
		await chat.send(id, input);
		return true;
	} catch (reason) {
		if (activeChatTabId === tabId) {
			optimistic = null;
			report(reason);
		}
		return false;
	} finally {
		sendingChatTabIds = sendingChatTabIds.filter((id) => id !== tabId);
	}
}
async function stop() {
	try {
		await chat.abort(sessionId);
		optimistic = null;
		await refreshSession(sessionId);
		toast.success("Response stopped");
	} catch (reason) {
		report(reason);
	}
}
function selectedModelRef() {
	const [providerID, ...rest] = model.split("/");
	return providerID && rest.length
		? { providerID, modelID: rest.join("/") }
		: undefined;
}
// Regenerate: hide the current answer and re-run the last user prompt with
// the composer's active model/agent. Works for every provider.
async function regenerateResponse() {
	if (!sessionId || !conversation) return;
	const list = conversation.messages;
	let lastUser = -1;
	for (let i = list.length - 1; i >= 0; i--) {
		if (list[i]!.info.role === "user") {
			lastUser = i;
			break;
		}
	}
	if (lastUser < 0) return;
	const text = userMessageText(list[lastUser]!);
	const hide = list
		.slice(lastUser + 1)
		.filter((message) => message.info.role === "assistant")
		.map((message) => message.info.id);
	if (hide.length) await chat.supersede(sessionId, hide).catch(() => {});
	await send({
		text,
		files: [],
		designNodeIds: [],
		agents: [],
		agent,
		customAgentId: customAgentId || undefined,
		model: selectedModelRef(),
	});
}
// Edit: supersede the chosen user turn and its answer, then resend as new.
async function editResponse(messageId: string, text: string) {
	if (!sessionId || !conversation) return;
	const hide = supersededIds(conversation.messages, messageId);
	if (hide.length) await chat.supersede(sessionId, hide).catch(() => {});
	await send({
		text,
		files: [],
		designNodeIds: [],
		agents: [],
		agent,
		customAgentId: customAgentId || undefined,
		model: selectedModelRef(),
	});
}
async function retryConnection() {
	error = "";
	try {
		await refreshProjects();
		if (sessionId) await refreshSession(sessionId);
	} catch (reason) {
		report(reason);
	}
}
function openRename(id: string, title: string) {
	renameTarget = id;
	renameTitle = title;
	renameOpen = true;
}
async function rename() {
	if (!renameTarget || !renameTitle.trim()) return;
	try {
		await chat.rename(renameTarget, renameTitle.trim());
		renameOpen = false;
		if (renameTarget === sessionId) await refreshSession(sessionId);
		else await refreshProjects();
		toast.success("Session renamed");
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Rename failed");
	}
}
async function removeSession() {
	if (!deleteTarget) return;
	try {
		await chat.remove(deleteTarget.id);
		sessions = sessions.filter((s) => s.id !== deleteTarget?.id);
		toast.success("Session deleted");
		if (deleteTarget.id === sessionId) {
			deleteSessionOpen = false;
			deleteTarget = null;
			sessionId = "";
			updateChatUrl();
			await selectSession("");
			return;
		}
		deleteSessionOpen = false;
		deleteTarget = null;
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Delete failed");
	}
}
function openProjectRename(project: Project) {
	projectRenameTarget = project;
	projectRenameName = project.name;
	projectRenameOpen = true;
}
async function renameProject() {
	const project = projectRenameTarget;
	const name = projectRenameName.trim();
	if (!project || !name) return;
	try {
		await daemon.updateProject(project.id, { name });
		await refreshProjects();
		projectRenameOpen = false;
		projectRenameTarget = null;
		toast.success("Project renamed");
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to rename project",
		);
	}
}
async function removeProject() {
	const project = projectDeleteTarget;
	if (!project) return;
	try {
		await daemon.deleteProject(project.id);
		projectDeleteOpen = false;
		projectDeleteTarget = null;
		await refreshProjects();
		toast.success("Project removed from Loom");
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to remove project",
		);
	}
}
async function refreshBoard() {
	try {
		legacyTasks = await daemon.listTasks();
	} catch (reason) {
		report(reason);
	}
}
async function showFiles(path = "") {
	const request = ++fileRequest;
	fileName = path;
	fileContent = "";
	fileError = "";
	fileOpen = true;
	fileLoading = true;
	try {
		const result = sessionId ? await chat.diff(sessionId) : [];
		if (request !== fileRequest) return;
		diffs = result;
		if (path) {
			const diff = result.find(
				(d) => d.file === path || path.endsWith(`/${d.file}`),
			);
			fileTab = diff ? "changes" : "content";
			if (diff) fileName = diff.file;
			try {
				const content = await chat.file(selectedProjectId, path);
				if (request !== fileRequest) return;
				fileContent =
					content.encoding === "base64"
						? "Binary file preview is unavailable."
						: content.content;
			} catch (reason) {
				if (!diff) throw reason;
				fileContent =
					"File is no longer available. Its recorded changes are shown in the Changes tab.";
			}
		}
	} catch (reason) {
		if (request === fileRequest)
			fileError =
				reason instanceof Error ? reason.message : "Unable to read file";
	} finally {
		if (request === fileRequest) fileLoading = false;
	}
}
function openProjectFile(path: string) {
	const project = selectedProject;
	if (!project || !path) return;
	const normalizedPath = path.replaceAll("\\", "/");
	const normalizedRoot = project.path.replaceAll("\\", "/").replace(/\/$/, "");
	const relativePath = normalizedPath.startsWith(`${normalizedRoot}/`)
		? normalizedPath.slice(normalizedRoot.length + 1)
		: normalizedPath;
	if (relativePath.startsWith("/")) {
		toast.error(`Cannot open a file outside the selected project: ${path}`);
		return;
	}
	editorRequestedPath = relativePath;
	editorOpenRequest += 1;
	previewExpanded = false;
	activePanel = "files";
}
async function permission(
	requestId: string,
	reply: "once" | "always" | "reject",
) {
	if (permissionReplying === requestId) return;
	permissionReplying = requestId;
	try {
		await chat.permission(sessionId, requestId, reply);
		await refreshSession(sessionId);
	} catch (reason) {
		report(reason);
	} finally {
		permissionReplying = null;
	}
}
async function setAutoAccept(value: boolean) {
	const project = selectedProject;
	if (!project) return;
	// Optimistically reflect the toggle, then persist; roll back on failure.
	project.autoAccept = value;
	try {
		const updated = await daemon.updateProject(project.id, {
			autoAccept: value,
		});
		const index = projects.findIndex((p) => p.id === project.id);
		if (index >= 0) projects[index] = { ...projects[index], ...updated };
	} catch (reason) {
		project.autoAccept = !value;
		report(reason);
	}
}
async function switchProjectWorkspace(value: string) {
	const project = selectedProject;
	if (!project || !value) return;
	try {
		if (value.startsWith("branch:")) {
			const branch = value.slice("branch:".length);
			await daemon.checkoutProjectBranch(project.id, branch);
			workspaceOverview = await daemon.getProjectGit(project.id);
			toast.success(`Switched to ${branch}`);
		} else if (value.startsWith("worktree:")) {
			const path = decodeURIComponent(value.slice("worktree:".length));
			const updated = await daemon.updateProject(project.id, {
				path,
			});
			projects = projects.map((item) =>
				item.id === updated.id ? updated : item,
			);
			workspaceOverview = await daemon.getProjectGit(project.id);
			toast.success("Worktree selected");
		} else if (value === "__new_worktree") {
			worktreeBranchName = "";
			worktreeDialogOpen = true;
		}
	} catch (reason) {
		report(reason);
	}
}
async function createProjectWorktree() {
	const project = selectedProject;
	const branch = worktreeBranchName.trim();
	if (!project || !branch || worktreeCreating) return;
	worktreeCreating = true;
	try {
		const workspace = await daemon.createProjectWorktree(project.id, branch);
		const updated = await daemon.updateProject(project.id, {
			path: workspace.path,
		});
		projects = projects.map((item) =>
			item.id === updated.id ? updated : item,
		);
		workspaceOverview = await daemon.getProjectGit(project.id);
		worktreeDialogOpen = false;
		toast.success(`Worktree ${workspace.branch} created`);
	} catch (reason) {
		report(reason);
	} finally {
		worktreeCreating = false;
	}
}
async function answer(requestId: string, answers: string[][]) {
	try {
		await chat.question(sessionId, requestId, answers);
		await refreshSession(sessionId);
	} catch (reason) {
		report(reason);
	}
}
</script>

{#snippet walkthroughModelOption(item: WalkthroughModel, section: string)}
	{@const key = walkthroughModelKey(item)}
	{@const favorite = walkthroughFavoriteModelIds.includes(key)}
	<div class="flex items-center gap-1">
		<Command.Item
			value={`${section} ${item.name} ${item.provider} ${item.providerID} ${item.modelID} ${key}`}
			onSelect={() => chooseWalkthroughModel(item)}
			class="h-12 min-w-0 flex-1 items-center"
		>
			<span class="min-w-0 flex-1">
				<span class="flex min-w-0 items-center gap-2">
					<span class="truncate">{item.name}</span>
					<Badge
						variant="outline"
						class={`model-badge model-badge--${walkthroughProviderTone(item.providerID)} shrink-0 px-1.5 text-[10px] uppercase tracking-wide`}
						>{item.providerID}</Badge
					>
				</span>
				<span class="block truncate text-xs text-muted-foreground"
					>{item.modelID}{item.connectionId &&
					item.connectionId !== item.providerID
						? ` · ${item.connectionId}`
						: ""}</span
				>
			</span>
		</Command.Item>
		<Button
			type="button"
			variant="ghost"
			size="icon"
			class="size-8 shrink-0"
			aria-label={favorite
				? `Remove ${item.name} from favorites`
				: `Add ${item.name} to favorites`}
			title={favorite ? "Remove from favorites" : "Add to favorites"}
			onclick={() => toggleWalkthroughFavorite(item)}
		>
			<Star
				class={favorite
					? "size-4 fill-amber-400 text-amber-400"
					: "size-4 text-muted-foreground"}
			/>
		</Button>
	</div>
{/snippet}

<svelte:head
	><title
		>{activeTaskRun?.title
			? `${activeTaskRun.title} · Loom`
			: conversation?.session.title
				? `${conversation.session.title} · Loom`
				: "Loom · Workspace"}</title
	></svelte:head
>
<Resizable.PaneGroup
	direction="horizontal"
	class="h-svh overflow-hidden bg-background text-foreground"
>
	{#if sidebarOpen}
		<Resizable.Pane
			defaultSize={15}
			minSize={15}
			maxSize={35}
			class="max-md:!absolute max-md:inset-y-0 max-md:left-0 max-md:!z-40 max-md:!w-[280px]"
		>
			<aside
				class="relative flex h-full w-full min-w-0 flex-col border-r bg-sidebar max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[280px]"
				aria-label="Workspace sidebar"
			>
				<div class="flex h-14 items-center justify-between px-4">
					<a
						href="/"
						class="flex items-center gap-2 text-sm font-semibold tracking-wide"
						><img src="/loom-mark.webp" alt="" class="size-6 object-contain" /> loom</a
					><Button
						variant="ghost"
						size="icon"
						aria-label="Collapse sidebar"
						onclick={() => (sidebarOpen = false)}
						><PanelLeft size={16} /></Button
					>
				</div>
				<div class="space-y-2 px-3 pb-3">
					<Button
						variant="outline"
						class="w-full justify-start bg-background/50"
						onclick={() => newSession()}
						><MessageSquarePlus size={16} />New session<span
							class="ml-auto text-muted-foreground">+</span
						></Button
					>
					<div class="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							class="flex-1 justify-start text-muted-foreground"
							onclick={() => (searchOpen = !searchOpen)}
							><Search size={15} />Search sessions</Button
						><Button
							variant="ghost"
							size="icon"
							title="Add project"
							aria-label="Add project"
							onclick={() => (addProjectOpen = true)}
							><FolderPlus size={16} /></Button
						>
					</div>
					{#if searchOpen}<Input
							aria-label="Search sessions"
							placeholder="Find a conversation…"
							bind:value={search}
						/>{/if}
				</div>
				<nav class="nice-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4">
					<p
						class="px-2 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
					>
						Recent chats
					</p>
					{#each filteredSessions.slice(0, 6) as session}
						{@const active = session.id === sessionId}
						<div
							class={`group mb-0.5 flex h-8 items-center rounded-md pr-1 ${active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
						>
							{#if active}<span
									class="ml-1 h-4 w-0.5 shrink-0 rounded-full bg-primary"
									aria-hidden="true"
								></span>{/if}
							<Button
								variant="ghost"
								class="h-8 min-w-0 flex-1 justify-start bg-transparent px-2 text-xs hover:bg-transparent"
								onclick={() => openSession(session.id)}
								><span class="truncate">{session.title}</span></Button
							>
							<span class="hidden shrink-0 group-hover:flex">
								<Button
									variant="ghost"
									size="icon"
									class="size-6"
									title="Rename session"
									aria-label={`Rename ${session.title}`}
									onclick={() => openRename(session.id, session.title)}
									><Pencil size={12} /></Button
								>
								<Button
									variant="ghost"
									size="icon"
									class="size-6 text-destructive"
									title="Delete session"
									aria-label={`Delete ${session.title}`}
									onclick={() => {
										deleteTarget = session;
										deleteSessionOpen = true;
									}}><Trash2 size={12} /></Button
								>
							</span>
						</div>
					{/each}
					{#if !filteredSessions.length}<p
							class="px-2 py-2 text-xs text-muted-foreground"
						>
							{search
								? "No matching conversations."
								: "Your conversations will appear here."}
						</p>{/if}
					{#each projects as project}
						{@const selected = project.id === selectedProjectId}
						<section class="mt-5">
							<div
								class={`group relative flex items-center rounded-md ${selected ? "bg-accent/40" : ""}`}
							>
								<Button
									variant="ghost"
									size="icon"
									class="size-6"
									aria-label={`Toggle ${project.name}`}
									aria-expanded={!collapsed.includes(project.id)}
									onclick={() =>
										(collapsed = collapsed.includes(project.id)
											? collapsed.filter((id) => id !== project.id)
											: [...collapsed, project.id])}
									><ChevronDown
										size={13}
										class={collapsed.includes(project.id) ? "-rotate-90" : ""}
									/></Button
								><Button
									variant="ghost"
									class="h-8 min-w-0 flex-1 justify-start bg-transparent px-1 text-xs font-medium hover:bg-transparent"
									onclick={() => newSession(project.id)}
									><Folder size={14} class="text-teal-400" /><span
										class="truncate">{project.name}</span
									></Button
								><Button
									variant="ghost"
									size="icon"
									class="size-6"
									title={`New session in ${project.name}`}
									aria-label={`New session in ${project.name}`}
									onclick={() => newSession(project.id)}
									><Plus size={13} /></Button
								>
								<details class="group/project-menu relative">
									<summary
										class="grid size-6 cursor-pointer list-none place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										aria-label={`Project menu for ${project.name}`}
										title="Project options"
										><EllipsisVertical size={14} /></summary
									>
									<div
										class="absolute right-0 top-7 z-50 min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
									>
										<button
											type="button"
											class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
											onclick={(event) => {
												(
													event.currentTarget.closest(
														"details",
													) as HTMLDetailsElement
												).open = false;
												newSession(project.id);
											}}><Plus size={13} />New session</button
										><button
											type="button"
											class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
											onclick={(event) => {
												(
													event.currentTarget.closest(
														"details",
													) as HTMLDetailsElement
												).open = false;
												openProjectRename(project);
											}}><Pencil size={13} />Edit project</button
										><button
											type="button"
											class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10"
											onclick={(event) => {
												(
													event.currentTarget.closest(
														"details",
													) as HTMLDetailsElement
												).open = false;
												projectDeleteTarget = project;
												projectDeleteOpen = true;
											}}><Trash2 size={13} />Delete project</button
										>
									</div>
								</details>
							</div>
							{#if !collapsed.includes(project.id)}<div
									class="ml-3 border-l pl-3"
								>
									{#each filteredSessions.filter((s) => s.projectId === project.id) as session}
										{@const active = session.id === sessionId}
										<div
											class={`group flex h-8 items-center rounded-md pr-1 ${active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
										>
											{#if active}<span
													class="ml-1 h-4 w-0.5 shrink-0 rounded-full bg-primary"
													aria-hidden="true"
												></span>{/if}
											<Button
												variant="ghost"
												class="h-8 min-w-0 flex-1 justify-start bg-transparent px-2 text-xs hover:bg-transparent"
												onclick={() => openSession(session.id)}
												><span class="truncate">{session.title}</span></Button
											>
											<span class="hidden shrink-0 group-hover:flex">
												<Button
													variant="ghost"
													size="icon"
													class="size-6"
													title="Rename session"
													aria-label={`Rename ${session.title}`}
													onclick={() => openRename(session.id, session.title)}
													><Pencil size={12} /></Button
												>
												<Button
													variant="ghost"
													size="icon"
													class="size-6 text-destructive"
													title="Delete session"
													aria-label={`Delete ${session.title}`}
													onclick={() => {
														deleteTarget = session;
														deleteSessionOpen = true;
													}}><Trash2 size={12} /></Button
												>
											</span>
										</div>
									{/each}{#if !sessions.some((s) => s.projectId === project.id)}<p
											class="py-2 text-xs text-muted-foreground"
										>
											No chats yet.
										</p>{/if}
								</div>{/if}
						</section>
					{/each}
				</nav>
				<div class="flex items-center gap-1 border-t p-3">
					<Button
						href={settingsUrl("/settings")}
						variant="ghost"
						size="icon"
						title="Settings"
						aria-label="Settings"><Settings size={16} /></Button
					><Button
						variant="ghost"
						size="icon"
						title="About Loom"
						aria-label="About Loom"
						onclick={() => (aboutOpen = true)}><CircleHelp size={16} /></Button
					><Button
						variant="ghost"
						size="sm"
						class="ml-auto text-xs text-muted-foreground"
						onclick={retryConnection}
						title="Refresh connection"
						><span
							class={`size-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`}
						></span>{connected ? "Connected" : "Reconnect"}</Button
					>
				</div>
			</aside>
			<Button
				class="fixed inset-0 z-30 h-full w-full rounded-none bg-black/50 md:hidden"
				variant="ghost"
				aria-label="Close sidebar backdrop"
				onclick={() => (sidebarOpen = false)}
			/>
		</Resizable.Pane>
		<Resizable.Handle class="hidden md:flex" withHandle />
	{/if}
	<Resizable.Pane
		defaultSize={sidebarOpen ? 85 : 100}
		minSize={40}
		class="h-full min-h-0 min-w-0 flex-1"
	>
		<main class="flex h-full min-h-0 min-w-0 flex-col">
			<header
				class="flex h-[72px] shrink-0 items-center gap-2 sm:gap-3 border-b border-white/[0.08] px-3 sm:px-8"
			>
				{#if !sidebarOpen}<Button
						variant="ghost"
						size="icon"
						aria-label="Open sidebar"
						onclick={() => (sidebarOpen = true)}><PanelLeft size={16} /></Button
					>{/if}
				<div class="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
					<div
						class="grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.06] shadow-sm"
					>
						<Sparkles size={16} class="text-cyan-300" />
					</div>
					<div class="min-w-0">
						<p class="truncate text-sm font-semibold tracking-[-0.01em]">
							{viewMode === "chat"
								? designId
									? (designNode?.title ?? "Design agent session")
									: (activeTaskRun?.title ??
										conversation?.session.title ??
										"New session")
								: `Tasks · ${selectedProject?.name ?? "No project"}`}
						</p>
						{#if selectedProject}<p
								class="mt-1 flex items-center gap-2 text-[11px] text-white/45"
							>
								<span class="truncate">{selectedProject.name}</span><span
									class="text-white/20">·</span
								><GitBranch size={12} />{selectedProject.defaultBranch}
							</p>{/if}
					</div>
				</div>
				<Tabs.Root
					bind:value={viewMode}
					onValueChange={(value) => syncViewParam(value as ViewMode)}
					aria-label="Workspace mode"
					><Tabs.List
						class="h-auto gap-1 rounded-xl border border-white/10 bg-white/[0.04] p-1"
						><Tabs.Trigger
							value="chat"
							class="h-9 gap-1.5 sm:gap-2 rounded-lg px-2 sm:px-3 text-xs text-white/50 data-[state=active]:bg-white/[0.12] data-[state=active]:text-white data-[state=active]:shadow-sm"
							><MessageSquare size={14} /><span class="hidden sm:inline"
								>Chat</span
							></Tabs.Trigger
						><Tabs.Trigger
							value="kanban"
							class="h-9 gap-1.5 sm:gap-2 rounded-lg px-2 sm:px-3 text-xs text-white/50 data-[state=active]:bg-white/[0.12] data-[state=active]:text-white data-[state=active]:shadow-sm"
							><Columns3 size={14} /><span class="hidden sm:inline">Kanban</span
							></Tabs.Trigger
						>{#if selectedProject}<a
								href={`/project/${selectedProject.id}/canvas`}
								class="inline-flex h-9 items-center gap-1.5 sm:gap-2 rounded-lg px-2 sm:px-3 text-xs font-medium text-white/50 transition hover:text-white/80"
								aria-label="Design canvas"
								><Sparkles size={14} /><span class="hidden sm:inline"
									>Canvas</span
								></a
							>{/if}</Tabs.List
					></Tabs.Root
				>
			</header>
			{#if viewMode === "kanban"}
				<div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
					{#if !selectedProjectId}
						<p class="py-12 text-center text-sm text-muted-foreground">
							Add a project to see its task board.
						</p>
					{:else}
						<KanbanBoard
							projectId={selectedProjectId}
							tasks={legacyTasks.filter(
								(task) => task.projectId === selectedProjectId,
							)}
							onChanged={refreshBoard}
							onTaskStarted={openTaskRunTab}
						/>
					{/if}
				</div>
			{:else}
				{#if noModels}<div
						role="alert"
						class="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-5 py-3 text-sm text-amber-200"
					>
						<TriangleAlert size={16} class="shrink-0 text-amber-300" />
						<p class="min-w-0 flex-1">
							Connected, but no models are configured in OpenCode. Add a
							provider (for example, run <code
								class="rounded bg-black/30 px-1 py-0.5 text-xs"
								>opencode auth login</code
							>), then restart the daemon.
						</p>
						<Button variant="outline" size="sm" onclick={reloadModels}
							><RefreshCw size={13} />Reload models</Button
						>
					</div>{/if}
				<Resizable.PaneGroup
					direction="horizontal"
					class="h-full min-h-0 flex-1"
				>
					<Resizable.Pane
						defaultSize={activePanel ? (previewExpanded ? 0 : 72) : 100}
						minSize={0}
						class="flex h-full min-h-0 min-w-0 flex-col"
					>
						<div
							class={`flex min-h-0 min-w-0 flex-1 flex-col ${activePanel === "files" && previewExpanded ? "hidden" : ""}`}
						>
							{#if splitChat && viewMode === "chat" && !designId}
								<SplitChatWorkspace
									project={selectedProject}
									{catalog}
									{customAgents}
									primarySessionId={sessionId}
									primaryModel={model}
									primaryAgent={agent}
									primaryCustomAgentId={customAgentId}
									primaryDraft={draft}
									onclose={leaveSplitChat}
									onfile={showFiles}
									onopenfile={openProjectFile}
									onSession={registerSplitSession}
								/>
							{:else}
								{#if viewMode === "chat"}
									<div
										class="nice-scroll flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.08] bg-background/40 px-3 py-2"
										role="tablist"
										aria-label="Chat tabs"
									>
										{#each chatTabs as tab (tab.id)}
											{@const isActive = tab.id === activeChatTabId}
											{@const agentLabel = customAgents.find(
												(item) => item.id === tab.customAgentId,
											)?.label}
											{@const runTask = tab.taskId
												? legacyTasks.find((item) => item.id === tab.taskId)
												: undefined}
											<div
												role="group"
												aria-label={`Chat tab ${tab.label}`}
												aria-roledescription="Draggable chat tab"
												draggable="true"
												ondragstart={(event) => beginChatTabDrag(event, tab.id)}
												ondragend={() => (draggedChatTabId = "")}
												ondragover={(event) => event.preventDefault()}
												ondrop={(event) => dropChatTab(event, tab.id)}
												class={`group flex h-8 max-w-56 shrink-0 cursor-grab items-center rounded-md border transition active:cursor-grabbing ${draggedChatTabId === tab.id ? "opacity-40" : ""} ${isActive ? "border-white/15 bg-white/[0.08] text-foreground" : "border-transparent text-muted-foreground hover:bg-white/[0.04]"}`}
											>
												<Button
													variant="ghost"
													role="tab"
													aria-selected={isActive}
													class="h-7 min-w-0 justify-start gap-2 px-2 text-xs"
													title={tab.label}
													onclick={() => void switchChatTab(tab.id)}
													>{#if tab.taskId}<Activity
															size={13}
															class="shrink-0"
														/>{:else}<MessageSquare
															size={13}
															class="shrink-0"
														/>{/if}<span class="max-w-40 truncate"
														>{tab.sessionId || tab.taskId
															? tab.label
															: (agentLabel ?? tab.label)}</span
													>{#if runTask && (runTask.status === "running" || runTask.status === "preparing")}<span
															class="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-400"
															aria-label="Task running"

														></span>{:else if runTask && (runTask.status === "queued" || runTask.status === "ready")}<span
															class="size-1.5 shrink-0 rounded-full bg-amber-400"
															aria-label="Task queued"
														></span>{:else if isActive && sending}<span
															class="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
														></span>{/if}</Button
												>
												<Button
													variant="ghost"
													size="icon"
													class="mr-0.5 size-6 shrink-0 opacity-60 hover:opacity-100"
													aria-label={`Close ${tab.label}`}
													title="Close tab"
													onclick={(event) => {
														event.stopPropagation();
														void closeChatTab(tab.id);
													}}><X size={12} /></Button
												>
											</div>
										{/each}
										<Button
											variant="ghost"
											size="icon"
											class="size-8 shrink-0 text-muted-foreground"
											aria-label="New chat tab"
											title="New chat tab"
											onclick={() => newChatTab()}><Plus size={15} /></Button
										>
										<Button
											variant="ghost"
											size="icon"
											class="size-8 shrink-0 text-muted-foreground"
											aria-label="Open split chat"
											title="Open split chat"
											disabled={!selectedProjectId}
											onclick={openSplitChat}><Columns3 size={15} /></Button
										>
									</div>
								{/if}
								{#if designId && viewMode === "chat"}
									<div
										class="nice-scroll min-h-0 flex-1 overflow-y-auto p-5"
										aria-label="Design agent session trace"
									>
										<div class="mx-auto max-w-3xl space-y-5">
											<a
												href={`/project/${encodeURIComponent(designProjectId)}/canvas`}
												class="text-sm text-primary hover:underline"
												>Back to canvas</a
											>
											<h2 class="text-lg font-medium">
												{designNode?.title ?? "Design agent session"}
											</h2>
											<p class="text-xs text-muted-foreground">
												Canvas design trace · not an OpenCode chat session
											</p>
											{#if designTraceLoading && !designTrace}<p
													role="status"
													class="text-sm text-muted-foreground"
												>
													Loading design trace…
												</p>{/if}
											{#if designTraceError}<p
													role="alert"
													class="text-sm text-destructive"
												>
													{designTraceError}
												</p>{/if}
											{#if designNode?.status === "generating" || designNode?.status === "queued"}<p
													role="status"
													class="flex items-center gap-2 text-sm text-muted-foreground"
												>
													<LoaderCircle size={14} class="animate-spin" />Design
													is {designNode.status}. Trace updates automatically.
												</p>{/if}
											{#if designNode?.errorMessage}<p
													role="alert"
													class="text-sm text-destructive"
												>
													{designNode.errorMessage}
												</p>{/if}
											{#if designTrace && !designTrace.runs.length}<p
													class="text-sm text-muted-foreground"
												>
													No agent runs recorded for this design yet.
												</p>{/if}
											{#each designTrace?.runs ?? [] as run, index (index)}
												<section
													class="space-y-3 rounded-lg border p-4"
													aria-label={`Design run ${index + 1}`}
												>
													<h3 class="text-sm font-medium">Run {index + 1}</h3>
													<p
														class="break-all font-mono text-xs text-muted-foreground"
													>
														Runtime session ID: {run.sessionId}
													</p>
													<p class="text-xs text-muted-foreground">
														{run.createdAt}
													</p>
													{#if !run.events.length}<p
															class="text-xs text-muted-foreground"
														>
															No events recorded yet.
														</p>{/if}
													{#each run.events as event, eventIndex (eventIndex)}
														<div
															class="space-y-1 rounded-md border bg-muted/20 p-3 text-sm"
														>
															<p class="font-medium">
																{event.tool
																	? `Tool · ${event.tool}`
																	: `Provider · ${event.type}`}{event.status
																	? ` · ${event.status}`
																	: ""}
															</p>
															{#if event.text}<pre
																	class="whitespace-pre-wrap break-words text-xs">{event.text}</pre>{/if}
															{#if event.output}<pre
																	class="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{event.output}</pre>{/if}
															{#if event.error}<pre
																	role="alert"
																	class="whitespace-pre-wrap break-words text-xs text-destructive">{event.error}</pre>{/if}
														</div>
													{/each}
												</section>
											{/each}
										</div>
									</div>
								{:else if activeChatTab?.taskId}
									{#if activeTaskRun}
										<TaskRunChat
											task={activeTaskRun}
											output={monitorTaskOutput[activeTaskRun.id] ?? ""}
											activities={monitorTaskActivities[activeTaskRun.id] ?? []}
											progress={monitorTaskProgress[activeTaskRun.id] ?? []}
											permissions={monitorPermissions.filter(
												(request) => request.taskId === activeTaskRun.id,
											)}
											onpermission={decideTaskPermission}
											onopenfile={openProjectFile}
											oncancel={cancelTaskRun}
										/>
									{:else}
										<div
											class="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-muted-foreground"
										>
											This task is no longer available in the workspace.
										</div>
									{/if}
								{:else}
									<div
										bind:this={scroller}
										onscroll={(event) => {
											const node = event.currentTarget;
											follow =
												node.scrollHeight - node.scrollTop - node.clientHeight <
												100;
										}}
										class="nice-scroll min-h-0 flex-1 overflow-y-auto"
									>
										<div
											class={`mx-auto flex min-h-full w-full max-w-[740px] flex-col px-5 ${sessionId ? "py-8" : "justify-center py-12"}`}
										>
											{#if loading || sessionLoading}<div
													role="status"
													class="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
												>
													<LoaderCircle size={17} class="animate-spin" />Loading {loading
														? "workspace"
														: "conversation"}…
												</div>
											{:else if !sessionId}<section
													class="relative isolate -mx-5 flex flex-col items-center px-5 pb-10 pt-[8vh] sm:pt-[12vh]"
												>
													<div
														class="pointer-events-none absolute left-1/2 top-24 -z-10 h-80 w-[min(42rem,90vw)] -translate-x-1/2 rounded-full bg-cyan-500/[0.035] blur-3xl"
													></div>
													<div class="w-full max-w-[700px]">
														<div class="mb-8 text-center">
															<div
																aria-hidden="true"
																class="relative mx-auto mb-6 size-20"
															>
																<div class="hero-orbit hero-orbit-one"></div>
																<div class="hero-orbit hero-orbit-two"></div>
																<div
																	class="absolute inset-0 grid place-items-center"
																>
																	<div
																		class="hero-core grid size-12 place-items-center rounded-2xl border border-cyan-200/30 bg-cyan-300/[0.1]"
																	>
																		<Sparkles size={20} class="text-cyan-200" />
																	</div>
																</div>
																<span class="hero-node hero-node-one"
																></span><span class="hero-node hero-node-two"
																></span><span class="hero-node hero-node-three"
																></span>
															</div>
															<h1
																class="text-3xl font-medium tracking-[-0.04em] text-white sm:text-[38px]"
															>
																Turn ideas into momentum
															</h1>
															<p
																class="mx-auto mt-3 max-w-md text-sm leading-6 text-white/45"
															>
																Bring a little context. We’ll shape the next
																step together.
															</p>
														</div>
													</div>
												</section>{/if}
											{#if sessionId}
												<div
													class="space-y-8"
													aria-live="polite"
													aria-relevant="additions text"
												>
													{#if conversation?.session.parentID}
														<div
															class="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs"
														>
															<span
																class="min-w-0 flex-1 truncate text-muted-foreground"
																>Focused child session</span
															>
															<Button
																variant="outline"
																size="sm"
																class="h-7"
																onclick={() =>
																	void openSession(
																		conversation!.session.parentID!,
																	)}>Back to parent chat</Button
															>
														</div>
													{/if}
													{#if childSessions.length}
														<details class="rounded-lg border bg-muted/20 p-3">
															<summary
																class="cursor-pointer text-xs font-medium"
																>Child sessions ({childSessions.length})</summary
															>
															<ul class="mt-2 space-y-1">
																{#each childSessions as child (child.id)}
																	<li
																		class="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
																	>
																		<span
																			class={`size-1.5 shrink-0 rounded-full ${child.status.type === "busy" || child.status.type === "running" ? "animate-pulse bg-sky-400" : child.status.type === "error" ? "bg-destructive" : "bg-emerald-400"}`}
																			aria-hidden="true"
																		></span>
																		<span
																			class="min-w-0 flex-1 truncate text-xs"
																			>{child.title ||
																				"Untitled child session"}</span
																		>
																		<span
																			class="shrink-0 text-[10px] text-muted-foreground"
																			>{child.status.type === "busy" ||
																			child.status.type === "retry"
																				? "Loom is working…"
																				: (child.status.message ??
																					child.status.type)}</span
																		>
																		<Button
																			variant="ghost"
																			size="sm"
																			class="h-7 px-2 text-xs"
																			onclick={() => void openSession(child.id)}
																			>Focus</Button
																		>
																	</li>
																{/each}
															</ul>
														</details>
													{/if}
													{#if turns.length > visibleTurnCount}
														<Button
															variant="ghost"
															class="mb-4 w-full"
															onclick={() => void showEarlierTurns()}
															>Load earlier messages</Button
														>
													{/if}
													{#each visibleTurns as turn (turn.key)}
														<Turn
															messages={turn.messages}
															{catalog}
															{sessionId}
															projectId={selectedProjectId}
															onfile={showFiles}
															onopenfile={openProjectFile}
															onbranch={startNewChatFromAnswer}
															onregenerate={turn.role ===
																"assistant" &&
																turn.key === lastAssistantTurnKey &&
																!busy
																? regenerateResponse
																: undefined}
															onedit={turn.role === "user" && !busy
																? editResponse
																: undefined}
														/>
													{/each}
												</div>
												{#if busy}<Marker.Root
														variant="border"
														class="mt-5 flex items-center"
														><Marker.Icon
															><LoaderCircle
																size={14}
																class="animate-spin"
															/></Marker.Icon
														><Marker.Content
															>{conversation?.permissions.length
																? "Waiting for permission"
																: conversation?.questions.length
																	? "Waiting for your answer"
																	: "Loom is working…"}</Marker.Content
														></Marker.Root
													>{/if}
												{#each conversation?.permissions ?? [] as request}<div
														role="group"
														aria-label={`Permission required: ${request.permission}`}
														class="mt-5 space-y-3 rounded-xl border border-amber-500/30 bg-card p-4"
													>
														<p
															class="flex items-center gap-2 text-sm font-medium"
														>
															<ShieldCheck size={16} />Permission required: {request.permission}
														</p>
														{#if request.patterns.length}<pre
																class="overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{request.patterns.join(
																	"\n",
																)}</pre>{/if}
														<div class="flex flex-wrap gap-2">
															<Button
																size="sm"
																disabled={permissionReplying === request.id}
																onclick={() => permission(request.id, "once")}
																>Accept once</Button
															><Button
																variant="outline"
																size="sm"
																disabled={permissionReplying === request.id}
																onclick={() => permission(request.id, "always")}
																>Always allow</Button
															><Button
																variant="ghost"
																size="sm"
																disabled={permissionReplying === request.id}
																onclick={() => permission(request.id, "reject")}
																>Decline</Button
															>
														</div>
													</div>{/each}
												{#each conversation?.questions ?? [] as question}<div
														class="mt-5"
													>
														<QuestionCard
															{question}
															onanswer={(answers) =>
																answer(question.id, answers)}
														/>
													</div>{/each}
											{/if}

											{#if error}<div
													role="alert"
													class="my-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
												>
													<p
														class="min-w-0 flex-1 break-words text-destructive"
													>
														{error}
													</p>
													<Button
														variant="ghost"
														size="sm"
														onclick={retryConnection}
														><RefreshCw size={13} />Retry</Button
													><Button
														variant="ghost"
														size="icon"
														class="size-7"
														aria-label="Dismiss error"
														onclick={() => (error = "")}><X size={13} /></Button
													>
												</div>{/if}
											{#if !sessionId && !loading}
												{#if !projects.length}<div class="mb-5 text-center">
														<p class="mb-3 text-sm text-muted-foreground">
															Add a local Git project to start chatting with
															OpenCode.
														</p>
														<Button onclick={() => (addProjectOpen = true)}
															><FolderPlus size={16} />Add project</Button
														>
													</div>{:else}<div
														class="mb-3 flex flex-wrap items-center gap-2"
													>
														<Select.Root
															type="single"
															bind:value={selectedProjectId}
															><Select.Trigger
																class="h-10 w-auto min-w-40 gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-sm text-white/75 shadow-none transition hover:bg-white/[0.08]"
																aria-label="Choose project"
																><Folder
																	size={16}
																	class="text-white/55"
																/>{selectedProject?.name ??
																	"Choose project"}</Select.Trigger
															><Select.Content
																>{#each projects as project}<Select.Item
																		value={project.id}
																		>{project.name}</Select.Item
																	>{/each}</Select.Content
															></Select.Root
														>
														{#if workspaceOverview}<Select.Root
																type="single"
																value={`branch:${workspaceOverview.branch.split("...")[0]}`}
																onValueChange={(value) =>
																	void switchProjectWorkspace(value)}
																><Select.Trigger
																	class="h-10 w-auto max-w-64 gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-sm text-white/75 shadow-none transition hover:bg-white/[0.08]"
																	aria-label="Choose branch or worktree"
																	title="Choose branch or worktree"
																	><GitBranch
																		size={15}
																		class="shrink-0 text-amber-300"
																	/><span class="max-w-48 truncate"
																		>{workspaceOverview.branch.split(
																			"...",
																		)[0] || "Branch"}</span
																	></Select.Trigger
																><Select.Content class="max-h-80"
																	><Select.Group
																		><Select.Label
																			>Project root · {workspaceOverview.branch.split(
																				"...",
																			)[0]}</Select.Label
																		>{#each workspaceOverview.branches as branch}<Select.Item
																				value={`branch:${branch}`}
																				>{branch}{branch ===
																				workspaceOverview.branch.split("...")[0]
																					? " · current"
																					: ""}</Select.Item
																			>{/each}</Select.Group
																	>{#if workspaceOverview.worktrees.filter((item) => !item.current).length}<Select.Separator
																		/><Select.Group
																			><Select.Label>Worktrees</Select.Label
																			>{#each workspaceOverview.worktrees.filter((item) => !item.current) as item}<Select.Item
																					value={`worktree:${encodeURIComponent(item.path)}`}
																					>{item.branch}
																					·
																					{item.path
																						.split("/")
																						.at(-1)}</Select.Item
																				>{/each}</Select.Group
																		>{/if}<Select.Separator /><Select.Item
																		value="__new_worktree"
																		>＋ New worktree…</Select.Item
																	></Select.Content
																></Select.Root
															>{:else if workspaceLoading}<span
																class="px-2 text-xs text-muted-foreground"
																>Loading branch…</span
															>{/if}
													</div>{/if}
												<Composer
													projectId={selectedProjectId}
													{catalog}
													{customAgents}
													{busy}
													disabled={!selectedProjectId || loading}
													onsend={send}
													onstop={stop}
													bind:draft
													bind:model
													bind:agent
													bind:customAgentId
													autoAccept={selectedProject?.autoAccept ?? false}
													onAutoAcceptChange={selectedProject
														? (value) => void setAutoAccept(value)
														: undefined}
												/>

												<div class="mt-5 flex flex-wrap justify-center gap-2">
													{#each prompts as prompt}<Button
															variant="outline"
															size="sm"
															class="rounded-full border-white/10 bg-white/[0.025] px-3.5 py-2 text-xs text-white/55 transition hover:border-white/20 hover:bg-white/[0.07] hover:text-white/80"
															onclick={() => (draft = prompt.text)}
															>{prompt.label}</Button
														>{/each}
												</div>
											{/if}
										</div>
									</div>
								{/if}
								{#if !activeChatTab?.taskId && sessionId && viewMode === "chat"}<div
										class="shrink-0 border-t bg-background px-5 py-4"
									>
										<div class="mx-auto max-w-3xl">
											<Composer
												projectId={selectedProjectId}
												{catalog}
												{customAgents}
												{busy}
												disabled={!conversation || sessionLoading}
												onsend={send}
												onstop={stop}
												bind:draft
												bind:model
												bind:agent
												bind:customAgentId
												autoAccept={selectedProject?.autoAccept ?? false}
												onAutoAcceptChange={selectedProject
													? (value) => void setAutoAccept(value)
													: undefined}
											/>
										</div>
									</div>{/if}
							{/if}
						</div>
					</Resizable.Pane>
					{#if activePanel}
						<Resizable.Handle
							class={previewExpanded ? "hidden" : "hidden md:flex"}
							withHandle
						/>
						<Resizable.Pane
							defaultSize={previewExpanded ? 100 : 28}
							minSize={previewExpanded ? 30 : 18}
							maxSize={previewExpanded ? 100 : 65}
							class="flex h-full min-h-0 min-w-0 flex-col max-md:!absolute max-md:inset-y-0 max-md:left-0 max-md:right-11 max-md:!z-30 max-md:bg-background"
						>
							<aside
								class="relative flex h-full min-w-0 flex-col border-l bg-card/30"
								aria-label={`${activePanel} panel`}
							>
								{#if activePanel === "files"}
									{#key selectedProjectId}<WorkspaceCodePreview
											projectId={selectedProjectId}
											projectName={selectedProject?.name ?? "Project"}
											projectPath={selectedProject?.path ?? ""}
											requestedPath={editorRequestedPath}
											openRequest={editorOpenRequest}
											{busy}
											bind:hasUnsavedChanges={previewHasUnsavedChanges}
											bind:expanded={previewExpanded}
											onclose={() => {
												previewExpanded = false;
												activePanel = null;
											}}
										/>{/key}
								{:else if activePanel === "terminal"}
									{#key selectedProjectId}<TerminalPanel
											projectId={selectedProjectId}
										/>{/key}
								{:else}
									<div
										class="flex h-12 shrink-0 items-center gap-2 border-b px-4"
									>
										<p class="min-w-0 flex-1 truncate text-sm font-medium">
											{activePanel === "agents"
												? "Agents & tasks"
												: activePanel === "context"
													? "Context usage"
													: activePanel === "git"
														? "Git"
														: activePanel === "pull-requests"
															? "Pull requests"
															: activePanel === "walkthrough"
																? "Walkthrough"
																: "Changes"}
										</p>
										{#if activePanel !== "context"}<Button
												variant="ghost"
												size="icon"
												class="size-7"
												aria-label="Refresh panel"
												title="Refresh"
												onclick={() => void showPanel(activePanel!, true)}
												disabled={panelLoading}
												><RefreshCw
													size={13}
													class={panelLoading ? "animate-spin" : ""}
												/></Button
											>{/if}
										<Button
											variant="ghost"
											size="icon"
											class="size-7 md:hidden"
											aria-label="Close panel"
											title="Close"
											onclick={() => {
												activePanel = null;
												previewExpanded = false;
											}}><X size={14} /></Button
										>
									</div>
									<div class="nice-scroll min-h-0 flex-1 overflow-y-auto p-4">
										{#if panelError}<p
												role="alert"
												class="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
											>
												{panelError}
											</p>{/if}
										{#if activePanel === "agents"}
											<div class="space-y-5">
												{#if monitorError}<p
														role="alert"
														class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
													>
														{monitorError}
													</p>{/if}
												<section class="rounded-lg border bg-card/50 p-3">
													<div class="flex items-center justify-between gap-2">
														<div class="flex items-center gap-2">
															<Activity size={14} class="text-primary" />
															<p class="text-xs font-medium">Agent activity</p>
														</div>
														<span class="text-[10px] text-muted-foreground"
															>Live · 5s</span
														>
													</div>
													<div class="mt-3 grid grid-cols-2 gap-2">
														<div class="rounded-md border bg-background/50 p-2">
															<p class="text-[10px] text-muted-foreground">
																Running tasks
															</p>
															<p class="mt-1 text-lg font-semibold">
																{monitorRunningCount}
															</p>
														</div>
														<div class="rounded-md border bg-background/50 p-2">
															<p class="text-[10px] text-muted-foreground">
																Idle agents
															</p>
															<p class="mt-1 text-lg font-semibold">
																{monitorIdleCount}
															</p>
														</div>
													</div>
												</section>
												<section>
													<div class="mb-2 flex items-center justify-between">
														<h3 class="text-xs font-semibold">MCP servers</h3>
														<a
															href={settingsUrl("/settings/mcp")}
															class="text-[10px] text-primary hover:underline"
															>Manage</a
														>
													</div>
													{#if !monitorMcpConnections.length}<p
															class="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground"
														>
															No MCP connections configured.
														</p>
													{:else}<div class="space-y-2">
															{#each monitorMcpConnections as connection (connection.id)}
																{@const isConnected =
																	connection.status === "connected"}
																{@const isError =
																	connection.status === "error" ||
																	connection.status === "degraded"}
																{@const isPending =
																	connection.status === "connecting" ||
																	connection.status === "auth_required"}
																{@const tone = isConnected
																	? "text-emerald-400"
																	: isError
																		? "text-red-400"
																		: isPending
																			? "text-amber-300"
																			: "text-muted-foreground"}
																{@const dot = isConnected
																	? "bg-emerald-400"
																	: isError
																		? "bg-red-400"
																		: isPending
																			? "bg-amber-300"
																			: "bg-muted-foreground"}
																<article
																	class="rounded-lg border bg-card/40 p-3"
																>
																	<div class="flex min-w-0 items-start gap-2">
																		<div
																			class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border bg-background/60"
																		>
																			<Globe size={14} class="text-cyan-300" />
																		</div>
																		<div class="min-w-0 flex-1">
																			<div
																				class="flex items-center justify-between gap-2"
																			>
																				<p class="truncate text-xs font-medium">
																					{connection.label}
																				</p>
																				<span
																					class={`inline-flex shrink-0 items-center gap-1.5 text-[10px] font-medium ${tone}`}
																					><span
																						class={`size-2 rounded-full ${dot} ${connection.status === "connecting" ? "animate-pulse" : ""}`}
																					></span>{connection.status.replaceAll(
																						"_",
																						" ",
																					)}</span
																				>
																			</div>
																			<p
																				class="mt-1 truncate text-[10px] text-muted-foreground"
																			>
																				{connection.transport === "stdio"
																					? (connection.command ??
																						"Local process")
																					: (connection.endpointHost ??
																						"Remote endpoint")}{connection.toolCount
																					? ` · ${connection.toolCount} tools`
																					: ""}
																			</p>
																			{#if connection.lastError}<p
																					class="mt-1 line-clamp-2 text-[10px] leading-4 text-red-300"
																				>
																					{connection.lastError}
																				</p>{/if}
																		</div>
																	</div>
																</article>
															{/each}
														</div>{/if}
												</section>
												<section>
													<div class="mb-2 flex items-center justify-between">
														<h3 class="text-xs font-semibold">
															Registered agents
														</h3>
														<a
															href={settingsUrl("/settings/agents")}
															class="text-[10px] text-primary hover:underline"
															>Manage</a
														>
													</div>
													{#if !agentMonitorRows.length}<p
															class="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground"
														>
															No custom agents have been created yet.
														</p>
													{:else}<div class="space-y-2">
															{#each agentMonitorRows as item (item.agent.id)}
																{@const running =
																	item.run?.status === "running" ||
																	item.kanbanTask?.status === "running" ||
																	item.kanbanTask?.status === "preparing"}
																{@const queued =
																	item.run?.status === "queued" ||
																	item.kanbanTask?.status === "queued" ||
																	item.kanbanTask?.status === "ready"}
																{@const idle =
																	item.agent.status === "active" &&
																	!item.run &&
																	!item.kanbanTask &&
																	!item.failed}
																{@const statusTone = item.failed
																	? "text-red-400"
																	: running || queued
																		? "text-amber-300"
																		: idle
																			? "text-emerald-400"
																			: "text-muted-foreground"}
																{@const dotTone = item.failed
																	? "bg-red-400"
																	: running || queued
																		? "bg-amber-300"
																		: idle
																			? "bg-emerald-400"
																			: "bg-muted-foreground"}
																<article
																	class="rounded-lg border bg-card/40 p-3"
																>
																	<div class="flex min-w-0 items-start gap-2">
																		<div
																			class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border bg-background/60"
																		>
																			<Bot size={14} class="text-cyan-300" />
																		</div>
																		<div class="min-w-0 flex-1">
																			<div class="flex items-center gap-2">
																				<p
																					class="min-w-0 flex-1 truncate text-xs font-medium"
																				>
																					{item.agent.label}
																				</p>
																				<span
																					class={`inline-flex shrink-0 items-center gap-1.5 text-[10px] font-medium ${statusTone}`}
																					title={item.failed
																						? "The most recent agent run failed"
																						: undefined}
																					><span
																						class="relative inline-flex size-2"
																						><span
																							class={`absolute inline-flex size-full rounded-full opacity-60 ${dotTone} ${idle || running || queued ? "animate-ping" : ""}`}
																						></span><span
																							class={`relative inline-flex size-2 rounded-full ${dotTone}`}
																						></span></span
																					>{item.failed
																						? "Error"
																						: running
																							? "Running"
																							: queued
																								? "Queued"
																								: idle
																									? "Idle"
																									: "Inactive"}</span
																				>
																			</div>
																			<p
																				class="mt-1 truncate text-[10px] text-muted-foreground"
																			>
																				{item.agent.role}
																				·
																				{item.agent.provider}
																			</p>
																			{#if item.kanbanTask && (running || queued)}<p
																					class="mt-2 flex items-start gap-1.5 text-[10px] leading-4 text-muted-foreground"
																				>
																					<Activity
																						size={12}
																						class={`mt-0.5 shrink-0 ${running ? "text-emerald-300" : "text-amber-200"}`}
																					/>{running
																						? `Working on · ${item.kanbanTask.title}`
																						: `Queued · ${item.kanbanTask.title}`}
																				</p>
																				{#if running}<p
																						class="mt-1 line-clamp-2 pl-5 text-[10px] leading-4 text-muted-foreground"
																					>
																						{monitorOutputPreview(
																							item.kanbanTask.id,
																						)}
																					</p>{/if}<button
																					type="button"
																					class="mt-1 pl-5 text-[10px] text-primary hover:underline"
																					onclick={() =>
																						void openTaskRunTab(
																							item.kanbanTask!.id,
																						)}
																					>View live progress in chat</button
																				>
																			{:else if item.run && (running || queued)}<p
																					class="mt-2 flex items-start gap-1.5 text-[10px] leading-4 text-muted-foreground"
																				>
																					<Activity
																						size={12}
																						class={`mt-0.5 shrink-0 ${running ? "text-emerald-300" : "text-amber-200"}`}
																					/>{item.task
																						? `In use · ${item.task.title}`
																						: item.run.trigger === "chat"
																							? "In use · Chat session"
																							: "Agent run active"}
																				</p>{/if}
																		</div>
																	</div>
																</article>
															{/each}
														</div>{/if}
												</section>
												<section>
													<div class="mb-2 flex items-center justify-between">
														<h3
															class="flex items-center gap-1.5 text-xs font-semibold"
														>
															<ListTodo size={13} />Tasks
														</h3>
														<button
															type="button"
															class="text-[10px] text-primary hover:underline"
															onclick={() => openKanbanBoard(selectedProjectId)}
															>Open board</button
														>
													</div>
													{#if !visibleMonitorTasks.length}<p
															class="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground"
														>
															No tasks to show{selectedProject
																? ` for ${selectedProject.name}`
																: ""}.
														</p>
													{:else}<div class="space-y-1">
															{#each visibleMonitorTasks as task (task.id)}
																{@const taskProject = projects.find(
																	(project) => project.id === task.projectId,
																)}
																<button
																	type="button"
																	class="flex min-w-0 w-full items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left transition hover:border-border hover:bg-accent/30"
																	onclick={() =>
																		openKanbanBoard(task.projectId)}
																	aria-label={`Open Kanban board for ${task.title}`}
																	><span
																		class={`size-1.5 shrink-0 rounded-full ${task.status === "running" ? "bg-emerald-400" : task.status === "failed" || task.status === "merge_conflict" ? "bg-red-400" : task.status === "completed" ? "bg-sky-300" : "bg-amber-300"}`}
																	></span><span class="min-w-0 flex-1"
																		><span class="block truncate text-[11px]"
																			>{task.title}</span
																		><span
																			class="mt-0.5 block truncate text-[9px] text-muted-foreground"
																			>{taskProject?.name ?? "Project"}
																			· {task.status.replaceAll("_", " ")}</span
																		></span
																	></button
																>
															{/each}
														</div>{/if}
												</section>
											</div>
										{:else if activePanel === "context"}
											<div class="flex flex-col gap-3">
												<section class="rounded-xl border bg-card/70 p-4">
													<p class="text-xs text-muted-foreground">
														Latest provider context
													</p>
													<p class="mt-2 text-2xl font-semibold tabular-nums">
														{!sessionId || latestUsageMessage
															? contextTokens.toLocaleString()
															: "—"}
														<span
															class="text-sm font-normal text-muted-foreground"
															>tokens</span
														>
													</p>
													{#if contextPercent !== null}
														<div
															class="mt-3 h-2 overflow-hidden rounded-full bg-muted"
														>
															<div
																class="h-full rounded-full bg-primary transition-[width]"
																style={`width: ${contextPercent}%`}
															></div>
														</div>
														<p class="mt-2 text-[11px] text-muted-foreground">
															{contextPercent.toFixed(1)}% of {contextModel?.contextWindow?.toLocaleString()}
															token window
														</p>
													{:else if latestUsageMessage}
														<p class="mt-2 text-[11px] text-muted-foreground">
															Provider reported usage; context window size is
															unavailable.
														</p>
													{:else}
														<p
															class="mt-2 text-[11px] leading-5 text-muted-foreground"
														>
															{sessionId
																? "No token usage has been reported by the provider for this conversation yet."
																: "A new session starts at 0 tokens. Usage appears after the provider returns it."}
														</p>
													{/if}
													{#if latestUsageMessage}<p
															class="mt-2 truncate text-[11px] text-muted-foreground"
														>
															{latestUsageMessage.info
																.providerID}/{latestUsageMessage.info.modelID}
														</p>{/if}
												</section>
												<div class="grid grid-cols-2 gap-2">
													<div class="rounded-lg border bg-card/50 p-3">
														<p class="text-[11px] text-muted-foreground">
															Messages
														</p>
														<p class="mt-1 text-lg font-medium tabular-nums">
															{conversation?.messages.length ?? 0}
														</p>
													</div>
													<div class="rounded-lg border bg-card/50 p-3">
														<p class="text-[11px] text-muted-foreground">
															Cost
														</p>
														<p class="mt-1 text-lg font-medium tabular-nums">
															{hasProviderCost
																? `$${sessionUsage.cost.toFixed(4)}`
																: "—"}
														</p>
													</div>
												</div>
												<section class="rounded-lg border bg-card/50 p-3">
													<p class="text-xs font-medium">Session token usage</p>
													{#if hasProviderUsage}<dl
															class="mt-3 flex flex-col gap-2 text-xs"
														>
															<div class="flex justify-between gap-3">
																<dt class="text-muted-foreground">Input</dt>
																<dd class="tabular-nums">
																	{sessionUsage.input.toLocaleString()}
																</dd>
															</div>
															<div class="flex justify-between gap-3">
																<dt class="text-muted-foreground">Output</dt>
																<dd class="tabular-nums">
																	{sessionUsage.output.toLocaleString()}
																</dd>
															</div>
															<div class="flex justify-between gap-3">
																<dt class="text-muted-foreground">Reasoning</dt>
																<dd class="tabular-nums">
																	{sessionUsage.reasoning.toLocaleString()}
																</dd>
															</div>
															<div class="flex justify-between gap-3">
																<dt class="text-muted-foreground">
																	Cache read / write
																</dt>
																<dd class="tabular-nums">
																	{sessionUsage.cacheRead.toLocaleString()}
																	/ {sessionUsage.cacheWrite.toLocaleString()}
																</dd>
															</div>
														</dl>
													{:else if !sessionId}<p
															class="mt-3 text-[11px] leading-5 text-muted-foreground"
														>
															Usage totals start at 0 and fill in when the
															provider returns token metadata.
														</p>
													{:else}<p
															class="mt-3 text-[11px] leading-5 text-muted-foreground"
														>
															Provider usage details are unavailable until a
															response includes token metadata.
														</p>{/if}
												</section>
												<section class="rounded-lg border bg-card/50 p-3">
													<p class="text-xs font-medium">Context library</p>
													<p
														class="mt-1 text-[11px] leading-5 text-muted-foreground"
													>
														Manage scoped knowledge, rules, skills, and approved
														memory for this workspace.
													</p>
													<a
														class="mt-3 inline-flex h-8 items-center rounded-md border px-3 text-xs transition hover:bg-accent"
														href={settingsUrl("/settings/context", {
															projectId: selectedProjectId,
														})}>Open Context Hub</a
													>
												</section>
											</div>
										{:else if activePanel === "git"}
											{#if panelLoading && !gitOverview}<div
													class="flex items-center gap-2 py-8 text-xs text-muted-foreground"
												>
													<LoaderCircle size={14} class="animate-spin" />Reading
													repository…
												</div>
											{:else if gitOverview && !gitOverview.gitAvailable}<section
													class="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3"
												>
													<p class="text-xs font-medium text-amber-200">
														Git repository required
													</p>
													<p
														class="mt-1 text-xs leading-5 text-muted-foreground"
													>
														{gitOverview.gitMessage ??
															"Initialize Git in this project to inspect changes, commit, or sync with a remote."}
													</p>
												</section>
											{:else if gitOverview}<div class="flex flex-col gap-3">
													<section class="rounded-lg border bg-card/50 p-3">
														<p class="text-[11px] text-muted-foreground">
															Current branch
														</p>
														<p
															class="mt-1 flex items-center gap-2 break-all text-sm font-medium"
														>
															<GitBranch
																size={14}
																class="shrink-0 text-orange-300"
															/>{gitOverview.branch}
														</p>
														<p class="mt-2 text-[11px] text-muted-foreground">
															Default: {gitOverview.defaultBranch}
														</p>
													</section>
													{#if gitOverview.remoteUrl}<section
															class="rounded-lg border bg-card/50 p-3"
														>
															<p class="text-[11px] text-muted-foreground">
																Origin
															</p>
															{#if gitOverview.remoteUrl.startsWith("https://") || gitOverview.remoteUrl.startsWith("http://")}<a
																	href={gitOverview.remoteUrl}
																	target="_blank"
																	rel="noreferrer"
																	class="mt-1 block truncate text-xs text-primary underline-offset-4 hover:underline"
																	>{gitOverview.remoteUrl}</a
																>{:else}<p
																	class="mt-1 truncate font-mono text-xs text-muted-foreground"
																>
																	{gitOverview.remoteUrl}
																</p>{/if}
														</section>{:else}<section
															class="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3"
														>
															<p class="text-xs font-medium text-amber-200">
																No remote configured
															</p>
															<p
																class="mt-1 text-xs leading-5 text-muted-foreground"
															>
																You can commit locally. Add an <code
																	>origin</code
																> remote to use Commit &amp; sync or create a pull
																request.
															</p>
														</section>{/if}
													<section class="rounded-lg border bg-card/50 p-3">
														<p class="text-xs font-medium">Working tree</p>
														<p class="mt-1 text-xs text-muted-foreground">
															{gitOverview.files.length
																? `${gitOverview.files.length}${gitOverview.truncated ? "+" : ""} changed files`
																: "Clean"}
														</p>
													</section>
													{#if gitOverview.diffStat}<pre
															class="overflow-auto rounded-lg border bg-background p-3 text-[11px] leading-5 text-muted-foreground">{gitOverview.diffStat}</pre>{/if}
													<section class="rounded-lg border bg-card/50 p-3">
														<p class="text-xs font-medium">Commit changes</p>
														<p
															class="mt-1 text-[11px] leading-5 text-muted-foreground"
														>
															This includes all {gitOverview.files.length} changed
															and untracked files in the working tree.
														</p>
														<Popover.Root
															bind:open={walkthroughModelOpen}
															onOpenChange={(open) => {
																walkthroughModelOpen = open;
																if (open) {
																	walkthroughFavoriteModelIds =
																		readWalkthroughModelKeys(
																			walkthroughFavoritesKey,
																		);
																	walkthroughRecentModelIds =
																		readWalkthroughModelKeys(
																			walkthroughRecentsKey,
																		);
																} else walkthroughModelSearch = "";
															}}
														>
															<Popover.Trigger
																class="mt-3 flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-xs transition hover:bg-accent/50"
																aria-label="Commit message model"
																><span class="flex min-w-0 items-center gap-2"
																	><span class="truncate"
																		>{catalog.models.find(
																			(item) =>
																				walkthroughModelKey(item) ===
																				commitModelSelection,
																		)?.name ?? "Select model"}</span
																	>{#if catalog.models.find((item) => walkthroughModelKey(item) === commitModelSelection)}<Badge
																			variant="outline"
																			class={`model-badge model-badge--${walkthroughProviderTone(catalog.models.find((item) => walkthroughModelKey(item) === commitModelSelection)!.providerID)} shrink-0 px-1.5 text-[9px] uppercase tracking-wide`}
																			>{catalog.models.find(
																				(item) =>
																					walkthroughModelKey(item) ===
																					commitModelSelection,
																			)!.providerID}</Badge
																		>{/if}</span
																><ChevronDown
																	size={12}
																	class="shrink-0 text-muted-foreground"
																/></Popover.Trigger
															>
															<Popover.Content
																class="w-96 max-w-[calc(100vw-2rem)] p-0"
																align="end"
																><Command.Root
																	><Command.Input
																		bind:value={walkthroughModelSearch}
																		placeholder="Search models…"
																	/><Command.List class="max-h-96"
																		><Command.Empty
																			>No configured models found.</Command.Empty
																		>{#if visibleWalkthroughFavorites.length}<Command.Group
																				heading="Favorites"
																				>{#each visibleWalkthroughFavorites as item (walkthroughModelKey(item))}{@render walkthroughModelOption(
																						item,
																						"favorite",
																					)}{/each}</Command.Group
																			>{/if}{#if visibleWalkthroughRecents.length}<Command.Separator
																			/><Command.Group heading="Recent"
																				>{#each visibleWalkthroughRecents as item (walkthroughModelKey(item))}{@render walkthroughModelOption(
																						item,
																						"recent",
																					)}{/each}</Command.Group
																			>{/if}{#each walkthroughProviderGroups as group (group.id)}<Command.Separator
																			/><Command.Group heading={group.label}
																				>{#each group.models as item (walkthroughModelKey(item))}{@render walkthroughModelOption(
																						item,
																						group.id,
																					)}{/each}</Command.Group
																			>{/each}</Command.List
																	></Command.Root
																></Popover.Content
															>
														</Popover.Root>
														<div class="mt-2 flex gap-2">
															<Input
																bind:value={gitCommitMessage}
																aria-label="Commit message"
																placeholder="Commit message"
																maxlength={500}
															/><Button
																variant="outline"
																size="icon"
																title={!commitModelSelection
																	? "Choose a model"
																	: "Generate with AI"}
																aria-label="Generate commit message with AI"
																onclick={() => void generateCommitMessage()}
																disabled={!gitOverview.files.length ||
																	gitGeneratingMessage ||
																	gitBusy ||
																	!commitModelSelection}
																>{#if gitGeneratingMessage}<LoaderCircle
																		size={14}
																		class="animate-spin"
																	/>{:else}<Sparkles size={14} />{/if}</Button
															>
														</div>
														<div class="mt-2 grid grid-cols-2 gap-2">
															<Button
																variant="outline"
																size="sm"
																class="text-xs"
																onclick={() => void commitChanges(false)}
																disabled={!gitOverview.files.length ||
																	!gitCommitMessage.trim() ||
																	gitBusy ||
																	gitGeneratingMessage}
																>{gitBusy ? "Working…" : "Commit"}</Button
															><Button
																size="sm"
																class="text-xs"
																onclick={() => void commitChanges(true)}
																disabled={!gitOverview.files.length ||
																	!gitCommitMessage.trim() ||
																	gitBusy ||
																	gitGeneratingMessage ||
																	!gitOverview.remoteUrl}
																title={!gitOverview.remoteUrl
																	? "Configure an origin remote to sync"
																	: "Commit and push changes"}
																>{gitBusy
																	? "Working…"
																	: "Commit & sync"}</Button
															>
														</div>
													</section>
												</div>
											{:else if !panelLoading}<p
													class="rounded-lg border border-dashed p-4 text-xs text-muted-foreground"
												>
													Repository details are unavailable.
												</p>{/if}
										{:else if activePanel === "pull-requests"}
											{#if panelLoading && !pullRequestData}<div
													class="flex items-center gap-2 py-8 text-xs text-muted-foreground"
												>
													<LoaderCircle size={14} class="animate-spin" />Loading
													pull requests…
												</div>{:else if pullRequestData?.available}<form
													class="mb-3 space-y-2 rounded-lg border bg-card/50 p-3"
													onsubmit={(event) => {
														event.preventDefault();
														void createPullRequest();
													}}
												>
													<p class="text-xs font-medium">Create pull request</p>
													{#if createdPullRequestUrl}<a
															href={createdPullRequestUrl}
															target="_blank"
															rel="noreferrer"
															class="block text-xs text-primary underline"
															>Open the pull request that was just created</a
														>{/if}<Input
														bind:value={pullRequestTitle}
														aria-label="Pull request title"
														placeholder="Title"
														maxlength={256}
													/><Select.Root
														type="single"
														value={pullRequestBase || "__default"}
														onValueChange={(value) =>
															(pullRequestBase =
																value === "__default" ? "" : value)}
														><Select.Trigger
															class="w-full"
															aria-label="Base branch"
															><Select.Value
																placeholder="Choose a base branch"
															/></Select.Trigger
														><Select.Content
															><Select.Item value="__default"
																>Default branch · {gitOverview?.defaultBranch ||
																	"default"}</Select.Item
															>{#each [...new Set([...(gitOverview?.branches ?? []), gitOverview?.branch ?? ""].filter(Boolean))] as branch (branch)}{#if branch !== gitOverview?.defaultBranch}<Select.Item
																		value={branch}>{branch}</Select.Item
																	>{/if}{/each}</Select.Content
														></Select.Root
													><Textarea
														bind:value={pullRequestBody}
														aria-label="Pull request description"
														placeholder="What changed and why?"
														class="min-h-24 resize-y text-xs"
													/><label
														class="flex items-center gap-2 text-xs text-muted-foreground"
														><Checkbox.Root
															bind:checked={pullRequestDraft}
															aria-label="Draft pull request"
														/>Draft</label
													><Button
														type="submit"
														size="sm"
														class="w-full"
														disabled={!pullRequestTitle.trim() ||
															pullRequestBusy}
														>{pullRequestBusy
															? "Creating…"
															: "Create pull request"}</Button
													>
												</form>
												{#if pullRequestData.pullRequests.length}<div
														class="flex flex-col gap-2"
													>
														{#each pullRequestData.pullRequests as pr (pr.number)}<a
																href={pr.url}
																target="_blank"
																rel="noreferrer"
																class="block rounded-lg border bg-card/50 p-3 transition hover:border-primary/40 hover:bg-accent/30"
																><div class="flex items-center gap-2">
																	<Badge variant="outline" class="shrink-0"
																		>#{pr.number}</Badge
																	><span
																		class="truncate text-[11px] text-muted-foreground"
																		>{pr.state}</span
																	>
																</div>
																<p class="mt-2 text-sm font-medium leading-5">
																	{pr.title}
																</p>
																<p
																	class="mt-1 truncate font-mono text-[10px] text-muted-foreground"
																>
																	{pr.headRefName}
																</p></a
															>{/each}
													</div>{:else}<p
														class="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground"
													>
														No open pull requests found for this repository.
													</p>{/if}{:else if pullRequestData?.message}<section
													class="flex flex-col gap-3 rounded-lg border border-dashed p-4"
												>
													<GitPullRequest
														size={17}
														class="text-muted-foreground"
													/>
													<p class="text-xs leading-5 text-muted-foreground">
														{pullRequestData.message}
													</p>
													<p
														class="text-[11px] leading-5 text-muted-foreground"
													>
														Install and authenticate GitHub CLI with <code
															class="rounded bg-muted px-1 py-0.5"
															>gh auth login</code
														> to load or create pull requests.
													</p>
												</section>{/if}
										{:else if activePanel === "walkthrough"}
											<div class="flex min-h-full flex-col gap-3">
												{#if panelLoading && !walkthroughSnapshot}<div
														role="status"
														class="flex items-center gap-2 py-8 text-xs text-muted-foreground"
													>
														<LoaderCircle
															size={14}
															class="animate-spin"
														/>Capturing repository changes…
													</div>{/if}
												{#if walkthroughError}<p
														role="alert"
														class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
													>
														{walkthroughError}
													</p>{/if}
												<div
													class="flex flex-wrap items-center gap-2 rounded-lg border bg-card/50 p-2"
												>
													<Badge variant="outline" class="gap-1"
														><FileDiffIcon size={12} />{walkthroughSnapshot
															?.files.length ?? 0}
														uncommitted files</Badge
													><span class="text-[10px] text-muted-foreground"
														>Unchanged project files are not included.</span
													>
													<Select.Root
														type="single"
														bind:value={walkthroughLanguage}
													>
														<Select.Trigger
															class="h-8 w-auto min-w-[130px] gap-2 border-0 bg-transparent px-2 text-xs shadow-none"
															aria-label="Walkthrough language"
															>{walkthroughLanguage === "en"
																? "English"
																: "Bahasa Indonesia"}</Select.Trigger
														>
														<Select.Content
															><Select.Item value="en">English</Select.Item
															><Select.Item value="id"
																>Bahasa Indonesia</Select.Item
															></Select.Content
														>
													</Select.Root>
													<Popover.Root
														bind:open={walkthroughModelOpen}
														onOpenChange={(open) => {
															walkthroughModelOpen = open;
															if (open) {
																walkthroughFavoriteModelIds =
																	readWalkthroughModelKeys(
																		walkthroughFavoritesKey,
																	);
																walkthroughRecentModelIds =
																	readWalkthroughModelKeys(
																		walkthroughRecentsKey,
																	);
															} else walkthroughModelSearch = "";
														}}
													>
														<Popover.Trigger
															class="flex h-8 min-w-[160px] max-w-[260px] flex-1 items-center justify-between gap-2 rounded-md px-2 text-xs transition hover:bg-accent/50"
															aria-label="Walkthrough model"
															><span class="truncate"
																>{catalog.models.find(
																	(item) =>
																		`${item.providerID}/${item.modelID}` ===
																		model,
																)?.name ?? "Select chat model"}</span
															><ChevronDown
																size={12}
																class="shrink-0 text-muted-foreground"
															/></Popover.Trigger
														>
														<Popover.Content
															class="w-96 max-w-[calc(100vw-2rem)] p-0"
															align="end"
														>
															<Command.Root>
																<Command.Input
																	bind:value={walkthroughModelSearch}
																	placeholder="Search models…"
																/>
																<Command.List class="max-h-96"
																	><Command.Empty
																		>No configured models found.</Command.Empty
																	>
																	{#if visibleWalkthroughFavorites.length}<Command.Group
																			heading="Favorites"
																			>{#each visibleWalkthroughFavorites as item (walkthroughModelKey(item))}{@render walkthroughModelOption(
																					item,
																					"favorite",
																				)}{/each}</Command.Group
																		>{/if}
																	{#if visibleWalkthroughRecents.length}<Command.Separator
																		/><Command.Group heading="Recent"
																			>{#each visibleWalkthroughRecents as item (walkthroughModelKey(item))}{@render walkthroughModelOption(
																					item,
																					"recent",
																				)}{/each}</Command.Group
																		>{/if}
																	{#each walkthroughProviderGroups as group (group.id)}<Command.Separator
																		/><Command.Group heading={group.label}
																			>{#each group.models as item (walkthroughModelKey(item))}{@render walkthroughModelOption(
																					item,
																					group.id,
																				)}{/each}</Command.Group
																		>{/each}
																</Command.List>
															</Command.Root>
														</Popover.Content>
													</Popover.Root>
													{#if walkthroughDocument}<Button
															variant="outline"
															size="icon"
															class="size-8"
															aria-label="Previous walkthrough step"
															title="Previous step"
															onclick={() => moveWalkthroughStep(-1)}
															disabled={walkthroughSteps.findIndex(
																(step) =>
																	step.id === selectedWalkthroughStep?.id,
															) <= 0}
															><ChevronDown
																size={14}
																class="rotate-90"
															/></Button
														><Button
															variant="outline"
															size="icon"
															class="size-8"
															aria-label="Next walkthrough step"
															title="Next step"
															onclick={() => moveWalkthroughStep(1)}
															disabled={walkthroughSteps.findIndex(
																(step) =>
																	step.id === selectedWalkthroughStep?.id,
															) >=
																walkthroughSteps.length - 1}
															><ChevronDown
																size={14}
																class="-rotate-90"
															/></Button
														>{/if}
													<Button
														variant="outline"
														size="sm"
														class="h-8 gap-1.5 text-xs"
														onclick={() => void generateWalkthrough()}
														disabled={!model ||
															walkthroughGenerating ||
															!selectedProjectId}
														><RefreshCw
															size={13}
															class={walkthroughGenerating
																? "animate-spin"
																: ""}
														/>{walkthroughGenerating
															? "Generating…"
															: walkthroughDocument
																? "Regenerate"
																: "Generate"}</Button
													>
												</div>
												{#if walkthroughSnapshot?.coverage.truncated || (walkthroughSnapshot?.coverage.excludedFiles ?? 0) > 0 || (walkthroughSnapshot?.coverage.omittedFiles ?? 0) > 0}<p
														class="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-100/75"
													>
														Partial snapshot: {walkthroughSnapshot?.coverage
															.excludedFiles} sensitive or ignored files excluded{walkthroughSnapshot
															?.coverage.omittedFiles
															? `, ${walkthroughSnapshot.coverage.omittedFiles} files beyond the limit`
															: ""}{walkthroughSnapshot?.coverage.message
															? `. ${walkthroughSnapshot.coverage.message}`
															: ""}
													</p>{/if}
												{#if walkthroughStale}<p
														role="status"
														class="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-100/75"
													>
														Files changed since this walkthrough was generated.
														Refresh the snapshot or regenerate.
													</p>{/if}
												{#if walkthroughDocument?.limitations.length}<section
														class="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3"
													>
														<h3 class="text-xs font-semibold text-amber-200">
															Coverage limitations
														</h3>
														<ul
															class="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-amber-100/75"
														>
															{#each walkthroughDocument.limitations as limitation}<li
																>
																	{limitation}
																</li>{/each}
														</ul>
													</section>{/if}
												<p class="text-[10px] leading-4 text-muted-foreground">
													Generating sends the bounded text diff snapshot to the
													selected model with read-only permissions. Sensitive
													filenames and binary files are excluded.
												</p>
												{#if !selectedProjectId}<p
														class="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground"
													>
														Choose a project to review uncommitted changes.
													</p>
												{:else if !walkthroughSnapshot && !panelLoading}<p
														class="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground"
													>
														Choose Walkthrough to capture this project’s
														changes.
													</p>
												{:else if walkthroughSnapshot && !walkthroughSnapshot.files.length}<div
														class="rounded-lg border border-dashed p-7 text-center"
													>
														<ListTree
															size={20}
															class="mx-auto text-muted-foreground"
														/>
														<p class="mt-2 text-sm font-medium">
															No uncommitted changes
														</p>
														<p class="mt-1 text-xs text-muted-foreground">
															There are no changed text files to explain yet.
														</p>
													</div>
												{:else if walkthroughSnapshot}<div
														class="grid min-h-[420px] flex-1 grid-cols-1 md:grid-cols-[minmax(160px,220px)_minmax(0,1fr)] overflow-hidden rounded-xl border bg-background/50"
													>
														<nav
															class="nice-scroll overflow-y-auto border-b md:border-b-0 md:border-r p-2 max-md:max-h-44"
															aria-label="Walkthrough steps"
														>
															{#if walkthroughDocument}
																<div class="mb-3 px-2 pt-1">
																	<p
																		class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
																	>
																		{walkthroughDocument.groups.reduce(
																			(total, group) =>
																				total + group.steps.length,
																			0,
																		)} steps
																	</p>
																</div>
																{#each walkthroughDocument.groups as group (group.id)}<section
																		class="mb-3"
																	>
																		<p
																			class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
																		>
																			{group.title}
																		</p>
																		{#each group.steps as step, index (`${group.id}:${step.id}`)}<Button
																				variant="ghost"
																				class={`mb-1 h-auto w-full justify-start gap-2 whitespace-normal px-2 py-2 text-left ${selectedWalkthroughStep?.id === step.id ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
																				onclick={() =>
																					(walkthroughStepId = step.id)}
																				><span
																					class="grid size-5 shrink-0 place-items-center rounded-full border text-[10px]"
																					>{index + 1}</span
																				><span
																					class="line-clamp-2 min-w-0 text-xs leading-4"
																					>{step.title}</span
																				></Button
																			>{/each}
																	</section>{/each}
															{:else}<div class="mb-2 px-2 pt-1">
																	<p
																		class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
																	>
																		Changed files
																	</p>
																</div>
																{#each walkthroughSnapshot.files as item (item.id)}<Button
																		variant="ghost"
																		class="h-auto w-full justify-start gap-2 px-2 py-2 text-left text-xs"
																		onclick={() => {
																			walkthroughStepId = item.id;
																		}}
																		><FileCode
																			size={13}
																			class="shrink-0"
																		/><span class="min-w-0 truncate font-mono"
																			>{item.file}</span
																		></Button
																	>{/each}{/if}
														</nav>
														<div
															class="nice-scroll min-w-0 overflow-y-auto p-4 sm:p-5"
														>
															{#if walkthroughDocument && selectedWalkthroughStep}
																<section
																	class="mb-5 rounded-lg border bg-card/50 p-3"
																>
																	<p
																		class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
																	>
																		Overview
																	</p>
																	<p
																		class="mt-1 text-xs leading-5 text-muted-foreground"
																	>
																		{walkthroughDocument.summary}
																	</p>
																</section>
																<p
																	class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-primary"
																>
																	{selectedWalkthroughStep.groupTitle}
																</p>
																<h2 class="text-lg font-semibold leading-6">
																	{selectedWalkthroughStep.title}
																</h2>
																<p
																	class="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground"
																>
																	{selectedWalkthroughStep.explanation}
																</p>
																{#if selectedWalkthroughStep.observations.length}<section
																		class="mt-5"
																	>
																		<h3 class="text-xs font-semibold">
																			What the change does
																		</h3>
																		<ul
																			class="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground"
																		>
																			{#each selectedWalkthroughStep.observations as observation}<li
																				>
																					{observation}
																				</li>{/each}
																		</ul>
																	</section>{/if}
																{#if selectedWalkthroughStep.cautions.length}<section
																		class="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3"
																	>
																		<h3
																			class="flex items-center gap-1.5 text-xs font-semibold text-amber-200"
																		>
																			<TriangleAlert size={13} />Cautions
																		</h3>
																		<ul
																			class="mt-2 space-y-2 text-xs leading-5 text-amber-100/75"
																		>
																			{#each selectedWalkthroughStep.cautions as caution}<li
																				>
																					<Badge
																						variant="outline"
																						class="mr-1.5 text-[9px] uppercase"
																						>{caution.kind}</Badge
																					>{caution.message}
																				</li>{/each}
																		</ul>
																	</section>{/if}
																{#each walkthroughEvidence as item (item.id)}<section
																		class="mt-5 overflow-hidden rounded-lg border"
																	>
																		<div
																			class="flex items-center gap-2 border-b bg-card/70 px-3 py-2"
																		>
																			<FileCode
																				size={13}
																				class="shrink-0 text-primary"
																			/><span
																				class="min-w-0 flex-1 truncate font-mono text-[11px]"
																				title={item.file}>{item.file}</span
																			><Badge
																				variant="outline"
																				class="font-mono text-[9px]"
																				>{item.status}</Badge
																			>{#if item.truncated}<Badge
																					variant="secondary"
																					class="text-[9px]">Partial</Badge
																				>{/if}
																		</div>
																		<pre
																			class="nice-scroll max-h-[420px] overflow-auto bg-background py-2 text-[10px] leading-[1.45rem]">{#each item.patch.split("\n") as line}<div
																					class={`min-h-6 whitespace-pre px-3 ${line.startsWith("+") ? "bg-emerald-500/10 text-emerald-300" : line.startsWith("-") ? "bg-red-500/10 text-red-300" : line.startsWith("@@") ? "bg-blue-500/10 text-blue-300" : "text-muted-foreground"}`}>{line ||
																						" "}</div>{/each}</pre>
																	</section>{/each}
															{:else if walkthroughDocument}<h2
																	class="text-lg font-semibold"
																>
																	{walkthroughDocument.title}
																</h2>
																<p
																	class="mt-2 text-sm leading-6 text-muted-foreground"
																>
																	{walkthroughDocument.summary}
																</p>
																<p class="mt-5 text-xs text-muted-foreground">
																	Select a step to inspect its evidence.
																</p>
															{:else}<div
																	class="rounded-lg border border-dashed p-6 text-center"
																>
																	<FileDiffIcon
																		size={18}
																		class="mx-auto text-muted-foreground"
																	/>
																	<h2 class="mt-2 text-sm font-medium">
																		Snapshot ready
																	</h2>
																	<p
																		class="mt-1 text-xs leading-5 text-muted-foreground"
																	>
																		Select the same model as Chat and generate a
																		guided explanation. The diff remains
																		available here even if generation fails.
																	</p>
																</div>
																{#each walkthroughSnapshot.files as item (item.id)}<section
																		class="mt-3 overflow-hidden rounded-lg border"
																	>
																		<div
																			class="flex items-center gap-2 border-b bg-card/70 px-3 py-2"
																		>
																			<FileCode size={13} /><span
																				class="min-w-0 flex-1 truncate font-mono text-[11px]"
																				>{item.file}</span
																			><Badge
																				variant="outline"
																				class="font-mono text-[9px]"
																				>{item.status}</Badge
																			>
																		</div>
																		<pre
																			class="nice-scroll max-h-64 overflow-auto bg-background py-2 text-[10px] leading-[1.4rem]">{#each item.patch.split("\n") as line}<div
																					class={`whitespace-pre px-3 ${line.startsWith("+") ? "bg-emerald-500/10 text-emerald-300" : line.startsWith("-") ? "bg-red-500/10 text-red-300" : "text-muted-foreground"}`}>{line ||
																						" "}</div>{/each}</pre>
																	</section>{/each}{/if}
														</div>
													</div>{/if}
											</div>
										{:else}
											<section>
												<div class="mb-3 flex items-center justify-between">
													<p class="text-xs font-medium">Session changes</p>
													<Badge variant="outline">{diffs.length}</Badge>
												</div>
												<p
													class="-mt-1 mb-3 text-[10px] leading-4 text-muted-foreground"
												>
													Files changed by this chat. Git shows all changes in
													the workspace.
												</p>
												{#if panelLoading && !diffs.length}<div
														class="flex items-center gap-2 py-8 text-xs text-muted-foreground"
													>
														<LoaderCircle
															size={14}
															class="animate-spin"
														/>Loading changes…
													</div>
												{:else if !sessionId}<p
														class="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground"
													>
														Start a chat to see its file changes.
													</p>
												{:else if !diffs.length}<p
														class="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground"
													>
														No file changes in this session yet.
													</p>
												{:else}<div class="flex flex-col gap-1">
														{#each diffs as diff (diff.file)}<Button
																variant="ghost"
																class="h-auto min-w-0 justify-start gap-2 px-2 py-2"
																onclick={() => void showFiles(diff.file)}
																><FileCode size={14} /><span
																	class="min-w-0 flex-1 truncate text-left font-mono text-[11px]"
																	title={diff.file}>{diff.file}</span
																><span
																	class="shrink-0 text-[10px] text-emerald-400"
																	>+{diff.additions}</span
																><span class="shrink-0 text-[10px] text-red-400"
																	>−{diff.deletions}</span
																></Button
															>{/each}
													</div>{/if}
											</section>
										{/if}
									</div>
								{/if}
							</aside>
						</Resizable.Pane>
					{/if}
					<nav
						class="flex w-11 shrink-0 flex-col items-center gap-1 border-l bg-card/20 py-2"
						aria-label="Chat tools"
					>
						{#each visibleChatPanels as panel (panel.id)}
							{@const PanelIcon = panel.icon}
							<Button
								variant="ghost"
								size="icon"
								class={`relative size-9 ${activePanel === panel.id ? "bg-accent text-primary" : "text-muted-foreground"}`}
								aria-label={panel.label}
								title={panel.id === "agents" && monitorRunningCount
									? `${panel.label} · ${monitorRunningCount} running`
									: panel.label}
								aria-pressed={activePanel === panel.id}
								onclick={() => openRegisteredPanel(panel.id)}
								><PanelIcon
									size={16}
								/>{#if panel.id === "agents" && monitorRunningCount}<span
										class="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-emerald-400"
										aria-hidden="true"
									></span>{/if}</Button
							>
						{/each}
						<div class="mt-auto border-t border-white/10 pt-1">
							<Button
								variant="ghost"
								size="icon"
								class="size-9 text-muted-foreground"
								aria-label="Configure panels"
								title="Configure panels"
								onclick={() => (configurePanelsOpen = true)}
								><SlidersHorizontal size={16} /></Button
							>
						</div>
					</nav>
				</Resizable.PaneGroup>
			{/if}
		</main>
	</Resizable.Pane>
</Resizable.PaneGroup>
<Dialog.Root bind:open={configurePanelsOpen}>
	<Dialog.Content
		class="flex max-h-[min(80svh,560px)] flex-col overflow-hidden sm:max-w-lg"
	>
		<Dialog.Header>
			<Dialog.Title>Configure panels</Dialog.Title>
			<Dialog.Description
				>Choose which panels appear in the sidebar. Hidden panels keep their
				data and any work in progress.</Dialog.Description
			>
		</Dialog.Header>
		<div
			class="nice-scroll min-h-0 space-y-1 overflow-y-auto pr-1"
			aria-label="Available sidebar panels"
		>
			{#each availableChatPanels.filter((panel) => panel.configurable) as panel (panel.id)}
				{@const PanelIcon = panel.icon}
				<label
					class="flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 transition hover:border-border hover:bg-accent/40 focus-within:ring-2 focus-within:ring-ring"
				>
					<Checkbox.Root
						checked={isChatPanelVisible(panel, panelPreferences)}
						onCheckedChange={(checked) =>
							setRailPanelVisibility(panel.id, checked === true)}
						aria-label={`Show ${panel.label} in the sidebar`}
					/>
					<PanelIcon size={16} class="shrink-0 text-muted-foreground" />
					<span class="min-w-0 flex-1 text-sm">{panel.label}</span>
				</label>
			{/each}
		</div>
		{#if panelPreferencesSaveError}
			<div
				class="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5"
				role="status"
				aria-live="polite"
			>
				<p class="min-w-0 flex-1 text-xs leading-5 text-amber-100/80">
					Your panel choices are active for this session, but could not be saved
					on this device.
				</p>
				<Button
					variant="outline"
					size="sm"
					class="h-7"
					onclick={saveRailPanelPreferences}>Retry</Button
				>
			</div>
		{/if}
		<Dialog.Footer class="flex-row justify-between">
			<Button variant="ghost" size="sm" onclick={resetRailPanelPreferences}
				>Reset to defaults</Button
			>
			<Dialog.Close class={buttonVariants({ variant: "outline", size: "sm" })}
				>Close</Dialog.Close
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
<Dialog.Root bind:open={addProjectOpen}
	><Dialog.Content class="sm:max-w-2xl"
		><Dialog.Header
			><Dialog.Title>Add project directory</Dialog.Title><Dialog.Description
				>Choose a folder on the machine running Loom’s local daemon.</Dialog.Description
			></Dialog.Header
		><AddProjectForm
			oncreated={() => {
				addProjectOpen = false;
				void retryConnection();
			}}
		/></Dialog.Content
	></Dialog.Root
>
<Dialog.Root bind:open={worktreeDialogOpen}
	><Dialog.Content
		><Dialog.Header
			><Dialog.Title>Create worktree</Dialog.Title><Dialog.Description
				>Create an isolated checkout on a new branch, then use it as this
				project’s active workspace.</Dialog.Description
			></Dialog.Header
		>
		<form
			class="space-y-4"
			onsubmit={(event) => {
				event.preventDefault();
				void createProjectWorktree();
			}}
		>
			<Input
				bind:value={worktreeBranchName}
				aria-label="New branch name"
				placeholder="feature/my-change"
				maxlength={240}
			/><Dialog.Footer
				><Dialog.Close class={buttonVariants({ variant: "outline" })}
					>Cancel</Dialog.Close
				><Button
					type="submit"
					disabled={!worktreeBranchName.trim() || worktreeCreating}
					>{worktreeCreating ? "Creating…" : "Create worktree"}</Button
				></Dialog.Footer
			>
		</form></Dialog.Content
	></Dialog.Root
>
<Dialog.Root bind:open={renameOpen}
	><Dialog.Content
		><Dialog.Header
			><Dialog.Title>Rename session</Dialog.Title><Dialog.Description
				>Choose a title you can find in the sidebar.</Dialog.Description
			></Dialog.Header
		>
		<form
			class="space-y-4"
			onsubmit={(event) => {
				event.preventDefault();
				void rename();
			}}
		>
			<Input
				aria-label="Session title"
				bind:value={renameTitle}
				maxlength={200}
			/><Dialog.Footer
				><Button type="submit" disabled={!renameTitle.trim()}>Save title</Button
				></Dialog.Footer
			>
		</form></Dialog.Content
	></Dialog.Root
>
<Dialog.Root bind:open={projectRenameOpen}
	><Dialog.Content
		><Dialog.Header
			><Dialog.Title>Edit project name</Dialog.Title><Dialog.Description
				>This only changes how the workspace is named in Loom.</Dialog.Description
			></Dialog.Header
		>
		<form
			class="space-y-4"
			onsubmit={(event) => {
				event.preventDefault();
				void renameProject();
			}}
		>
			<Input
				aria-label="Project name"
				bind:value={projectRenameName}
				maxlength={120}
			/><Dialog.Footer
				><Dialog.Close class={buttonVariants({ variant: "outline" })}
					>Cancel</Dialog.Close
				><Button type="submit" disabled={!projectRenameName.trim()}
					>Save changes</Button
				></Dialog.Footer
			>
		</form></Dialog.Content
	></Dialog.Root
>
<AlertDialog.Root bind:open={projectDeleteOpen}
	><AlertDialog.Content
		><AlertDialog.Header
			><AlertDialog.Title>Delete project from Loom?</AlertDialog.Title
			><AlertDialog.Description
				>“{projectDeleteTarget?.name}” will be removed from Loom’s workspace
				list. Its folder and files on disk will stay untouched.</AlertDialog.Description
			></AlertDialog.Header
		><AlertDialog.Footer
			><AlertDialog.Cancel>Cancel</AlertDialog.Cancel><AlertDialog.Action
				onclick={() => void removeProject()}>Delete project</AlertDialog.Action
			></AlertDialog.Footer
		></AlertDialog.Content
	></AlertDialog.Root
>
<AlertDialog.Root bind:open={deleteSessionOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete session?</AlertDialog.Title>
			<AlertDialog.Description
				>“{deleteTarget?.title}” and its OpenCode history will be removed
				permanently.</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => void removeSession()}
				>Delete session</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
<Dialog.Root bind:open={aboutOpen}
	><Dialog.Content
		><Dialog.Header
			><Dialog.Title>About Loom</Dialog.Title><Dialog.Description
				>Your local workspace for conversations with OpenCode.</Dialog.Description
			></Dialog.Header
		>
		<p class="text-sm leading-6 text-muted-foreground">
			Chats are saved in OpenCode. Use @ to attach project files or agents. The
			Changes panel shows file edits; task worktrees are available from the
			sidebar.
		</p>
		<Badge variant="outline"
			>{connected ? "OpenCode connected" : "Connection unavailable"}</Badge
		></Dialog.Content
	></Dialog.Root
>
<Dialog.Root bind:open={fileOpen}
	><Dialog.Content
		class="flex h-[min(85svh,56rem)] max-h-[85svh] min-h-0 flex-col overflow-hidden sm:max-w-5xl"
		><Dialog.Header class="shrink-0"
			><Dialog.Title class="truncate pr-8"
				>{fileName || "Session changes"}</Dialog.Title
			><Dialog.Description
				>{fileName
					? "Inspect file content and changes made in this session."
					: `${diffs.length} changed files in this session.`}</Dialog.Description
			></Dialog.Header
		>
		{#if fileLoading}<p
				class="min-h-0 flex-1 py-6 text-sm text-muted-foreground"
			>
				Loading file…
			</p>{:else if fileError}<p
				role="alert"
				class="min-h-0 flex-1 overflow-auto text-sm text-destructive"
			>
				{fileError}
			</p>{:else if !fileName}<ScrollArea.Root
				class="min-h-0 flex-1 rounded-lg border"
				orientation="vertical"
				><div class="p-1">
					{#each diffs as diff}<Button
							variant="ghost"
							class="h-auto w-full justify-start py-3"
							onclick={() => showFiles(diff.file)}
							><FileCode size={15} /><span
								class="min-w-0 flex-1 truncate text-left">{diff.file}</span
							><span class="text-xs text-emerald-400">+{diff.additions}</span
							><span class="text-xs text-red-400">−{diff.deletions}</span
							></Button
						>{/each}{#if !diffs.length}<p
							class="py-8 text-center text-sm text-muted-foreground"
						>
							No file changes in this session yet.
						</p>{/if}
				</div></ScrollArea.Root
			>
		{:else}<Tabs.Root
				bind:value={fileTab}
				class="flex min-h-0 flex-1 flex-col overflow-hidden"
				><Tabs.List class="shrink-0"
					><Tabs.Trigger value="changes" disabled={!selectedDiff}
						>Changes</Tabs.Trigger
					><Tabs.Trigger value="content">File content</Tabs.Trigger></Tabs.List
				><Tabs.Content value="changes" class="min-h-0 flex-1 overflow-hidden"
					>{#if selectedDiff?.patch}<ScrollArea.Root
							class="h-full min-h-0 rounded-lg border bg-background"
							orientation="both"
							><pre
								class="min-w-fit py-3 text-xs leading-6">{#each selectedDiff.patch.split("\n") as line}<div
										class={`min-h-6 px-4 ${line.startsWith("+") ? "bg-emerald-500/10 text-emerald-300" : line.startsWith("-") ? "bg-red-500/10 text-red-300" : line.startsWith("@@") ? "bg-blue-500/10 text-blue-300" : "text-muted-foreground"}`}>{line ||
											" "}</div>{/each}</pre></ScrollArea.Root
						>{:else if selectedDiff}<ScrollArea.Root
							class="h-full min-h-0 rounded-lg border"
							orientation="both"
							><div class="grid min-w-[640px] grid-cols-2 divide-x">
								<div>
									<p
										class="sticky top-0 border-b bg-card p-2 text-xs text-red-300"
									>
										Before · −{selectedDiff.deletions}
									</p>
									<pre
										class="bg-red-500/5 p-3 text-xs leading-6">{selectedDiff.before ||
											"(empty)"}</pre>
								</div>
								<div>
									<p
										class="sticky top-0 border-b bg-card p-2 text-xs text-emerald-300"
									>
										After · +{selectedDiff.additions}
									</p>
									<pre
										class="bg-emerald-500/5 p-3 text-xs leading-6">{selectedDiff.after ||
											"(empty)"}</pre>
								</div>
							</div></ScrollArea.Root
						>{/if}</Tabs.Content
				><Tabs.Content value="content" class="min-h-0 flex-1 overflow-hidden"
					><ScrollArea.Root class="h-full min-h-0 rounded-lg" orientation="both"
						><CodeBlock
							code={fileContent || "(empty file)"}
							language={fileName}
							maxHeight="max-h-none"
							scrollable={false}
						/></ScrollArea.Root
					></Tabs.Content
				></Tabs.Root
			><Dialog.Footer class="shrink-0"
				><Button
					variant="outline"
					onclick={() => {
						fileName = "";
						fileContent = "";
					}}>All changes</Button
				><Button
					onclick={() => {
						draft = `Please update @${fileName}: `;
						fileOpen = false;
					}}>Discuss this file</Button
				></Dialog.Footer
			>{/if}
	</Dialog.Content></Dialog.Root
>
