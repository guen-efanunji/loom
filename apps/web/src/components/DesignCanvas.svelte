<script lang="ts">
import {
	ChevronRight,
	Layers,
	LoaderCircle,
	Monitor,
	Moon,
	RefreshCw,
	Scan,
	Smartphone,
	Sparkles,
	Sun,
	Trash2,
	Upload,
	ZoomIn,
	ZoomOut,
} from "@lucide/svelte";
import { onDestroy, onMount, tick } from "svelte";
import { toast } from "svelte-sonner";
import type { Catalog, ChatAttachment, Question } from "$lib/chat";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
import Composer from "./chat/Composer.svelte";
import Markdown from "./chat/Markdown.svelte";
import QuestionCard from "./chat/QuestionCard.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import {
	type DesignActivity,
	type DesignMessage,
	type DesignNode,
	type DesignViewport,
	daemon,
} from "$lib/daemon";

let {
	projectId,
	projectName = "",
	catalog,
}: {
	projectId: string;
	projectName?: string;
	catalog: Catalog;
} = $props();

let nodes = $state<DesignNode[]>([]);
let messages = $state<DesignMessage[]>([]);
// Optimistic messages shown while a turn is in flight. The background poll
// replaces `messages` with the (lagging) server list, so keeping these apart
// stops the user's own bubble from vanishing mid-turn.
let pending = $state<DesignMessage[]>([]);
let loading = $state(true);
let error = $state("");
let selectedId = $state("");
let draft = $state("");
let model = $state("");
let zoom = $state(1);
let panX = $state(48);
let panY = $state(48);
let theme = $state<"light" | "dark">("light");
let deleteTarget = $state<DesignNode | null>(null);
let deleteOpen = $state(false);
let publishing = $state(false);
let sending = $state(false);
let thinking = $state(false);
let pendingQuestion = $state<Question | null>(null);
/** Live "what is the agent reading/doing" per generating node, keyed by id. */
let activity = $state<Record<string, DesignActivity>>({});
let surface = $state<HTMLDivElement>();
let scroller = $state<HTMLDivElement>();
let disposed = false;
let timer: ReturnType<typeof setTimeout>;
const frames: Record<DesignViewport, { width: number; height: number }> = {
	desktop: { width: 1440, height: 900 },
	mobile: { width: 390, height: 844 },
};

