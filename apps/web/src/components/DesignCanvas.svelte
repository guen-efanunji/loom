<script lang="ts">
import {
	ArrowUp,
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
import type { Catalog } from "$lib/chat";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import { Textarea } from "$lib/components/ui/textarea";
import {
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
let loading = $state(true);
let error = $state("");
let selectedId = $state("");
let draft = $state("");
let viewport = $state<DesignViewport>("desktop");
let model = $state("");
let zoom = $state(1);
let panX = $state(48);
let panY = $state(48);
let theme = $state<"light" | "dark">("light");
let previewNode = $state<DesignNode | null>(null);
let deleteTarget = $state<DesignNode | null>(null);
let deleteOpen = $state(false);
let publishing = $state(false);
let previewOpen = $state(false);
let sending = $state(false);
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
	messages
		.filter((message) => !activeNodeId || message.nodeId === activeNodeId)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
);
const selectedModel = $derived(
	catalog.models.find((item) => `${item.providerID}/${item.modelID}` === model),
);
const modelChoices = $derived(
	catalog.models.map((item) => ({
		value: `${item.providerID}/${item.modelID}`,
		label: item.name,
		supported: item.designSupported !== false,
	})),
);
const unsupportedModel = $derived(
	Boolean(model && (!selectedModel || selectedModel.designSupported === false)),
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

function withTheme(html: string, dark: boolean) {
	if (!html || !dark) return html;
	const style =
		"<style>html{filter:invert(1) hue-rotate(180deg);background:#0b0b0d}img,video,canvas{filter:invert(1) hue-rotate(180deg)}</style>";
	return /<\/head>/i.test(html)
		? html.replace(/<\/head>/i, `${style}</head>`)
		: `${style}${html}`;
}

function previewSrcdoc(html: string) {
	return withTheme(html, theme === "dark");
}

async function load() {
	if (!projectId) {
		nodes = [];
		messages = [];
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

async function createDesign(brief: string) {
	if (!projectId) {
		toast.error("Add a project before generating designs.");
		return;
	}
	if (unsupportedModel) {
		toast.error("This model is not supported by the OpenCode design agent.");
		return;
	}
	const text = brief.trim();
	if (!text) return;
	sending = true;
	try {
		const created = await daemon.createDesign({
			projectId,
			brief: text,
			viewport,
			...(modelRef() ? { model: modelRef() } : {}),
		});
		selectedId = created.nodeId;
		draft = "";
		await load();
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Design failed to start",
		);
	} finally {
		sending = false;
	}
}

async function refineDesign(node: DesignNode, message: string) {
	if (unsupportedModel) {
		toast.error("This model is not supported by the OpenCode design agent.");
		return;
	}
	sending = true;
	try {
		const created = await daemon.refineDesign(node.id, {
			message: message.trim(),
			...(modelRef() ? { model: modelRef() } : {}),
		});
		selectedId = created.nodeId;
		draft = "";
		await load();
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Refine failed");
	} finally {
		sending = false;
	}
}

function submit() {
	const text = draft.trim();
	if (!text || sending) return;
	const target = selected;
	if (target && target.status === "ready") void refineDesign(target, text);
	else void createDesign(text);
}

function keydown(event: KeyboardEvent) {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		submit();
	}
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
		if (previewNode?.id === node.id) {
			previewNode = null;
			previewOpen = false;
		}
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

function openPreview() {
	const node = selected ?? nodes.at(-1) ?? null;
	if (!node) return;
	previewNode = node;
	previewOpen = true;
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
			<Button variant="outline" size="sm" onclick={() => publish(selected)} disabled={publishing || !selected || selected.status !== "ready"}>
				{#if publishing}<LoaderCircle size={14} class="animate-spin" />{:else}<Upload size={14} />{/if}
				<span class="hidden sm:inline">Publish</span>
			</Button>
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
							class="absolute overflow-hidden rounded-xl border bg-card shadow-lg transition-colors {node.id === selectedId ? "border-primary ring-2 ring-primary/30" : "border-muted-foreground/25"}"
							style="left: {node.x}px; top: {node.y}px; width: {node.width}px; height: {node.height}px;"
							onpointerdown={(event) => nodeDown(event, node)}
							role="button"
							tabindex="0"
							onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectedId = node.id; } }}
							aria-label={`${node.title} · ${statusLabel(node.status)}`}
						>
							<div class="flex h-8 items-center gap-2 border-b bg-card px-2">
								{#if node.viewport === "mobile"}<Smartphone size={12} />{:else}<Monitor size={12} />{/if}
								<p class="min-w-0 flex-1 truncate text-[11px] font-medium">{node.title}</p>
								{#if node.status === "queued" || node.status === "generating"}
									<LoaderCircle size={12} class="animate-spin text-sky-400" />
								{:else if node.status === "failed"}
									<Badge variant="destructive" class="h-4 px-1.5 text-[10px]">Failed</Badge>
								{:else}
									<Badge variant="secondary" class="h-4 px-1.5 text-[10px]">Ready</Badge>
								{/if}
							</div>
							<div class="relative h-[calc(100%-2rem)] overflow-hidden bg-white">
								{#if node.status === "ready" && node.html}
									<div class="pointer-events-none absolute top-0 left-0 origin-top-left" style="width: {frames[node.viewport === "mobile" ? "mobile" : "desktop"].width}px; height: {frames[node.viewport === "mobile" ? "mobile" : "desktop"].height}px; transform: scale({scaleOf(node)});">
										<iframe title={`${node.title} preview`} srcdoc={previewSrcdoc(node.html)} sandbox="allow-scripts" class="size-full border-0" loading="lazy" tabindex="-1"></iframe>
									</div>
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
			{#if nodes.length}
				<div class="absolute top-3 right-3 flex items-center gap-1 rounded-lg border bg-card/90 p-1 shadow backdrop-blur">
					<Button variant="ghost" size="sm" class="h-7 text-[11px]" onclick={openPreview}><Monitor size={12} />Open preview</Button>
					{#if selected}<Button variant="ghost" size="icon" class="size-7" aria-label="Retry design" title="Retry design" onclick={() => selected && void retry(selected)}><RefreshCw size={13} /></Button>
					<Button variant="ghost" size="icon" class="size-7 text-destructive" aria-label="Delete design" title="Delete design" onclick={() => selected && askRemove(selected)}><Trash2 size={13} /></Button>{/if}
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
				<p class="rounded-lg border border-dashed p-4 text-xs leading-5 text-muted-foreground">Ask for a UI: “checkout flow for a coffee subscription”, “dashboard for a logistics app”. The result lands on the canvas as a new node, and follow-up messages refine it.</p>
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
							<div class="rounded-2xl rounded-bl-sm border bg-background px-3 py-2 text-sm">{message.text}</div>
							{#if message.durationMs}<p class="mt-1 text-[11px] text-muted-foreground">{durationLabel(message.durationMs)}</p>{/if}
						{/if}
					</div>
				{/if}
			{/each}
			{#if error}<p role="alert" class="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>{/if}
		</div>
		<div class="shrink-0 border-t p-3">
			{#if selected?.status === "ready"}
				<p class="mb-2 truncate text-[11px] text-muted-foreground">Refining “{selected.title}” — changes create a new node next to it.</p>
			{:else}
				<p class="mb-2 text-[11px] text-muted-foreground">Generating a new node with the selected viewport.</p>
			{/if}
			<form onsubmit={(event) => { event.preventDefault(); submit(); }}>
				<div class="rounded-xl border bg-background">
					<Textarea bind:value={draft} onkeydown={keydown} rows={3} aria-label="Design brief" placeholder={selected?.status === "ready" ? "Ask for changes: darker theme, add pricing section…" : "Describe the UI you want to design…"} class="max-h-40 min-h-16 resize-none border-0 bg-transparent p-3 text-sm shadow-none focus-visible:ring-0" disabled={sending || !projectId} />
					<div class="flex flex-wrap items-center gap-1 border-t px-2 py-2">
						<div class="flex items-center rounded-md border">
							<Button type="button" variant={viewport === "desktop" ? "secondary" : "ghost"} size="icon" class="size-7 rounded-none" aria-label="Desktop viewport" title="Desktop 1440×900" onclick={() => viewport = "desktop"}><Monitor size={13} /></Button>
							<Button type="button" variant={viewport === "mobile" ? "secondary" : "ghost"} size="icon" class="size-7 rounded-none" aria-label="Mobile viewport" title="Mobile 390×844" onclick={() => viewport = "mobile"}><Smartphone size={13} /></Button>
						</div>
						{#if modelChoices.length}
							<div class="min-w-0 flex-1">
								<select bind:value={model} aria-label="Model" class="h-8 w-full min-w-0 truncate rounded-md border bg-background px-2 text-xs">
									<option value="">Default model</option>
									{#each modelChoices as choice}									<option value={choice.value} disabled={!choice.supported}>{choice.label}{choice.supported ? "" : " · unavailable for OpenCode design"}</option>{/each}
								</select>
							</div>
						{:else}
							<span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{catalog.models.length ? "Pick a model" : "No models configured — run opencode auth login"}</span>
						{/if}
						{#if unsupportedModel}<span class="w-full text-[11px] text-destructive" role="alert">Selected provider model is unavailable for the OpenCode design agent.</span>{/if}
						<Button type="submit" size="icon" class="size-8 rounded-full" aria-label={selected?.status === "ready" ? "Send change request" : "Generate design"} disabled={sending || !draft.trim() || !projectId}>
							{#if sending}<LoaderCircle size={15} class="animate-spin" />{:else}<ArrowUp size={15} />{/if}
						</Button>
					</div>
				</div>
			</form>
			<p class="mt-2 text-center text-[10px] text-muted-foreground">Enter to send · Shift + Enter for a new line</p>
		</div>
	</aside>
</div>

<Dialog.Root bind:open={previewOpen}>
	<Dialog.Content class="flex max-h-[90svh] flex-col overflow-hidden sm:max-w-6xl">
		<Dialog.Header>
			<Dialog.Title class="truncate pr-8">{previewNode?.title ?? "Design preview"}</Dialog.Title>
			<Dialog.Description>{previewNode ? `${previewNode.viewport === "mobile" ? "390 × 844" : "1440 × 900"} · ${statusLabel(previewNode.status)}` : ""}</Dialog.Description>
		</Dialog.Header>
		{#if previewNode}
			<div class="min-h-0 flex-1 overflow-auto rounded-lg border bg-white">
				<iframe title={`${previewNode.title} full preview`} srcdoc={previewSrcdoc(previewNode.html)} sandbox="allow-scripts" class="mx-auto border-0" style="width: {frames[previewNode.viewport === "mobile" ? "mobile" : "desktop"].width}px; height: {frames[previewNode.viewport === "mobile" ? "mobile" : "desktop"].height}px;"></iframe>
			</div>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => previewNode && void publish(previewNode)} disabled={publishing}><Upload size={14} />Publish to project</Button>
				<Button onclick={() => previewNode && void refineDesign(previewNode, draft.trim() || "Make this design feel more polished")}>Refine</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

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
