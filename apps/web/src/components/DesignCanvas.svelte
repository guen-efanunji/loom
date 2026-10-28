<script lang="ts">
import { DESIGN_FRAME_PRESETS, type DesignFrame } from "@loom/protocol";
import {
	ChevronRight,
	Copy,
	Frame,
	Layers,
	LoaderCircle,
	Monitor,
	Moon,
	MousePointerClick,
	Pencil,
	RefreshCw,
	Scan,
	Smartphone,
	Sparkles,
	Sun,
	Trash2,
	Upload,
	X,
	ZoomIn,
	ZoomOut,
} from "@lucide/svelte";
import { onDestroy, onMount, tick } from "svelte";
import { toast } from "svelte-sonner";
import type { Catalog, ChatAttachment, Question } from "$lib/chat";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import * as Popover from "$lib/components/ui/popover/index.js";
import {
	type DesignActivity,
	type DesignMessage,
	type DesignNode,
	daemon,
} from "$lib/daemon";
import Composer from "./chat/Composer.svelte";
import Markdown from "./chat/Markdown.svelte";
import QuestionCard from "./chat/QuestionCard.svelte";

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
let selectedByUser = $state(false);
/** Multi-selection (shift-click / marquee); drives the bulk-refine toolbar. */
let selectedIds = $state<string[]>([]);
/** Id of the node whose iframe element picker is armed ("" = off). */
let elementPick = $state("");
let renaming = $state(false);
let renameDraft = $state("");
let deleteTarget = $state<DesignNode | null>(null);
let deleteOpen = $state(false);
let clearOpen = $state(false);
let publishTarget = $state<DesignNode | null>(null);
let publishOpen = $state(false);
let refiningNodeId = $state("");
let draft = $state("");
let model = $state("");
let zoom = $state(1);
let panX = $state(48);
let panY = $state(48);
let theme = $state<"light" | "dark">("light");
let publishing = $state(false);
let sending = $state(false);
let thinking = $state(false);
let pendingQuestion = $state<Question | null>(null);
/** Live "what is the agent reading/doing" per generating node, keyed by id. */
let activity = $state<Record<string, DesignActivity>>({});
let decidingPermission = $state("");
let loadRequest = 0;
let surface = $state<HTMLDivElement>();
let scroller = $state<HTMLDivElement>();
/**
 * Sticky scroll: only yank the chat to the bottom when the reader is already
 * near it. Reading history disables it; sending a message re-enables it.
 */
let follow = $state(true);
/** Design context rail visibility; collapsible, overlays the canvas below lg. */
let railOpen = $state(true);
/** Design chat visibility; collapsible, becomes a drawer below xl. */
let chatOpen = $state(true);
let disposed = false;
let timer: ReturnType<typeof setTimeout>;
/** Marquee drag box (surface coordinates) while rubber-band selecting. */
let marquee: { x: number; y: number } | null = null;
let marqueeBox = $state<{
	left: number;
	top: number;
	width: number;
	height: number;
} | null>(null);
/** Iframe window id: how the pick protocol addresses each node's document. */
function safeFrameId(id: string) {
	return id.replace(/[^\w-]/g, "");
}
/** Pick protocol reports sanitized ids back; resolve them to real nodes. */
function nodeBySafe(safe: unknown) {
	return nodes.find((node) => safeFrameId(node.id) === safe) ?? null;
}
/** Design space a node was drawn for; legacy rows fall back to web/mobile. */
function frameOf(node: DesignNode) {
	return {
		width: node.frameWidth || (node.viewport === "mobile" ? 390 : 1440),
		height: node.frameHeight || (node.viewport === "mobile" ? 844 : 900),
	};
}

