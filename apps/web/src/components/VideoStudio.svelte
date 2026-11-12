<script lang="ts">
	import {
		Clock,
		Columns3,
		Film,
		GitBranch,
		LoaderCircle,
		MessageSquare,
		PlayCircle,
		Plus,
		Sparkles,
		Upload,
		Video,
		Pencil as PencilIcon,
	} from "@lucide/svelte";
	import { onMount } from "svelte";
	import { toast } from "svelte-sonner";
	import type { Catalog } from "$lib/chat";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
	import * as Select from "$lib/components/ui/select/index.js";
	import {
		daemon,
		type CustomAgentMonitorItem,
		type Project,
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

	let agents = $state<CustomAgentMonitorItem[]>([]);
	let providers = $state<
		Array<{ id: string; providerId: string; name: string; status: string }>
	>([]);
	let tasks = $state<Array<{ id: string; projectId: string; title: string; status: string }>>([]);
	let loading = $state(true);
	let error = $state("");

	let selectedAgentId = $state("");
	let selectedProviderId = $state("");
	let selectedModelId = $state("");
	let availableModels = $state<
		Array<{ id: string; name: string; displayName: string; isAvailable: boolean; isDefault?: boolean }>
	>([]);
	let selectedTaskId = $state("");
	let filePath = $state("out/video.mp4");
	let loadingFile = $state(false);
	let seeding = $state(false);
	let prompt = $state(
		"Generate a short promotional video for this project. Use Remotion (remotion-dev/remotion) and bang-motion (bangtutorial/bang-motion) techniques. Render an MP4 to out/video.mp4. Include a title card, 2-3 feature highlights, and an outro with a call to action.",
	);
	let criteria = $state(
		"MP4 video rendered to out/video.mp4\nNo render or TypeScript errors\nVideo plays end-to-end",
	);
	let generating = $state(false);
	let lastTaskId = $state<string | null>(null);

	// Preview state
	let videoFile = $state<File | null>(null);
	let videoUrl = $state<string | null>(null);
	let objectUrl = $state<string | null>(null);

	// Edit at timestamp
	let editSeconds = $state(0);
	let editInstruction = $state("");
	let editing = $state(false);
	let videoEl = $state<HTMLVideoElement | null>(null);
	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let revisions = $state<
		Array<{ seconds: number; instruction: string; at: string }>
	>([]);
	let thumbnailUrl = $state<string | null>(null);
	let currentTime = $state(0);
	let duration = $state(0);
	let autoDetecting = $state(false);
	let autoDetectingTaskId = "";
	let autoDetectedTaskId = "";

	$effect(() => {
		const taskId = selectedTaskId;
		if (taskId) {
			void autoDetectVideo(taskId);
		}
	});

	$effect(() => {
		if (!selectedProviderId) {
			availableModels = [];
			selectedModelId = "";
			return;
		}
		const p = providers.find((x) => x.id === selectedProviderId);
		if (!p) return;
		void (async () => {
			try {
				const ms = await daemon.listProviderModels(p.providerId);
				availableModels = ms.filter((m) => m.isAvailable);
				const def = availableModels.find((m) => m.isDefault);
				selectedModelId = def?.id ?? availableModels[0]?.id ?? "";
			} catch {
				availableModels = [];
			}
		})();
	});

	const remotionSrcdoc =
		"<!DOCTYPE html><html><head><style>body{margin:0;background:#0b0b0d;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}h1{font-size:2rem;animation:fade 2s ease-in-out infinite alternate}@keyframes fade{from{opacity:.3;transform:scale(.9)}to{opacity:1;transform:scale(1)}}</style></head><body><h1>Remotion · Title Card</h1></body></html>";
	const bangMotionSrcdoc =
		"<!DOCTYPE html><html><head><style>body{margin:0;background:#0b0b0d;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}.box{width:60px;height:60px;background:#a78bfa;border-radius:12px;animation:move 1.5s ease-in-out infinite alternate}@keyframes move{from{transform:translateX(-60px) rotate(0)}to{transform:translateX(60px) rotate(360deg)}}</style></head><body><div class=\"box\"></div></body></html>";

	onMount(async () => {
		try {
			const [ag, prov, allTasks] = await Promise.all([
				daemon.listCustomAgents(projectId),
				daemon.listProviders(),
				daemon.listTasks(),
			]);
			agents = ag.filter((a) => a.allowKanban && a.status === "active");
			providers = prov
				.filter((p) => p.installed)
				.map((p) => ({
					id: p.id,
					providerId: p.providerId,
					name: p.name,
					status: p.status ?? "unknown",
				}));
			tasks = allTasks
				.filter((t) => t.projectId === projectId)
				.map((t) => ({
					id: t.id,
					projectId: t.projectId,
					title: t.title,
					status: t.status,
				}));
			if (tasks.length) selectedTaskId = tasks[0].id;
			if (agents.length) selectedAgentId = agents[0].id;
			else if (providers.length) selectedProviderId = providers[0].id;
		} catch (reason) {
			error =
				reason instanceof Error ? reason.message : "Unable to load agents";
		} finally {
			loading = false;
		}
	});

	function handleFileChange(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0] ?? null;
		if (objectUrl) URL.revokeObjectURL(objectUrl);
		videoFile = file;
		if (file) {
			const url = URL.createObjectURL(file);
			objectUrl = url;
			videoUrl = url;
		} else {
			objectUrl = null;
			videoUrl = null;
		}
	}

	async function loadFromTask() {
		if (!selectedTaskId) {
			toast.error("Select a task");
			return;
		}
		if (!filePath.trim()) {
			toast.error("Enter a file path");
			return;
		}
		loadingFile = true;
		try {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
			const url = await daemon.taskFileUrl(selectedTaskId, filePath.trim());
			objectUrl = url;
			videoUrl = url;
			toast.success("Loaded from task worktree");
		} catch (reason) {
			toast.error(
				reason instanceof Error ? reason.message : "Failed to load file",
			);
		} finally {
			loadingFile = false;
		}
	}

	async function seedVideoSkills() {
		seeding = true;
		try {
			const existing = await daemon.listContextEntries(projectId);
			const skills = [
				{
					title: "Remotion video generation",
					description:
						"Use Remotion (remotion-dev/remotion) to render MP4 videos programmatically in React.",
					content:
						"When generating videos for this project, use Remotion. Install with `npm i remotion @remotion/cli`. Create compositions in src/Video.tsx, render with `npx remotion render src/index.ts CompositionId out/video.mp4`. Reference: https://github.com/remotion-dev/remotion",
					sourceRef: null,
				},
				{
					title: "bang-motion motion design",
					description:
						"Motion design references and templates from bangtutorial/bang-motion.",
					content:
						"Use bang-motion templates for kinetic typography, transitions and motion graphics. Reference: https://github.com/bangtutorial/bang-motion",
					sourceRef: null,
				},
			];
			let created = 0;
			for (const s of skills) {
				if (existing.some((e) => e.title === s.title)) continue;
				await daemon.createContextEntry({
					projectId,
					kind: "skill",
					title: s.title,
					description: s.description,
					content: s.content,
					scope: "project",
					sourceKind: "manual",
					sourceRef: s.sourceRef,
					surfaces: ["chat", "kanban"],
					tags: ["video", "remotion"],
					pathGlobs: [],
				});
				created++;
			}
			toast.success(
				created
					? `Seeded ${created} video skill(s)`
					: "Video skills already present",
			);
		} catch (reason) {
			toast.error(
				reason instanceof Error ? reason.message : "Failed to seed skills",
			);
		} finally {
			seeding = false;
		}
	}

	const candidatePaths = [
		"out/video.mp4",
		"out/output.mp4",
		"video.mp4",
		"public/video.mp4",
		"remotion/out/video.mp4",
	];

	async function autoDetectVideo(taskId: string) {
		if (
			!taskId ||
			autoDetectingTaskId === taskId ||
			autoDetectedTaskId === taskId
		)
			return;
		autoDetectingTaskId = taskId;
		autoDetecting = true;
		try {
			for (const p of candidatePaths) {
				try {
					const url = await daemon.taskFileUrl(taskId, p);
					if (selectedTaskId !== taskId) {
						URL.revokeObjectURL(url);
						return;
					}
					if (objectUrl) URL.revokeObjectURL(objectUrl);
					objectUrl = url;
					videoUrl = url;
					filePath = p;
					autoDetectedTaskId = taskId;
					toast.success(`Auto-detected: ${p}`);
					return;
				} catch {
					// try next
				}
			}
			if (selectedTaskId === taskId) {
				autoDetectedTaskId = taskId;
				toast.info("No output MP4 found in common paths. Enter path manually.");
			}
		} finally {
			if (autoDetectingTaskId === taskId) autoDetectingTaskId = "";
			autoDetecting = false;
		}
	}

	async function captureThumbnail() {
		const v = videoEl;
		const c = canvasEl;
		if (!v || !c) return;
		try {
			if (!v.videoWidth || !v.videoHeight) return;
			v.currentTime = Math.min(1, (v.duration || 1) * 0.1);
			await new Promise<void>((resolve) => {
				const handler = () => {
					v.removeEventListener("seeked", handler);
					resolve();
				};
				v.addEventListener("seeked", handler);
				setTimeout(resolve, 1500);
			});
			c.width = v.videoWidth || 320;
			c.height = v.videoHeight || 180;
			const ctx = c.getContext("2d");
			if (ctx) {
				ctx.drawImage(v, 0, 0, c.width, c.height);
				thumbnailUrl = c.toDataURL("image/jpeg", 0.7);
			}
		} catch {
			// ignore thumbnail errors
		}
	}

	async function generate() {
		if (!prompt.trim()) {
			toast.error("Prompt is required");
			return;
		}
		let executor: { kind: string; [key: string]: unknown } | null = null;
		if (selectedAgentId) {
			executor = { kind: "agent", agentId: selectedAgentId };
		} else if (selectedProviderId) {
			const p = providers.find((x) => x.id === selectedProviderId);
			if (!p) {
				toast.error("Select a provider");
				return;
			}
			executor = {
				kind: "direct",
				providerId: p.providerId,
				modelId: selectedModelId || null,
			};
		} else {
			toast.error(
				"Configure a Kanban agent or connected provider in settings first",
			);
			return;
		}

		const acceptanceCriteria = criteria
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
		if (!acceptanceCriteria.length) {
			toast.error("Add at least one acceptance criterion");
			return;
		}

		generating = true;
		try {
			const task = await daemon.createTask({
				projectId,
				title: "Generate project video",
				prompt: `${prompt}\n\nReference templates:\n- Remotion: https://github.com/remotion-dev/remotion\n- bang-motion: https://github.com/bangtutorial/bang-motion\n\nRender output to out/video.mp4 (MP4).`,
				acceptanceCriteria,
				executor: executor as never,
				targetBranch: null,
			});
			lastTaskId = task.id;
			await daemon.startTask(task.id);
			toast.success(
				"Video generation task created and started. Track it on the Kanban board.",
			);
		} catch (reason) {
			toast.error(
				reason instanceof Error ? reason.message : "Failed to create task",
			);
		} finally {
			generating = false;
		}
	}

	async function sendEdit() {
		if (!lastTaskId) {
			toast.error("Generate a video task first");
			return;
		}
		if (!editInstruction.trim()) {
			toast.error("Describe the change");
			return;
		}
		editing = true;
		try {
			await daemon.queueTaskMessage(
				lastTaskId,
				`Edit the generated video at timestamp ${editSeconds}s: ${editInstruction}. Re-render out/video.mp4.`,
			);
			revisions = [
				...revisions,
				{
					seconds: editSeconds,
					instruction: editInstruction,
					at: new Date().toLocaleTimeString(),
				},
			];
			toast.success("Revision queued to the agent");
			editInstruction = "";
		} catch (reason) {
			toast.error(
				reason instanceof Error ? reason.message : "Failed to queue revision",
			);
		} finally {
			editing = false;
		}
	}

	// references are shown in-app via iframes above
