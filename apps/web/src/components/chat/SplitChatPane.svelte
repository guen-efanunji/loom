<script lang="ts">
	import { LoaderCircle, MessageSquare, Plus, X } from "@lucide/svelte";
	import { onDestroy, onMount, tick, untrack } from "svelte";
	import {
		canonicalModelSelection,
		chat,
		type Catalog,
		type ChatMessage,
		type ChatSession,
		type ChatState,
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
	let turns = $derived.by(() => {
		const groups: Array<{
			key: string;
			role: string;
			messages: ChatMessage[];
		}> = [];
		for (const message of displayedMessages) {
			const last = groups[groups.length - 1];
			if (message.info.role === "assistant" && last?.role === "assistant")
				last.messages.push(message);
			else
				groups.push({
					key: message.info.id,
					role: message.info.role,
					messages: [message],
				});
		}
		return groups;
	});

	let visibleTurns = $derived(turns.slice(-visibleTurnCount));
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
			if (
				JSON.stringify(tab.conversation?.messages) !==
					JSON.stringify(state.messages) ||
				JSON.stringify(tab.conversation?.permissions) !==
					JSON.stringify(state.permissions) ||
				JSON.stringify(tab.conversation?.questions) !==
					JSON.stringify(state.questions) ||
				tab.conversation?.status.type !== state.status.type
			)
				tab.conversation = state;
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
	async function poll() {
		for (const tab of tabs) {
			if (
				tab.sessionId &&
				(tab.loading ||
					tab.conversation?.status.type === "busy" ||
					tab.conversation?.status.type === "retry" ||
					sendingIds.includes(tab.id))
			)
				await refresh(tab);
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

	function newTab() {
		const tab = makeTab();
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
		if (!tab || !tab.projectId || sendingIds.includes(tab.id)) return false;
		const tabId = tab.id;
		sendingIds = [...sendingIds, tabId];
		tab.error = "";
		try {
			if (!tab.sessionId) {
				const created = await chat.create(
					tab.projectId,
					input.text.split("\n")[0]?.slice(0, 80) || "New chat",
				);
				tab.sessionId = created.id;
				tab.title = created.title;
				tab.conversation = {
					session: created,
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
			tab.error =
				reason instanceof Error
					? reason.message
					: "Unable to send this message.";
			return false;
		} finally {
			sendingIds = sendingIds.filter((id) => id !== tabId);
		}
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
			onclick={newTab}><Plus size={14} /></Button
		>
	</div>
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
							Permission required: {request.permission}
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
