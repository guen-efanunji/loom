<script lang="ts">
import {
	ChevronDown,
	CircleHelp,
	FileCode,
	Folder,
	FolderPlus,
	GitBranch,
	LoaderCircle,
	MessageSquarePlus,
	PanelLeft,
	Pencil,
	RefreshCw,
	Search,
	Settings,
	ShieldCheck,
	Sparkles,
	Trash2,
	X,
} from "@lucide/svelte";
import { onMount, tick } from "svelte";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import {
	type Catalog,
	type ChatMessage,
	type ChatSession,
	type ChatState,
	chat,
	type FileDiff,
} from "$lib/chat";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import * as Tabs from "$lib/components/ui/tabs";
import { daemon, type Project, type Task } from "$lib/daemon";
import AddProjectForm from "./AddProjectForm.svelte";
import Composer from "./chat/Composer.svelte";
import QuestionCard from "./chat/QuestionCard.svelte";
import Turn from "./chat/Turn.svelte";
import KanbanBoard from "./KanbanBoard.svelte";
import ProgressBoard from "./ProgressBoard.svelte";

let projects = $state<Project[]>([]);
let sessions = $state<ChatSession[]>([]);
let legacyTasks = $state<Task[]>([]);
let selectedProjectId = $state("");
let sessionId = $state("");
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
let aboutOpen = $state(false);
let renameOpen = $state(false);
let renameTitle = $state("");
let renameTarget = $state("");
let deleteTarget = $state<ChatSession | null>(null);
let deleteSessionOpen = $state(false);
type ViewMode = "chat" | "kanban" | "progress";
function initialView(): ViewMode {
	const view = page.url.searchParams.get("view");
	return view === "kanban" || view === "progress" ? view : "chat";
}
let viewMode = $state<ViewMode>(initialView());
let draft = $state("");
let model = $state("");
let agent = $state("build");
let catalog = $state<Catalog>({
	models: [],
	defaults: {},
	agents: [
		{ name: "build", mode: "primary" },
		{ name: "plan", mode: "primary" },
	],
	commands: [],
});
let fileOpen = $state(false);
let fileLoading = $state(false);
let fileError = $state("");
let fileName = $state("");
let fileContent = $state("");
let diffs = $state<FileDiff[]>([]);
let fileTab = $state("changes");
let scroller = $state<HTMLDivElement>();
let follow = true;
let disposed = false;
let timer: ReturnType<typeof setTimeout>;
let projectRequest = 0;
let fileRequest = 0;
let sending = $state(false);
const selectedProject = $derived(
	projects.find((p) => p.id === selectedProjectId),
);
const messages = $derived([
	...(conversation?.messages ?? []),
	...(optimistic ? [optimistic] : []),
]);
type TurnGroup = { key: string; role: string; messages: ChatMessage[] };
const turns = $derived.by(() => {
	const groups: TurnGroup[] = [];
	for (const message of messages) {
		const last = groups[groups.length - 1];
		if (message.info.role === "assistant" && last && last.role === "assistant")
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
			(await chat.sessions(p.id)).map((s) => ({ ...s, projectId: p.id })),
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
		JSON.stringify(result.messages) !== JSON.stringify(conversation?.messages);
	conversation = result;
	connected = true;
	const project = projects.find(
		(p) =>
			p.id === result.session.projectId ||
			p.path.replace(/\/$/, "") === result.session.directory.replace(/\/$/, ""),
	);
	if (project) selectedProjectId = project.id;
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
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
	}
	return result;
}
async function selectSession(id: string) {
	sessionId = id;
	conversation = null;
	optimistic = null;
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
		if (recent?.providerID && recent.modelID)
			model = `${recent.providerID}/${recent.modelID}`;
		else model = preferredModel(selectedProjectId);
		if (recent?.agent) agent = recent.agent;
	} catch (reason) {
		if (id === sessionId) report(reason);
	} finally {
		if (id === sessionId) sessionLoading = false;
	}
}
$effect(() => {
	const id = page.url.searchParams.get("session") ?? "";
	if (ready && id !== sessionId) void selectSession(id);
});
$effect(() => {
	const mode = viewMode;
	const url = new URL(window.location.href);
	if (mode === "chat") url.searchParams.delete("view");
	else url.searchParams.set("view", mode);
	window.history.replaceState({}, "", url);
	if (mode !== "chat" && ready) void refreshBoard();
});
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
	if (!projectId) return;
	const request = ++projectRequest;
	chat
		.catalog(projectId)
		.then((result) => {
			if (disposed || request !== projectRequest) return;
			catalog = result;
			if (
				!sessionId &&
				model &&
				result.models.length &&
				!result.models.some(
					(item) => `${item.providerID}/${item.modelID}` === model,
				)
			)
				model = "";
		})
		.catch((reason) => {
			if (!disposed && request === projectRequest) report(reason);
		});
});
async function poll() {
	if (disposed) return;
	try {
		if (sessionId && !sessionLoading && !sending)
			await refreshSession(sessionId);
	} catch (reason) {
		connected = false;
		report(reason);
	} finally {
		if (!disposed) timer = setTimeout(poll, 1200);
	}
}
onMount(() => {
	sidebarOpen = window.innerWidth >= 768;
	void (async () => {
		try {
			await refreshProjects();
			legacyTasks = await daemon.listTasks();
			model = preferredModel(selectedProjectId);
			ready = true;
			await selectSession(page.url.searchParams.get("session") ?? "");
		} catch (reason) {
			report(reason);
			ready = true;
		} finally {
			loading = false;
			void poll();
		}
	})();
	return () => {
		disposed = true;
		clearTimeout(timer);
	};
});
function homeUrl(session = "") {
	const params = new URLSearchParams();
	if (session) params.set("session", session);
	if (viewMode !== "chat") params.set("view", viewMode);
	const query = params.toString();
	return `/${query ? `?${query}` : ""}`;
}
async function openSession(id: string) {
	draft = "";
	if (window.innerWidth < 768) sidebarOpen = false;
	await goto(homeUrl(id));
}
async function newSession(projectId = selectedProjectId) {
	selectedProjectId = projectId;
	draft = "";
	model = preferredModel(projectId);
	await goto(homeUrl());
	if (sessionId) await selectSession("");
}
async function send(input: Parameters<typeof chat.send>[1]) {
	if (!selectedProjectId || sending) return false;
	sending = true;
	error = "";
	try {
		let id = sessionId;
		if (!id) {
			const created = await chat.create(
				selectedProjectId,
				input.text.split("\n")[0].slice(0, 80) || "File discussion",
			);
			id = created.id;
			sessionId = id;
			conversation = {
				session: created,
				messages: [],
				status: { type: "idle" },
				permissions: [],
				questions: [],
			};
			sessions = [{ ...created, projectId: selectedProjectId }, ...sessions];
			await goto(homeUrl(id), { replaceState: true });
		}
		await chat.send(id, input);
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
		return true;
	} catch (reason) {
		report(reason);
		return false;
	} finally {
		sending = false;
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
			await goto(homeUrl());
			await selectSession("");
			return;
		}
		deleteSessionOpen = false;
		deleteTarget = null;
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Delete failed");
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
async function permission(
	requestId: string,
	reply: "once" | "always" | "reject",
) {
	try {
		await chat.permission(sessionId, requestId, reply);
		await refreshSession(sessionId);
	} catch (reason) {
		report(reason);
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

<svelte:head><title>{conversation?.session.title ? `${conversation.session.title} · Loom` : "Loom · Workspace"}</title></svelte:head>
<div class="flex h-svh overflow-hidden bg-background text-foreground">
  {#if sidebarOpen}
    <aside class="fixed inset-y-0 left-0 z-40 flex w-[280px] shrink-0 flex-col border-r bg-sidebar md:relative" aria-label="Workspace sidebar">
      <div class="flex h-14 items-center justify-between px-4"><a href="/" class="flex items-center gap-2 text-sm font-semibold tracking-wide"><span class="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">L</span> loom</a><Button variant="ghost" size="icon" aria-label="Collapse sidebar" onclick={() => sidebarOpen = false}><PanelLeft size={16} /></Button></div>
      <div class="space-y-2 px-3 pb-3"><Button variant="outline" class="w-full justify-start bg-background/50" onclick={() => newSession()}><MessageSquarePlus size={16} />New session<span class="ml-auto text-muted-foreground">+</span></Button><div class="flex items-center gap-1"><Button variant="ghost" size="sm" class="flex-1 justify-start text-muted-foreground" onclick={() => searchOpen = !searchOpen}><Search size={15} />Search sessions</Button><Button variant="ghost" size="icon" title="Add project" aria-label="Add project" onclick={() => addProjectOpen = true}><FolderPlus size={16} /></Button></div>{#if searchOpen}<Input aria-label="Search sessions" placeholder="Find a conversation…" bind:value={search} />{/if}</div>
      <nav class="nice-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <p class="px-2 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Recent chats</p>
        {#each filteredSessions.slice(0, 6) as session}
          {@const active = session.id === sessionId}
          <div class={`group mb-0.5 flex h-8 items-center rounded-md pr-1 ${active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}>
            {#if active}<span class="ml-1 h-4 w-0.5 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>{/if}
            <Button variant="ghost" class="h-8 min-w-0 flex-1 justify-start bg-transparent px-2 text-xs hover:bg-transparent" onclick={() => openSession(session.id)}><span class="truncate">{session.title}</span></Button>
            <span class="hidden shrink-0 group-hover:flex">
              <Button variant="ghost" size="icon" class="size-6" title="Rename session" aria-label={`Rename ${session.title}`} onclick={() => openRename(session.id, session.title)}><Pencil size={12} /></Button>
              <Button variant="ghost" size="icon" class="size-6 text-destructive" title="Delete session" aria-label={`Delete ${session.title}`} onclick={() => { deleteTarget = session; deleteSessionOpen = true; }}><Trash2 size={12} /></Button>
            </span>
          </div>
        {/each}
        {#if !filteredSessions.length}<p class="px-2 py-2 text-xs text-muted-foreground">{search ? "No matching conversations." : "Your conversations will appear here."}</p>{/if}
        {#each projects as project}
          {@const selected = project.id === selectedProjectId}
          <section class="mt-5"><div class={`flex items-center rounded-md ${selected ? "bg-accent/40" : ""}`}><Button variant="ghost" size="icon" class="size-6" aria-label={`Toggle ${project.name}`} aria-expanded={!collapsed.includes(project.id)} onclick={() => collapsed = collapsed.includes(project.id) ? collapsed.filter((id) => id !== project.id) : [...collapsed, project.id]}><ChevronDown size={13} class={collapsed.includes(project.id) ? "-rotate-90" : ""} /></Button><Button variant="ghost" class="h-8 min-w-0 flex-1 justify-start bg-transparent px-1 text-xs font-medium hover:bg-transparent" onclick={() => newSession(project.id)}><Folder size={14} class="text-teal-400" /><span class="truncate">{project.name}</span></Button><Button href={`/project/${project.id}`} variant="ghost" size="icon" class="size-6" aria-label={`Settings for ${project.name}`} title="Project tasks and settings"><Settings size={12} /></Button></div>
            {#if !collapsed.includes(project.id)}<div class="ml-3 border-l pl-3">{#each filteredSessions.filter((s) => s.projectId === project.id) as session}
              {@const active = session.id === sessionId}
              <div class={`group flex h-8 items-center rounded-md pr-1 ${active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}>
                {#if active}<span class="ml-1 h-4 w-0.5 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>{/if}
                <Button variant="ghost" class="h-8 min-w-0 flex-1 justify-start bg-transparent px-2 text-xs hover:bg-transparent" onclick={() => openSession(session.id)}><span class="truncate">{session.title}</span></Button>
                <span class="hidden shrink-0 group-hover:flex">
                  <Button variant="ghost" size="icon" class="size-6" title="Rename session" aria-label={`Rename ${session.title}`} onclick={() => openRename(session.id, session.title)}><Pencil size={12} /></Button>
                  <Button variant="ghost" size="icon" class="size-6 text-destructive" title="Delete session" aria-label={`Delete ${session.title}`} onclick={() => { deleteTarget = session; deleteSessionOpen = true; }}><Trash2 size={12} /></Button>
                </span>
              </div>
            {/each}{#if !sessions.some((s) => s.projectId === project.id)}<p class="py-2 text-xs text-muted-foreground">No chats yet.</p>{/if}</div>{/if}
          </section>
        {/each}
        {#if legacyTasks.length}<section class="mt-6"><p class="px-2 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">Task boards</p>{#each projects.filter(p => legacyTasks.some(t => t.projectId === p.id)) as project}<Button href={`/project/${project.id}`} variant="ghost" class="h-8 w-full justify-start text-xs text-muted-foreground">{project.name}<Badge variant="outline" class="ml-auto">{legacyTasks.filter(t => t.projectId === project.id).length}</Badge></Button>{/each}</section>{/if}
      </nav>
      <div class="flex items-center gap-1 border-t p-3"><Button href="/settings" variant="ghost" size="icon" title="Settings" aria-label="Settings"><Settings size={16} /></Button><Button variant="ghost" size="icon" title="About Loom" aria-label="About Loom" onclick={() => aboutOpen = true}><CircleHelp size={16} /></Button><Button variant="ghost" size="sm" class="ml-auto text-xs text-muted-foreground" onclick={retryConnection} title="Refresh connection"><span class={`size-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`}></span>{connected ? "Connected" : "Reconnect"}</Button></div>
    </aside>
    <Button class="fixed inset-0 z-30 h-full w-full rounded-none bg-black/50 md:hidden" variant="ghost" aria-label="Close sidebar backdrop" onclick={() => sidebarOpen = false} />
  {/if}
  <main class="flex min-w-0 flex-1 flex-col">
    <header class="flex h-14 shrink-0 items-center gap-3 border-b px-4">
      {#if !sidebarOpen}<Button variant="ghost" size="icon" aria-label="Open sidebar" onclick={() => sidebarOpen = true}><PanelLeft size={16} /></Button>{/if}
      <div class="min-w-0 flex-1"><p class="truncate text-sm font-medium">{viewMode === "chat" ? (conversation?.session.title ?? "New session") : `${viewMode === "kanban" ? "Tasks" : "Progress"} · ${selectedProject?.name ?? "No project"}`}</p>{#if selectedProject}<p class="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"><span class="truncate">{selectedProject.name}</span><GitBranch size={11} />{selectedProject.defaultBranch}</p>{/if}</div>
      <Tabs.Root bind:value={viewMode} aria-label="Workspace mode"><Tabs.List class="h-8"><Tabs.Trigger value="chat" class="h-6 px-3 text-xs">Chat</Tabs.Trigger><Tabs.Trigger value="kanban" class="h-6 px-3 text-xs">Kanban</Tabs.Trigger><Tabs.Trigger value="progress" class="h-6 px-3 text-xs">Progress</Tabs.Trigger></Tabs.List></Tabs.Root>
      {#if sessionId && viewMode === "chat"}<Button variant="ghost" size="icon" title="Rename session" aria-label="Rename session" onclick={() => openRename(sessionId, conversation?.session.title ?? "")}><Pencil size={15} /></Button><Button variant="outline" size="sm" onclick={() => showFiles()}><FileCode size={14} /><span class="hidden sm:inline">Changes</span></Button>{/if}
    </header>
    {#if viewMode === "kanban"}
      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {#if !selectedProjectId}
          <p class="py-12 text-center text-sm text-muted-foreground">Add a project to see its task board.</p>
        {:else}
          <KanbanBoard projectId={selectedProjectId} tasks={legacyTasks.filter((task) => task.projectId === selectedProjectId)} onChanged={refreshBoard} />
        {/if}
      </div>
    {:else if viewMode === "progress"}
      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <ProgressBoard tasks={selectedProjectId ? legacyTasks.filter((task) => task.projectId === selectedProjectId) : legacyTasks} onChanged={refreshBoard} />
      </div>
    {:else}
    <div bind:this={scroller} onscroll={(event) => { const node = event.currentTarget; follow = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }} class="nice-scroll min-h-0 flex-1 overflow-y-auto">
      <div class={`mx-auto flex min-h-full w-full max-w-3xl flex-col px-5 ${sessionId ? "py-8" : "justify-center py-12"}`}>
        {#if loading || sessionLoading}<div role="status" class="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><LoaderCircle size={17} class="animate-spin" />Loading {loading ? "workspace" : "conversation"}…</div>
        {:else if !sessionId}<div class="mb-8 text-center"><div class="mx-auto mb-5 flex size-10 items-center justify-center rounded-xl border bg-card"><Sparkles size={20} class="text-teal-300" /></div><h1 class="text-2xl font-medium tracking-tight sm:text-3xl">What are we working on?</h1><p class="mt-3 text-sm text-muted-foreground">A little context. A clear idea. Let's build something.</p></div>{/if}
        {#if sessionId}<div class="space-y-8" aria-live="polite" aria-relevant="additions text">{#each turns as turn (turn.key)}<Turn messages={turn.messages} {sessionId} projectId={selectedProjectId} onfile={showFiles} />{/each}</div>
          {#if busy}<div role="status" class="mt-5 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle size={14} class="animate-spin" />{conversation?.permissions.length ? "Waiting for permission" : conversation?.questions.length ? "Waiting for your answer" : conversation?.status.message || "OpenCode is working…"}</div>{/if}
          {#each conversation?.permissions ?? [] as request}<div class="mt-5 space-y-3 rounded-xl border border-amber-500/30 bg-card p-4"><p class="flex items-center gap-2 text-sm font-medium"><ShieldCheck size={16} />Permission required: {request.permission}</p><pre class="overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{request.patterns.join("\n")}</pre><div class="flex flex-wrap gap-2"><Button size="sm" onclick={() => permission(request.id, "once")}>Allow once</Button><Button variant="outline" size="sm" onclick={() => permission(request.id, "always")}>Always allow</Button><Button variant="ghost" size="sm" onclick={() => permission(request.id, "reject")}>Deny</Button></div></div>{/each}
          {#each conversation?.questions ?? [] as question}<div class="mt-5"><QuestionCard {question} onanswer={(answers) => answer(question.id, answers)} /></div>{/each}
        {/if}
        {#if error}<div role="alert" class="my-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"><p class="min-w-0 flex-1 break-words text-destructive">{error}</p><Button variant="ghost" size="sm" onclick={retryConnection}><RefreshCw size={13} />Retry</Button><Button variant="ghost" size="icon" class="size-7" aria-label="Dismiss error" onclick={() => error = ""}><X size={13} /></Button></div>{/if}
        {#if !sessionId && !loading}
          {#if !projects.length}<div class="mb-5 text-center"><p class="mb-3 text-sm text-muted-foreground">Add a local Git project to start chatting with OpenCode.</p><Button onclick={() => addProjectOpen = true}><FolderPlus size={16} />Add project</Button></div>{:else}<div class="mb-3"><Select.Root type="single" bind:value={selectedProjectId}><Select.Trigger class="w-auto min-w-40 border-0 bg-transparent shadow-none" aria-label="Choose project"><Folder size={14} />{selectedProject?.name ?? "Choose project"}</Select.Trigger><Select.Content>{#each projects as project}<Select.Item value={project.id}>{project.name}</Select.Item>{/each}</Select.Content></Select.Root></div>{/if}
          <Composer projectId={selectedProjectId} {catalog} {busy} disabled={!selectedProjectId || loading} onsend={send} onstop={stop} bind:draft bind:model bind:agent />
          <div class="mt-5 flex flex-wrap justify-center gap-2">{#each prompts as prompt}<Button variant="outline" size="sm" class="rounded-full text-xs text-muted-foreground" onclick={() => draft = prompt.text}>{prompt.label}</Button>{/each}</div>
        {/if}
      </div>
    </div>
    {#if sessionId && viewMode === "chat"}<div class="shrink-0 border-t bg-background px-5 py-4"><div class="mx-auto max-w-3xl"><Composer projectId={selectedProjectId} {catalog} {busy} disabled={!conversation || sessionLoading} onsend={send} onstop={stop} bind:draft bind:model bind:agent /></div></div>{/if}
    {/if}
  </main>
</div>
<Dialog.Root bind:open={addProjectOpen}><Dialog.Content><Dialog.Header><Dialog.Title>Add project</Dialog.Title><Dialog.Description>Connect a local Git repository to OpenCode.</Dialog.Description></Dialog.Header><AddProjectForm oncreated={() => { addProjectOpen = false; void retryConnection(); }} /></Dialog.Content></Dialog.Root>
<Dialog.Root bind:open={renameOpen}><Dialog.Content><Dialog.Header><Dialog.Title>Rename session</Dialog.Title><Dialog.Description>Choose a title you can find in the sidebar.</Dialog.Description></Dialog.Header><form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void rename(); }}><Input aria-label="Session title" bind:value={renameTitle} maxlength={200} /><Dialog.Footer><Button type="submit" disabled={!renameTitle.trim()}>Save title</Button></Dialog.Footer></form></Dialog.Content></Dialog.Root>
<AlertDialog.Root bind:open={deleteSessionOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete session?</AlertDialog.Title>
			<AlertDialog.Description>“{deleteTarget?.title}” and its OpenCode history will be removed permanently.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => void removeSession()}>Delete session</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
<Dialog.Root bind:open={aboutOpen}><Dialog.Content><Dialog.Header><Dialog.Title>About Loom</Dialog.Title><Dialog.Description>Your local workspace for conversations with OpenCode.</Dialog.Description></Dialog.Header><p class="text-sm leading-6 text-muted-foreground">Chats are saved in OpenCode. Use @ to attach project files or agents. The Changes panel shows file edits; task worktrees are available from the sidebar.</p><Badge variant="outline">{connected ? "OpenCode connected" : "Connection unavailable"}</Badge></Dialog.Content></Dialog.Root>
<Dialog.Root bind:open={fileOpen}><Dialog.Content class="flex max-h-[85svh] flex-col overflow-hidden sm:max-w-5xl"><Dialog.Header><Dialog.Title class="truncate pr-8">{fileName || "Session changes"}</Dialog.Title><Dialog.Description>{fileName ? "Inspect file content and changes made in this session." : `${diffs.length} changed files in this session.`}</Dialog.Description></Dialog.Header>
  {#if fileLoading}<p class="py-6 text-sm text-muted-foreground">Loading file…</p>{:else if fileError}<p role="alert" class="text-sm text-destructive">{fileError}</p>{:else if !fileName}<div class="min-h-0 overflow-auto">{#each diffs as diff}<Button variant="ghost" class="h-auto w-full justify-start py-3" onclick={() => showFiles(diff.file)}><FileCode size={15} /><span class="min-w-0 flex-1 truncate text-left">{diff.file}</span><span class="text-xs text-emerald-400">+{diff.additions}</span><span class="text-xs text-red-400">−{diff.deletions}</span></Button>{/each}{#if !diffs.length}<p class="py-8 text-center text-sm text-muted-foreground">No file changes in this session yet.</p>{/if}</div>
  {:else}<Tabs.Root bind:value={fileTab} class="flex min-h-0 flex-1 flex-col"><Tabs.List><Tabs.Trigger value="changes" disabled={!selectedDiff}>Changes</Tabs.Trigger><Tabs.Trigger value="content">File content</Tabs.Trigger></Tabs.List><Tabs.Content value="changes" class="min-h-0 overflow-auto">{#if selectedDiff?.patch}<div class="overflow-auto rounded-lg border bg-background"><pre class="min-w-fit py-3 text-xs leading-6">{#each selectedDiff.patch.split("\n") as line}<div class={`min-h-6 px-4 ${line.startsWith("+") ? "bg-emerald-500/10 text-emerald-300" : line.startsWith("-") ? "bg-red-500/10 text-red-300" : line.startsWith("@@") ? "bg-blue-500/10 text-blue-300" : "text-muted-foreground"}`}>{line || " "}</div>{/each}</pre></div>{:else if selectedDiff}<div class="grid min-w-[640px] grid-cols-2 divide-x rounded-lg border"><div><p class="sticky top-0 border-b bg-card p-2 text-xs text-red-300">Before · −{selectedDiff.deletions}</p><pre class="overflow-auto bg-red-500/5 p-3 text-xs leading-6">{selectedDiff.before || "(empty)"}</pre></div><div><p class="sticky top-0 border-b bg-card p-2 text-xs text-emerald-300">After · +{selectedDiff.additions}</p><pre class="overflow-auto bg-emerald-500/5 p-3 text-xs leading-6">{selectedDiff.after || "(empty)"}</pre></div></div>{/if}</Tabs.Content><Tabs.Content value="content" class="min-h-0 overflow-auto"><pre class="rounded-lg border bg-background p-4 text-xs leading-6">{fileContent || "(empty file)"}</pre></Tabs.Content></Tabs.Root><Dialog.Footer><Button variant="outline" onclick={() => { fileName = ""; fileContent = ""; }}>All changes</Button><Button onclick={() => { draft = `Please update @${fileName}: `; fileOpen = false; }}>Discuss this file</Button></Dialog.Footer>{/if}
</Dialog.Content></Dialog.Root>