</script>

<div class="flex h-full flex-col gap-6 overflow-y-auto p-6">
	<!-- Header -->
	<div class="flex items-center gap-3">
		<div
			class="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"
		>
			<Film size={20} />
		</div>
		<div>
			<h1 class="text-lg font-semibold tracking-tight">Video Studio</h1>
			<p class="text-xs text-white/45">
				Generate project videos with Remotion + bang-motion. {projectName
					? `· ${projectName}`
					: ""}
			</p>
		</div>
		<Button variant="outline" size="sm" onclick={seedVideoSkills} disabled={seeding}>
			{#if seeding}
				<LoaderCircle size={14} class="animate-spin" />
			{:else}
				<Plus size={14} />
			{/if}
			Seed video skills
		</Button>
	</div>

	{#if error}
		<p
			role="alert"
			class="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive"
		>
			{error}
		</p>
	{/if}

	<!-- Concept preview (in-app) -->
	<section class="space-y-3">
		<h2 class="text-sm font-semibold text-white/80">Concept preview</h2>
		<p class="text-xs text-white/45">
			Live preview rendered inside Loom. Review before generating.
		</p>
		<div class="grid gap-4 sm:grid-cols-2">
			<div
				class="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]"
			>
				<iframe
					title="Remotion example"
					class="h-40 w-full bg-black"
					srcdoc={remotionSrcdoc}
					sandbox="allow-scripts"
				></iframe>
				<div class="p-3">
					<p class="text-sm font-medium">Remotion</p>
					<p class="text-xs text-white/45">
						Make videos programmatically in React.
					</p>
				</div>
			</div>
			<div
				class="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]"
			>
				<iframe
					title="bang-motion example"
					class="h-40 w-full bg-black"
					srcdoc={bangMotionSrcdoc}
					sandbox="allow-scripts allow-same-origin"
				></iframe>
				<div class="p-3">
					<p class="text-sm font-medium">bang-motion</p>
					<p class="text-xs text-white/45">
						Motion design references and templates.
					</p>
				</div>
			</div>
		</div>
	</section>

	<!-- Generate -->
	<section class="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
		<h2 class="text-sm font-semibold text-white/80">Generate video</h2>
		{#if loading}
			<p class="text-xs text-white/45">Loading agents…</p>
		{:else}
			<div class="grid gap-3 sm:grid-cols-2">
				<div class="space-y-1.5">
					<label class="text-xs text-white/60">Kanban agent</label>
					<Select.Root
						type="single"
						value={selectedAgentId}
						onValueChange={(v) => {
							selectedAgentId = v ?? "";
							if (selectedAgentId) selectedProviderId = "";
						}}
					>
						<Select.Trigger class="w-full">
							{agents.find((a) => a.id === selectedAgentId)?.label ??
								"— none —"}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="">— none —</Select.Item>
							{#each agents as agent (agent.id)}
								<Select.Item value={agent.id}>{agent.label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
				<div class="space-y-1.5">
					<label class="text-xs text-white/60">Direct provider</label>
					<Select.Root
						type="single"
						value={selectedProviderId}
						onValueChange={(v) => {
							selectedProviderId = v ?? "";
							if (selectedProviderId) selectedAgentId = "";
						}}
					>
						<Select.Trigger class="w-full">
							{providers.find((p) => p.id === selectedProviderId)?.name ??
								"— none —"}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="">— none —</Select.Item>
							{#each providers as provider (provider.id)}
								<Select.Item value={provider.id}
									>{provider.name} ({provider.status})</Select.Item
								>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			</div>
			{#if selectedProviderId && availableModels.length}
				<div class="space-y-1.5">
					<label class="text-xs text-white/60">Model</label>
					<Select.Root
						type="single"
						value={selectedModelId}
						onValueChange={(v) => {
							selectedModelId = v ?? "";
						}}
					>
						<Select.Trigger class="w-full">
							{availableModels.find((m) => m.id === selectedModelId)
								?.displayName ?? "— none —"}
						</Select.Trigger>
						<Select.Content>
							{#each availableModels as m (m.id)}
								<Select.Item value={m.id}>{m.displayName}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			{/if}
			<div class="space-y-1.5">
				<label class="text-xs text-white/60" for="prompt">Prompt</label>
				<Textarea
					id="prompt"
					bind:value={prompt}
					rows={4}
					class="resize-none"
				/>
			</div>
			<div class="space-y-1.5">
				<label class="text-xs text-white/60" for="criteria"
					>Acceptance criteria (one per line)</label
				>
				<Textarea
					id="criteria"
					bind:value={criteria}
					rows={3}
					class="resize-none"
				/>
			</div>
			<div class="flex items-center gap-3">
				<Button onclick={generate} disabled={generating}>
					{#if generating}
						<LoaderCircle size={14} class="animate-spin" /> Generating…
					{:else}
						<Sparkles size={14} /> Generate video
					{/if}
				</Button>
				{#if lastTaskId}
					<span class="text-xs text-white/45">
						Task: {lastTaskId} · edit below
					</span>
				{/if}
			</div>
		{/if}
	</section>

	<!-- Preview result -->
	<section class="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
		<h2 class="text-sm font-semibold text-white/80">Preview generated video</h2>
		<p class="text-xs text-white/45">
			Select the rendered MP4 from your filesystem to preview it here.
		</p>
		<div class="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
			<div class="space-y-1.5">
				<label class="text-xs text-white/60" for="task-select">Task</label>
				<Select.Root
					type="single"
					value={selectedTaskId}
					onValueChange={(v) => {
						selectedTaskId = v ?? "";
					}}
				>
					<Select.Trigger class="w-full">
						{tasks.find((t) => t.id === selectedTaskId)?.title ??
							"— none —"}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="">— none —</Select.Item>
						{#each tasks as task (task.id)}
							<Select.Item value={task.id}
								>{task.title} ({task.status})</Select.Item
							>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<div class="space-y-1.5">
				<label class="text-xs text-white/60" for="filepath">File path</label>
				<Input
					id="filepath"
					bind:value={filePath}
					placeholder="out/video.mp4"
				/>
			</div>
			<Button onclick={loadFromTask} disabled={loadingFile || !selectedTaskId}>
				{#if loadingFile}
					<LoaderCircle size={14} class="animate-spin" />
				{:else}
					<PlayCircle size={14} />
				{/if}
				Load
			</Button>
		</div>
		<p class="text-[11px] text-white/30">
			Or pick a file manually:
		</p>
		<input
			type="file"
			accept="video/mp4,video/webm"
			onchange={handleFileChange}
			class="text-xs"
		/>
		<canvas bind:this={canvasEl} class="hidden"></canvas>
		{#if thumbnailUrl}
			<p class="text-[11px] text-white/40">
				Thumbnail captured automatically.
			</p>
		{/if}
		{#if videoUrl}
			<video
				bind:this={videoEl}
				src={videoUrl}
				controls
				poster={thumbnailUrl ?? undefined}
				onloadedmetadata={() => {
					duration = videoEl?.duration ?? 0;
					void captureThumbnail();
				}}
				ontimeupdate={() => {
					currentTime = videoEl?.currentTime ?? 0;
				}}
				class="mt-3 w-full max-w-2xl rounded-lg border border-white/10 bg-black"
			>
				<track kind="captions" />
			</video>
			{#if videoFile}
				<p class="text-xs text-white/45">
					{videoFile.name} · {(videoFile.size / 1024 / 1024).toFixed(2)} MB
				</p>
			{/if}
			{#if duration > 0}
				<div class="mt-3 w-full max-w-2xl">
					<div
						class="relative h-8 rounded-md border border-white/10 bg-white/[0.03]"
						role="slider"
						aria-valuemin={0}
						aria-valuemax={duration}
						aria-valuenow={currentTime}
						tabindex="0"
						onclick={(e) => {
							const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
							const ratio = (e.clientX - rect.left) / rect.width;
							const t = Math.max(0, Math.min(duration, ratio * duration));
							if (videoEl) videoEl.currentTime = t;
						}}
					>
						<div
							class="absolute top-0 left-0 h-full rounded-md bg-violet-500/30"
							style={`width: ${(currentTime / duration) * 100}%`}
						></div>
						{#each revisions as r (r.seconds + r.instruction)}
							<button
								type="button"
								class="absolute top-1/2 h-4 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-amber-400"
								style={`left: ${(r.seconds / duration) * 100}%`}
								title={`${r.seconds}s: ${r.instruction}`}
								onclick={(e) => {
									e.stopPropagation();
									if (videoEl) videoEl.currentTime = r.seconds;
								}}
							></button>
						{/each}
						<div
							class="absolute top-0 h-full w-0.5 bg-white"
							style={`left: ${(currentTime / duration) * 100}%`}
						></div>
					</div>
					<div class="mt-1 flex justify-between text-[10px] text-white/40">
						<span>{currentTime.toFixed(1)}s</span>
						<span>{duration.toFixed(1)}s</span>
					</div>
				</div>
			{/if}
		{:else}
			<div
				class="mt-3 flex h-40 items-center justify-center rounded-lg border border-dashed border-white/10 text-xs text-white/30"
			>
				No video selected yet
			</div>
		{/if}
	</section>

	<!-- Edit at timestamp -->
	<section class="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
		<h2 class="text-sm font-semibold text-white/80">Revise at timestamp</h2>
		<p class="text-xs text-white/45">
			Found a mistake at a specific second? Queue a revision to the agent.
		</p>
		<div class="flex flex-wrap items-end gap-3">
			<div class="space-y-1.5">
				<label class="text-xs text-white/60" for="secs">Second</label>
				<Input
					id="secs"
					type="number"
					min={0}
					bind:value={editSeconds}
					class="w-24"
				/>
			</div>
			<div class="min-w-0 flex-1 space-y-1.5">
				<label class="text-xs text-white/60" for="editinstr">Change</label>
				<Input
					id="editinstr"
					bind:value={editInstruction}
					placeholder="e.g. fix typo 'Lom' → 'Loom'"
				/>
			</div>
			<Button onclick={sendEdit} disabled={editing || !lastTaskId}>
				{#if editing}
					<LoaderCircle size={14} class="animate-spin" />
				{:else}
					<PencilIcon size={14} />
				{/if}
				Queue revision
			</Button>
		</div>
		{#if !lastTaskId}
			<p class="text-xs text-amber-300/70">
				Generate a video task first to enable revisions.
			</p>
		{/if}
		{#if revisions.length}
			<div class="mt-3 space-y-2">
				<p class="text-xs font-medium text-white/60">Queued revisions</p>
				<ul class="space-y-1">
					{#each revisions as r, i (i)}
						<li
							class="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-2 py-1 text-xs"
						>
							<button
								type="button"
								class="font-mono text-violet-300 hover:underline"
								onclick={() => {
									if (videoEl) videoEl.currentTime = r.seconds;
								}}
							>
								{r.seconds}s
							</button>
							<span class="flex-1 truncate text-white/70"
								>{r.instruction}</span
							>
							<span class="text-white/30">{r.at}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</section>
</div>