const selected = $derived(nodes.find((node) => node.id === selectedId) ?? null);
const busyNodes = $derived(
	nodes.filter(
		(node) => node.status === "queued" || node.status === "generating",
	),
);
const activeNodeId = $derived(
	selected?.status === "ready" ? selected.id : (busyNodes[0]?.id ?? ""),
);
const threadMessages = $derived(
	[...messages, ...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
);
const selectedModel = $derived(
	catalog.models.find((item) => `${item.providerID}/${item.modelID}` === model),
);
const unsupportedModel = $derived(
	Boolean(model && (!selectedModel || selectedModel.designSupported === false)),
);
const workingNode = $derived(
	nodes.find(
		(node) =>
			node.id === activeNodeId &&
			(node.status === "queued" || node.status === "generating"),
	) ?? null,
);

function modelRef() {
	if (unsupportedModel) return undefined;
	if (selectedModel?.openCodeProviderID && selectedModel.openCodeModelID)
		return {
			providerID: selectedModel.openCodeProviderID,
			modelID: selectedModel.openCodeModelID,
		};
	const slash = model.indexOf("/");
	if (slash <= 0) return undefined;
	return {
		providerID: model.slice(0, slash),
		modelID: model.slice(slash + 1),
	};
}

function durationLabel(ms: number | null) {
	if (!ms) return "";
	const seconds = Math.round(ms / 1000);
	return seconds < 60
		? `Worked for ${seconds}s`
		: `Worked for ${Math.round(seconds / 60)}m`;
}

function statusLabel(status: string) {
	if (status === "queued") return "Queued";
	if (status === "generating") return "Generating";
	if (status === "failed") return "Failed";
	return "Ready";
}

function scaleOf(node: DesignNode) {
	const frame = frames[node.viewport === "mobile" ? "mobile" : "desktop"];
	return node.width / frame.width;
}

const PREVIEW_GUARD =
	"<style>html,body{overflow-x:hidden}html{scrollbar-width:none}::-webkit-scrollbar{width:0;height:0;display:none}</style>";
const DARK_STYLE =
	"<style>html{filter:invert(1) hue-rotate(180deg);background:#0b0b0d}img,video,canvas{filter:invert(1) hue-rotate(180deg)}</style>";

function injectHead(html: string, style: string) {
	if (!html) return html;
	return /<\/head>/i.test(html)
		? html.replace(/<\/head>/i, `${style}</head>`)
		: `${style}${html}`;
}

function previewSrcdoc(html: string) {
	let doc = injectHead(html, PREVIEW_GUARD);
	if (theme === "dark") doc = injectHead(doc, DARK_STYLE);
	return doc;
}

async function load() {
	if (!projectId) {
		nodes = [];
		messages = [];
		pending = [];
		loading = false;
		return;
	}
	try {
		const thread = await daemon.listDesigns(projectId);
		if (disposed) return;
		nodes = thread.nodes;
		messages = thread.messages;
		if (!nodes.some((node) => node.id === selectedId))
			selectedId = nodes.at(-1)?.id ?? "";
		error = "";
	} catch (reason) {
		if (!disposed)
			error =
				reason instanceof Error ? reason.message : "Unable to load designs";
	} finally {
		if (!disposed) loading = false;
	}
}

function schedule() {
	if (disposed) return;
	timer = setTimeout(
		async () => {
			await load();
			schedule();
		},
		busyNodes.length ? 1500 : 5000,
	);
}

onMount(() => {
	if (typeof localStorage !== "undefined")
		model = localStorage.getItem("loom.design.model") ?? "";
	schedule();
});

onDestroy(() => {
	disposed = true;
	clearTimeout(timer);
});

$effect(() => {
	if (typeof localStorage === "undefined" || !model) return;
	localStorage.setItem("loom.design.model", model);
});

$effect(() => {
	void projectId;
	void load();
});

$effect(() => {
	void threadMessages.length;
	void (async () => {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
	})();
});

// Poll each generating node's activity so the chat can say what it is reading.
$effect(() => {
	const ids = busyNodes.map((node) => node.id).join(",");
	if (!ids) {
		activity = {};
		return;
	}
	let stop = false;
	const poll = async () => {
		const next: Record<string, DesignActivity> = {};
		await Promise.all(
			busyNodes.map(async (node) => {
				try {
					const found = await daemon.designSteps(node.id);
					if (found) next[node.id] = found;
				} catch {
					/* ignore transient poll errors */
				}
			}),
		);
		if (!stop) activity = next;
	};
	void poll();
	const interval = setInterval(() => void poll(), 1200);
	return () => {
		stop = true;
		clearInterval(interval);
	};
});

type DesignSend = {
	text: string;
	files: string[];
	attachments?: ChatAttachment[];
};

function toAttachments(items?: ChatAttachment[]) {
	return (items ?? []).map((item) => ({
		filename: item.filename,
		mime: item.mime,
		data: item.data,
	}));
}

/**
 * The composer is now a real chat: every message goes through the design agent,
 * which decides whether to answer, ask a clarifying question, or draw a node.
 */
async function handleSend(input: DesignSend): Promise<boolean> {
	if (!projectId) {
		toast.error("Add a project before using the design agent.");
		return false;
	}
	const text = input.text.trim();
	if (!text) return false;
	if (unsupportedModel) {
		toast.error("This model is not supported by the OpenCode design agent.");
		return false;
	}
	const target =
		selected && selected.html && selected.status === "ready" ? selected : null;
	const optimistic: DesignMessage = {
		id: `pending-${Date.now()}`,
		projectId,
		nodeId: target?.id ?? null,
		role: "user",
		text,
		model: model || null,
		errorMessage: null,
		durationMs: null,
		createdAt: new Date().toISOString(),
	};
	pending = [...pending, optimistic];
	sending = true;
	thinking = true;
	pendingQuestion = null;
	try {
		const result = await daemon.designChat(projectId, {
			message: text,
			...(target ? { nodeId: target.id } : {}),
			files: input.files,
			attachments: toAttachments(input.attachments),
			...(modelRef() ? { model: modelRef() } : {}),
		});
		if (result.kind === "design") selectedId = result.nodeId;
		else if (result.kind === "question") pendingQuestion = result.question;
		await load();
		pending = [];
		return true;
	} catch (reason) {
		toast.error(
			reason instanceof Error
				? reason.message
				: "The design agent could not respond",
		);
		await load();
		pending = [];
		return false;
	} finally {
		sending = false;
		thinking = false;
	}
}

/** A questionnaire answer is sent back as the user's next message. */
async function answerQuestion(answers: string[][]): Promise<void> {
	const question = pendingQuestion;
	pendingQuestion = null;
	if (!question) return;
	const text = question.questions
		.map((item, index) => `${item.question} ${(answers[index] ?? []).join(", ")}`)
		.filter((line) => line.trim())
		.join("\n");
	if (text) await handleSend({ text, files: [], attachments: [] });
}

async function retry(node: DesignNode) {
	try {
		await daemon.retryDesign(node.id);
		selectedId = node.id;
		await load();
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Retry failed");
	}
}

function askRemove(node: DesignNode) {
	deleteTarget = node;
	deleteOpen = true;
}

async function remove(node: DesignNode | null = deleteTarget) {
	if (!node) return;
	deleteOpen = false;
	deleteTarget = null;
	try {
		await daemon.deleteDesign(node.id);
		if (selectedId === node.id) selectedId = "";
		await load();
		toast.success("Design removed");
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Delete failed");
	}
}

async function publish(node: DesignNode | null) {
	if (node?.status !== "ready") {
		toast.error("Generate a design before publishing it.");
		return;
	}
	publishing = true;
	try {
		const result = await daemon.publishDesign(node.id);
		toast.success(`Published to ${result.path}`);
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Publish failed");
	} finally {
		publishing = false;
	}
}

async function clearAll() {
	try {
		await daemon.clearDesigns(projectId);
		selectedId = "";
		await load();
		toast.success("Canvas cleared");
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Clear failed");
	}
}

/* ---------- canvas interaction: pan, zoom, node drag ---------- */

let panning: { x: number; y: number; panX: number; panY: number } | null = null;
let dragging: {
	id: string;
	x: number;
	y: number;
	left: number;
	top: number;
} | null = null;

function surfaceDown(event: PointerEvent) {
	if (event.button !== 0) return;
	panning = { x: event.clientX, y: event.clientY, panX, panY };
}

function nodeDown(event: PointerEvent, node: DesignNode) {
	event.stopPropagation();
	if (event.button !== 0) return;
	selectedId = node.id;
	dragging = {
		id: node.id,
		x: event.clientX,
		y: event.clientY,
		left: node.x,
		top: node.y,
	};
}

/**
 * Builds a self-contained HTML page that previews a generated design in a real
 * browser tab, with Desktop/Mobile and Light/Dark toggles so the result can be
 * checked responsively. The design document is injected into a sandboxed iframe
 * at runtime (via srcdoc) so its own markup never collides with this shell.
 */
function previewShellHtml(node: DesignNode): string {
	const title = node.title.replace(/[&<>]/g, (ch) =>
		ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;",
	);
	// JSON.stringify leaves `<` untouched, so a closing script tag inside the
	// design would end this shell's own inline script early and leak the JS as
	// visible text. Escaping `<` to \u003c keeps it inert for the HTML parser
	// while the JS string still evaluates back to the real markup.
	const doc = JSON.stringify(node.html).replace(/</g, "\\u003c");
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Loom preview</title>
<style>
*{box-sizing:border-box}body{margin:0;font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#18181b;color:#e4e4e7}
.bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;background:#27272a;border-bottom:1px solid #3f3f46}
.bar .t{font-weight:600;margin-right:auto;max-width:44vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp{display:flex;border:1px solid #52525b;border-radius:8px;overflow:hidden}
.grp button{border:0;background:transparent;color:#e4e4e7;padding:6px 12px;font:inherit;cursor:pointer}
.grp button.on{background:#fafafa;color:#18181b}
.stage{display:flex;justify-content:center;align-items:flex-start;padding:24px}
.frame{transform-origin:top center;border:0;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.45)}
</style></head>
<body>
<div class="bar"><span class="t">${title}</span>
<div class="grp" id="v"><button data-v="desktop" class="on">Desktop</button><button data-v="mobile">Mobile</button></div>
<div class="grp" id="th"><button data-th="light" class="on">Light</button><button data-th="dark">Dark</button></div>
</div>
<div class="stage" id="s"><iframe class="frame" id="f" title="Design preview" sandbox="allow-scripts"></iframe></div>
<script>
var DOC=${doc},v="desktop",th="light",S={desktop:[1440,900],mobile:[390,844]};
var GUARD='<style>html,body{overflow-x:hidden}html{scrollbar-width:none}::-webkit-scrollbar{width:0;height:0;display:none}</style>';
var DARK='<style>html{filter:invert(1) hue-rotate(180deg);background:#0b0b0d}img,video,canvas{filter:invert(1) hue-rotate(180deg)}</style>';
function inject(doc,style){return /<\\/head>/i.test(doc)?doc.replace(/<\\/head>/i,style+'</head>'):style+doc;}
function apply(){var f=document.getElementById('f'),doc=inject(DOC,GUARD);
if(th==='dark')doc=inject(doc,DARK);
f.setAttribute('srcdoc',doc);var w=S[v][0],h=S[v][1];f.style.width=w+'px';f.style.height=h+'px';
var st=document.getElementById('s'),k=Math.min(1,(st.clientWidth-48)/w,(window.innerHeight-120)/h);
f.style.transform='scale('+k+')';st.style.height=(h*k+48)+'px';}
document.getElementById('v').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;v=b.dataset.v;[].forEach.call(this.children,function(c){c.classList.toggle('on',c===b)});apply();});
document.getElementById('th').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;th=b.dataset.th;[].forEach.call(this.children,function(c){c.classList.toggle('on',c===b)});apply();});
window.addEventListener('resize',apply);apply();
<\/script>
</body></html>`;
}

function openPreview() {
	const node = selected ?? nodes.at(-1) ?? null;
	if (!node || node.status !== "ready" || !node.html) {
		toast.error("Generate a design before opening the preview.");
		return;
	}
	const url = URL.createObjectURL(
		new Blob([previewShellHtml(node)], { type: "text/html" }),
	);
	const opened = window.open(url, "_blank", "noopener");
	if (!opened)
		toast.error("The preview tab was blocked. Allow pop-ups and try again.");
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function focusChat() {
	const el = document.getElementById("design-composer-input");
	if (el) el.focus();
}

function pointerMove(event: PointerEvent) {
	if (panning) {
		panX = panning.panX + (event.clientX - panning.x);
		panY = panning.panY + (event.clientY - panning.y);
		return;
	}
	const drag = dragging;
	if (!drag) return;
	const node = nodes.find((item) => item.id === drag.id);
	if (!node) return;
	nodes = nodes.map((item) =>
		item.id === drag.id
			? {
					...item,
					x: Math.round(drag.left + (event.clientX - drag.x) / zoom),
					y: Math.round(drag.top + (event.clientY - drag.y) / zoom),
				}
			: item,
	);
}

async function pointerUp() {
	const moved = dragging;
	dragging = null;
	panning = null;
	if (!moved) return;
	const node = nodes.find((item) => item.id === moved.id);
	if (!node) return;
	try {
		await daemon.patchDesign(node.id, { x: node.x, y: node.y });
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to save position",
		);
	}
}

function zoomBy(delta: number) {
	zoom = Math.min(2, Math.max(0.25, Math.round((zoom + delta) * 100) / 100));
}

function fit() {
	if (!nodes.length || !surface) {
		zoom = 1;
		panX = 48;
		panY = 48;
		return;
	}
	const minX = Math.min(...nodes.map((node) => node.x));
	const minY = Math.min(...nodes.map((node) => node.y));
	const maxX = Math.max(...nodes.map((node) => node.x + node.width));
	const maxY = Math.max(...nodes.map((node) => node.y + node.height));
	const boxWidth = maxX - minX;
	const boxHeight = maxY - minY;
	const next = Math.min(
		1,
		(surface.clientWidth - 96) / boxWidth,
		(surface.clientHeight - 96) / boxHeight,
	);
	zoom = Math.round(Math.max(0.25, next) * 100) / 100;
	panX = (surface.clientWidth - boxWidth * zoom) / 2 - minX * zoom;
	panY = (surface.clientHeight - boxHeight * zoom) / 2 - minY * zoom;
}

function wheel(event: WheelEvent) {
	if (!event.ctrlKey && !event.metaKey) return;
	event.preventDefault();
	zoomBy(event.deltaY > 0 ? -0.1 : 0.1);
}
</script>

<div class="flex min-h-0 flex-1 overflow-hidden" role="group" aria-label="Design workspace" onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp}>
	<!-- Design context rail -->
	<aside class="hidden w-[260px] shrink-0 flex-col border-r bg-card/40 lg:flex" aria-label="Design context">
		<div class="border-b p-4">
			<p class="flex items-center gap-2 text-sm font-medium"><Layers size={15} class="text-teal-300" />Design Context</p>
			<p class="mt-2 text-xs leading-5 text-muted-foreground">Every generation becomes a node on the canvas. Pick a node to preview it, refine it, or publish the HTML into your project.</p>
		</div>
		<div class="flex items-center justify-between px-4 py-3">
			<p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Design nodes</p>
			<Badge variant="outline">{nodes.length}</Badge>
		</div>
		<div class="nice-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4">
			{#if !nodes.length}
				<div class="rounded-lg border border-dashed p-4 text-center">
					<Sparkles size={18} class="mx-auto mb-2 text-muted-foreground" />
					<p class="text-xs text-muted-foreground">No nodes yet. Describe a screen in the chat to generate your first UI.</p>
				</div>
			{:else}
				<div class="space-y-1">
					{#each nodes as node (node.id)}
						<Button variant="ghost" class={`h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-left ${node.id === selectedId ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`} onclick={() => selectedId = node.id}>
							{#if node.viewport === "mobile"}<Smartphone size={14} />{:else}<Monitor size={14} />{/if}
							<span class="min-w-0 flex-1">
								<span class="block truncate text-xs font-medium">{node.title}</span>
								<span class="block text-[11px] text-muted-foreground">{statusLabel(node.status)}{node.durationMs ? ` · ${durationLabel(node.durationMs).replace("Worked for ", "")}` : ""}</span>
							</span>
							<ChevronRight size={13} class="text-muted-foreground" />
						</Button>
					{/each}
				</div>
			{/if}
		</div>
		<div class="border-t p-3">
			<Button variant="ghost" size="sm" class="w-full justify-start text-xs text-muted-foreground" onclick={clearAll} disabled={!nodes.length}><Trash2 size={13} />Clear canvas</Button>
		</div>
	</aside>

	<!-- Canvas -->
	<div class="relative flex min-w-0 flex-1 flex-col bg-background">
		<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
			<p class="min-w-0 flex-1 truncate text-sm font-medium">{projectName || "Design"} · Design canvas</p>
			<div class="flex items-center rounded-md border p-0.5">
				<Button variant={theme === "light" ? "secondary" : "ghost"} size="icon" class="size-7" aria-label="Light preview" title="Light preview" onclick={() => theme = "light"}><Sun size={13} /></Button>
				<Button variant={theme === "dark" ? "secondary" : "ghost"} size="icon" class="size-7" aria-label="Dark preview" title="Dark preview" onclick={() => theme = "dark"}><Moon size={13} /></Button>
			</div>
		</div>
		<div
			bind:this={surface}
			class="nice-scroll relative min-h-0 flex-1 overflow-hidden"
			role="application"
			aria-label="Design canvas"
			onwheel={wheel}
			onpointerdown={surfaceDown}
			style="background-image: radial-gradient(circle, color-mix(in oklab, currentColor 20%, transparent) 1px, transparent 1px); background-size: 24px 24px;"
		>
			{#if loading}
				<div role="status" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={17} class="animate-spin" />Loading canvas…</div>
			{:else if !nodes.length}
				<div class="flex h-full items-center justify-center p-8">
					<div class="max-w-md rounded-xl border border-dashed bg-card/60 p-8 text-center">
						<Sparkles size={22} class="mx-auto mb-3 text-teal-300" />
						<h2 class="text-base font-medium">Design a screen with your model</h2>
						<p class="mt-2 text-sm text-muted-foreground">Write a brief in the chat panel — for example “landing page for a specialty coffee roaster with menu and order form” — and Loom renders the result as a canvas node.</p>
						{#if error}<p role="alert" class="mt-3 text-xs text-destructive">{error}</p>{/if}
					</div>
				</div>
			{:else}
				<div class="absolute top-0 left-0 origin-top-left" style="transform: translate({panX}px, {panY}px) scale({zoom});">
					{#each nodes as node (node.id)}
						<div
							class="absolute"
							style="left: {node.x}px; top: {node.y}px; width: {node.width}px; height: {node.height}px;"
							onpointerdown={(event) => nodeDown(event, node)}
							role="button"
							tabindex="0"
							onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectedId = node.id; } }}
							aria-label={`${node.title} · ${statusLabel(node.status)}`}
						>
							<!-- Floating title/status label above the card (Stitch-style) -->
							<div class="pointer-events-none absolute bottom-full left-0 flex w-full items-center gap-1.5 pb-1.5">
								{#if node.viewport === "mobile"}<Smartphone size={12} class="shrink-0 text-muted-foreground" />{:else}<Monitor size={12} class="shrink-0 text-muted-foreground" />{/if}
								<p class="min-w-0 flex-1 truncate text-[11px] font-medium">{node.title}</p>
								{#if node.status === "queued" || node.status === "generating"}
									<LoaderCircle size={12} class="shrink-0 animate-spin text-sky-400" />
								{:else if node.status === "failed"}
									<Badge variant="destructive" class="h-4 shrink-0 px-1.5 text-[10px]">Failed</Badge>
								{:else if node.status === "ready"}
									<Badge variant="secondary" class="h-4 shrink-0 px-1.5 text-[10px]">Ready</Badge>
								{/if}
							</div>
							<div class="relative size-full overflow-hidden rounded-xl border bg-card shadow-lg transition-colors {node.id === selectedId ? "border-primary ring-2 ring-primary/30" : "border-muted-foreground/25"}">
								{#if node.html}
									<div class="pointer-events-none absolute top-0 left-0 origin-top-left" style="width: {frames[node.viewport === "mobile" ? "mobile" : "desktop"].width}px; height: {frames[node.viewport === "mobile" ? "mobile" : "desktop"].height}px; transform: scale({scaleOf(node)});">
										<iframe title={`${node.title} preview`} srcdoc={previewSrcdoc(node.html)} sandbox="allow-scripts" class="size-full border-0" loading="lazy" tabindex="-1"></iframe>
									</div>
									{#if node.status === "queued" || node.status === "generating"}
										<div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 text-muted-foreground backdrop-blur-[1px]">
											<LoaderCircle size={18} class="animate-spin" />
											<p class="text-[11px]">Refining this design…</p>
										</div>
									{/if}
								{:else if node.status === "failed"}
									<div class="flex size-full flex-col items-center justify-center gap-2 bg-destructive/5 p-3 text-center">
										<p class="line-clamp-3 text-[11px] text-destructive">{node.errorMessage ?? "Generation failed"}</p>
										<div class="flex gap-1">
											<Button size="sm" variant="outline" class="h-6 text-[11px]" onclick={(event) => { event.stopPropagation(); void retry(node); }}><RefreshCw size={11} />Retry</Button>
											<Button size="sm" variant="ghost" class="h-6 text-[11px]" onclick={(event) => { event.stopPropagation(); askRemove(node); }}><Trash2 size={11} />Delete</Button>
										</div>
									</div>
								{:else}
									<div class="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
										<LoaderCircle size={18} class="animate-spin" />
										<p class="text-[11px]">{node.status === "queued" ? "Waiting for the design agent…" : "Designing your screen…"}</p>
										<p class="max-w-[80%] line-clamp-2 text-center text-[10px]">{node.brief}</p>
									</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
			<div class="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-card/90 p-1 shadow-lg backdrop-blur">
				<Button variant="ghost" size="icon" class="size-7" aria-label="Zoom out" title="Zoom out" onclick={() => zoomBy(-0.15)}><ZoomOut size={14} /></Button>
				<span class="w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
				<Button variant="ghost" size="icon" class="size-7" aria-label="Zoom in" title="Zoom in" onclick={() => zoomBy(0.15)}><ZoomIn size={14} /></Button>
				<Button variant="ghost" size="icon" class="size-7" aria-label="Fit nodes" title="Fit nodes" onclick={fit}><Scan size={14} /></Button>
			</div>
			{#if selected}
				<div class="absolute top-3 left-1/2 flex max-w-[94%] -translate-x-1/2 items-center gap-1 rounded-xl border bg-card/95 py-1 pr-1 pl-2 shadow-lg backdrop-blur">
					<span class="flex min-w-0 items-center gap-1.5 text-[11px] font-medium">
						{#if selected.viewport === "mobile"}<Smartphone size={13} class="shrink-0 text-muted-foreground" />{:else}<Monitor size={13} class="shrink-0 text-muted-foreground" />{/if}
						<span class="max-w-[150px] truncate">{selected.title}</span>
					</span>
					<span class="mx-1 h-5 w-px bg-border"></span>
					<Button variant="secondary" size="sm" class="h-7 gap-1.5 text-[11px]" onclick={focusChat}><Sparkles size={12} />Refine</Button>
					<Button variant="ghost" size="sm" class="h-7 gap-1.5 text-[11px]" onclick={openPreview}><Monitor size={12} /><span class="hidden sm:inline">Preview</span></Button>
					<Button variant="ghost" size="sm" class="h-7 gap-1.5 text-[11px]" onclick={() => publish(selected)} disabled={publishing || selected.status !== "ready"}><Upload size={12} /><span class="hidden sm:inline">Publish</span></Button>
					<span class="mx-1 h-5 w-px bg-border"></span>
					<Button variant="ghost" size="icon" class="size-7" aria-label="Regenerate design" title="Regenerate" onclick={() => void retry(selected)}><RefreshCw size={13} /></Button>
					<Button variant="ghost" size="icon" class="size-7 text-destructive" aria-label="Delete design" title="Delete design" onclick={() => askRemove(selected)}><Trash2 size={13} /></Button>
				</div>
			{/if}
		</div>
	</div>

	<!-- Chat rail -->
	<aside class="flex w-[320px] shrink-0 flex-col border-l bg-card/30 xl:w-[380px]" aria-label="Design chat">
		<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
			<p class="min-w-0 flex-1 truncate text-sm font-medium">Design agent</p>
			{#if busyNodes.length}<Badge variant="outline" class="gap-1"><LoaderCircle size={11} class="animate-spin" />{busyNodes.length} running</Badge>{/if}
		</div>
		<div bind:this={scroller} class="nice-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
			{#if !threadMessages.length}
				<p class="rounded-lg border border-dashed p-4 text-xs leading-5 text-muted-foreground">Chat with the design agent. Say hi, ask about your project, or ask it to build something — “design a checkout flow for a coffee subscription”. It only draws a canvas node when you ask for a screen.</p>
			{/if}
			{#each threadMessages as message (message.id)}
				{#if message.role === "user"}
					<div class="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">{message.text}</div>
				{:else}
					<div class="max-w-[90%]">
						<p class="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">OpenCode agent{message.model ? ` · ${message.model}` : ""}</p>
						{#if message.errorMessage}
							<div class="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs leading-5 text-destructive">{message.errorMessage}</div>
						{:else}
							<div class="rounded-2xl rounded-bl-sm border bg-background px-3 py-2 text-sm">
								<Markdown text={message.text} />
							</div>
							{#if message.durationMs}<p class="mt-1 text-[11px] text-muted-foreground">{durationLabel(message.durationMs)}</p>{/if}
						{/if}
					</div>
				{/if}
			{/each}
			{#if workingNode}
				{@const act = activity[workingNode.id]}
				<div class="max-w-[90%]">
					<p class="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">OpenCode agent</p>
					<div class="rounded-2xl rounded-bl-sm border bg-background px-3 py-2 text-xs text-muted-foreground">
						<div class="flex items-center gap-2">
							<LoaderCircle size={13} class="shrink-0 animate-spin" />
							<span>{act?.phase === "drafting" ? "Drafting the design with your model…" : "Reading your project files and matching its theme…"}</span>
						</div>
						{#if act?.files?.length}
							<p class="mt-2 text-[10px] font-medium uppercase tracking-wider">Read {act.files.length} file{act.files.length === 1 ? "" : "s"}</p>
							<ul class="mt-1 flex flex-wrap gap-1">
								{#each act.files.slice(0, 12) as file (file)}
									<li class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground" title={file}>{file.split("/").pop() ?? file}</li>
								{/each}
								{#if act.files.length > 12}<li class="px-1 text-[10px]">+{act.files.length - 12} more</li>{/if}
							</ul>
						{/if}
					</div>
				</div>
			{/if}
			{#if pendingQuestion}
				<div class="max-w-[95%]">
					<p class="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">OpenCode agent needs a detail</p>
					<QuestionCard question={pendingQuestion} onanswer={answerQuestion} />
				</div>
			{:else if thinking && !workingNode}
				<div class="max-w-[90%]">
					<p class="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">OpenCode agent</p>
					<div class="flex items-center gap-2 rounded-2xl rounded-bl-sm border bg-background px-3 py-2 text-xs text-muted-foreground">
						<LoaderCircle size={13} class="shrink-0 animate-spin" />
						<span>Thinking…</span>
					</div>
				</div>
			{/if}
			{#if error}<p role="alert" class="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>{/if}
		</div>
		<div class="shrink-0 border-t p-3">
			{#if selected?.html}
				<p class="mb-2 truncate text-[11px] text-muted-foreground">Chat or ask for changes to “{selected.title}” — the agent refines it in place.</p>
			{:else}
				<p class="mb-2 text-[11px] text-muted-foreground">Chat with the design agent. Ask for a screen to draw one; use @ for files or paste a screenshot.</p>
			{/if}
			<Composer
				{projectId}
				{catalog}
				busy={false}
				disabled={sending || !projectId}
				bind:draft
				bind:model
				showAgents={false}
				inputId="design-composer-input"
				onsend={handleSend}
				onstop={() => {}}
			/>
			{#if unsupportedModel}<p class="mt-2 text-[11px] text-destructive" role="alert">Selected model is unavailable for the OpenCode design agent.</p>{/if}
		</div>
	</aside>
</div>

<AlertDialog.Root bind:open={deleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete design?</AlertDialog.Title>
			<AlertDialog.Description>“{deleteTarget?.title}” and its design agent messages will be removed permanently.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" onclick={() => void remove()}>Delete design</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
