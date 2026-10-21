<script lang="ts">
	import DOMPurify from "dompurify";
	import hljs from "highlight.js/lib/common";
	import "highlight.js/styles/github-dark.css";
	import {
		Check,
		ChevronDown,
		ChevronRight,
		ChevronUp,
		Copy,
		FileCode,
		FilePlus2,
		Folder,
		FolderPlus,
		LoaderCircle,
		Maximize2,
		Minimize2,
		PanelRightClose,
		Pencil,
		RefreshCw,
		Save,
		Search,
		X,
	} from "@lucide/svelte";
	import { onDestroy, onMount, tick } from "svelte";
	import { toast } from "svelte-sonner";
	import {
		chat,
		type WorkspaceFileEntry,
		type WorkspaceFilePreview,
	} from "$lib/chat";
	import { Button } from "$lib/components/ui/button";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Input } from "$lib/components/ui/input";

	let {
		projectId,
		projectName,
		projectPath,
		requestedPath = "",
		openRequest = 0,
		busy = false,
		hasUnsavedChanges = $bindable(false),
		expanded = $bindable(false),
		onclose,
	}: {
		projectId: string;
		projectName: string;
		projectPath: string;
		requestedPath?: string;
		openRequest?: number;
		busy?: boolean;
		hasUnsavedChanges?: boolean;
		expanded?: boolean;
		onclose: () => void;
	} = $props();

	type PreviewPreferences = {
		treeVisible?: boolean;
		treeWidth?: number;
		workspaceId?: string;
		activePath?: string | null;
		selectedDirectory?: string | null;
		expandedDirectories?: string[];
		expanded?: boolean;
	};

	let treeVisible = $state(true);
	let treeWidth = $state(250);
	let entriesByDirectory = $state<Record<string, WorkspaceFileEntry[]>>({});
	let expandedDirectories = $state<string[]>([]);
	let activePath = $state<string | null>(null);
	let selectedDirectory = $state<string | null>(null);
	let treeSearchQuery = $state("");
	let editing = $state(false);
	let draftContent = $state("");
	let saveBaseRevision = $state("");
	let saving = $state(false);
	let findReplaceOpen = $state(false);
	let findQuery = $state("");
	let replaceQuery = $state("");
	let caseSensitive = $state(false);
	let regexSearch = $state(false);
	let wholeWord = $state(false);
	let matchIndex = $state(-1);
	let editorElement = $state<HTMLTextAreaElement | undefined>(undefined);
	let findInputElement = $state<HTMLInputElement | undefined>(undefined);
	let gutterElement = $state<HTMLDivElement | undefined>(undefined);
	let treeLoading = $state(false);
	let refreshing = $state(false);
	let fileLoading = $state(false);
	let filePreview = $state<WorkspaceFilePreview | null>(null);
	let fileError = $state("");
	let missingFile = $state(false);
	let createOpen = $state(false);
	let createKind = $state<"file" | "directory">("file");
	let createName = $state("");
	let createError = $state("");
	let creating = $state(false);
	let copyState = $state<"path" | "content" | null>(null);
	let contextLabel = $state("Project checkout");
	let workspaceId = $state("");
	let disposed = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let preferencesReady = false;
	let initialTreeReady = false;
	let contentRequest = 0;
	let treeRequest = 0;
	let directoryRequest = new Map<string, number>();
	let lastRevision = "";
	let lastRevisionPath = "";
	let contextEpoch = 0;
	let handledOpenRequest = 0;
	const hiddenPreferencesKey = $derived(`loom.preview.panel.${projectId}`);

	const selectedParent = $derived.by(() => {
		if (selectedDirectory !== null) return selectedDirectory;
		if (activePath) return activePath.split("/").slice(0, -1).join("/");
		return "";
	});
	const unsavedChanges = $derived(
		editing && draftContent !== (filePreview?.content ?? ""),
	);
	const draftLineNumbers = $derived(
		draftContent.split("\n").map((_, index) => index + 1),
	);
	const findPatternError = $derived.by(() => {
		if (!regexSearch || !findQuery) return "";
		try {
			const source = wholeWord ? `\\b(?:${findQuery})\\b` : findQuery;
			new RegExp(source, `gu${caseSensitive ? "" : "i"}`);
			return "";
		} catch {
			return "Invalid regular expression";
		}
	});
	const findMatches = $derived.by(() => {
		if (!findQuery || findPatternError) return [];
		try {
			const source = regexSearch ? findQuery : escapeRegExp(findQuery);
			const boundedSource = wholeWord ? `\\b(?:${source})\\b` : source;
			const expression = new RegExp(
				boundedSource,
				`gu${caseSensitive ? "" : "i"}`,
			);
			const matches: Array<{ start: number; end: number; text: string }> = [];
			const sourceText = editing ? draftContent : displayCode;
			for (
				let match = expression.exec(sourceText);
				match;
				match = expression.exec(sourceText)
			) {
				matches.push({
					start: match.index,
					end: match.index + match[0].length,
					text: match[0],
				});
				if (!match[0].length) expression.lastIndex += 1;
			}
			return matches;
		} catch {
			return [];
		}
	});
	const syntaxLanguage = $derived(
		activePath?.split(".").at(-1)?.toLowerCase() ?? "plaintext",
	);
	const displayCode = $derived(filePreview?.content ?? "");
	const highlighted = $derived.by(() => {
		if (!filePreview || filePreview.binary || !filePreview.complete) return "";
		try {
			if (hljs.getLanguage(syntaxLanguage))
				return hljs.highlight(displayCode, { language: syntaxLanguage }).value;
			return hljs.highlightAuto(displayCode).value;
		} catch {
			return hljs.highlightAuto(displayCode).value;
		}
	});
	const safeHighlighted = $derived(DOMPurify.sanitize(highlighted));
	const codeLines = $derived(safeHighlighted.split("\n"));
	const filteredRootEntries = $derived(
		filterEntries(entriesByDirectory[""] ?? []),
	);

	function filterEntries(entries: WorkspaceFileEntry[]): WorkspaceFileEntry[] {
		const query = treeSearchQuery.trim().toLocaleLowerCase();
		if (!query) return entries;
		return entries.filter((entry) => {
			if (entry.name.toLocaleLowerCase().includes(query)) return true;
			return (
				entry.type === "directory" &&
				filterEntries(entriesByDirectory[entry.path] ?? []).length > 0
			);
		});
	}

	function escapeRegExp(value: string) {
		return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	function preferences(): PreviewPreferences {
		try {
			return JSON.parse(
				localStorage.getItem(hiddenPreferencesKey) ?? "{}",
			) as PreviewPreferences;
		} catch {
			return {};
		}
	}

	function projectRelativePath(path: string | null | undefined): string | null {
		if (!path) return null;
		const normalized = path.replaceAll("\\", "/");
		const root = projectPath.replaceAll("\\", "/").replace(/\/$/, "");
		if (normalized === root) return "";
		if (normalized.startsWith(`${root}/`))
			return normalized.slice(root.length + 1);
		return normalized.startsWith("/") ? null : normalized;
	}

	function savePreferences() {
		if (typeof localStorage === "undefined") return;
		try {
			localStorage.setItem(
				hiddenPreferencesKey,
				JSON.stringify({
					treeVisible,
					treeWidth,
					workspaceId,
					activePath,
					selectedDirectory,
					expandedDirectories: expandedDirectories.slice(0, 30),
					expanded,
				}),
			);
		} catch {
			// Panel state is only a preference; storage may be disabled.
		}
	}

	async function loadDirectory(directory: string) {
		const request = ++treeRequest;
		const requestContextEpoch = contextEpoch;
		const requestForDirectory = (directoryRequest.get(directory) ?? 0) + 1;
		directoryRequest.set(directory, requestForDirectory);
		if (!entriesByDirectory[directory]) treeLoading = true;
		try {
			const result = await chat.workspaceTree(
				projectId,
				directory,
				directory ? workspaceId : "",
			);
			if (
				disposed ||
				projectId !== result.context.projectId ||
				(requestContextEpoch !== contextEpoch && directory !== "") ||
				directoryRequest.get(directory) !== requestForDirectory
			)
				return;
			if (workspaceId && workspaceId !== result.context.workspaceId) {
				contextEpoch++;
				contentRequest++;
				entriesByDirectory = {};
				expandedDirectories = [];
				activePath = null;
				selectedDirectory = null;
				filePreview = null;
				fileError = "";
				lastRevision = "";
				lastRevisionPath = "";
				toast.info(
					"The project checkout changed. The file selection was reset.",
				);
			}
			workspaceId = result.context.workspaceId;
			contextLabel = result.context.label;
			entriesByDirectory = {
				...entriesByDirectory,
				[directory]: result.entries,
			};
			if (result.truncated)
				toast.info(
					`Showing the first ${result.entries.length} entries in ${directory || "the project root"}.`,
				);
		} catch (reason) {
			if (
				!disposed &&
				directoryRequest.get(directory) === requestForDirectory
			) {
				fileError =
					reason instanceof Error
						? reason.message
						: "Unable to list workspace files.";
			}
		} finally {
			if (!disposed && request === treeRequest) treeLoading = false;
		}
	}

	async function openFile(path: string, silent = false) {
		if (unsavedChanges) {
			toast.error("Save or discard your edits before opening another file.");
			return;
		}
		if (editing) editing = false;
		activePath = path;
		selectedDirectory = null;
		fileLoading = !silent;
		fileError = "";
		missingFile = false;
		const request = ++contentRequest;
		try {
			if (!workspaceId) throw new Error("Workspace context is not ready yet.");
			const result = await chat.workspaceFile(projectId, path, workspaceId);
			if (disposed || request !== contentRequest) return;
			if (
				lastRevisionPath === path &&
				lastRevision &&
				lastRevision !== result.revision
			)
				toast.info("File changed on disk. Preview refreshed.");
			lastRevision = result.revision;
			lastRevisionPath = path;
			filePreview = result;
		} catch (reason) {
			if (disposed || request !== contentRequest) return;
			filePreview = null;
			missingFile = true;
			fileError =
				reason instanceof Error ? reason.message : "Unable to read this file.";
		} finally {
			if (!disposed && request === contentRequest) fileLoading = false;
		}
	}

	async function toggleDirectory(path: string) {
		selectedDirectory = path;
		if (expandedDirectories.includes(path)) {
			expandedDirectories = expandedDirectories.filter((item) => item !== path);
			return;
		}
		expandedDirectories = [...expandedDirectories, path];
		await loadDirectory(path);
	}

	async function refresh() {
		if (refreshing) return;
		if (unsavedChanges) {
			toast.error("Save or discard your edits before refreshing the preview.");
			return;
		}
		refreshing = true;
		fileError = "";
		try {
			await loadDirectory("");
			for (const directory of expandedDirectories)
				await loadDirectory(directory);
			if (activePath) await openFile(activePath);
		} finally {
			refreshing = false;
		}
	}

	function beginEdit() {
		if (!filePreview || filePreview.binary || !filePreview.complete) return;
		draftContent = filePreview.content ?? "";
		saveBaseRevision = filePreview.revision;
		editing = true;
	}

	function cancelEdit() {
		if (saving) return;
		draftContent = filePreview?.content ?? "";
		editing = false;
		findReplaceOpen = false;
		matchIndex = -1;
	}

	async function saveFile() {
		if (
			!activePath ||
			!filePreview ||
			!editing ||
			!unsavedChanges ||
			saving ||
			busy ||
			!workspaceId
		)
			return;
		saving = true;
		const lineEnding = filePreview.content?.includes("\r\n") ? "\r\n" : "\n";
		const content =
			lineEnding === "\r\n"
				? draftContent.replace(/\r?\n/g, "\r\n")
				: draftContent;
		try {
			const result = await chat.saveWorkspaceFile(
				projectId,
				workspaceId,
				activePath,
				content,
				saveBaseRevision,
				crypto.randomUUID(),
			);
			filePreview = {
				...filePreview,
				content,
				byteSize: result.byteSize,
				revision: result.revision,
			};
			draftContent = content;
			saveBaseRevision = result.revision;
			lastRevision = result.revision;
			lastRevisionPath = activePath;
			editing = false;
			findReplaceOpen = false;
			toast.success("File saved.");
		} catch (reason) {
			toast.error(
				reason instanceof Error ? reason.message : "Unable to save this file.",
			);
		} finally {
			saving = false;
		}
	}

	async function openFindReplace() {
		findReplaceOpen = !findReplaceOpen;
		if (!findReplaceOpen) return;
		await tick();
		findInputElement?.focus();
		findInputElement?.select();
	}

	async function findNext(direction: 1 | -1) {
		if (!editing) beginEdit();
		await tick();
		if (!findMatches.length) {
			matchIndex = -1;
			return;
		}
		matchIndex =
			direction === 1
				? (matchIndex + 1 + findMatches.length) % findMatches.length
				: (matchIndex <= 0 ? findMatches.length : matchIndex) - 1;
		const match = findMatches[matchIndex];
		if (!match || !editorElement) return;
		editorElement.setSelectionRange(match.start, match.end);
		const line = draftContent.slice(0, match.start).split("\n").length - 1;
		editorElement.scrollTop = line * 24;
	}

	async function replaceCurrent() {
		if (!editing) beginEdit();
		await tick();
		if (matchIndex < 0 && findMatches.length) matchIndex = 0;
		const match = findMatches[matchIndex];
		if (!match) {
			await findNext(1);
			return;
		}
		const source = regexSearch ? findQuery : escapeRegExp(findQuery);
		const boundedSource = wholeWord ? `\\b(?:${source})\\b` : source;
		const flags = `u${caseSensitive ? "" : "i"}`;
		try {
			const expression = new RegExp(boundedSource, flags);
			const replacement = match.text.replace(expression, replaceQuery);
			draftContent =
				draftContent.slice(0, match.start) +
				replacement +
				draftContent.slice(match.end);
			matchIndex = -1;
			await tick();
			await findNext(1);
		} catch {
			toast.error("Check the search expression and replacement text.");
		}
	}

	function replaceAll() {
		if (!findQuery) return;
		if (!editing) beginEdit();
		const source = regexSearch ? findQuery : escapeRegExp(findQuery);
		const boundedSource = wholeWord ? `\\b(?:${source})\\b` : source;
		try {
			const expression = new RegExp(
				boundedSource,
				`gu${caseSensitive ? "" : "i"}`,
			);
			const nextContent = draftContent.replace(expression, replaceQuery);
			const replacements = findMatches.length;
			draftContent = nextContent;
			matchIndex = -1;
			toast.success(
				`${replacements} replacement${replacements === 1 ? "" : "s"} applied.`,
			);
		} catch {
			toast.error("Check the search expression and replacement text.");
		}
	}

	function handleFindKeydown(event: KeyboardEvent) {
		if (event.key !== "Enter") return;
		event.preventDefault();
		void findNext(event.shiftKey ? -1 : 1);
	}

	function handleEditorScroll(event: Event) {
		if (gutterElement)
			gutterElement.scrollTop = (
				event.currentTarget as HTMLTextAreaElement
			).scrollTop;
	}

	function collapseAll() {
		expandedDirectories = [];
		selectedDirectory = null;
		// Keep the active file and the currently visible preview selected.
	}

	function showCreate(kind: "file" | "directory") {
		if (busy || !projectId || !workspaceId) return;
		if (unsavedChanges) {
			toast.error(
				"Save or discard your edits before creating a file or folder.",
			);
			return;
		}
		createKind = kind;
		createName = "";
		createError = "";
		createOpen = true;
	}

	async function submitCreate(event: SubmitEvent) {
		event.preventDefault();
		if (!createName.trim() || creating) return;
		creating = true;
		createError = "";
		const name = createName;
		const requestId = crypto.randomUUID();
		try {
			const result =
				createKind === "file"
					? await chat.createWorkspaceFile(
							projectId,
							workspaceId,
							selectedParent,
							name,
							requestId,
						)
					: await chat.createWorkspaceDirectory(
							projectId,
							workspaceId,
							selectedParent,
							name,
							requestId,
						);
			createOpen = false;
			await loadDirectory(selectedParent);
			if (selectedParent && !expandedDirectories.includes(selectedParent))
				expandedDirectories = [...expandedDirectories, selectedParent];
			if (result.type === "directory") {
				selectedDirectory = result.path;
				expandedDirectories = [...expandedDirectories, result.path];
				await loadDirectory(result.path);
			} else {
				selectedDirectory = selectedParent;
				await openFile(result.path);
			}
			toast.success(`${createKind === "file" ? "File" : "Folder"} created.`);
		} catch (reason) {
			createError =
				reason instanceof Error
					? reason.message
					: "Unable to create workspace entry.";
		} finally {
			creating = false;
		}
	}

	async function copy(value: string, kind: "path" | "content") {
		try {
			if (!navigator.clipboard?.writeText)
				throw new Error("Clipboard access is unavailable in this browser.");
			await navigator.clipboard.writeText(value);
			copyState = kind;
			toast.success(
				kind === "path" ? "File path copied." : "File content copied.",
			);
			setTimeout(() => {
				if (copyState === kind) copyState = null;
			}, 1500);
		} catch (reason) {
			toast.error(
				reason instanceof Error
					? reason.message
					: "Unable to copy to clipboard.",
			);
		}
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
			event.preventDefault();
			if (!findReplaceOpen) void openFindReplace();
			return;
		}
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "h") {
			event.preventDefault();
			if (!findReplaceOpen) void openFindReplace();
			return;
		}
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void saveFile();
			return;
		}
		if (event.key === "Escape" && findReplaceOpen) {
			findReplaceOpen = false;
			event.stopPropagation();
			return;
		}
		if (event.key === "Escape" && expanded && !createOpen) {
			expanded = false;
			event.stopPropagation();
		}
	}

	function closePreview() {
		if (unsavedChanges) {
			toast.error("Save or discard your edits before closing this panel.");
			return;
		}
		onclose();
	}

	function openCreateParentLabel() {
		return selectedParent || "Project root";
	}

	onMount(async () => {
		const saved = preferences();
		treeVisible = saved.treeVisible ?? true;
		treeWidth = Math.max(180, Math.min(420, saved.treeWidth ?? 250));
		activePath = projectRelativePath(saved.activePath);
		selectedDirectory = projectRelativePath(saved.selectedDirectory);
		expandedDirectories = (saved.expandedDirectories ?? [])
			.map(projectRelativePath)
			.filter((path): path is string => path !== null)
			.slice(0, 30);
		workspaceId = saved.workspaceId ?? "";
		expanded = saved.expanded ?? false;
		preferencesReady = true;
		await loadDirectory("");
		initialTreeReady = true;
		for (const path of expandedDirectories) await loadDirectory(path);
		if (activePath) await openFile(activePath);
		refreshTimer = setInterval(() => {
			if (disposed || document.hidden) return;
			void (async () => {
				await loadDirectory("");
				for (const path of expandedDirectories) await loadDirectory(path);
				if (activePath && !unsavedChanges && !editing)
					await openFile(activePath, true);
			})();
		}, 3000);
	});

	onDestroy(() => {
		disposed = true;
		if (refreshTimer) clearInterval(refreshTimer);
	});

	$effect(() => {
		if (!preferencesReady) return;
		treeVisible;
		treeWidth;
		activePath;
		selectedDirectory;
		expandedDirectories;
		expanded;
		savePreferences();
	});

	$effect(() => {
		const request = openRequest;
		const path = requestedPath;
		if (
			!initialTreeReady ||
			!workspaceId ||
			!path ||
			request === 0 ||
			request === handledOpenRequest
		)
			return;
		handledOpenRequest = request;
		void openFile(path);
	});

	$effect(() => {
		hasUnsavedChanges = unsavedChanges;
	});
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#snippet renderEntries(entries: WorkspaceFileEntry[], depth: number)}
	{#each entries as entry (entry.path)}
		{@const isOpen = expandedDirectories.includes(entry.path)}
		<div
			class="flex min-w-0 items-center"
			style={`padding-left:${8 + depth * 14}px`}
		>
			{#if entry.type === "directory"}
				<Button
					variant="ghost"
					class={`h-7 min-w-0 flex-1 justify-start gap-1.5 rounded-md px-1.5 text-left text-xs ${selectedDirectory === entry.path ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
					title={entry.path}
					aria-expanded={isOpen}
					aria-label={`${isOpen ? "Collapse" : "Expand"} folder ${entry.name}`}
					onclick={() => void toggleDirectory(entry.path)}
				>
					{#if isOpen}<ChevronDown size={13} />{:else}<ChevronRight
							size={13}
						/>{/if}
					<Folder size={14} class="shrink-0 text-amber-300/80" />
					<span class="min-w-0 truncate">{entry.name}</span>
				</Button>
			{:else}
				<Button
					variant="ghost"
					class={`h-7 min-w-0 flex-1 justify-start gap-1.5 rounded-md px-1.5 text-left text-xs ${activePath === entry.path ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
					title={entry.path}
					aria-current={activePath === entry.path ? "page" : undefined}
					onclick={() => void openFile(entry.path)}
				>
					<span class="w-[13px] shrink-0" aria-hidden="true"></span>
					<FileCode size={14} class="shrink-0 text-sky-300/80" />
					<span class="min-w-0 truncate">{entry.name}</span>
				</Button>
			{/if}
		</div>
		{#if entry.type === "directory" && isOpen}
			{@render renderEntries(
				filterEntries(entriesByDirectory[entry.path] ?? []),
				depth + 1,
			)}
		{/if}
	{/each}
{/snippet}

<div
	class={`flex min-h-0 flex-1 flex-col bg-background/60 ${expanded ? "absolute inset-0 z-20" : ""}`}
>
	<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
		<FileCode size={15} class="shrink-0 text-primary" />
		<div class="min-w-0 flex-1">
			<p
				class="truncate text-xs font-medium"
				title={activePath ?? `${projectName}/`}
			>
				{activePath ?? projectName}
			</p>
			<p class="text-[10px] text-muted-foreground">{contextLabel}</p>
		</div>
		<Button
			variant="ghost"
			size="icon"
			class="size-8"
			aria-label={treeVisible ? "Hide file tree" : "Show file tree"}
			title={treeVisible ? "Hide file tree" : "Show file tree"}
			aria-pressed={treeVisible}
			onclick={() => (treeVisible = !treeVisible)}
		>
			<PanelRightClose size={15} class={treeVisible ? "" : "rotate-180"} />
		</Button>
		<Button
			variant="ghost"
			size="icon"
			class="size-8"
			aria-label={expanded ? "Restore panel" : "Expand panel"}
			title={expanded ? "Restore panel" : "Expand panel"}
			aria-pressed={expanded}
			onclick={() => (expanded = !expanded)}
		>
			{#if expanded}<Minimize2 size={15} />{:else}<Maximize2 size={15} />{/if}
		</Button>
		<Button
			variant="ghost"
			size="icon"
			class="size-8"
			aria-label="Close file preview"
			title="Close"
			onclick={closePreview}><X size={15} /></Button
		>
	</header>
	<div class="flex min-h-0 flex-1 flex-col md:flex-row">
		{#if treeVisible}
			<aside
				class="order-2 flex min-h-0 shrink-0 flex-col border-t md:border-t-0 md:border-l max-md:!w-full max-md:max-h-60"
				style={`width:${treeWidth}px`}
				aria-label="Workspace file tree"
			>
				<div class="flex h-10 shrink-0 items-center gap-0.5 border-b px-2">
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label="Create file"
						title="New file"
						disabled={busy || !projectId || !workspaceId}
						onclick={() => showCreate("file")}><FilePlus2 size={14} /></Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label="Create folder"
						title="New folder"
						disabled={busy || !projectId || !workspaceId}
						onclick={() => showCreate("directory")}
						><FolderPlus size={14} /></Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label="Refresh file tree and preview"
						title="Refresh"
						disabled={refreshing || treeLoading}
						onclick={() => void refresh()}
						><RefreshCw
							size={13}
							class={refreshing ? "animate-spin" : ""}
						/></Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label="Collapse all folders"
						title="Collapse all folders"
						onclick={collapseAll}><ChevronDown size={14} /></Button
					>
				</div>
				<div class="relative border-b p-2">
					<Search
						size={13}
						class="pointer-events-none absolute left-4 top-[17px] text-muted-foreground"
					/>
					<Input
						class="h-8 pl-8 text-xs"
						aria-label="Search files and folders"
						placeholder="Search files…"
						bind:value={treeSearchQuery}
					/>
				</div>
				<div class="nice-scroll min-h-0 flex-1 overflow-auto p-2">
					<div
						class="mb-1 flex items-center gap-1 px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
					>
						<Folder size={12} />{projectName}
					</div>
					{#if treeLoading && !entriesByDirectory[""]}<div
							class="flex items-center gap-2 px-2 py-5 text-xs text-muted-foreground"
						>
							<LoaderCircle size={14} class="animate-spin" />Loading files…
						</div>
					{:else if filteredRootEntries.length}{@render renderEntries(
							filteredRootEntries,
							0,
						)}
					{:else}<p class="px-2 py-5 text-center text-xs text-muted-foreground">
							{treeSearchQuery
								? "No matching files."
								: "This project has no visible files."}
						</p>{/if}
				</div>
				<div
					class="flex items-center justify-between border-t px-2 py-1.5 text-[10px] text-muted-foreground"
				>
					<span class="truncate">{selectedParent || "Project root"}</span><span
						class="shrink-0">Project</span
					>
				</div>
			</aside>
		{/if}
		<section class="relative order-1 flex min-h-0 min-w-0 flex-1 flex-col">
			<div class="flex h-10 shrink-0 items-center gap-1 border-b px-3">
				<span
					class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
					>{activePath ?? "No file selected"}</span
				>
				{#if unsavedChanges}<span
						class="mr-1 size-2 rounded-full bg-amber-400"
						title="Unsaved changes"
					></span>{/if}
				<Button
					variant="ghost"
					size="icon"
					class={`size-7 ${findReplaceOpen ? "text-primary" : ""}`}
					aria-label="Find and replace"
					title="Find and replace (Ctrl/⌘+F)"
					disabled={!filePreview || filePreview.binary}
					aria-pressed={findReplaceOpen}
					onclick={() => void openFindReplace()}
				>
					<Search size={14} />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					aria-label="Copy file path"
					title="Copy file path"
					disabled={!activePath}
					onclick={() => activePath && void copy(activePath, "path")}
				>
					{#if copyState === "path"}<Check size={14} />{:else}<FileCode
							size={14}
						/>{/if}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					aria-label="Copy file content"
					title="Copy file content"
					disabled={!filePreview || filePreview.binary || !filePreview.complete}
					onclick={() =>
						filePreview?.content !== null &&
						filePreview?.content !== undefined &&
						void copy(editing ? draftContent : filePreview.content, "content")}
				>
					{#if copyState === "content"}<Check size={14} />{:else}<Copy
							size={14}
						/>{/if}
				</Button>
				{#if editing}
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label="Cancel edits"
						title="Discard edits"
						disabled={saving}
						onclick={cancelEdit}><X size={14} /></Button
					>
					<Button
						size="icon"
						class="size-7"
						aria-label="Save file"
						title="Save file (Ctrl/⌘+S)"
						disabled={!unsavedChanges || saving || busy}
						onclick={() => void saveFile()}
					>
						{#if saving}<LoaderCircle
								size={14}
								class="animate-spin"
							/>{:else}<Save size={14} />{/if}
					</Button>
				{:else}
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label="Edit file"
						title="Edit file"
						disabled={!filePreview ||
							filePreview.binary ||
							!filePreview.complete ||
							busy}
						onclick={beginEdit}><Pencil size={14} /></Button
					>
				{/if}
			</div>
			{#if findReplaceOpen}
				<div
					class="absolute right-3 top-12 z-20 w-[min(480px,calc(100%-24px))] rounded-lg border bg-popover p-2 shadow-xl"
					aria-label="Find and replace"
				>
					<div class="flex flex-wrap items-center gap-1 sm:flex-nowrap">
						<input
							bind:this={findInputElement}
							class="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
							aria-label="Find text"
							placeholder="Find"
							bind:value={findQuery}
							oninput={() => (matchIndex = -1)}
							onkeydown={handleFindKeydown}
						/>
						<Button
							variant={caseSensitive ? "secondary" : "ghost"}
							size="sm"
							class="h-7 min-w-7 px-1.5 text-xs"
							aria-label="Match case"
							title="Match case"
							aria-pressed={caseSensitive}
							onclick={() => {
								caseSensitive = !caseSensitive;
								matchIndex = -1;
							}}>Aa</Button
						>
						<Button
							variant={regexSearch ? "secondary" : "ghost"}
							size="sm"
							class="h-7 min-w-7 px-1.5 font-mono text-xs"
							aria-label="Use regular expression"
							title="Use regular expression"
							aria-pressed={regexSearch}
							onclick={() => {
								regexSearch = !regexSearch;
								matchIndex = -1;
							}}>.*</Button
						>
						<Button
							variant={wholeWord ? "secondary" : "ghost"}
							size="sm"
							class="h-7 min-w-7 px-1.5 font-mono text-xs"
							aria-label="Match whole word"
							title="Match whole word"
							aria-pressed={wholeWord}
							onclick={() => {
								wholeWord = !wholeWord;
								matchIndex = -1;
							}}>ab</Button
						>
						<Button
							variant="ghost"
							size="icon"
							class="size-7"
							aria-label="Previous match"
							title="Previous match"
							disabled={!findMatches.length}
							onclick={() => void findNext(-1)}><ChevronUp size={14} /></Button
						>
						<Button
							variant="ghost"
							size="icon"
							class="size-7"
							aria-label="Next match"
							title="Next match"
							disabled={!findMatches.length}
							onclick={() => void findNext(1)}><ChevronDown size={14} /></Button
						>
						<Button
							variant="ghost"
							size="icon"
							class="size-7"
							aria-label="Close find and replace"
							title="Close"
							onclick={() => (findReplaceOpen = false)}><X size={14} /></Button
						>
					</div>
					<div class="mt-1 flex flex-wrap items-center gap-1 sm:flex-nowrap">
						<Input
							class="h-7 min-w-0 flex-1 text-xs"
							aria-label="Replace with"
							placeholder="Replace"
							bind:value={replaceQuery}
							onkeydown={handleFindKeydown}
						/>
						<span
							class="min-w-16 text-center text-[10px] text-muted-foreground"
							aria-live="polite"
							>{#if findPatternError}{findPatternError}{:else if findQuery}{findMatches.length
									? `${matchIndex < 0 ? 1 : matchIndex + 1} of ${findMatches.length}`
									: "No results"}{/if}</span
						>
						<Button
							variant="outline"
							size="sm"
							class="h-7 px-2 text-xs"
							disabled={!findMatches.length || !!findPatternError}
							onclick={() => void replaceCurrent()}>Replace</Button
						>
						<Button
							variant="outline"
							size="sm"
							class="h-7 px-2 text-xs"
							disabled={!findQuery || !findMatches.length || !!findPatternError}
							onclick={replaceAll}>All</Button
						>
					</div>
				</div>
			{/if}
			{#if fileLoading}<div
					role="status"
					class="grid min-h-0 flex-1 place-items-center text-xs text-muted-foreground"
				>
					<span class="flex items-center gap-2"
						><LoaderCircle size={14} class="animate-spin" />Loading file
						preview…</span
					>
				</div>
			{:else if fileError}<div
					role="alert"
					class="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
				>
					<p>{fileError}</p>
					{#if missingFile}<Button
							variant="outline"
							size="sm"
							class="mt-3"
							onclick={() => activePath && void openFile(activePath)}
							>Retry preview</Button
						>{/if}
				</div>
			{:else if filePreview?.binary}<div
					class="grid min-h-0 flex-1 place-items-center p-6 text-center"
				>
					<div>
						<FileCode size={22} class="mx-auto text-muted-foreground" />
						<p class="mt-2 text-sm font-medium">Unsupported binary preview</p>
						<p class="mt-1 text-xs text-muted-foreground">
							This file is binary and cannot be displayed or copied as text.
						</p>
					</div>
				</div>
			{:else if !activePath}<div
					class="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-muted-foreground"
				>
					Select a file from the project tree to preview its contents.
				</div>
			{:else if editing}<div
					class="flex min-h-0 flex-1 overflow-hidden bg-background"
				>
					<div
						bind:this={gutterElement}
						class="nice-scroll min-w-12 shrink-0 overflow-hidden py-2 text-right font-mono text-xs leading-6 text-muted-foreground"
					>
						{#each draftLineNumbers as line}<div class="h-6 pr-3">
								{line}
							</div>{/each}
					</div>
					<textarea
						bind:this={editorElement}
						bind:value={draftContent}
						class="nice-scroll min-h-0 min-w-0 flex-1 resize-none overflow-auto bg-transparent px-3 py-2 font-mono text-xs leading-6 text-foreground outline-none"
						aria-label={`Edit ${activePath ?? "file"}`}
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						wrap="off"
						onscroll={handleEditorScroll}
						oninput={() => (matchIndex = -1)}></textarea>
				</div>
			{:else}<div
					class="nice-scroll min-h-0 flex-1 overflow-auto bg-background"
				>
					<pre class="min-w-fit p-0 text-xs leading-6"><code
							class="hljs block bg-transparent py-2"
							>{#each codeLines as line, index}<span
									class="preview-code-line"
									data-line={index + 1}>{@html line || " "}</span
								>{/each}</code
						></pre>
				</div>
			{/if}
		</section>
	</div>
</div>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title
				>{createKind === "file" ? "Create file" : "Create folder"}</Dialog.Title
			>
			<Dialog.Description
				>Create a new entry in this project checkout.</Dialog.Description
			>
		</Dialog.Header>
		<form class="flex flex-col gap-4" onsubmit={submitCreate}>
			<div class="rounded-md border bg-muted/30 px-3 py-2 text-xs">
				<span class="text-muted-foreground">Parent</span>
				<p class="mt-1 break-all font-mono">{openCreateParentLabel()}</p>
			</div>
			<label
				class="flex flex-col gap-2 text-sm font-medium"
				for="workspace-entry-name"
				>{createKind === "file" ? "File name" : "Folder name"}<Input
					id="workspace-entry-name"
					bind:value={createName}
					maxlength={255}
					autocomplete="off"
					placeholder={createKind === "file"
						? "e.g. new-file.ts"
						: "e.g. components"}
				/></label
			>
			{#if createError}<p role="alert" class="text-xs text-destructive">
					{createError}
				</p>{/if}
			<Dialog.Footer
				><Button
					type="button"
					variant="outline"
					onclick={() => (createOpen = false)}
					disabled={creating}>Cancel</Button
				><Button type="submit" disabled={!createName.trim() || creating}
					>{#if creating}<LoaderCircle
							size={14}
							class="animate-spin"
						/>{/if}Create {createKind === "file" ? "file" : "folder"}</Button
				></Dialog.Footer
			>
		</form>
	</Dialog.Content>
</Dialog.Root>

<style>
	.preview-code-line {
		display: block;
		position: relative;
		min-height: 1.5rem;
		padding-left: 4.25rem;
		padding-right: 1rem;
		white-space: pre;
	}
	.preview-code-line::before {
		position: absolute;
		left: 0;
		width: 3.25rem;
		padding-right: 0.75rem;
		color: var(--muted-foreground);
		text-align: right;
		content: attr(data-line);
		user-select: none;
	}
	@media (max-width: 767px) {
		aside[aria-label="Workspace file tree"] {
			width: 100% !important;
			max-height: 40%;
		}
	}
</style>
