import type { LucideIcon } from "@lucide/svelte";
import {
	Bot,
	FileDiff,
	FolderOpen,
	Gauge,
	GitBranch,
	GitPullRequest,
	ListTree,
	Server,
	SquareTerminal,
} from "@lucide/svelte";

export type ChatPanelId =
	| "files"
	| "context"
	| "git"
	| "pull-requests"
	| "changes"
	| "walkthrough"
	| "terminal"
	| "agents"
	| "ssh";

export type ChatPanelContext = {
	projectId: string;
	openPanel: (panel: ChatPanelId) => void;
};

export type ChatPanelDefinition = {
	id: ChatPanelId;
	label: string;
	icon: LucideIcon;
	defaultVisible: boolean;
	configurable: boolean;
	isAvailable: (context: Pick<ChatPanelContext, "projectId">) => boolean;
	open: (context: ChatPanelContext) => void;
};

const needsProject = ({ projectId }: Pick<ChatPanelContext, "projectId">) =>
	Boolean(projectId);

export const chatPanelRegistry: readonly ChatPanelDefinition[] = [
	{
		id: "files",
		label: "Project files",
		icon: FolderOpen,
		defaultVisible: true,
		configurable: true,
		isAvailable: needsProject,
		open: ({ openPanel }) => openPanel("files"),
	},
	{
		id: "context",
		label: "Context usage",
		icon: Gauge,
		defaultVisible: true,
		configurable: true,
		isAvailable: () => true,
		open: ({ openPanel }) => openPanel("context"),
	},
	{
		id: "git",
		label: "Git status",
		icon: GitBranch,
		defaultVisible: true,
		configurable: true,
		isAvailable: needsProject,
		open: ({ openPanel }) => openPanel("git"),
	},
	{
		id: "pull-requests",
		label: "Pull requests",
		icon: GitPullRequest,
		defaultVisible: true,
		configurable: true,
		isAvailable: needsProject,
		open: ({ openPanel }) => openPanel("pull-requests"),
	},
	{
		id: "changes",
		label: "Changed files",
		icon: FileDiff,
		defaultVisible: true,
		configurable: true,
		isAvailable: () => true,
		open: ({ openPanel }) => openPanel("changes"),
	},
	{
		id: "walkthrough",
		label: "Walkthrough",
		icon: ListTree,
		defaultVisible: true,
		configurable: true,
		isAvailable: needsProject,
		open: ({ openPanel }) => openPanel("walkthrough"),
	},
	{
		id: "terminal",
		label: "Terminal",
		icon: SquareTerminal,
		defaultVisible: true,
		configurable: true,
		isAvailable: needsProject,
		open: ({ openPanel }) => openPanel("terminal"),
	},
	{
		id: "agents",
		label: "Agents & tasks",
		icon: Bot,
		defaultVisible: true,
		configurable: true,
		isAvailable: () => true,
		open: ({ openPanel }) => openPanel("agents"),
	},
	{
		id: "ssh",
		label: "SSH connections",
		icon: Server,
		defaultVisible: true,
		configurable: true,
		isAvailable: () => true,
		open: ({ openPanel }) => openPanel("ssh"),
	},
];

export type RailPanelPreferences = {
	version: 1;
	visibilityOverrides: Partial<Record<ChatPanelId, boolean>>;
};

export const railPanelPreferencesKey = "loom.chat.railPanelPreferences";

export function defaultRailPanelPreferences(): RailPanelPreferences {
	return { version: 1, visibilityOverrides: {} };
}

export function parseRailPanelPreferences(
	raw: string | null,
): RailPanelPreferences {
	if (!raw) return defaultRailPanelPreferences();
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!value ||
			typeof value !== "object" ||
			(value as { version?: unknown }).version !== 1
		)
			return defaultRailPanelPreferences();
		const input = (value as { visibilityOverrides?: unknown })
			.visibilityOverrides;
		if (!input || typeof input !== "object" || Array.isArray(input))
			return defaultRailPanelPreferences();
		const visibilityOverrides: RailPanelPreferences["visibilityOverrides"] = {};
		for (const panel of chatPanelRegistry) {
			if (!panel.configurable) continue;
			const visible = (input as Record<string, unknown>)[panel.id];
			if (typeof visible === "boolean") visibilityOverrides[panel.id] = visible;
		}
		return { version: 1, visibilityOverrides };
	} catch {
		return defaultRailPanelPreferences();
	}
}

export function isChatPanelVisible(
	panel: ChatPanelDefinition,
	preferences: RailPanelPreferences,
) {
	if (!panel.configurable) return panel.defaultVisible;
	return preferences.visibilityOverrides[panel.id] ?? panel.defaultVisible;
}

export function withChatPanelVisibility(
	preferences: RailPanelPreferences,
	panel: ChatPanelDefinition,
	visible: boolean,
): RailPanelPreferences {
	if (!panel.configurable) return preferences;
	const visibilityOverrides = { ...preferences.visibilityOverrides };
	if (visible === panel.defaultVisible) delete visibilityOverrides[panel.id];
	else visibilityOverrides[panel.id] = visible;
	return { version: 1, visibilityOverrides };
}
