<script lang="ts">
import { Columns2, Columns3, X } from "@lucide/svelte";
import { untrack } from "svelte";
import type { Catalog, ChatSession } from "$lib/chat";
import { Button } from "$lib/components/ui/button";
import type { Project } from "$lib/daemon";
import SplitChatPane from "./SplitChatPane.svelte";

let {
	project,
	catalog,
	customAgents,
	primarySessionId,
	primaryModel,
	primaryAgent,
	primaryCustomAgentId,
	primaryDraft,
	onfile,
	onopenfile,
	onSession,
	onclose,
}: {
	project: Project | undefined;
	catalog: Catalog;
	customAgents: Array<{
		id: string;
		label: string;
		allowChat: boolean;
		status: string;
		provider: string;
		modelId: string | null;
	}>;
	primarySessionId: string;
	primaryModel: string;
	primaryAgent: string;
	primaryCustomAgentId: string;
	primaryDraft: string;
	onfile: (path: string) => void;
	onopenfile?: (path: string) => void;
	onSession: (session: ChatSession, projectId: string) => void;
	onclose: (state: {
		sessionId: string;
		projectId: string;
		model: string;
		agent: string;
		customAgentId: string;
		draft: string;
		title: string;
	}) => void;
} = $props();

let layout = $state<"columns" | "rows">("columns");
let leftState = $state(
	untrack(() => ({
		sessionId: primarySessionId,
		model: primaryModel,
		agent: primaryAgent,
		customAgentId: primaryCustomAgentId,
		draft: primaryDraft,
		title: "New chat",
		projectId: project?.id ?? "",
	})),
);
let rightState = $state(
	untrack(() => ({
		sessionId: "",
		model: primaryModel,
		agent: "build",
		customAgentId: "",
		draft: "",
		title: "New chat",
		projectId: project?.id ?? "",
	})),
);

function updatePane(side: "left" | "right", state: typeof leftState) {
	if (side === "left") leftState = state;
	else rightState = state;
}
</script>

<section
	class="flex min-h-0 min-w-0 flex-1 flex-col"
	aria-label="Split chat workspace"
>
	<div
		class="flex h-10 shrink-0 items-center justify-end gap-1 border-b border-white/[0.08] bg-background/50 px-2"
	>
		<span class="mr-auto px-2 text-[11px] text-muted-foreground"
			>Split chat</span
		>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1.5 px-2 text-xs"
			aria-label="Arrange panes side by side"
			aria-pressed={layout === "columns"}
			title="Side by side"
			onclick={() => (layout = "columns")}
			><Columns2 size={14} /><span class="hidden sm:inline">Side by side</span
			></Button
		>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1.5 px-2 text-xs"
			aria-label="Arrange panes stacked"
			aria-pressed={layout === "rows"}
			title="Stacked"
			onclick={() => (layout = "rows")}
			><Columns3 size={14} class="rotate-90" /><span class="hidden sm:inline"
				>Stacked</span
			></Button
		>
		<Button
			variant="ghost"
			size="icon"
			class="size-7"
			aria-label="Close split view"
			title="Close split view"
			onclick={() => onclose(leftState)}><X size={14} /></Button
		>
	</div>
	<div
		class={`flex min-h-0 min-w-0 flex-1 divide-white/[0.08] ${layout === "columns" ? "flex-row max-md:flex-col max-md:divide-x-0 max-md:divide-y divide-x" : "flex-col divide-y"}`}
	>
		<SplitChatPane
			className="min-h-0 min-w-0 flex-1"
			side="left"
			{project}
			{catalog}
			{customAgents}
			initialSessionId={primarySessionId}
			initialModel={primaryModel}
			initialAgent={primaryAgent}
			initialCustomAgentId={primaryCustomAgentId}
			initialDraft={primaryDraft}
			onstate={(state) => updatePane("left", state)}
			{onfile}
			{onopenfile}
			{onSession}
		/>
		<SplitChatPane
			className="min-h-0 min-w-0 flex-1"
			side="right"
			{project}
			{catalog}
			{customAgents}
			initialSessionId=""
			initialModel={primaryModel}
			initialAgent="build"
			initialCustomAgentId=""
			initialDraft=""
			onstate={(state) => updatePane("right", state)}
			{onfile}
			{onopenfile}
			{onSession}
		/>
	</div>
</section>
