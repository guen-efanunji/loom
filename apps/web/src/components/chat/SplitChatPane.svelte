<script lang="ts">
	import {
		GitBranch,
		LoaderCircle,
		MessageSquare,
		Plus,
		Sparkles,
		Upload,
		X,
	} from "@lucide/svelte";
	import { onDestroy, onMount, tick, untrack } from "svelte";
	import {
		type Catalog,
		type ChatMessage,
		type ChatSession,
		type ChatState,
		type ChatWorkspace,
		canonicalModelSelection,
		chat,
		groupTurns,
		permissionActionLabel,
		supersededIds,
		userMessageText,
	} from "$lib/chat";
	import { Button } from "$lib/components/ui/button";
	import * as Marker from "$lib/components/ui/marker";
	import type { Project } from "$lib/daemon";
	import Composer from "./Composer.svelte";
	import QuestionCard from "./QuestionCard.svelte";
	import Turn from "./Turn.svelte";

	type PaneTab = {
		id: string;
		sessionId: string;
		projectId: string;
		title: string;
		draft: string;
		model: string;
		agent: string;
		customAgentId: string;
		conversation: ChatState | null;
		loading: boolean;
		error: string;
		optimistic: ChatMessage | null;
		/** Chosen before the session exists: run this tab in its own git worktree. */
		isolated: boolean;
		workspace: ChatWorkspace | null;
		workspaceError: string;
		/** Files the last merge/sync reported as conflicting. */
		conflict: string[];
	};

	let {
		className = "",
		side,
		project,
		catalog,
		customAgents,
		initialSessionId,
		initialModel,
		initialAgent,
		initialCustomAgentId,
		initialDraft,
		onstate,
		onfile,
		onopenfile,
		onSession,
	}: {
		className?: string;
		side: "left" | "right";
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
		initialSessionId: string;
		initialModel: string;
		initialAgent: string;
		initialCustomAgentId: string;
		initialDraft: string;
		onstate: (state: {
			sessionId: string;
			projectId: string;
			model: string;
			agent: string;
			customAgentId: string;
			draft: string;
			title: string;
		}) => void;
		onfile: (path: string) => void;
		onopenfile?: (path: string) => void;
		onSession: (session: ChatSession, projectId: string) => void;
	} = $props();

	function makeTab(
		sessionId = "",
		model = initialModel,
		agent = "build",
		customAgentId = "",
		draft = "",
		isolated = false,
	): PaneTab {
		return {
			id: crypto.randomUUID(),
			sessionId,
			projectId: project?.id ?? "",
			title: "New chat",
			draft,
			model,
			agent,
			customAgentId,
			conversation: null,
			loading: !!sessionId,
			error: "",
			optimistic: null,
			isolated,
			workspace: null,
			workspaceError: "",
			conflict: [],
		};
	}
	let tabs = $state<PaneTab[]>(
		untrack(() => [
			makeTab(
				initialSessionId,
				initialModel,
				initialAgent,
				initialCustomAgentId,
				initialDraft,
			),
		]),
	);
	let activeId = $state(untrack(() => tabs[0]!.id));
	let sendingIds = $state<string[]>([]);
	let timer: ReturnType<typeof setInterval> | undefined;
	let permissionReplying = $state("");
	let visibleTurnCount = $state(80);
	let scroller: HTMLDivElement;
	// P2-9: hold at most one message per tab while its session is busy so a fast
	// follow-up is queued and auto-sent the moment the run finishes.
	let queues = $state<Record<string, Parameters<typeof chat.send>[1] | null>>(
		{},
	);
	// P1-7: last cheap status signature per tab, so we only re-fetch full state
	// when the conversation actually changed instead of every poll.
	let signatures = $state<Record<string, string>>({});
	let active = $derived(tabs.find((tab) => tab.id === activeId) ?? tabs[0]!);
	let busy = $derived(
		!!active &&
			(sendingIds.includes(active.id) ||
				active.conversation?.status.type === "busy" ||
				active.conversation?.status.type === "retry"),
	);
	let displayedMessages = $derived(
		active
			? [
					...(active.conversation?.messages ?? []),
					...(active.optimistic ? [active.optimistic] : []),
				]
			: [],
	);
	let turns = $derived(groupTurns(displayedMessages));

	let visibleTurns = $derived(turns.slice(-visibleTurnCount));
	// Only the newest completed assistant turn offers Regenerate; edits apply to
	// real (non-pending) user turns. Both are hidden while a run is in flight.
	let lastAssistantTurnKey = $derived(
		turns.findLast((turn) => turn.role === "assistant")?.key ?? "",
	);
	async function showEarlierTurns() {
		const previousHeight = scroller.scrollHeight;
		visibleTurnCount += 80;
		await tick();
		scroller.scrollTop += scroller.scrollHeight - previousHeight;
	}
	function publishState(tab: PaneTab | undefined = active) {
		if (!tab) return;
		onstate({
			sessionId: tab.sessionId,
			projectId: tab.projectId,
			model: tab.model,
			agent: tab.agent,
			customAgentId: tab.customAgentId,
			draft: tab.draft,
			title: tab.conversation?.session.title ?? tab.title,
		});
	}
	$effect(() => publishState(active));
	async function refresh(tab: PaneTab) {
		if (!tab.sessionId) return;
		try {
			const state = await chat.state(tab.sessionId);
			if (
				!tabs.some((item) => item.id === tab.id) ||
				tab.sessionId !== state.session.id
			)
				return;
			const signature = [
				state.messages.length,
				state.messages.at(-1)?.info.id ?? "",
				state.messages.at(-1)?.info.time.completed ?? "",
				state.status.type,
				state.permissions.length,
				state.questions.length,
			].join("|");
			if (signatures[tab.id] !== signature) {
				signatures[tab.id] = signature;
				tab.conversation = state;
			}
			tab.title = state.session.title;
			const latestAssistant = state.messages.findLast(
				(message) => message.info.role === "assistant",
			)?.info;
			if (latestAssistant?.providerID && latestAssistant.modelID)
				tab.model = canonicalModelSelection(
					catalog,
					latestAssistant.providerID,
					latestAssistant.modelID,
				);
			tab.loading = false;
			tab.error = "";
			if (
				tab.optimistic &&
				state.messages.some(
					(message) =>
						message.info.role === "user" &&
						message.parts.some(
							(part) =>
								part.type === "text" &&
								part.text === tab.optimistic?.parts[0]?.text,
						),
				)
			)
				tab.optimistic = null;
			if (tab.id === activeId) publishState(tab);
		} catch (reason) {
			tab.loading = false;
			tab.error =
				reason instanceof Error
					? reason.message
					: "Unable to load this conversation.";
		}
	}
	// Cheap poll: hit only the status summary and re-fetch full state when it
	// changed or a busy run settled. P1-7 keeps long sessions off the main thread.
	async function pollTab(tab: PaneTab) {
		if (!tab.sessionId) return;
		const conversation = tab.conversation;
		const wasBusy =
			conversation?.status.type === "busy" ||
			conversation?.status.type === "retry";
		let status: Awaited<ReturnType<typeof chat.status>> | null = null;
		try {
			status = await chat.status(tab.sessionId);
		} catch {
			await refresh(tab);
			return;
		}
		if (!tabs.some((item) => item.id === tab.id)) return;
		const changed =
			status.count !== (conversation?.messages.length ?? -1) ||
			status.lastMessageId !== (conversation?.messages.at(-1)?.info.id ?? "") ||
			status.status.type !== (conversation?.status.type ?? "idle") ||
			status.pendingPermissions !== (conversation?.permissions.length ?? 0) ||
			status.pendingQuestions !== (conversation?.questions.length ?? 0);
		if (changed || wasBusy || tab.loading) await refresh(tab);
		// P2-9: flush a queued follow-up the moment the run goes idle.
		const settled =
			!status.busy &&
			!sendingIds.includes(tab.id) &&
			tab.conversation?.status.type !== "busy" &&
			tab.conversation?.status.type !== "retry";
		if (wasBusy && settled && !tab.optimistic && queues[tab.id]) {
			const queued = queues[tab.id];
			queues[tab.id] = null;
			if (queued) void sendFor(tab, queued);
		}
		// A finished run may have written files; refresh the workspace view so the
		// tab shows pending output that is ready to checkpoint and merge.
		if (wasBusy && settled && tab.workspace) await loadWorkspace(tab);
	}
	async function poll() {
		for (const tab of tabs) {
			if (
				tab.sessionId &&
				(tab.loading ||
					queues[tab.id] ||
					tab.conversation?.status.type === "busy" ||
					tab.conversation?.status.type === "retry" ||
					sendingIds.includes(tab.id))
			)
				await pollTab(tab);
		}
	}
	/**
	 * Workspace state comes from Git, so it is refreshed on events (session created,
	 * a run settling, an explicit action) rather than on the 1.2s conversation poll.
	 */
	async function loadWorkspace(tab: PaneTab) {
		if (!tab.sessionId) return;
		try {
			const state = await chat.workspace(tab.sessionId);
			if (!tabs.some((item) => item.id === tab.id)) return;
			tab.workspace = state.mode === "isolated" ? state : null;
			tab.isolated = state.mode === "isolated";
			tab.workspaceError = "";
		} catch (reason) {
			// A deleted worktree or a Git failure must not break the conversation view.
			tab.workspace = null;
			tab.workspaceError =
				reason instanceof Error
					? reason.message
					: "Workspace status unavailable.";
		}
	}
	onMount(() => {
		const first = tabs[0];
		if (first?.sessionId) void refresh(first);
		timer = setInterval(() => void poll(), 1200);
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
	});

	function newTab(isolated = false) {
		const tab = makeTab("", initialModel, "build", "", "", isolated);
		tabs = [...tabs, tab];
		activeId = tab.id;
		visibleTurnCount = 80;
		publishState(tab);
	}
	function startNewChatFromAnswer(answer: string) {
		const tab = makeTab(
			"",
			active.model,
			active.agent,
			active.customAgentId,
			`Continue from this answer:\n\n${answer.trim()}\n\n`,
		);
		tabs = [...tabs, tab];
		activeId = tab.id;
		visibleTurnCount = 80;
		publishState(tab);
	}
	async function switchTab(id: string) {
		if (id === activeId) return;
		activeId = id;
		visibleTurnCount = 80;
		publishState();
		const tab = tabs.find((item) => item.id === id);
		if (tab?.sessionId && !tab.conversation) await refresh(tab);
	}
	function closeTab(id: string) {
		const index = tabs.findIndex((tab) => tab.id === id);
		if (index < 0) return;
		const wasActive = id === activeId;
		tabs = tabs.filter((tab) => tab.id !== id);
		if (!tabs.length) {
			const tab = makeTab();
			tabs = [tab];
			activeId = tab.id;
			publishState(tab);
		} else if (wasActive) {
			activeId = tabs[Math.min(index, tabs.length - 1)]!.id;
			visibleTurnCount = 80;
			publishState();
		}
	}
	async function send(input: Parameters<typeof chat.send>[1]) {
		const tab = active;
		if (!tab?.projectId) return false;
		// P2-9: when the tab is already running, queue a single follow-up instead
		// of rejecting the send; it flushes automatically once the run settles.
		const running =
			sendingIds.includes(tab.id) ||
			tab.conversation?.status.type === "busy" ||
			tab.conversation?.status.type === "retry";
		if (running) {
			queues[tab.id] = input;
			return true;
		}
		return sendFor(tab, input);
	}
	/** The daemon refuses a second writer on one checkout; the code is the signal. */
	function isProjectBusy(reason: unknown) {
		const error = reason as {
			code?: string;
			status?: number;
			message?: string;
		};
		return (
			error?.code === "PROJECT_BUSY" ||
			(error?.status === 409 &&
				/already editing this project/i.test(error.message ?? ""))
		);
	}
	function conflictFiles(reason: unknown) {
		const error = reason as { files?: unknown; message?: string };
		return Array.isArray(error?.files) ? (error.files as string[]) : [];
	}
	async function sendFor(
		tab: PaneTab,
		input: Parameters<typeof chat.send>[1],
		allowIsolationFallback = true,
	) {
		if (!tab?.projectId || sendingIds.includes(tab.id)) return false;
		const tabId = tab.id;
		sendingIds = [...sendingIds, tabId];
		tab.error = "";
		let createdHere = false;
		let retryIsolated = false;
		try {
			if (!tab.sessionId) {
				// Isolation is decided when the session is created: the provider session
				// is bound to its directory for life, so it cannot be moved later.
				const created = await chat.create(
					tab.projectId,
					input.text.split("\n")[0]?.slice(0, 80) || "New chat",
					tab.isolated ? "isolated" : "shared",
				);
				createdHere = true;
				tab.sessionId = created.id;
				tab.title = created.title;
				tab.workspace = created.workspace ?? null;
				tab.isolated = created.workspace?.mode === "isolated";
				tab.conversation = {
					session: { ...created, workspace: undefined },
					messages: [],
					status: { type: "idle" },
					permissions: [],
					questions: [],
				};
				onSession({ ...created, projectId: tab.projectId }, tab.projectId);
			}
			tab.optimistic = {
				info: {
					id: `pending-${Date.now()}`,
					role: "user",
					time: { created: Date.now() },
				},
				parts: [
					{ id: "pending-text", type: "text", text: input.text },
					...input.files.map((filename, index) => ({
						id: `pending-file-${index}`,
						type: "file",
						filename,
					})),
				],
			};
			await chat.send(tab.sessionId, input);
			await refresh(tab);
			publishState(tab);
			return true;
		} catch (reason) {
			tab.optimistic = null;
			// The project folder is taken by another chat. A conversation that has barely
			// started can be re-created straight into its own worktree, so the parallel
			// run the user asked for still happens instead of a dead end.
			if (
				isProjectBusy(reason) &&
				createdHere &&
				!tab.isolated &&
				allowIsolationFallback
			) {
				await chat.remove(tab.sessionId).catch(() => {});
				tab.sessionId = "";
				tab.conversation = null;
				tab.workspace = null;
				tab.isolated = true;
				tab.error =
					"The project folder was busy, so this chat restarted in its own workspace.";
				retryIsolated = true;
			} else {
				tab.error =
					reason instanceof Error
						? reason.message
						: "Unable to send this message.";
			}
		} finally {
			sendingIds = sendingIds.filter((id) => id !== tabId);
		}
		// Retry outside the finally so the tab is not marked idle mid-flight.
		if (retryIsolated) return sendFor(tab, input, false);
		return false;
	}
	/** Commit this tab's output on its branch, then integrate it into the project. */
	async function integrate(tab: PaneTab) {
		if (!tab.sessionId || !tab.workspace) return;
		tab.error = "";
		tab.conflict = [];
		try {
			if (tab.workspace.pendingChanges !== false)
				await chat.checkpoint(tab.sessionId);
			await chat.mergeWorkspace(tab.sessionId);
			await loadWorkspace(tab);
		} catch (reason) {
			tab.conflict = conflictFiles(reason);
			tab.error =
				reason instanceof Error
					? reason.message
					: "Unable to merge this workspace.";
			await loadWorkspace(tab);
		}
	}
	async function syncWorkspace(tab: PaneTab) {
		if (!tab.sessionId || !tab.workspace) return;
		tab.error = "";
		tab.conflict = [];
		try {
			if (tab.workspace.pendingChanges !== false)
				await chat.checkpoint(tab.sessionId);
			await chat.syncWorkspace(tab.sessionId);
			await loadWorkspace(tab);
		} catch (reason) {
			tab.conflict = conflictFiles(reason);
			tab.error =
				reason instanceof Error
					? reason.message
					: "Unable to sync this workspace.";
		}
	}
	async function discardWorkspace(tab: PaneTab) {
		if (!tab.sessionId || !tab.workspace) return;
		if (
			!confirm(
				"Discard this isolated workspace? Unmerged agent output is lost.",
			)
		)
			return;
		tab.error = "";
		try {
			await chat.discardWorkspace(tab.sessionId);
			await chat.remove(tab.sessionId).catch(() => {});
			tab.workspace = null;
			tab.isolated = false;
			tab.sessionId = "";
			tab.conversation = null;
			publishState(tab);
		} catch (reason) {
			tab.error =
				reason instanceof Error
					? reason.message
					: "Unable to discard this workspace.";
		}
	}
	// Rebuild a send payload from the tab's current model/agent selection so a
	// regenerate/edit re-runs the prompt exactly like the composer would.
	function inputFromTab(
		tab: PaneTab,
		text: string,
	): Parameters<typeof chat.send>[1] {
		const [providerID, ...rest] = tab.model.split("/");
		const model =
			providerID && rest.length
				? { providerID, modelID: rest.join("/") }
				: undefined;
		return {
			text,
			files: [],
			designNodeIds: [],
			agents: [],
			agent: tab.agent || "build",
			customAgentId: tab.customAgentId || undefined,
			model,
		};
	}
	async function regenerate() {
		const tab = active;
		const messages = tab?.conversation?.messages;
		if (!tab || !messages || !tab.sessionId) return;
		let lastUser = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]!.info.role === "user") {
				lastUser = i;
				break;
			}
		}
		if (lastUser < 0) return;
		const text = userMessageText(messages[lastUser]!);
		const hide = messages
			.slice(lastUser + 1)
			.filter((message) => message.info.role === "assistant")
			.map((message) => message.info.id);
		if (hide.length) await chat.supersede(tab.sessionId, hide).catch(() => {});
		await sendFor(tab, inputFromTab(tab, text));
	}
	async function editMessage(messageId: string, text: string) {
		const tab = active;
		const messages = tab?.conversation?.messages;
		if (!tab || !messages || !tab.sessionId) return;
		const hide = supersededIds(messages, messageId);
		if (hide.length) await chat.supersede(tab.sessionId, hide).catch(() => {});
		await sendFor(tab, inputFromTab(tab, text));
	}
	async function stop() {
		if (!active?.sessionId) return;
		try {
			await chat.abort(active.sessionId);
			await refresh(active);
		} catch (reason) {
			active.error =
				reason instanceof Error
					? reason.message
					: "Unable to stop this response.";
		}
	}
	async function permission(
		requestId: string,
		reply: "once" | "always" | "reject",
	) {
		if (!active?.sessionId) return;
		permissionReplying = requestId;
		try {
			await chat.permission(active.sessionId, requestId, reply);
			await refresh(active);
		} catch (reason) {
			active.error =
				reason instanceof Error
					? reason.message
					: "Unable to update permission.";
		} finally {
			permissionReplying = "";
		}
	}
	async function answer(requestId: string, answers: string[][]) {
		if (!active?.sessionId) return;
		try {
			await chat.question(active.sessionId, requestId, answers);
			await refresh(active);
		} catch (reason) {
			active.error =
				reason instanceof Error
					? reason.message
					: "Unable to submit your answer.";
		}
	}