const selected = $derived(nodes.find((node) => node.id === selectedId) ?? null);
const busyNodes = $derived(
	nodes.filter(
		(node) => node.status === "queued" || node.status === "generating",
	),
);
const threadMessages = $derived(
	[
		...messages,
		...pending.filter(
			(item) =>
				!messages.some(
					(saved) =>
						saved.role === "user" &&
						saved.text === item.text &&
						Math.abs(Date.parse(saved.createdAt) - Date.parse(item.createdAt)) <
							10_000,
				),
		),
	].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
);
const selectedModel = $derived(
	catalog.models.find((item) => `${item.providerID}/${item.modelID}` === model),
);
const unavailableModel = $derived(Boolean(model && !selectedModel));
const designAgentLabel = $derived(
	selectedModel?.provider ?? selectedModel?.providerID ?? "Design assistant",
);
function modelRef() {
	if (unavailableModel) return undefined;
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

function permissionCommand(args: Record<string, unknown>) {
	for (const key of ["CommandLine", "command", "cmd", "script"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return JSON.stringify(args, null, 2);
}

async function decideDesignPermission(
	nodeId: string,
	permissionId: string,
	decision: "allow_once" | "allow" | "deny",
) {
	if (decidingPermission) return;
	decidingPermission = permissionId;
	try {
		await daemon.decideDesignPermission(nodeId, permissionId, decision);
		const updated = await daemon.designSteps(nodeId);
		if (updated) activity = { ...activity, [nodeId]: updated };
		toast.success(
			decision === "deny"
				? "Permission denied"
				: decision === "allow"
					? "Permission allowed for this design run"
					: "Permission allowed once",
		);
	} catch (cause) {
		toast.error(
			cause instanceof Error ? cause.message : "Unable to update permission",
		);
	} finally {
		decidingPermission = "";
	}
}

function statusLabel(status: string) {
	if (status === "queued") return "Queued";
	if (status === "generating") return "Generating";
	if (status === "failed") return "Failed";
	return "Ready";
}

function scaleOf(node: DesignNode) {
	const frame = frameOf(node);
	return Math.min(node.width / frame.width, node.height / frame.height);
}

function frameStyle(node: DesignNode) {
	const frame = frameOf(node);
	const scale = scaleOf(node);
	return `width:${frame.width}px;height:${frame.height}px;left:${(node.width - frame.width * scale) / 2}px;top:${(node.height - frame.height * scale) / 2}px;transform:scale(${scale})`;
}

/** Nearest canvas preset for the node's current ratio, for the picker label. */
function frameTitle(node: DesignNode) {
	const frame = frameOf(node);
	const preset = DESIGN_FRAME_PRESETS.find(
		(item) => item.width === frame.width && item.height === frame.height,
	);
	return `${preset?.label ?? "Custom"} · ${frame.width}×${frame.height}`;
}

async function applyFrame(node: DesignNode, frame: DesignFrame) {
	const size = cardSizeFor(frame);
	nodes = nodes.map((item) =>
		item.id === node.id
			? {
					...item,
					frameKind: frame.kind,
					frameWidth: frame.width,
					frameHeight: frame.height,
					viewport: frame.height > frame.width ? "mobile" : "desktop",
					width: size.width,
					height: size.height,
				}
			: item,
	);
	try {
		await daemon.patchDesign(node.id, { frame });
	} catch (reason) {
		toast.error(
			reason instanceof Error ? reason.message : "Unable to change the canvas",
		);
		await load();
	}
}

/** Card footprint matching a frame's ratio, mirroring the server's sizing. */
function cardSizeFor(frame: DesignFrame) {
	const ratio = frame.width / frame.height;
	if (ratio >= 1)
		return {
			width: 420,
			height: Math.min(620, Math.max(160, Math.round(420 / ratio))),
		};
	return {
		width: Math.min(620, Math.max(160, Math.round(476 * ratio))),
		height: 476,
	};
}

let customWidth = $state("");
let customHeight = $state("");

function applyCustomFrame(node: DesignNode) {
	const width = Number.parseInt(customWidth, 10);
	const height = Number.parseInt(customHeight, 10);
	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		toast.error("Enter both a width and a height in pixels.");
		return;
	}
	void applyFrame(node, { kind: "custom", width, height });
	customWidth = "";
	customHeight = "";
}

/** Grow the card to the document's real height so nothing is cut off. */
function fitNodeToContent(node: DesignNode, contentHeight: number) {
	if (handSized.has(node.id)) return;
	const frame = frameOf(node);
	const wanted = Math.max(
		frame.height,
		Math.min(8192, Math.round(contentHeight)),
	);
	const scale = node.width / frame.width;
	const next = Math.min(4096, Math.max(120, Math.round(wanted * scale)));
	if (Math.abs(next - node.height) <= 6) return;
	nodes = nodes.map((item) =>
		item.id === node.id ? { ...item, height: next } : item,
	);
	void daemon.patchDesign(node.id, { height: next }).catch(() => undefined);
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

/**
 * Reports the document's real height back to the canvas so a long page grows
 * its card instead of being cut off at the frame height.
 */
/**
 * Element picker injected into every node document (like the height reporter).
 * The parent arms/disarms it via a `design-pick` postMessage; while armed it
 * outlines the hovered element and sends its descriptor back on click — that
 * descriptor pre-fills the composer as an inline refine brief.
 */
function pickerScript(safe: string) {
	return `<script>(function(){var ID="${safe}";var act=false,cur=null,box=null,tip=null;
function ensure(){if(box)return;box=document.createElement("div");box.style.cssText="position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;display:none;border:2px solid #06b6d4;background:rgba(6,182,212,.10)";document.documentElement.appendChild(box);}
function tipOn(){if(tip)return;tip=document.createElement("div");tip.style.cssText="position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#06b6d4;color:#04212e;font:600 12px/1.2 system-ui,sans-serif;padding:6px 14px;border-radius:999px;box-shadow:0 2px 12px rgba(0,0,0,.35)";tip.textContent="Click an element to refine it — Esc to cancel";document.documentElement.appendChild(tip);}
function stop(){act=false;document.removeEventListener("mousemove",mv,true);document.removeEventListener("click",ck,true);document.removeEventListener("keydown",esc,true);window.removeEventListener("scroll",sc,true);if(box)box.style.display="none";if(tip){tip.remove();tip=null;}cur=null;}
function mark(el){cur=el;var r=el.getBoundingClientRect();if(!r.height&&!r.width)return;ensure();box.style.display="block";box.style.left=r.left+"px";box.style.top=r.top+"px";box.style.width=r.width+"px";box.style.height=r.height+"px";}
function mv(ev){var el=ev.target;if(el&&el!==document.documentElement)mark(el);}
function sc(){if(cur)mark(cur);}
function ck(ev){if(!act)return;ev.preventDefault();ev.stopPropagation();stop();var el=ev.target;var data=el&&el!==document.documentElement?{tag:String(el.tagName||"div").toLowerCase(),cls:typeof el.className==="string"?el.className:"",text:(el.textContent||"").replace(/\\s+/g," ").trim().slice(0,160),html:(el.outerHTML||"").slice(0,1500)}:null;parent.postMessage({loom:"design-element",id:ID,element:data},"*");}
function esc(ev){if(ev.key==="Escape"){stop();parent.postMessage({loom:"design-element",id:ID,element:null},"*");}}
window.addEventListener("message",function(ev){var d=ev.data&&typeof ev.data==="object"?ev.data:null;if(!d||d.loom!=="design-pick")return;if(d.enabled){act=true;tipOn();ensure();cur=null;document.addEventListener("mousemove",mv,true);document.addEventListener("click",ck,true);document.addEventListener("keydown",esc,true);window.addEventListener("scroll",sc,true);}else stop();});
window.parent.postMessage({loom:"design-picker-ready",id:ID},"*");})();<\/script>`;
}

function measureSrcdoc(id: string, html: string) {
	const safe = id.replace(/[^\w-]/g, "");
	const script =
		`<script>(function(){var last=0;function send(){var h=Math.ceil(document.documentElement.scrollHeight)||0;if(h===last)return;last=h;parent.postMessage({loom:"design-height",id:"${safe}",height:h},"*")}` +
		`addEventListener("load",send);if(window.ResizeObserver){try{new ResizeObserver(send).observe(document.documentElement)}catch(e){}}` +
		"setTimeout(send,200);setTimeout(send,1500)})()<\/script>";
	return injectHead(previewSrcdoc(html), script + pickerScript(safe));
}

function onDesignMessage(event: MessageEvent) {
	const data = event.data as
		| {
				loom?: string;
				id?: string;
				height?: number;
				element?: {
					tag?: string;
					cls?: string;
					text?: string;
					html?: string;
				} | null;
		  }
		| undefined;
	if (typeof data?.id !== "string") return;
	const node = nodeBySafe(data.id);
	if (data.loom === "design-height") {
		if (typeof data.height !== "number") return;
		if (node?.status !== "ready") return;
		fitNodeToContent(node, data.height);
		return;
	}
	if (node?.status !== "ready") return;
	// A (re)loaded node document announces its picker; re-arm if the user was
	// already in pick mode (e.g. the document reloaded on a theme flip).
	if (data.loom === "design-picker-ready") {
		if (elementPick === node.id) pushPick(node.id, true);
		return;
	}
	if (data.loom === "design-element") {
		const element = data.element ?? null;
		elementPick = "";
		if (!element?.tag) return;
		promptElementRefine(node, element);
	}
}

/** Sends the pick mode arm/disarm into a node's iframe document. */
function pushPick(id: string, enabled: boolean) {
	const frame = document.getElementById(`design-iframe-${safeFrameId(id)}`);
	if (frame instanceof HTMLIFrameElement)
		frame.contentWindow?.postMessage({ loom: "design-pick", enabled }, "*");
}

let pickPushed = "";
$effect(() => {
	const active = elementPick;
	if (pickPushed && pickPushed !== active) pushPick(pickPushed, false);
	if (active) pushPick(active, true);
	pickPushed = active;
});

function toggleElementPick() {
	const node = selected;
	if (node?.status !== "ready" || !node.html) return;
	elementPick = elementPick === node.id ? "" : node.id;
}

/**
 * An element picked inside the iframe seeds the composer with a targeted
 * refine brief. The user finishes the "Change: ..." sentence and sends — the
 * turn goes to the design agent as an inline refine of that node.
 */
function promptElementRefine(
	node: DesignNode,
	element: { tag?: string; cls?: string; text?: string; html?: string },
) {
	selectedId = node.id;
	selectedByUser = true;
	selectedIds = [];
	refiningNodeId = node.id;
	follow = true;
	const classes = (element.cls ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 3)
		.join(".");
	const label = classes ? `${element.tag}.${classes}` : (element.tag ?? "part");
	const snippet = (element.html ?? "").trim().slice(0, 1200);
	draft = `Refine only the “${label}” part of this design — keep everything else exactly as it is. If the part carries text, reuse its wording as the baseline:\n\n${(element.text ?? "").slice(0, 160)}\n\nMarkup:\n${snippet}\n\nChanges: `;
	void tick().then(() => {
		document.getElementById("design-composer-input")?.focus();
	});
}

async function load() {
	const request = ++loadRequest;
	const currentProject = projectId;
	if (!currentProject) {
		nodes = [];
		messages = [];
		pending = [];
		loading = false;
		return;
	}
	try {
		const thread = await daemon.listDesigns(currentProject);
		if (disposed || request !== loadRequest || currentProject !== projectId)
			return;
		nodes = thread.nodes;
		messages = thread.messages;
		if (!nodes.some((node) => node.id === selectedId)) {
			selectedId = nodes.at(-1)?.id ?? "";
			selectedByUser = false;
			refiningNodeId = "";
		}
		selectedIds = selectedIds.filter((id) =>
			nodes.some((node) => node.id === id),
		);
		error = "";
	} catch (reason) {
		if (!disposed && request === loadRequest && currentProject === projectId)
			error =
				reason instanceof Error ? reason.message : "Unable to load designs";
	} finally {
		if (!disposed && request === loadRequest && currentProject === projectId)
			loading = false;
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
	window.addEventListener("message", onDesignMessage);
	schedule();
	if (typeof window !== "undefined") {
		if (window.matchMedia("(max-width: 1279px)").matches) chatOpen = false;
		if (window.matchMedia("(max-width: 1023px)").matches) railOpen = false;
	}
});

onDestroy(() => {
	disposed = true;
	clearTimeout(timer);
	window.removeEventListener("message", onDesignMessage);
});

$effect(() => {
	if (typeof localStorage === "undefined" || !model) return;
	localStorage.setItem("loom.design.model", model);
});

$effect(() => {
	void projectId;
	handSized.clear();
	void load();
});

// Non-passive wheel listener: see `wheel` above.
$effect(() => {
	const el = surface;
	if (!el) return;
	el.addEventListener("wheel", wheel, { passive: false });
	return () => el.removeEventListener("wheel", wheel);
});

$effect(() => {
	void threadMessages.length;
	if (!follow) return;
	void (async () => {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
	})();
});

/** Keeps following the stream until the reader scrolls away from the bottom. */
function onChatScroll() {
	const el = scroller;
	if (!el) return;
	follow = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

// Poll each generating node's activity so the chat can say what it is reading.
$effect(() => {
	const ids = busyNodes.map((node) => node.id).join(",");
	if (!ids) {
		activity = {};
		return;
	}
	let stop = false;
	let polling = false;
	const poll = async () => {
		if (polling) return;
		polling = true;
		const next: Record<string, DesignActivity> = {};
		try {
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
			if (!stop) activity = { ...activity, ...next };
		} finally {
			polling = false;
		}
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
	if (unavailableModel) {
		toast.error("Selected model is no longer available. Choose another model.");
		return false;
	}
	const target =
		nodes.find(
			(node) =>
				node.id === refiningNodeId && node.html && node.status === "ready",
		) ?? null;
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
	follow = true;
	pendingQuestion = null;
	try {
		const result = await daemon.designChat(projectId, {
			message: text,
			...(target ? { nodeId: target.id } : {}),
			files: input.files,
			attachments: toAttachments(input.attachments),
			...(modelRef() ? { model: modelRef() } : {}),
		});
		if (result.kind === "design") {
			selectedId = result.nodeId;
			selectedByUser = Boolean(target);
			refiningNodeId = "";
		} else if (result.kind === "question") pendingQuestion = result.question;
		thinking = false;
		pending = [];
		void load();
		return true;
	} catch (reason) {
		toast.error(
			reason instanceof Error
				? reason.message
				: "The design agent could not respond",
		);
		thinking = false;
		pending = [];
		void load();
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
		.map(
			(item, index) => `${item.question} ${(answers[index] ?? []).join(", ")}`,
		)
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
		selectedIds = selectedIds.filter((id) => id !== node.id);
		await load();
		toast.success("Design removed");
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Delete failed");
	}
}

function askPublish(node: DesignNode) {
	publishTarget = node;
	publishOpen = true;
}

async function publish(node: DesignNode | null) {
	if (node?.status !== "ready") {
		toast.error("Generate a design before publishing it.");
		return;
	}
	publishOpen = false;
	publishTarget = null;
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

function startRename() {
	const node = selected;
	if (!node) return;
	renameDraft = node.title;
	renaming = true;
}

async function commitRename() {
	if (!renaming) return;
	renaming = false;
	const node = selected;
	if (!node) return;
	const title = renameDraft.trim();
	if (!title || title === node.title) return;
	// Optimistic rename; a failed patch is reverted by the next refresh.
	nodes = nodes.map((item) =>
		item.id === node.id ? { ...item, title } : item,
	);
	try {
		await daemon.patchDesign(node.id, { title });
		toast.success("Design renamed");
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Rename failed");
		await load();
	}
}

/** Re-request the source node's design as a fresh generation. */
async function duplicate(node: DesignNode) {
	if (!node.html) {
		toast.error("Only ready designs can be duplicated.");
		return;
	}
	try {
		const result = await daemon.createDesign({
			projectId,
			brief: `Duplicate the existing screen “${node.title}”. Recreate it faithfully from the reference HTML below — same sections, structure, copy and visual styling:\n\n${node.html.slice(0, 6000)}`,
			viewport: node.viewport,
			frame: {
				kind: node.frameKind,
				width: node.frameWidth || frameOf(node).width,
				height: node.frameHeight || frameOf(node).height,
			},
			...(modelRef() ? { model: modelRef() } : {}),
		});
		selectedId = result.nodeId;
		selectedByUser = true;
		await load();
		toast.success("Duplicated — generating a copy…");
	} catch (reason) {
		toast.error(reason instanceof Error ? reason.message : "Duplicate failed");
	}
}

/**
 * Bulk refine: one chat turn listing every selected node. The design agent
 * supports refining several canvases from a single request, so the ids are
 * embedded in the message and no single nodeId is targeted.
 */
function startBulkRefine() {
	const chosen = nodes.filter(
		(node) => selectedIds.includes(node.id) && node.status === "ready",
	);
	if (!chosen.length) {
		toast.error("Select ready designs to refine them together.");
		return;
	}
	selectedIds = [];
	refiningNodeId = "";
	selectedByUser = true;
	follow = true;
	draft =
		`Refine these ${chosen.length} designs together. Keep their layouts, section structure and visual style consistent across all of them.\nNodes:\n` +
		chosen.map((node) => `- nodeId ${node.id} · “${node.title}”`).join("\n") +
		"\n\nInstruction: ";
	void tick().then(() => {
		document.getElementById("design-composer-input")?.focus();
	});
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
let resizing: {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	frameRatio: number;
} | null = null;
/** Cards the user sized by hand - auto-fit stops respecting them. */
const handSized = new Set<string>();

function surfaceDown(event: PointerEvent) {
	if (event.button !== 0) return;
	// Toolbars (zoom strip, selection actions) live on the canvas surface; a
	// press on them must not start a pan or clear the selection.
	if (
		event.target instanceof Element &&
		event.target.closest("[data-canvas-ui]")
	)
		return;
	// Shift-drag over empty canvas draws a marquee instead of panning, so it
	// can rubber-band a multi-selection without losing the pan gesture.
	if (event.shiftKey) {
		marquee = { x: event.clientX, y: event.clientY };
		return;
	}
	// Clicking empty canvas clears the user's node selection.
	selectedId = "";
	selectedByUser = false;
	selectedIds = [];
	panning = { x: event.clientX, y: event.clientY, panX, panY };
}

function nodeDown(event: PointerEvent, node: DesignNode) {
	event.stopPropagation();
	if (event.button !== 0) return;
	if (event.shiftKey) {
		// Shift-click toggles the node in the bulk (multi) selection.
		selectedIds = selectedIds.includes(node.id)
			? selectedIds.filter((id) => id !== node.id)
			: [...selectedIds, node.id];
		selectedId = node.id;
		selectedByUser = true;
		refiningNodeId = "";
		elementPick = "";
		return;
	}
	if (selectedIds.length) selectedIds = [];
	selectedId = node.id;
	selectedByUser = true;
	refiningNodeId = "";
	elementPick = "";
	dragging = {
		id: node.id,
		x: event.clientX,
		y: event.clientY,
		left: node.x,
		top: node.y,
	};
}

function nodeResizeDown(event: PointerEvent, node: DesignNode) {
	event.stopPropagation();
	if (event.button !== 0) return;
	selectedId = node.id;
	selectedByUser = true;
	const frame = frameOf(node);
	resizing = {
		id: node.id,
		x: event.clientX,
		y: event.clientY,
		width: node.width,
		height: node.height,
		frameRatio: frame.width / frame.height,
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
	const frame = frameOf(node);
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
<div class="grp" id="v"><button data-v="design" class="on">Canvas</button><button data-v="desktop">Desktop</button><button data-v="mobile">Mobile</button></div>
<div class="grp" id="th"><button data-th="light" class="on">Light</button><button data-th="dark">Dark</button></div>
</div>
<div class="stage" id="s"><iframe class="frame" id="f" title="Design preview" sandbox="allow-scripts"></iframe></div>
<script>
var DOC=${doc},v="design",th="light",S={design:[${frame.width},${frame.height}],desktop:[1440,900],mobile:[390,844]};
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
	if (node?.status !== "ready" || !node.html) {
		toast.error("Generate a design before opening the preview.");
		return;
	}
	const url = URL.createObjectURL(
		new Blob([previewShellHtml(node)], { type: "text/html" }),
	);
	// `window.open(..., "noopener")` always returns null by spec, which would
	// trip the "blocked" toast on every click. Open normally and cut the opener
	// link by hand so a null return reliably means a real popup block.
	const opened = window.open(url, "_blank");
	if (opened) opened.opener = null;
	else toast.error("The preview tab was blocked. Allow pop-ups and try again.");
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function focusChat() {
	if (selected?.status !== "ready" || !selected.html) return;
	refiningNodeId = selected.id;
	const el = document.getElementById("design-composer-input");
	if (el) el.focus();
}

function selectNode(id: string) {
	selectedId = id;
	selectedByUser = true;
	refiningNodeId = "";
	elementPick = "";
}

function pointerMove(event: PointerEvent) {
	if (marquee) {
		const base = surface?.getBoundingClientRect();
		if (!base) return;
		marqueeBox = {
			left: Math.min(marquee.x, event.clientX) - base.left,
			top: Math.min(marquee.y, event.clientY) - base.top,
			width: Math.abs(event.clientX - marquee.x),
			height: Math.abs(event.clientY - marquee.y),
		};
		return;
	}
	if (panning) {
		panX = panning.panX + (event.clientX - panning.x);
		panY = panning.panY + (event.clientY - panning.y);
		return;
	}
	const resize = resizing;
	if (resize) {
		const node = nodes.find((item) => item.id === resize.id);
		if (!node) return;
		const width = clampSize(
			resize.width + (event.clientX - resize.x) / zoom,
			160,
			4096,
		);
		// Shift locks the card to the canvas ratio instead of going free-form.
		const height = event.shiftKey
			? clampSize(width / resize.frameRatio, 120, 4096)
			: clampSize(resize.height + (event.clientY - resize.y) / zoom, 120, 4096);
		if (width === node.width && height === node.height) return;
		handSized.add(resize.id);
		nodes = nodes.map((item) =>
			item.id === resize.id ? { ...item, width, height } : item,
		);
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

function clampSize(value: number, min: number, max: number) {
	return Math.round(Math.min(max, Math.max(min, value)));
}

async function pointerUp() {
	const moved = dragging;
	const sized = resizing;
	const drawn = marquee;
	// Marquee commit: convert the drawn box to a multi-selection before any
	// click-interpretation runs.
	if (drawn) {
		const box = marqueeBox;
		marquee = null;
		marqueeBox = null;
		const hits =
			box && box.width * box.height >= 400
				? nodes
						.filter((node) => {
							const left = panX + node.x * zoom;
							const top = panY + node.y * zoom;
							return (
								left < box.left + box.width &&
								left + node.width * zoom > box.left &&
								top < box.top + box.height &&
								top + node.height * zoom > box.top
							);
						})
						.map((node) => node.id)
				: [];
		selectedIds = hits;
		selectedByUser = true;
		selectedId = hits.at(-1) ?? "";
		return;
	}
	dragging = null;
	resizing = null;
	panning = null;
	if (sized && !moved) {
		const node = nodes.find((item) => item.id === sized.id);
		if (!node) return;
		try {
			await daemon.patchDesign(node.id, {
				width: node.width,
				height: node.height,
			});
		} catch (reason) {
			toast.error(
				reason instanceof Error ? reason.message : "Unable to save size",
			);
		}
		return;
	}
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

/**
 * Ctrl/Cmd + wheel zooms; a plain two-finger scroll pans the canvas, so the
 * viewport behaves like a document (content follows the finger). The listener
 * is attached non-passively by an effect below because Svelte binds `onwheel`
 * passively, where `preventDefault` is ignored.
 */
function wheel(event: WheelEvent) {
	if (event.ctrlKey || event.metaKey) {
		event.preventDefault();
		zoomBy(event.deltaY > 0 ? -0.1 : 0.1);
		return;
	}
	if (event.deltaX || event.deltaY) {
		event.preventDefault();
		panX -= event.deltaX;
		panY -= event.deltaY;
	}
}
</script>

<!-- Global shortcuts: Escape deselects; Delete/Backspace removes the selected
node (only when focus is outside form fields and a confirm dialog keeps focus).
Dialogs handle their own Escape, so skip while one is open. -->
<svelte:window
	onkeydown={(event) => {
		if (deleteOpen || clearOpen || publishOpen) return;
		if (event.key === "Escape") {
			if (selectedId || selectedIds.length) {
				selectedId = "";
				selectedIds = [];
				selectedByUser = false;
				elementPick = "";
			}
			return;
		}
		if (event.key !== "Delete" && event.key !== "Backspace") return;
		if (!selected || !selectedByUser || elementPick) return;
		const target = event.target;
		if (
			target instanceof HTMLElement &&
			(target.isContentEditable ||
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.tagName === "SELECT")
		)
			return;
		event.preventDefault();
		askRemove(selected);
	}}
/>

<div
	class="relative flex min-h-0 flex-1 overflow-hidden"
	role="group"
	aria-label="Design workspace"
	onpointermove={pointerMove}
	onpointerup={pointerUp}
	onpointercancel={pointerUp}
>
	<!-- Design context rail: toggled by the header control; below lg it floats
	over the canvas instead of stealing width. -->
	{#if railOpen}
		<aside
			class="flex w-[260px] shrink-0 flex-col border-r bg-card/40 max-lg:absolute max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:w-[240px] max-lg:shadow-2xl max-lg:bg-card"
			aria-label="Design context"
		>
			<div class="flex items-start justify-between gap-2 border-b p-4">
				<div class="min-w-0">
					<p class="flex items-center gap-2 text-sm font-medium">
						<Layers size={15} class="text-teal-300" />Design Context
					</p>
					<p class="mt-2 text-xs leading-5 text-muted-foreground">
						Every generation becomes a node on the canvas. Pick a node to
						preview it, refine it, or publish the HTML into your project.
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon"
					class="size-7 shrink-0 lg:hidden"
					aria-label="Hide design context"
					title="Hide design context"
					onclick={() => (railOpen = false)}><X size={14} /></Button
				>
			</div>
		<div class="flex items-center justify-between px-4 py-3">
			<p
				class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
			>
				Design nodes
			</p>
			<Badge variant="outline">{nodes.length}</Badge>
		</div>
		<div class="nice-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4">
			{#if !nodes.length}
				<div class="rounded-lg border border-dashed p-4 text-center">
					<Sparkles size={18} class="mx-auto mb-2 text-muted-foreground" />
					<p class="text-xs text-muted-foreground">
						No nodes yet. Describe a screen in the chat to generate your first
						UI.
					</p>
				</div>
			{:else}
				<div class="space-y-1">
					{#each nodes as node (node.id)}
						<Button
							variant="ghost"
							class={`h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-left ${node.id === selectedId ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
							onclick={() => selectNode(node.id)}
						>
							{#if node.viewport === "mobile"}<Smartphone
									size={14}
								/>{:else}<Monitor size={14} />{/if}
							<span class="min-w-0 flex-1">
								<span class="block truncate text-xs font-medium"
									>{node.title}</span
								>
								<span class="block text-[11px] text-muted-foreground"
									>{statusLabel(node.status)}{node.durationMs
										? ` · ${durationLabel(node.durationMs).replace("Worked for ", "")}`
										: ""}</span
								>
							</span>
							<ChevronRight size={13} class="text-muted-foreground" />
						</Button>
					{/each}
				</div>
			{/if}
		</div>
		<div class="border-t p-3">
			<Button
				variant="ghost"
				size="sm"
				class="w-full justify-start text-xs text-muted-foreground"
				onclick={() => {
					clearOpen = true;
				}}
				disabled={!nodes.length}><Trash2 size={13} />Clear canvas</Button
			>
		</div>
		</aside>
	{/if}

	<!-- Canvas -->
	<div class="relative flex min-w-0 flex-1 flex-col bg-background">
		<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
			<p class="min-w-0 flex-1 truncate text-sm font-medium">
				{projectName || "Design"} · Design canvas
			</p>
			<Button
				variant="ghost"
				size="icon"
				class="size-7"
				aria-label={railOpen ? "Hide design context" : "Show design context"}
				aria-pressed={railOpen}
				title={railOpen ? "Hide design context" : "Show design context"}
				onclick={() => (railOpen = !railOpen)}><Layers size={14} /></Button
			>
			<div class="flex items-center rounded-md border p-0.5">
				<Button
					variant={theme === "light" ? "secondary" : "ghost"}
					size="icon"
					class="size-7"
					aria-label="Light preview"
					title="Light preview"
					onclick={() => (theme = "light")}><Sun size={13} /></Button
				>
				<Button
					variant={theme === "dark" ? "secondary" : "ghost"}
					size="icon"
					class="size-7"
					aria-label="Dark preview"
					title="Dark preview"
					onclick={() => (theme = "dark")}><Moon size={13} /></Button
				>
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
				<div
					role="status"
					class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
				>
					<LoaderCircle size={17} class="animate-spin" />Loading canvas…
				</div>
			{:else if !nodes.length}
				<div class="flex h-full items-center justify-center p-8">
					<div
						class="max-w-md rounded-xl border border-dashed bg-card/60 p-8 text-center"
					>
						<Sparkles size={22} class="mx-auto mb-3 text-teal-300" />
						<h2 class="text-base font-medium">
							Design a screen with your model
						</h2>
						<p class="mt-2 text-sm text-muted-foreground">
							Write a brief in the chat panel — for example “landing page for a
							specialty coffee roaster with menu and order form” — and Loom
							renders the result as a canvas node.
						</p>
						{#if error}<p role="alert" class="mt-3 text-xs text-destructive">
								{error}
							</p>{/if}
					</div>
				</div>
			{:else}
				<div
					class="absolute top-0 left-0 origin-top-left"
					style="transform: translate({panX}px, {panY}px) scale({zoom});"
				>
					{#each nodes as node (node.id)}
						<div
							class="absolute"
							style="left: {node.x}px; top: {node.y}px; width: {node.width}px; height: {node.height}px;"
							onpointerdown={(event) => nodeDown(event, node)}
							role="button"
							tabindex="0"
							onkeydown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									selectNode(node.id);
								}
							}}
							aria-label={`${node.title} · ${statusLabel(node.status)}`}
						>
							<!-- Floating title/status label above the card (Stitch-style) -->
							<div
								class="pointer-events-none absolute bottom-full left-0 flex w-full items-center gap-1.5 pb-1.5"
							>
								{#if node.viewport === "mobile"}<Smartphone
										size={12}
										class="shrink-0 text-muted-foreground"
									/>{:else}<Monitor
										size={12}
										class="shrink-0 text-muted-foreground"
									/>{/if}
								<p class="min-w-0 flex-1 truncate text-[11px] font-medium">
									{node.title}
								</p>
								{#if node.status === "queued" || node.status === "generating"}
									<LoaderCircle
										size={12}
										class="shrink-0 animate-spin text-sky-400"
									/>
								{:else if node.status === "failed"}
									<Badge
										variant="destructive"
										class="h-4 shrink-0 px-1.5 text-[10px]">Failed</Badge
									>
								{:else if node.status === "ready"}
									<Badge
										variant="secondary"
										class="h-4 shrink-0 px-1.5 text-[10px]">Ready</Badge
									>
								{/if}
							</div>
							<div
								class="relative size-full overflow-hidden rounded-xl border bg-card shadow-lg transition-colors {node.id ===
								selectedId || selectedIds.includes(node.id)
									? 'border-primary ring-2 ring-primary/30'
									: 'border-muted-foreground/25'}"
							>
								{#if node.html}
									<div
										class="absolute origin-top-left {elementPick === node.id
											? 'pointer-events-auto'
											: 'pointer-events-none'}"
										style={frameStyle(node)}
									>
										<iframe
											title={`${node.title} preview`}
											id={`design-iframe-${safeFrameId(node.id)}`}
											srcdoc={measureSrcdoc(node.id, node.html)}
											sandbox="allow-scripts"
											class="size-full border-0"
											loading="lazy"
											tabindex="-1"
										></iframe>
									</div>
									{#if node.id === selectedId}
										<button
											type="button"
											class="absolute right-0 bottom-0 z-10 size-3.5 cursor-nwse-resize touch-none rounded-br-xl bg-primary/70 transition-colors hover:bg-primary"
											aria-label="Resize {node.title}"
											title="Drag to resize · hold Shift to lock the canvas ratio"
											onpointerdown={(event) => nodeResizeDown(event, node)}
										></button>
									{/if}
									{#if node.status === "queued" || node.status === "generating"}
										<div
											class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 text-muted-foreground backdrop-blur-[1px]"
										>
											<LoaderCircle size={18} class="animate-spin" />
											<p class="text-[11px]">
												{refiningNodeId === node.id
													? "Refining this design…"
													: "Regenerating this design…"}
											</p>
										</div>
									{/if}
								{:else if node.status === "failed"}
									<div
										class="flex size-full flex-col items-center justify-center gap-2 bg-destructive/5 p-3 text-center"
									>
										<p class="line-clamp-3 text-[11px] text-destructive">
											{node.errorMessage ?? "Generation failed"}
										</p>
										<div class="flex gap-1">
											<Button
												size="sm"
												variant="outline"
												class="h-6 text-[11px]"
												onclick={(event) => {
													event.stopPropagation();
													void retry(node);
												}}><RefreshCw size={11} />Retry</Button
											>
											<Button
												size="sm"
												variant="ghost"
												class="h-6 text-[11px]"
												onclick={(event) => {
													event.stopPropagation();
													askRemove(node);
												}}><Trash2 size={11} />Delete</Button
											>
										</div>
									</div>
								{:else}
									<div
										class="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground"
									>
										<LoaderCircle size={18} class="animate-spin" />
										<p class="text-[11px]">
											{node.status === "queued"
												? "Waiting for the design agent…"
												: "Designing your screen…"}
										</p>
										<p class="max-w-[80%] line-clamp-2 text-center text-[10px]">
											{node.brief}
										</p>
									</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
			{#if marqueeBox}
				<div
					class="pointer-events-none absolute rounded border border-primary/70 bg-primary/10"
					style="left:{marqueeBox.left}px;top:{marqueeBox.top}px;width:{marqueeBox.width}px;height:{marqueeBox.height}px"
					role="presentation"
				></div>
			{/if}
			<div
				data-canvas-ui
				class="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-card/90 p-1 shadow-lg backdrop-blur"
			>
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					aria-label="Zoom out"
					title="Zoom out"
					onclick={() => zoomBy(-0.15)}><ZoomOut size={14} /></Button
				>
				<span
					class="w-12 text-center text-xs tabular-nums text-muted-foreground"
					>{Math.round(zoom * 100)}%</span
				>
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					aria-label="Zoom in"
					title="Zoom in"
					onclick={() => zoomBy(0.15)}><ZoomIn size={14} /></Button
				>
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					aria-label="Fit nodes"
					title="Fit nodes"
					onclick={fit}><Scan size={14} /></Button
				>
			</div>
			{#if selectedByUser && selectedIds.length >= 2}
				<div
					data-canvas-ui
					class="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border bg-card/95 px-3 py-1 shadow-lg backdrop-blur"
				>
					<span class="text-[11px] font-medium"
						>{selectedIds.length} designs selected</span
					>
					<span class="mx-1 h-5 w-px bg-border"></span>
					<Button
						variant="secondary"
						size="sm"
						class="h-7 gap-1.5 text-[11px]"
						onclick={startBulkRefine
							}><Sparkles size={12} />Refine {selectedIds.length} together</Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label="Clear selection"
						title="Clear selection"
						onclick={() => {
							selectedIds = [];
							selectedByUser = false;
						}}><X size={13} /></Button
					>
				</div>
			{:else if selected && selectedByUser}
				<div
					data-canvas-ui
					class="absolute top-3 left-1/2 flex max-w-[94%] -translate-x-1/2 items-center gap-1 rounded-xl border bg-card/95 py-1 pr-1 pl-2 shadow-lg backdrop-blur"
				>
				{#if renaming}
					<Input
						bind:value={renameDraft}
						type="text"
						maxlength={200}
						aria-label="Design name"
						class="h-7 w-40 min-w-0 text-[11px]"
						onblur={() => void commitRename()}
						onkeydown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void commitRename();
							} else if (event.key === "Escape") {
								renaming = false;
							}
						}}
					/>
				{:else}
					<button
						type="button"
						class="flex min-w-0 items-center gap-1.5 text-[11px] font-medium hover:text-accent-foreground"
						title="Rename"
						onclick={startRename}
					>
						{#if selected.viewport === "mobile"}<Smartphone
								size={13}
								class="shrink-0 text-muted-foreground"
							/>{:else}<Monitor
								size={13}
								class="shrink-0 text-muted-foreground"
							/>{/if}
						<span class="max-w-[150px] truncate">{selected.title}</span>
					</button>
				{/if}
					<Popover.Root>
						<Popover.Trigger
							class="inline-flex h-7 max-w-[180px] items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors hover:bg-accent hover:text-accent-foreground"
							title="Canvas size"
						>
							<Frame size={12} class="shrink-0" />
							<span class="truncate">{frameTitle(selected)}</span>
						</Popover.Trigger>
						<Popover.Content
							align="start"
							class="z-50 w-64 rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg"
						>
							<p
								class="px-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
							>
								Canvas
							</p>
							<div class="grid max-h-52 grid-cols-2 gap-1 overflow-y-auto">
								{#each DESIGN_FRAME_PRESETS as preset (preset.id)}
									<button
										type="button"
										class="flex flex-col items-start rounded-md border px-2 py-1 text-left text-[11px] transition-colors hover:bg-accent"
										onclick={() =>
											void applyFrame(selected, {
												kind: preset.id,
												width: preset.width,
												height: preset.height,
											})}
									>
										<span class="font-medium">{preset.label}</span>
										<span class="text-muted-foreground"
											>{preset.width}×{preset.height}</span
										>
									</button>
								{/each}
							</div>
							<div class="mt-2 flex items-center gap-1 border-t pt-2">
								<Input
									bind:value={customWidth}
									type="number"
									min="120"
									placeholder="W"
									aria-label="Custom width in pixels"
									class="h-7 w-full min-w-0 text-[11px]"
								/>
								<span class="text-[11px] text-muted-foreground">×</span>
								<Input
									bind:value={customHeight}
									type="number"
									min="120"
									placeholder="H"
									aria-label="Custom height in pixels"
									class="h-7 w-full min-w-0 text-[11px]"
								/>
								<Button
									size="sm"
									class="h-7 shrink-0 text-[11px]"
									onclick={() => applyCustomFrame(selected)}>Set</Button
								>
							</div>
							<p
								class="px-1 pt-1.5 text-[10px] leading-4 text-muted-foreground"
							>
								The canvas follows a mentioned screenshot or theme on its own.
								Pick one to override it.
							</p>
						</Popover.Content>
					</Popover.Root>
					<span class="mx-1 h-5 w-px bg-border"></span>
					<a
						href={`/?project=${encodeURIComponent(projectId)}&design=${encodeURIComponent(selected.id)}`}
						class="inline-flex h-7 items-center rounded-md px-2 text-[11px] hover:bg-accent hover:text-accent-foreground"
						>View full agent session</a
					>
				<Button
					variant="secondary"
					size="sm"
					class="h-7 gap-1.5 text-[11px]"
					onclick={focusChat}
					disabled={!selected.html || selected.status !== "ready"}
					><Sparkles size={12} />Refine</Button
				>
				<Button
					variant={elementPick === selected.id ? "secondary" : "ghost"}
					size="sm"
					class="h-7 gap-1.5 text-[11px]"
					aria-pressed={elementPick === selected.id}
					aria-label="Pick an element inside this design to refine"
					title="Pick an element inside this design to refine it"
					onclick={toggleElementPick}
					disabled={!selected.html || selected.status !== "ready"}
					><MousePointerClick size={12} /><span class="hidden sm:inline"
						>{elementPick === selected.id ? "Picking…" : "Pick part"}</span
					></Button
				>
					<Button
						variant="ghost"
						size="sm"
						class="h-7 gap-1.5 text-[11px]"
						onclick={openPreview}
						><Monitor size={12} /><span class="hidden sm:inline">Preview</span
						></Button
					>
					<Button
						variant="ghost"
						size="sm"
						class="h-7 gap-1.5 text-[11px]"
						onclick={() => askPublish(selected)}
						disabled={publishing || selected.status !== "ready"}
						><Upload size={12} /><span class="hidden sm:inline">Publish</span
						></Button
					>
					<span class="mx-1 h-5 w-px bg-border"></span>
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label="Rename design"
						title="Rename"
						onclick={startRename}><Pencil size={13} /></Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label="Duplicate design"
						title="Duplicate"
						onclick={() => void duplicate(selected)}><Copy size={13} /></Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label="Regenerate design"
						title="Regenerate"
						onclick={() => void retry(selected)}><RefreshCw size={13} /></Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="size-7 text-destructive"
						aria-label="Delete design"
						title="Delete design"
						onclick={() => askRemove(selected)}><Trash2 size={13} /></Button
					>
				</div>
			{/if}
		</div>
	</div>

	<!-- Design agent chat: docked at xl+, a toggleable drawer below that so the
	canvas stays usable at ~768px. -->
	{#if chatOpen}
		<aside
			class="relative z-30 flex w-[320px] shrink-0 flex-col border-l bg-card/30 xl:w-[380px] max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-40 max-xl:shadow-2xl max-xl:bg-card"
			aria-label="Design chat"
		>
			<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
				<p class="min-w-0 flex-1 truncate text-sm font-medium">Design agent</p>
				{#if busyNodes.length}<Badge variant="outline" class="gap-1"
					><LoaderCircle size={11} class="animate-spin" />{busyNodes.length}
						running</Badge
					>{/if}
				<Button
					variant="ghost"
					size="icon"
					class="size-7 shrink-0 xl:hidden"
					aria-label="Hide design chat"
					title="Hide design chat"
					onclick={() => (chatOpen = false)}><X size={14} /></Button
				>
			</div>
		<div
			bind:this={scroller}
			class="nice-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
			onscroll={onChatScroll}
		>
			{#if !threadMessages.length}
				<p
					class="rounded-lg border border-dashed p-4 text-xs leading-5 text-muted-foreground"
				>
					Chat with the design agent. Say hi, ask about your project, or ask it
					to build something — “design a checkout flow for a coffee
					subscription”. It only draws a canvas node when you ask for a screen.
				</p>
			{/if}
			{#each threadMessages as message (message.id)}
				{#if message.role === "user"}
					<div
						class="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
					>
						{message.text}
					</div>
				{:else}
					<div class="max-w-[90%]">
						<p
							class="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
						>
							{message.model ?? designAgentLabel}
						</p>
						{#if message.errorMessage}
							<div
								class="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs leading-5 text-destructive"
							>
								{message.errorMessage}
							</div>
						{:else}
							<div
								class="rounded-2xl rounded-bl-sm border bg-background px-3 py-2 text-sm"
							>
								<Markdown text={message.text} />
							</div>
							{#if message.durationMs}<p
									class="mt-1 text-[11px] text-muted-foreground"
								>
									{durationLabel(message.durationMs)}
								</p>{/if}
						{/if}
					</div>
				{/if}
			{/each}
			{#each busyNodes as workingNode (workingNode.id)}
				{@const act = activity[workingNode.id]}
				<div class="max-w-[90%]">
					<p
						class="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
					>
						{designAgentLabel}
					</p>
					<div
						class="rounded-2xl rounded-bl-sm border bg-background px-3 py-2 text-xs text-muted-foreground"
					>
						<div class="flex items-center gap-2">
							<LoaderCircle size={13} class="shrink-0 animate-spin" />
							<span
								>{act?.permissions?.length
									? "Waiting for permission…"
									: act?.phase === "drafting"
										? "Drafting the design with your model…"
										: act?.phase === "reading"
											? "Reading selected references…"
											: workingNode.status === "queued"
												? "Queued for generation…"
												: "Generating design…"}</span
							>
						</div>
						{#if act?.files?.length}
							<p class="mt-2 text-[10px] font-medium uppercase tracking-wider">
								Read {act.files.length} file{act.files.length === 1 ? "" : "s"}
							</p>
							<ul class="mt-1 flex flex-wrap gap-1">
								{#each act.files.slice(0, 12) as file (file)}
									<li
										class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground"
										title={file}
									>
										{file.split("/").pop() ?? file}
									</li>
								{/each}
								{#if act.files.length > 12}<li class="px-1 text-[10px]">
										+{act.files.length - 12} more
									</li>{/if}
							</ul>
						{/if}
						{#each act?.permissions ?? [] as permission (permission.id)}
							<div
								class="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 text-foreground"
							>
							<p class="text-xs font-medium">
								{designAgentLabel} requests permission: {permission.toolName}
							</p>
								<pre
									class="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[10px]">{permissionCommand(
										permission.args,
									)}</pre>
								<div class="mt-2 flex flex-wrap gap-1.5">
									<Button
										size="sm"
										class="h-7 px-2 text-[10px]"
										disabled={!!decidingPermission}
										onclick={() =>
											decideDesignPermission(
												workingNode.id,
												permission.id,
												"allow_once",
											)}>Allow once</Button
									>
									<Button
										variant="outline"
										size="sm"
										class="h-7 px-2 text-[10px]"
										disabled={!!decidingPermission}
										onclick={() =>
											decideDesignPermission(
												workingNode.id,
												permission.id,
												"allow",
											)}>Always allow this run</Button
									>
									<Button
										variant="ghost"
										size="sm"
										class="h-7 px-2 text-[10px]"
										disabled={!!decidingPermission}
										onclick={() =>
											decideDesignPermission(
												workingNode.id,
												permission.id,
												"deny",
											)}>Deny</Button
									>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
			{#if pendingQuestion}
				<div class="max-w-[95%]">
					<p
						class="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
					>
						{designAgentLabel} needs a detail
					</p>
					<QuestionCard question={pendingQuestion} onanswer={answerQuestion} />
				</div>
			{:else if thinking && !busyNodes.length}
				<div class="max-w-[90%]">
					<p
						class="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
					>
						{designAgentLabel}
					</p>
					<div
						class="flex items-center gap-2 rounded-2xl rounded-bl-sm border bg-background px-3 py-2 text-xs text-muted-foreground"
					>
						<LoaderCircle size={13} class="shrink-0 animate-spin" />
						<span>Thinking…</span>
					</div>
				</div>
			{/if}
			{#if error}<p
					role="alert"
					class="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
				>
					{error}
				</p>{/if}
		</div>
		<div class="shrink-0 border-t p-3">
			{#if refiningNodeId && selected?.id === refiningNodeId}
				<div
					class="mb-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground"
				>
					<span class="min-w-0 truncate">Refining “{selected.title}”</span
					><Button
						variant="ghost"
						size="sm"
						class="h-6 px-2 text-[10px]"
						onclick={() => (refiningNodeId = "")}>New design instead</Button
					>
				</div>
			{:else}
				<p class="mb-2 text-[11px] text-muted-foreground">
					Ask for a new screen to create a node. Select a ready node and click
					Refine to change it.
				</p>
			{/if}
			<Composer
				{projectId}
				{catalog}
				busy={thinking || busyNodes.length > 0}
				hideStop
				disabled={sending || !projectId}
				bind:draft
				bind:model
				showAgents={false}
				showDesigns={false}
				inputId="design-composer-input"
				onsend={handleSend}
				onstop={() => {}}
			/>
			{#if unavailableModel}<p
					class="mt-2 text-[11px] text-destructive"
					role="alert"
				>
					Selected model is no longer available. Choose another model.
				</p>{/if}
		</div>
		</aside>
	{/if}

	<!-- Floating chat toggle when the drawer is closed (below xl) -->
	{#if !chatOpen}
		<div class="absolute right-4 bottom-4 z-40 xl:hidden">
			<Button
				size="icon"
				class="size-10 rounded-full shadow-lg"
				aria-label="Open design chat"
				title="Open design chat"
				onclick={() => (chatOpen = true)}><Sparkles size={16} /></Button
			>
		</div>
	{/if}
</div>

<AlertDialog.Root bind:open={publishOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Publish “{publishTarget?.title}”?</AlertDialog.Title>
			<AlertDialog.Description
				>This writes the design's HTML into your project so it can be served
				like any other page. Publishing again with the same target will
				replace (overwrite) the previously published file. The exact path is
				shown in the confirmation toast once uploaded.</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				disabled={publishing}
				onclick={() => void publish(publishTarget)}
				>Publish</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={deleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete design?</AlertDialog.Title>
			<AlertDialog.Description
				>“{deleteTarget?.title}” and its design agent messages will be removed
				permanently.</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" onclick={() => void remove()}
				>Delete design</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={clearOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Clear the canvas?</AlertDialog.Title>
			<AlertDialog.Description
				>This permanently removes {nodes.length === 1
					? "the 1 design node on this canvas"
					: `all ${nodes.length} design nodes on this canvas`}. This cannot be
				undone.</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={() => void clearAll()}
				>Clear canvas</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
