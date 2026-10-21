<script lang="ts">
	import {
		ArrowUp,
		AtSign,
		Bot,
		Check,
		ChevronDown,
		File as FileIcon,
		Folder,
		Image as ImageIcon,
		LoaderCircle,
		PanelsTopLeft,
		Plus,
		Sparkles,
		Square,
		Star,
		X,
	} from "@lucide/svelte";
	import { onMount, tick } from "svelte";
	import {
		type Catalog,
		type ChatAttachment,
		chat,
		type Model,
		providerDisplayName,
	} from "$lib/chat";
	import * as AlertDialog from "$lib/components/ui/alert-dialog";
	import * as Attachment from "$lib/components/ui/attachment";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import * as Command from "$lib/components/ui/command";
	import * as Popover from "$lib/components/ui/popover";
	import * as Select from "$lib/components/ui/select";
	import { Switch } from "$lib/components/ui/switch";
	import { Textarea } from "$lib/components/ui/textarea";
	import { type DesignNode, daemon } from "$lib/daemon";

	let {
		projectId,
		catalog,
		busy,
		disabled,
		onsend,
		onstop,
		draft = $bindable(""),
		model = $bindable(""),
		agent = $bindable("build"),
		customAgentId = $bindable(""),
		customAgents = [],
		showAgents = true,
		showDesigns = true,
		inputId,
		autoAccept = false,
		onAutoAcceptChange,
	}: {
		projectId: string;
		catalog: Catalog;
		busy: boolean;
		disabled: boolean;
		onsend: (input: {
			text: string;
			files: string[];
			attachments?: ChatAttachment[];
			designNodeIds: string[];
			agents: string[];
			agent?: string;
			customAgentId?: string;
			model?: { providerID: string; modelID: string };
			thinkingMode?: string;
		}) => Promise<boolean>;
		onstop: () => void;
		draft?: string;
		model?: string;
		agent?: string;
		customAgentId?: string;
		customAgents?: Array<{
			id: string;
			label: string;
			allowChat?: boolean;
			provider: string;
			modelId: string | null;
		}>;
		showAgents?: boolean;
		showDesigns?: boolean;
		inputId?: string;
		/** Per-project auto-accept toggle. Rendered only when `onAutoAcceptChange` is provided. */
		autoAccept?: boolean;
		onAutoAcceptChange?: (value: boolean) => void;
	} = $props();
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let files = $state<string[]>([]);
	let attachments = $state<globalThis.File[]>([]);
	let previews = $state<{ file: globalThis.File; url: string }[]>([]);
	let previewCache: { file: globalThis.File; url: string }[] = [];
	let previewFile = $state<globalThis.File | null>(null);
	let previewOpen = $state(false);
	let projectPreviewOpen = $state(false);
	let projectPreviewPath = $state("");
	let projectPreviewText = $state("");
	let projectPreviewImage = $state("");
	let projectPreviewLoading = $state(false);
	let projectPreviewError = $state("");
	let projectPreviewRequest = 0;
	const previewUrl = $derived(
		previews.find((item) => item.file === previewFile)?.url,
	);
	let designNodes = $state<DesignNode[]>([]);
	let selectedDesignIds = $state<string[]>([]);
	let designOpen = $state(false);
	let loadingDesigns = $state(false);
	let designError = $state("");
	let designNotice = $state("");
	let attachmentInput = $state<HTMLInputElement | null>(null);
	let agents = $state<string[]>([]);
	let attachmentOpen = $state(false);
	let modelOpen = $state(false);
	let modelSearch = $state("");
	let query = $state<string | null>(null);
	let mentionStyle = $state("");
	let results = $state<string[]>([]);
	let searching = $state(false);
	let searchError = $state("");
	let active = $state(0);
	let mentionStart = 0;
	let cursor = 0;
	let previousProject = "";
	let sending = $state(false);
	let thinkingMode = $state("default");
	const favoriteStorageKey = "loom.chat.favoriteModels";
	const recentStorageKey = "loom.chat.recentModels";
	function readModelKeys(key: string): string[] {
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
	let favoriteModelIds = $state(readModelKeys(favoriteStorageKey));
	let recentModelIds = $state(readModelKeys(recentStorageKey));
	let favoriteSave = Promise.resolve();
	let favoriteRevision = 0;
	onMount(() => {
		const repositionMention = () => updateMentionPosition();
		window.addEventListener("resize", repositionMention);
		document.addEventListener("scroll", repositionMention, true);
		void (async () => {
			try {
				const revision = favoriteRevision;
				const saved = await chat.preferences();
				if (revision !== favoriteRevision) return;
				if (saved.favoriteModels.length)
					favoriteModelIds = saved.favoriteModels;
				else if (favoriteModelIds.length) {
					await chat.savePreferences(favoriteModelIds);
				}
				localStorage.setItem(
					favoriteStorageKey,
					JSON.stringify(favoriteModelIds),
				);
			} catch {
				// Keep this browser's saved favorites available if the daemon is offline.
			}
		})();
		return () => {
			for (const preview of previewCache) URL.revokeObjectURL(preview.url);
			window.removeEventListener("resize", repositionMention);
			document.removeEventListener("scroll", repositionMention, true);
		};
	});
	function thumbnailStyle(
		node: DesignNode,
		boxWidth: number,
		boxHeight: number,
	) {
		const frame =
			node.viewport === "mobile"
				? { width: 390, height: 844 }
				: { width: 1440, height: 900 };
		const scale = Math.min(boxWidth / frame.width, boxHeight / frame.height);
		const left = (boxWidth - frame.width * scale) / 2;
		const top = (boxHeight - frame.height * scale) / 2;
		return `width:${frame.width}px;height:${frame.height}px;left:${left}px;top:${top}px;transform:scale(${scale})`;
	}
	const choices = $derived([
		...catalog.agents
			.filter(
				(a) =>
					a.mode !== "primary" &&
					a.name.toLowerCase().includes((query ?? "").toLowerCase()),
			)
			.map((a) => ({ value: a.name, type: "agent" })),
		...customAgents
			.filter(
				(item) =>
					item.allowChat !== false &&
					item.label.toLowerCase().includes((query ?? "").toLowerCase()),
			)
			.map((item) => ({
				value: item.label,
				type: "custom-agent",
				id: item.id,
			})),
		...results.map((value) => ({ value, type: "file" })),
	]);
	const selectedModel = $derived(
		catalog.models.find((m) => `${m.providerID}/${m.modelID}` === model),
	);
	function modelKey(item: Model) {
		return `${item.providerID}/${item.modelID}`;
	}
	function modelsForKeys(keys: string[]) {
		return keys
			.map((key) => catalog.models.find((item) => modelKey(item) === key))
			.filter((item): item is Model => !!item);
	}
	const favoriteModels = $derived(modelsForKeys(favoriteModelIds));
	const recentModels = $derived(modelsForKeys(recentModelIds));
	const providerGroups = $derived.by(() => {
		const groups = new Map<
			string,
			{ id: string; label: string; models: Model[] }
		>();
		for (const item of catalog.models) {
			const id = item.providerID;
			let group = groups.get(id);
			if (!group) {
				const displayName = providerDisplayName(catalog, id, item.modelID);
				group = {
					id,
					label: id.startsWith("loom_custom_") ? displayName : displayName,
					models: [],
				};
				groups.set(id, group);
			}
			if (!group.models.some((model) => modelKey(model) === modelKey(item)))
				group.models.push(item);
		}
		return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
	});
	function providerTone(providerID: string) {
		const id = providerID.toLowerCase();
		if (["agy", "antigravity", "gemini"].includes(id)) return "agy";
		if (["claude", "anthropic"].includes(id)) return "claude";
		if (["codex", "openai"].includes(id)) return "codex";
		if (id === "opencode") return "opencode";
		return "default";
	}
	function toggleFavorite(item: Model) {
		favoriteRevision += 1;
		const key = modelKey(item);
		favoriteModelIds = favoriteModelIds.includes(key)
			? favoriteModelIds.filter((id) => id !== key)
			: [key, ...favoriteModelIds].slice(0, 12);
		try {
			localStorage.setItem(
				favoriteStorageKey,
				JSON.stringify(favoriteModelIds),
			);
		} catch {}
		favoriteSave = favoriteSave
			.then(() => chat.savePreferences([...favoriteModelIds]))
			.then(
				() => {},
				() => {},
			);
	}
	function chooseModel(item: Model) {
		const key = modelKey(item);
		model = key;
		recentModelIds = [key, ...recentModelIds.filter((id) => id !== key)].slice(
			0,
			8,
		);
		try {
			localStorage.setItem(recentStorageKey, JSON.stringify(recentModelIds));
		} catch {}
		modelSearch = "";
		modelOpen = false;
	}
	function chooseDefaultModel() {
		model = "";
		modelSearch = "";
		modelOpen = false;
	}
	function modelOptionValue(item: Model, section: string) {
		return `${section} ${item.name} ${item.provider} ${item.providerID} ${item.modelID}`;
	}
	function matchesModelSearch(item: Model, section: string) {
		const search = modelSearch.trim().toLowerCase();
		return (
			!search ||
			modelOptionValue(item, `${section} ${modelKey(item)}`)
				.toLowerCase()
				.includes(search)
		);
	}
	const visibleFavoriteModels = $derived(
		favoriteModels.filter((item) => matchesModelSearch(item, "favorite")),
	);
	const visibleRecentModels = $derived(
		recentModels.filter((item) => matchesModelSearch(item, "recent")),
	);
	const visibleProviderGroups = $derived(
		providerGroups.flatMap((group) => {
			const models = group.models.filter((item) =>
				matchesModelSearch(item, group.id),
			);
			return models.length ? [{ ...group, models }] : [];
		}),
	);
	const selectedCustomAgent = $derived(
		customAgents.find((item) => item.id === customAgentId),
	);
	const supportsThinkingMode = $derived(true);
	const thinkingModes = $derived(
		selectedModel?.providerID === "opencode" && selectedModel.variants?.length
			? selectedModel.variants
			: supportsThinkingMode
				? ["low", "medium", "high"]
				: [],
	);
	$effect(() => {
		if (thinkingMode !== "default" && !thinkingModes.includes(thinkingMode))
			thinkingMode = "default";
	});
	function customAgentModelLabel(
		item: NonNullable<typeof selectedCustomAgent>,
	) {
		if (!item.modelId) return `${item.provider} / default`;
		const shortId = item.modelId.startsWith(`${item.provider}/`)
			? item.modelId.slice(item.provider.length + 1)
			: item.modelId;
		const model = catalog.models.find((candidate) => {
			if (candidate.providerID !== item.provider) return false;
			return (
				candidate.modelID === item.modelId ||
				candidate.modelID === shortId ||
				`${candidate.providerID}/${candidate.modelID}` === item.modelId
			);
		});
		const providerName = model?.provider?.trim();
		const providerLabel =
			providerName && providerName.toLowerCase() !== item.provider.toLowerCase()
				? providerName
				: item.provider;
		return `${providerLabel} / ${model?.name ?? shortId}`;
	}
	$effect(() => {
		if (projectId !== previousProject) {
			previousProject = projectId;
			for (const preview of previewCache) URL.revokeObjectURL(preview.url);
			previews = [];
			previewCache = [];
			previewFile = null;
			previewOpen = false;
			projectPreviewRequest++;
			projectPreviewOpen = false;
			projectPreviewPath = "";
			projectPreviewText = "";
			projectPreviewImage = "";
			files = [];
			attachments = [];
			selectedDesignIds = [];
			designNodes = [];
			agents = [];
			query = null;
		}
	});
	$effect(() => {
		const value = query;
		const project = projectId;
		if (value === null || !project) return;
		let cancelled = false;
		searching = true;
		active = 0;
		searchError = "";
		const timer = setTimeout(async () => {
			try {
				const found = await chat.files(project, value);
				if (!cancelled) results = found;
			} catch (error) {
				if (!cancelled) {
					results = [];
					searchError =
						error instanceof Error ? error.message : "File search failed";
				}
			} finally {
				if (!cancelled) searching = false;
			}
		}, 150);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});
	function input(event?: Event) {
		const element =
			event?.currentTarget instanceof HTMLTextAreaElement
				? event.currentTarget
				: textarea;
		if (!element) return;
		cursor = element.selectionStart;
		const match = element.value.slice(0, cursor).match(/@([^\s@]*)$/);
		query = match ? match[1] : null;
		if (match) {
			mentionStart = cursor - match[1].length - 1;
			updateMentionPosition();
		} else {
			mentionStyle = "";
		}
	}
	async function openProjectPreview(path: string) {
		const request = ++projectPreviewRequest;
		const project = projectId;
		projectPreviewPath = path;
		projectPreviewText = "";
		projectPreviewImage = "";
		projectPreviewError = "";
		projectPreviewLoading = true;
		projectPreviewOpen = true;
		try {
			if (!project || path.endsWith("/"))
				throw new Error("File preview is unavailable.");
			const result = await chat.file(project, path);
			if (
				request !== projectPreviewRequest ||
				!projectPreviewOpen ||
				project !== projectId
			)
				return;
			const type = result.type.toLowerCase().split(";")[0]?.trim();
			const imageType =
				/^(image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(type ?? "")
					? type
					: type === "image" || type === "binary"
						? (
								{
									png: "image/png",
									jpg: "image/jpeg",
									jpeg: "image/jpeg",
									gif: "image/gif",
									webp: "image/webp",
								} as Record<string, string>
							)[path.split(".").pop()?.toLowerCase() ?? ""]
						: undefined;
			if (result.encoding === "base64" && imageType) {
				if (result.content.length > 1_400_000)
					throw new Error("Image is too large to preview.");
				if (
					!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
						result.content,
					) ||
					!result.content
				)
					throw new Error("Invalid image data.");
				projectPreviewImage = `data:${imageType};base64,${result.content}`;
			} else if (
				!result.encoding &&
				(type === "text" ||
					type?.startsWith("text/") ||
					type === "application/json" ||
					type === "application/javascript" ||
					type === "application/xml")
			) {
				projectPreviewText = result.content.slice(0, 100_000);
				if (result.content.length > 100_000)
					projectPreviewText += "\n… Preview truncated.";
			} else {
				throw new Error("Preview is unavailable for this file type.");
			}
		} catch (error) {
			if (
				request === projectPreviewRequest &&
				projectPreviewOpen &&
				project === projectId
			)
				projectPreviewError =
					error instanceof Error ? error.message : "Unable to preview file.";
		} finally {
			if (request === projectPreviewRequest) projectPreviewLoading = false;
		}
	}
	function clickInput(event: MouseEvent) {
		input(event);
		const position = textarea?.selectionStart ?? 0;
		for (const path of files) {
			const mention = `@${path}`;
			let start = draft.indexOf(mention);
			while (start !== -1) {
				const end = start + mention.length;
				if (
					position >= start &&
					position <= end &&
					(end === draft.length || /[\s),.!?;:]/.test(draft[end] ?? ""))
				) {
					void openProjectPreview(path);
					return;
				}
				start = draft.indexOf(mention, end);
			}
		}
		for (const { file } of previews) {
			const mention = `@${file.name}`;
			let start = draft.indexOf(mention);
			while (start !== -1) {
				const end = start + mention.length;
				if (
					position >= start &&
					position <= end &&
					(end === draft.length || /[\s),.!?;:]/.test(draft[end] ?? ""))
				) {
					previewFile = file;
					previewOpen = true;
					return;
				}
				start = draft.indexOf(mention, end);
			}
		}
	}
	function updateMentionPosition() {
		if (query === null || !textarea) return;
		const rect = textarea.getBoundingClientRect();
		const showAbove = rect.top > 260;
		const top = showAbove ? rect.top - 8 : rect.bottom + 8;
		mentionStyle = `position:fixed;z-index:1000;left:${Math.max(8, rect.left)}px;top:${top}px;width:min(${rect.width}px,calc(100vw - 16px));transform:${showAbove ? "translateY(-100%)" : "none"}`;
	}
	async function loadDesigns() {
		if (!projectId || loadingDesigns) return;
		loadingDesigns = true;
		designError = "";
		try {
			const thread = await daemon.listDesigns(projectId);
			designNodes = thread.nodes.filter(
				(node) => node.status === "ready" && node.html.trim(),
			);
		} catch (error) {
			designError =
				error instanceof Error
					? error.message
					: "Could not load Canvas designs";
		} finally {
			loadingDesigns = false;
		}
	}
	function toggleDesign(node: DesignNode) {
		if (selectedDesignIds.includes(node.id)) {
			selectedDesignIds = selectedDesignIds.filter((id) => id !== node.id);
			designNotice = "";
			return;
		}
		if (selectedDesignIds.length >= 5) {
			designNotice = "You can attach up to 5 Canvas designs per message.";
			return;
		}
		designNotice = "";
		selectedDesignIds = [...selectedDesignIds, node.id];
	}
	async function insertMention(label: string, start: number, end = start) {
		const prefix = draft.slice(0, start);
		const suffix = draft.slice(end);
		const insertion = `@${label}${suffix && !/\s/.test(suffix[0] ?? "") ? " " : ""}`;
		draft = `${prefix}${insertion}${suffix}`;
		query = null;
		await tick();
		textarea?.focus();
		textarea?.setSelectionRange(
			start + insertion.length,
			start + insertion.length,
		);
	}
	function removeMention(label: string) {
		const token = `@${label}`;
		const index = draft.indexOf(token);
		if (index < 0) return;
		const end = index + token.length;
		if (end < draft.length && !/[\s),.!?;:]/.test(draft[end] ?? "")) return;
		draft = `${draft.slice(0, index)}${draft.slice(end < draft.length && draft[end] === " " ? end + 1 : end)}`;
	}
	async function choose(item: { value: string; type: string; id?: string }) {
		if (item.type === "file") {
			files = [...new Set([...files, item.value])];
			await insertMention(item.value, mentionStart, cursor);
			return;
		}
		if (item.type === "custom-agent") customAgentId = item.id ?? "";
		else agents = [...new Set([...agents, item.value])];
		draft = `${draft.slice(0, mentionStart)}${draft.slice(cursor)}`;
		query = null;
		await tick();
		textarea?.focus();
		textarea?.setSelectionRange(mentionStart, mentionStart);
	}
	async function addFiles(incoming: globalThis.File[], position: number) {
		const added = incoming.slice(0, Math.max(0, 10 - attachments.length));
		if (!added.length) return;
		attachments = [...attachments, ...added];
		const newPreviews = added
			.filter((file) => file.type.startsWith("image/"))
			.map((file) => ({ file, url: URL.createObjectURL(file) }));
		previewCache = [...previewCache, ...newPreviews];
		previews = [...previews, ...newPreviews];
		let caret = position;
		for (const file of added) {
			await insertMention(file.name, caret);
			caret = textarea?.selectionStart ?? caret;
		}
	}
	function addAttachments(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		void addFiles(Array.from(input.files ?? []), attachmentCursor);
		input.value = "";
	}
	let attachmentCursor = 0;
	function openAttachments() {
		attachmentCursor = textarea?.selectionStart ?? draft.length;
		attachmentInput?.click();
	}
	function removeAttachment(file: globalThis.File) {
		attachments = attachments.filter((item) => item !== file);
		const preview = previews.find((item) => item.file === file);
		if (preview) URL.revokeObjectURL(preview.url);
		previews = previews.filter((item) => item.file !== file);
		previewCache = previewCache.filter((item) => item.file !== file);
		if (previewFile === file) previewOpen = false;
		removeMention(file.name);
	}

	/** Ctrl/Cmd+V a screenshot or photo straight into the attachment tray. */
	function onpaste(event: ClipboardEvent) {
		const items = event.clipboardData?.items;
		if (!items) return;
		const images: globalThis.File[] = [];
		for (const item of Array.from(items)) {
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) images.push(file);
			}
		}
		if (!images.length) return;
		event.preventDefault();
		const stamp = Date.now();
		const named = images.map((file, index) =>
			file.name && file.name !== "image.png"
				? file
				: new File([file], `pasted-${stamp}-${index}.png`, { type: file.type }),
		);
		void addFiles(named, textarea?.selectionStart ?? draft.length);
	}

	async function attach() {
		if (!textarea) return;
		textarea.focus();
		const pos = textarea.selectionStart ?? draft.length;
		const prefix = draft.slice(0, pos);
		const insertion = "@";
		draft = `${prefix}${insertion}${draft.slice(pos)}`;
		await tick();
		textarea.setSelectionRange(pos + insertion.length, pos + insertion.length);
		input();
	}
	async function send() {
		if (
			sending ||
			busy ||
			disabled ||
			(!draft.trim() &&
				!files.length &&
				!attachments.length &&
				!selectedDesignIds.length)
		)
			return;
		sending = true;
		query = null;
		const pendingDraft = draft;
		const pendingFiles = [...files];
		const pendingAttachments = [...attachments];
		const pendingDesignIds = [...selectedDesignIds];
		const pendingAgents = [...agents];
		try {
			const attachmentsPayload = await Promise.all(
				pendingAttachments.map(async (file): Promise<ChatAttachment> => ({
					filename: file.name,
					mime: file.type || "application/octet-stream",
					data: await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () =>
							resolve(String(reader.result).split(",")[1] ?? "");
						reader.onerror = () => reject(reader.error);
						reader.readAsDataURL(file);
					}),
				})),
			);
			const request = onsend({
				text: pendingDraft.trim(),
				files: pendingFiles,
				attachments: attachmentsPayload,
				designNodeIds: pendingDesignIds,
				agents: pendingAgents,
				agent,
				customAgentId: customAgentId || undefined,
				model: selectedModel
					? {
							providerID: selectedModel.providerID,
							modelID: selectedModel.modelID,
						}
					: undefined,
				thinkingMode: supportsThinkingMode ? thinkingMode : undefined,
			});
			draft = "";
			files = [];
			attachments = [];
			selectedDesignIds = [];
			agents = [];
			const ok = await request;
			if (ok) {
				for (const preview of previewCache) URL.revokeObjectURL(preview.url);
				previewCache = [];
				previews = [];
				previewFile = null;
				previewOpen = false;
			}
			if (!ok) {
				draft = pendingDraft;
				files = pendingFiles;
				attachments = pendingAttachments;
				selectedDesignIds = pendingDesignIds;
				agents = pendingAgents;
			}
		} catch (error) {
			draft = pendingDraft;
			files = pendingFiles;
			attachments = pendingAttachments;
			selectedDesignIds = pendingDesignIds;
			agents = pendingAgents;
			throw error;
		} finally {
			sending = false;
		}
	}
	function keydown(event: KeyboardEvent) {
		if (event.isComposing) return;
		if (event.repeat && event.key === "Enter") {
			event.preventDefault();
			return;
		}
		if (query !== null) {
			if (event.key === "Escape") {
				event.preventDefault();
				query = null;
				return;
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				active = Math.max(
					0,
					Math.min(
						choices.length - 1,
						active + (event.key === "ArrowDown" ? 1 : -1),
					),
				);
				document
					.getElementById(`mention-${active}`)
					?.scrollIntoView({ block: "nearest" });
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				if (choices[active]) void choose(choices[active]);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			textarea?.form?.requestSubmit();
		}
	}
</script>

{#snippet modelOption(item: Model, section: string)}
	{@const key = modelKey(item)}
	{@const favorite = favoriteModelIds.includes(key)}
	{@const selected = model === key}
	<div class="flex items-center gap-1">
		<Command.Item
			value={modelOptionValue(item, `${section} ${key}`)}
			onSelect={() => chooseModel(item)}
			aria-current={selected ? "true" : undefined}
			class={`h-12 min-w-0 flex-1 items-center ${selected ? "bg-primary/10 ring-1 ring-inset ring-primary/40" : ""}`}
		>
			<span class="min-w-0 flex-1">
				<span class="flex min-w-0 items-center gap-2">
					<span class="truncate">{item.name}</span>
					<Badge
						variant="outline"
						class={`model-badge model-badge--${providerTone(item.providerID)} max-w-36 shrink-0 truncate px-1.5 text-[10px] uppercase tracking-wide`}
						title={providerDisplayName(catalog, item.providerID, item.modelID)}
						>{providerDisplayName(
							catalog,
							item.providerID,
							item.modelID,
						)}</Badge
					>
				</span>
				<span class="block truncate text-xs text-muted-foreground">
					{item.modelID}{!item.providerID.startsWith("loom_custom_") &&
					item.connectionId &&
					item.connectionId !== item.providerID
						? ` · ${item.connectionId}`
						: ""}
				</span>
			</span>
			{#if selected}<span
					class="ml-2 inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-primary"
					><Check size={13} />Selected</span
				>{/if}
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
			onclick={() => toggleFavorite(item)}
		>
			<Star class="favorite-model-star" data-active={favorite} />
		</Button>
	</div>
{/snippet}
<form
	onsubmit={(event) => {
		event.preventDefault();
		void send();
	}}
	class="relative rounded-2xl border border-white/[0.14] bg-[#191b1e] shadow-[0_18px_70px_rgba(0,0,0,0.3)] transition-colors focus-within:border-cyan-300/30"
>
	{#if query !== null}
		<div
			style={mentionStyle}
			class="overflow-hidden rounded-xl border bg-popover shadow-xl"
		>
			<div
				class="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground"
			>
				<span>Files & agents · {choices.length} results</span><span
					>↑ ↓ select · Enter attach · Esc close</span
				>
			</div>
			<div
				class="max-h-64 overflow-y-auto p-1"
				role="listbox"
				aria-label="Files and agents"
				id="mention-list"
			>
				{#if searching}<p class="p-3 text-xs text-muted-foreground">
						Searching project files and folders…
					</p>{:else if searchError}<p
						role="alert"
						class="p-3 text-xs text-destructive"
					>
						{searchError}
					</p>{:else if !choices.length}<p
						class="p-3 text-xs text-muted-foreground"
					>
						No matching files, folders, or agents.
					</p>{/if}
				{#each choices as item, index}
					<Button
						id={`mention-${index}`}
						type="button"
						role="option"
						aria-selected={active === index}
						variant="ghost"
						class={`h-auto w-full justify-start py-2 text-left text-xs ${active === index ? "bg-accent" : ""}`}
						onclick={() => choose(item)}
					>
						{#if item.type === "agent" || item.type === "custom-agent"}<Bot
								size={15}
							/>{:else if item.value.endsWith("/")}<Folder
								size={15}
							/>{:else}<FileIcon size={15} />{/if}<span class="min-w-0 truncate"
							>{item.value}</span
						><span class="ml-auto text-muted-foreground"
							>{item.type === "custom-agent"
								? "Loom agent"
								: item.type === "agent"
									? "agent"
									: item.value.endsWith("/")
										? "folder"
										: "file"}</span
						>
					</Button>
				{/each}
			</div>
		</div>
	{/if}
	{#if files.length || agents.length || attachments.length || selectedDesignIds.length}<div
			class="flex flex-wrap gap-1 px-3 pt-3"
			aria-label="Message attachments"
		>
			{#each files as file}<Attachment.Root size="sm" class="max-w-56"
					><Attachment.Media><FileIcon /></Attachment.Media><Attachment.Content
						><Attachment.Title>{file}</Attachment.Title></Attachment.Content
					><Attachment.Actions
						><Attachment.Action
							type="button"
							aria-label={`Remove ${file}`}
							onclick={() => {
								files = files.filter((f) => f !== file);
								removeMention(file);
							}}><X /></Attachment.Action
						></Attachment.Actions
					><Attachment.Trigger
						aria-label={`Preview ${file}`}
						onclick={() => void openProjectPreview(file)}
					/></Attachment.Root
				>{/each}
			{#each agents as name}<Attachment.Root size="sm"
					><Attachment.Media><Bot /></Attachment.Media><Attachment.Content
						><Attachment.Title>{name}</Attachment.Title></Attachment.Content
					><Attachment.Actions
						><Attachment.Action
							type="button"
							aria-label={`Remove ${name}`}
							onclick={() => (agents = agents.filter((a) => a !== name))}
							><X /></Attachment.Action
						></Attachment.Actions
					></Attachment.Root
				>{/each}
			{#each attachments as file (file)}{@const preview = previews.find(
					(item) => item.file === file,
				)}<Attachment.Root size="sm" class="max-w-56"
					><Attachment.Media variant={preview ? "image" : "icon"}
						>{#if preview}<img
								src={preview.url}
								alt={file.name}
							/>{:else}<FileIcon />{/if}</Attachment.Media
					><Attachment.Content
						><Attachment.Title>{file.name}</Attachment.Title
						></Attachment.Content
					><Attachment.Actions
						><Attachment.Action
							type="button"
							aria-label={`Remove ${file.name}`}
							onclick={() => removeAttachment(file)}><X /></Attachment.Action
						></Attachment.Actions
					>{#if preview}<Attachment.Trigger
							aria-label={`Preview ${file.name}`}
							onclick={() => {
								previewFile = file;
								previewOpen = true;
							}}
						/>{/if}</Attachment.Root
				>{/each}
			{#each designNodes.filter( (node) => selectedDesignIds.includes(node.id) ) as node}<Attachment.Root
					size="sm"
					class="max-w-56"
					><Attachment.Media><PanelsTopLeft /></Attachment.Media
					><Attachment.Content
						><Attachment.Title>{node.title}</Attachment.Title
						></Attachment.Content
					><Attachment.Actions
						><Attachment.Action
							type="button"
							aria-label={`Remove Canvas design ${node.title}`}
							onclick={() => toggleDesign(node)}><X /></Attachment.Action
						></Attachment.Actions
					></Attachment.Root
				>{/each}
		</div>{/if}
	<input
		bind:this={attachmentInput}
		type="file"
		accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.css,.html,.pdf"
		multiple
		onchange={addAttachments}
		class="sr-only"
		aria-label="Attach files or images"
	/>
	<Textarea
		id={inputId}
		bind:ref={textarea}
		bind:value={draft}
		oninput={input}
		onclick={clickInput}
		{onpaste}
		onkeydown={keydown}
		aria-label="Message agent"
		aria-controls={query !== null ? "mention-list" : undefined}
		aria-activedescendant={query !== null ? `mention-${active}` : undefined}
		placeholder="Ask anything… @ for files and agents"
		rows={3}
		class="max-h-56 min-h-[126px] resize-none border-0 bg-transparent px-4 py-4 text-sm text-white shadow-none placeholder:text-white/35 focus-visible:ring-0"
		disabled={disabled || sending}
	/>
	<div
		class="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] px-3 py-2"
	>
		<div class="flex flex-wrap items-center gap-1">
			<Popover.Root bind:open={attachmentOpen}
				><Popover.Trigger
					class="inline-flex size-8 items-center justify-center rounded-lg border border-transparent text-white/55 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-50"
					title="Add to message"
					aria-label="Add to message"
					disabled={sending}><Plus size={16} /></Popover.Trigger
				><Popover.Content class="w-64 p-1" align="start"
					><Command.Root
						><Command.List
							><Command.Group
								><Command.Item
									value="Add photos & files"
									onSelect={() => {
										attachmentOpen = false;
										openAttachments();
									}}
									><ImageIcon size={15} /><span>Add photos &amp; files</span
									></Command.Item
								><Command.Item
									value="@ for mentions"
									disabled={!projectId}
									onSelect={() => {
										attachmentOpen = false;
										void attach();
									}}
									><AtSign size={15} /><span>@ for mentions</span></Command.Item
								></Command.Group
							></Command.List
						></Command.Root
					></Popover.Content
				></Popover.Root
			>
			{#if showDesigns}<Popover.Root
					bind:open={designOpen}
					onOpenChange={(open) => {
						designOpen = open;
						if (open) void loadDesigns();
					}}
					><Popover.Trigger
						class="inline-flex size-8 items-center justify-center rounded-lg border border-transparent text-white/55 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-50"
						title="Embed Canvas designs"
						aria-label="Embed Canvas designs"
						disabled={sending || !projectId}
						><PanelsTopLeft size={16} />{#if selectedDesignIds.length}<span
								class="ml-0.5 text-[10px]">{selectedDesignIds.length}</span
							>{/if}</Popover.Trigger
					><Popover.Content class="w-80 p-2" align="start"
						><div class="mb-2 flex items-center justify-between px-1">
							<p class="text-sm font-medium">Canvas designs</p>
							<span class="text-xs text-muted-foreground"
								>{selectedDesignIds.length}/5 selected</span
							>
						</div>
						{#if loadingDesigns}<p
								class="px-1 py-3 text-xs text-muted-foreground"
							>
								Loading designs…
							</p>{:else if designError}<p
								role="alert"
								class="px-1 py-2 text-xs text-destructive"
							>
								{designError}
							</p>{:else if !designNodes.length}<p
								class="px-1 py-3 text-xs text-muted-foreground"
							>
								No ready designs in this project's Canvas.
							</p>{:else}<div class="max-h-64 space-y-1 overflow-y-auto">
								{#each designNodes as node}<Button
										type="button"
										variant="ghost"
										class="h-auto w-full justify-start gap-2 py-2 text-left"
										aria-pressed={selectedDesignIds.includes(node.id)}
										onclick={() => toggleDesign(node)}
										><span
											class="relative h-12 w-16 shrink-0 overflow-hidden rounded border bg-background"
											><iframe
												title={`Preview of ${node.title}`}
												srcdoc={node.html}
												sandbox=""
												tabindex="-1"
												aria-hidden="true"
												style={thumbnailStyle(node, 64, 48)}
												class="pointer-events-none absolute origin-top-left border-0"
											></iframe></span
										><span class="min-w-0 flex-1"
											><span class="block truncate text-xs">{node.title}</span
											><span
												class="block truncate text-[10px] text-muted-foreground"
												>{node.viewport} · {node.brief}</span
											></span
										>{#if selectedDesignIds.includes(node.id)}<Check
												size={14}
												class="shrink-0"
											/>{/if}</Button
									>{/each}
							</div>
							{#if designNotice}<p class="px-1 pt-2 text-xs text-amber-300">
									{designNotice}
								</p>{/if}{/if}</Popover.Content
					></Popover.Root
				>{/if}
			{#if onAutoAcceptChange}<label
					class="ml-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-white/50 transition hover:bg-white/[0.06]"
					title="Auto-approve tool permissions for this project. When off, each tool asks for your approval."
					><Switch
						checked={autoAccept}
						onCheckedChange={(value) => onAutoAcceptChange(value)}
						size="sm"
					/><span class="hidden sm:inline">Auto-accept</span></label
				>{/if}
		</div>
		<div
			class="flex min-w-0 flex-wrap items-center justify-end gap-1 sm:flex-nowrap"
		>
			<Popover.Root
				bind:open={modelOpen}
				onOpenChange={(open) => {
					modelOpen = open;
					if (!open) modelSearch = "";
				}}
				><Popover.Trigger
					class="flex max-w-36 sm:max-w-56 items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-white/65 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
					aria-label={selectedCustomAgent
						? `Custom agent model: ${customAgentModelLabel(selectedCustomAgent)}`
						: selectedModel
							? `Selected model: ${selectedModel.name} from ${providerDisplayName(catalog, selectedModel.providerID, selectedModel.modelID)}`
							: "Select model"}
					title={selectedCustomAgent
						? customAgentModelLabel(selectedCustomAgent)
						: selectedModel
							? `${selectedModel.name} · ${providerDisplayName(catalog, selectedModel.providerID, selectedModel.modelID)} · ${selectedModel.modelID}`
							: "Default model"}
					disabled={!!selectedCustomAgent}
					><span class="truncate"
						>{selectedCustomAgent
							? customAgentModelLabel(selectedCustomAgent)
							: (selectedModel?.name ?? "Default model")}</span
					>{#if selectedModel && !selectedCustomAgent}<Badge
							variant="outline"
							class={`model-badge model-badge--${providerTone(selectedModel.providerID)} max-w-20 shrink-0 truncate px-1 text-[9px] uppercase tracking-wide`}
							>{providerDisplayName(
								catalog,
								selectedModel.providerID,
								selectedModel.modelID,
							)}</Badge
						>{/if}<ChevronDown size={12} /></Popover.Trigger
				>
				<Popover.Content class="w-96 max-w-[calc(100vw-2rem)] p-0" align="end"
					><Command.Root
						><Command.Input
							bind:value={modelSearch}
							placeholder="Search models…"
						/><Command.List class="max-h-96"
							><Command.Empty>No configured models found.</Command.Empty>
							{#if visibleFavoriteModels.length}<Command.Group
									heading="Favorites"
									>{#each visibleFavoriteModels as item (modelKey(item))}{@render modelOption(
											item,
											"favorite",
										)}{/each}</Command.Group
								>{/if}
							{#if visibleRecentModels.length}<Command.Separator
								/><Command.Group heading="Recent"
									>{#each visibleRecentModels as item (modelKey(item))}{@render modelOption(
											item,
											"recent",
										)}{/each}</Command.Group
								>{/if}
							<Command.Separator /><Command.Group heading="Default"
								><Command.Item value="default" onSelect={chooseDefaultModel}
									>Default model</Command.Item
								></Command.Group
							>
							{#each visibleProviderGroups as group (group.id)}<Command.Separator
								/><Command.Group heading={group.label}
									>{#each group.models as item (modelKey(item))}{@render modelOption(
											item,
											group.id,
										)}{/each}</Command.Group
								>{/each}
						</Command.List></Command.Root
					></Popover.Content
				>
			</Popover.Root>

			{#if showAgents}<Select.Root type="single" bind:value={agent}
					><Select.Trigger
						class="h-8 max-w-28 gap-1 rounded-lg border-0 bg-transparent px-2 text-xs text-white/65 shadow-none transition hover:bg-white/[0.06] hover:text-white focus-visible:ring-1 [&>svg:last-child]:hidden"
						aria-label={`Chat mode: ${agent}`}
						title={`Chat mode: ${agent}`}
						><Bot size={14} /><span class="truncate">{agent}</span
						></Select.Trigger
					><Select.Content
						>{#each catalog.agents.filter((a) => a.mode !== "subagent") as item}<Select.Item
								value={item.name}>{item.name}</Select.Item
							>{/each}</Select.Content
					></Select.Root
				>{/if}
			{#if supportsThinkingMode}<Select.Root
					type="single"
					bind:value={thinkingMode}
					><Select.Trigger
						class="h-8 w-8 gap-0 rounded-lg border-0 bg-transparent p-0 text-white/65 shadow-none transition hover:bg-transparent hover:text-white dark:bg-transparent dark:hover:bg-transparent data-[state=open]:bg-transparent focus-visible:ring-1 [&>svg:last-child]:hidden"
						aria-label={`Thinking mode: ${thinkingMode}`}
						title={`Thinking mode: ${thinkingMode}`}
						><Sparkles size={16} /><span class="sr-only"
							>{thinkingMode === "default" ? "Thinking" : thinkingMode}</span
						></Select.Trigger
					><Select.Content
						><Select.Group
							><Select.Label>Thinking</Select.Label><Select.Item value="default"
								>Default</Select.Item
							>{#each thinkingModes as mode}<Select.Item value={mode}
									>{mode[0]!.toUpperCase() + mode.slice(1)}</Select.Item
								>{/each}</Select.Group
						></Select.Content
					></Select.Root
				>{/if}
			{#if customAgents.length}<Select.Root
					type="single"
					bind:value={customAgentId}
					><Select.Trigger
						class="ml-1 h-8 max-w-32 sm:max-w-none truncate gap-1 rounded-lg border-0 border-l border-white/10 bg-transparent px-2 text-xs text-white/65 shadow-none transition hover:bg-white/[0.06]"
						aria-label="Select custom agent"
						>{customAgents.find((item) => item.id === customAgentId)?.label ??
							"Custom agent"}</Select.Trigger
					><Select.Content
						><Select.Item value="">Default agent</Select.Item
						>{#each customAgents as item}<Select.Item value={item.id}
								>{item.label}</Select.Item
							>{/each}</Select.Content
					></Select.Root
				>{/if}
			{#if busy}<Button
					type="button"
					size="icon"
					variant="secondary"
					class="rounded-full"
					aria-label="Stop response"
					title="Stop response"
					onclick={onstop}><Square size={14} /></Button
				>{:else}<Button
					type="submit"
					size="icon"
					class="size-9 rounded-full bg-white/65 text-[#191b1e] transition hover:bg-white"
					aria-label="Send message"
					title="Send message"
					disabled={disabled ||
						sending ||
						(!draft.trim() &&
							!files.length &&
							!attachments.length &&
							!selectedDesignIds.length)}
					>{#if sending}<LoaderCircle
							size={16}
							class="animate-spin"
						/>{:else}<ArrowUp size={17} />{/if}</Button
				>{/if}
		</div>
	</div>
</form>
<AlertDialog.Root bind:open={previewOpen}>
	<AlertDialog.Content class="max-h-[90vh] max-w-3xl overflow-auto">
		<AlertDialog.Header>
			<AlertDialog.Title
				>{previewFile?.name ?? "Image preview"}</AlertDialog.Title
			>
			<AlertDialog.Description>Attached image preview</AlertDialog.Description>
		</AlertDialog.Header>
		{#if previewFile && previewUrl}
			<img
				src={previewUrl}
				alt={previewFile.name}
				class="max-h-[70vh] w-full object-contain"
			/>
		{/if}
		<AlertDialog.Footer
			><AlertDialog.Cancel>Close</AlertDialog.Cancel></AlertDialog.Footer
		>
	</AlertDialog.Content>
</AlertDialog.Root>
<AlertDialog.Root
	bind:open={projectPreviewOpen}
	onOpenChange={(open) => {
		if (!open) {
			projectPreviewRequest++;
			projectPreviewImage = "";
			projectPreviewText = "";
		}
	}}
>
	<AlertDialog.Content class="max-h-[90vh] max-w-3xl overflow-auto">
		<AlertDialog.Header>
			<AlertDialog.Title>{projectPreviewPath}</AlertDialog.Title>
			<AlertDialog.Description>Project file preview</AlertDialog.Description>
		</AlertDialog.Header>
		{#if projectPreviewLoading}<p
				role="status"
				class="text-sm text-muted-foreground"
			>
				Loading file…
			</p>
		{:else if projectPreviewError}<p
				role="alert"
				class="text-sm text-destructive"
			>
				{projectPreviewError}
			</p>
		{:else if projectPreviewImage}<img
				src={projectPreviewImage}
				alt={projectPreviewPath}
				class="max-h-[70vh] w-full object-contain"
			/>
		{:else}<pre
				class="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words text-sm">{projectPreviewText}</pre>{/if}
		<AlertDialog.Footer
			><AlertDialog.Cancel>Close</AlertDialog.Cancel></AlertDialog.Footer
		>
	</AlertDialog.Content>
</AlertDialog.Root>
<p class="mt-3 text-center text-[11px] text-white/35">
	Enter to send · Shift + Enter for a new line · Files attach from your project
</p>