</script>

<section
	class={`flex min-h-0 min-w-0 flex-1 flex-col ${className}`}
	aria-label={`${side === "left" ? "Left" : "Right"} chat pane`}
>
	<div
		class="nice-scroll flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.08] bg-background/35 px-2"
		role="tablist"
		aria-label={`${side} chat tabs`}
	>
		{#each tabs as tab (tab.id)}
			<div
				class={`group flex h-7 max-w-48 shrink-0 items-center rounded-md border ${activeId === tab.id ? "border-white/15 bg-white/[0.08]" : "border-transparent text-muted-foreground hover:bg-white/[0.04]"}`}
			>
				<Button
					variant="ghost"
					role="tab"
					aria-selected={activeId === tab.id}
					class="h-6 min-w-0 justify-start gap-1.5 px-2 text-[11px]"
					title={tab.title}
					onclick={() => void switchTab(tab.id)}
					><MessageSquare size={12} class="shrink-0" /><span class="truncate"
						>{tab.title}</span
					>{#if sendingIds.includes(tab.id)}<span
							class="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
						></span>{/if}</Button
				>
				<Button
					variant="ghost"
					size="icon"
					class="mr-0.5 size-5 shrink-0 opacity-50 hover:opacity-100"
					aria-label={`Close ${tab.title}`}
					title="Close tab"
					onclick={(event) => {
						event.stopPropagation();
						closeTab(tab.id);
					}}><X size={11} /></Button
				>
			</div>
		{/each}
		<Button
			variant="ghost"
			size="icon"
			class="size-7 shrink-0 text-muted-foreground"
			aria-label={`New ${side} chat tab`}
			title="New chat tab"
			onclick={() => newTab()}><Plus size={14} /></Button
		>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 shrink-0 gap-1.5 px-2 text-[11px] text-muted-foreground"
			aria-label={`New isolated ${side} chat tab`}
			title="New tab in its own git worktree — runs in parallel with other chats"
			onclick={() => newTab(true)}><GitBranch size={12} />Isolated</Button
		>
	</div>
	{#if active?.sessionId}
		<div
			class="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-white/[0.08] bg-background/25 px-2 py-1 text-[11px] text-muted-foreground"
			aria-label="Chat workspace"
		>
			{#if active.workspace && active.workspace.mode === "isolated"}
				{@const workspace = active.workspace}
				<span
					class="flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-400/[0.07] px-1.5 py-0.5 text-emerald-200"
					title={workspace.path}
					><GitBranch size={11} />{workspace.branch ?? "isolated"}</span
				>
				<span>
					{#if workspace.state === "ready"}
						{workspace.pendingChanges
							? "Uncommitted output"
							: workspace.integrated
								? `Integrated into ${workspace.targetBranch ?? "main"}`
								: "Checkpointed, ready to merge"}
					{:else if workspace.state === "error"}
						{workspace.error ?? "Workspace unavailable"}
					{:else}
						Workspace status unavailable
					{/if}
				</span>
				{#if active.conflict.length}
					<span class="text-destructive"
						>Merge conflict in {active.conflict.length} file(s)</span
					>
				{/if}
				<span class="ml-auto flex items-center gap-1">
					<Button
						variant="outline"
						size="sm"
						class="h-6 px-2 text-[11px]"
						title="Commit this tab's output and merge it into the project branch"
						disabled={busy || !!active.workspaceError}
						onclick={() => void integrate(active)}
						><Upload size={11} />Merge into project</Button
					>
					<Button
						variant="ghost"
						size="sm"
						class="h-6 px-2 text-[11px]"
						title="Pull the project branch into this workspace"
						disabled={busy}
						onclick={() => void syncWorkspace(active)}>Sync</Button
					>
					<Button
						variant="ghost"
						size="sm"
						class="h-6 px-2 text-[11px] text-muted-foreground"
						title="Throw away this workspace and its unmerged output"
						disabled={busy}
						onclick={() => void discardWorkspace(active)}>Discard</Button
					>
				</span>
			{:else}
				<span
					class="flex items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5"
					title="This chat edits the project folder directly"
					><Sparkles size={11} />Project folder</span
				>
				<span
					>One agent at a time here · open an Isolated tab to work in parallel</span
				>
			{/if}
			{#if active.workspaceError}
				<span class="text-destructive">{active.workspaceError}</span>
			{/if}
		</div>
	{/if}
	<div bind:this={scroller} class="nice-scroll min-h-0 flex-1 overflow-y-auto">
		<div
			class="mx-auto flex min-h-full w-full max-w-[900px] flex-col px-4 py-5 sm:px-5"
		>
			{#if active?.loading}<div
					class="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
				>
					<LoaderCircle size={15} class="animate-spin" />Loading conversation…
				</div>
			{:else if active?.sessionId}
				<div
					class="space-y-6"
					aria-live="polite"
					aria-relevant="additions text"
				>
					{#if turns.length > visibleTurnCount}<Button
							variant="ghost"
							class="w-full"
							onclick={() => void showEarlierTurns()}
							>Load earlier messages</Button
						>{/if}{#each visibleTurns as turn (turn.key)}<Turn
							messages={turn.messages}
							{catalog}
							sessionId={active.sessionId}
							projectId={active.projectId}
							{onfile}
							{onopenfile}
							onbranch={startNewChatFromAnswer}
							onregenerate={turn.role === "assistant" &&
							turn.key === lastAssistantTurnKey &&
							!busy
								? regenerate
								: undefined}
							onedit={turn.role === "user" && !busy ? editMessage : undefined}
						/>{/each}
				</div>
				{#if busy}<Marker.Root variant="border" class="mt-4 flex items-center"
						><Marker.Icon
							><LoaderCircle size={13} class="animate-spin" /></Marker.Icon
						><Marker.Content
							>{active.conversation?.permissions.length
								? "Waiting for permission"
								: active.conversation?.questions.length
									? "Waiting for your answer"
									: "Loom is working…"}</Marker.Content
						></Marker.Root
					>{/if}
				{#each active.conversation?.permissions ?? [] as request}<div
						role="group"
						aria-label={`Permission required: ${request.permission}`}
						class="mt-4 space-y-3 rounded-xl border border-amber-500/30 bg-card p-3"
					>
						<p class="text-xs font-medium">
							Allow this action?
							<span class="text-muted-foreground">·</span>
							{permissionActionLabel(request.permission, request.patterns)}
						</p>
						<p class="text-[11px] text-muted-foreground">
							The request expires automatically after 2 minutes if you don't
							answer.
						</p>
						{#if request.patterns.length}<pre
								class="overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{request.patterns.join(
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
								onclick={() => permission(request.id, "reject")}>Decline</Button
							>
						</div>
					</div>{/each}
				{#each active.conversation?.questions ?? [] as question}<div
						class="mt-4"
					>
						<QuestionCard
							{question}
							onanswer={(answers) => answer(question.id, answers)}
						/>
					</div>{/each}
			{:else}
				<div
					class="flex flex-1 flex-col items-center justify-center py-8 text-center"
				>
					<div
						class="mb-3 grid size-10 place-items-center rounded-xl border border-cyan-300/20 bg-cyan-300/[0.06] text-cyan-200"
					>
						<MessageSquare size={17} />
					</div>
					<h2 class="text-base font-medium">What do you want to build?</h2>
					<p class="mt-1 text-xs text-muted-foreground">
						{side === "left"
							? "Continue this chat or start a new conversation."
							: "Start a separate conversation in this pane."}
					</p>
				</div>
			{/if}
			{#if active?.error}<p
					role="alert"
					class="mt-3 break-words rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
				>
					{active.error}
				</p>{/if}
		</div>
	</div>
	{#if project}<div
			class="shrink-0 border-t border-white/[0.08] bg-background/70 p-3"
		>
			<Composer
				projectId={project.id}
				{catalog}
				{customAgents}
				{busy}
				disabled={!project}
				onsend={send}
				onstop={stop}
				bind:draft={active.draft}
				bind:model={active.model}
				bind:agent={active.agent}
				bind:customAgentId={active.customAgentId}
				autoAccept={project.autoAccept ?? false}
			/>
		</div>{:else}<p
			class="border-t p-4 text-center text-xs text-muted-foreground"
		>
			Choose a project before starting a chat.
		</p>{/if}
</section>
