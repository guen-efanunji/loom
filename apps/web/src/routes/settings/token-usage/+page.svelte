<script lang="ts">
import {
	Activity,
	BarChart3,
	CalendarDays,
	CircleAlert,
	Clock3,
	Coins,
	MessageSquareText,
	RefreshCw,
	Server,
	Sparkles,
	WalletCards,
} from "@lucide/svelte";
import { onMount } from "svelte";
import { page } from "$app/state";
import { type ChatMessage, type ChatSession, chat } from "$lib/chat";
import SettingsSidebar from "$lib/components/settings/SettingsSidebar.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import * as Tabs from "$lib/components/ui/tabs";
import { daemon, type Project } from "$lib/daemon";
import { settingsHref } from "$lib/settings-navigation";

type Period = "today" | "7d" | "30d" | "all" | "custom";
type UsageRecord = {
	id: string;
	projectId: string;
	projectName: string;
	sessionId: string;
	sessionTitle: string;
	messageId: string;
	createdAt: number;
	providerId: string | null;
	modelId: string | null;
	totalTokens: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	costAmount: number | null;
	result: "completed" | "failed";
};
type ModelUsage = {
	key: string;
	providerId: string;
	modelId: string;
	records: UsageRecord[];
};
type TimeBucket = {
	key: string;
	label: string;
	knownTotal: number;
	withTotal: number;
	withoutTotal: number;
};

let projects = $state<Project[]>([]);
let records = $state<UsageRecord[]>([]);
let loading = $state(true);
let refreshing = $state(false);
let error = $state("");
let partialFailures = $state(0);
let cappedProjects = $state<string[]>([]);
let projectFilter = $state("all");
let providerFilter = $state("all");
let modelFilter = $state("all");
let activityFilter = $state("all");
let period = $state<Period>("30d");
let customFrom = $state("");
let customTo = $state("");
let activeView = $state("overview");
let chartMetric = $state<"tokens" | "cost">("tokens");
let lastUpdated = $state<number | null>(null);
let activityPage = $state(0);
let selectedActivity = $state<UsageRecord | null>(null);
let activityOpen = $state(false);
let settingsSearch = $state("");

const timezone =
	Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
const activityPageSize = 20;

function positiveNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function toUsageRecords(
	project: Project,
	session: ChatSession,
	messages: ChatMessage[],
): UsageRecord[] {
	return messages.flatMap((message) => {
		if (message.info.role !== "assistant") return [];
		const tokens = message.info.tokens;
		return [
			{
				id: `${session.id}:${message.info.id}`,
				projectId: project.id,
				projectName: project.name,
				sessionId: session.id,
				sessionTitle: session.title || "Untitled session",
				messageId: message.info.id,
				createdAt: message.info.time.completed ?? message.info.time.created,
				providerId: message.info.providerID || null,
				modelId: message.info.modelID || null,
				totalTokens: positiveNumber(tokens?.total),
				inputTokens: positiveNumber(tokens?.input),
				outputTokens: positiveNumber(tokens?.output),
				reasoningTokens: positiveNumber(tokens?.reasoning),
				cacheReadTokens: positiveNumber(tokens?.cache?.read),
				cacheWriteTokens: positiveNumber(tokens?.cache?.write),
				costAmount: positiveNumber(message.info.cost),
				result: message.info.error ? "failed" : "completed",
			},
		];
	});
}

async function mapConcurrent<T, U>(
	items: T[],
	limit: number,
	map: (item: T) => Promise<U>,
): Promise<U[]> {
	const results = new Array<U>(items.length);
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex++;
				results[index] = await map(items[index]!);
			}
		}),
	);
	return results;
}

async function loadUsage() {
	if (refreshing) return;
	refreshing = true;
	if (!records.length) loading = true;
	error = "";
	partialFailures = 0;
	cappedProjects = [];
	try {
		const loadedProjects = await daemon.listProjects();
		projects = loadedProjects;
		if (
			projectFilter !== "all" &&
			!loadedProjects.some((item) => item.id === projectFilter)
		) {
			projectFilter = "all";
		}
		const allProjectRecords = await mapConcurrent(
			loadedProjects,
			3,
			async (project) => {
				let sessions: ChatSession[];
				try {
					sessions = await chat.sessions(project.id);
				} catch {
					partialFailures += 1;
					return [] as UsageRecord[];
				}
				if (sessions.length >= 200)
					cappedProjects = [...cappedProjects, project.name];
				const sessionRecords = await mapConcurrent(
					sessions,
					5,
					async (session) => {
						try {
							const state = await chat.state(session.id);
							return toUsageRecords(project, session, state.messages);
						} catch {
							partialFailures += 1;
							return [] as UsageRecord[];
						}
					},
				);
				return sessionRecords.flat();
			},
		);
		const unique = new Map<string, UsageRecord>();
		for (const item of allProjectRecords.flat()) unique.set(item.id, item);
		records = [...unique.values()].sort((a, b) => b.createdAt - a.createdAt);
		lastUpdated = Date.now();
	} catch (reason) {
		error =
			reason instanceof Error
				? reason.message
				: "Unable to load usage history.";
	} finally {
		loading = false;
		refreshing = false;
	}
}

onMount(() => {
	const projectId = page.url.searchParams.get("project");
	if (projectId) projectFilter = projectId;
	void loadUsage();
});

function localDateStart(value: Date) {
	return new Date(
		value.getFullYear(),
		value.getMonth(),
		value.getDate(),
	).getTime();
}
function localNextDateStart(value: Date) {
	return new Date(
		value.getFullYear(),
		value.getMonth(),
		value.getDate() + 1,
	).getTime();
}

function dateFromInput(value: string, end = false): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	const [year, month, day] = match.slice(1).map(Number);
	const date = new Date(year!, month! - 1, day!);
	if (
		Number.isNaN(date.getTime()) ||
		date.getFullYear() !== year ||
		date.getMonth() !== month! - 1 ||
		date.getDate() !== day
	)
		return null;
	return end
		? new Date(
				date.getFullYear(),
				date.getMonth(),
				date.getDate() + 1,
			).getTime()
		: localDateStart(date);
}

const periodBounds = $derived.by(() => {
	const now = new Date();
	const today = localDateStart(now);
	if (period === "today") return { start: today, end: localNextDateStart(now) };
	if (period === "7d")
		return {
			start: new Date(
				now.getFullYear(),
				now.getMonth(),
				now.getDate() - 6,
			).getTime(),
			end: localNextDateStart(now),
		};
	if (period === "30d")
		return {
			start: new Date(
				now.getFullYear(),
				now.getMonth(),
				now.getDate() - 29,
			).getTime(),
			end: localNextDateStart(now),
		};
	if (period === "custom") {
		return {
			start: dateFromInput(customFrom),
			end: dateFromInput(customTo, true),
		};
	}
	return { start: null, end: null };
});

const scopedRecords = $derived.by(() =>
	records.filter((record) => {
		if (
			period === "custom" &&
			(periodBounds.start === null ||
				periodBounds.end === null ||
				periodBounds.start >= periodBounds.end)
		)
			return false;
		if (projectFilter !== "all" && record.projectId !== projectFilter)
			return false;
		if (periodBounds.start !== null && record.createdAt < periodBounds.start)
			return false;
		if (periodBounds.end !== null && record.createdAt >= periodBounds.end)
			return false;
		return true;
	}),
);
const providerOptions = $derived(
	[
		...new Set(
			scopedRecords
				.map((record) => record.providerId)
				.filter((id): id is string => !!id),
		),
	].sort(),
);
const modelOptions = $derived(
	[
		...new Set(
			scopedRecords
				.filter(
					(record) =>
						providerFilter === "all" || record.providerId === providerFilter,
				)
				.map((record) => record.modelId)
				.filter((id): id is string => !!id),
		),
	].sort(),
);
const filteredRecords = $derived(
	scopedRecords.filter(
		(record) =>
			(providerFilter === "all" || record.providerId === providerFilter) &&
			(modelFilter === "all" || record.modelId === modelFilter) &&
			(activityFilter === "all" || activityFilter === "chat"),
	),
);
const recordsWithUsage = $derived(
	filteredRecords.filter(
		(record) =>
			record.totalTokens !== null ||
			record.inputTokens !== null ||
			record.outputTokens !== null ||
			record.costAmount !== null,
	),
);
const totalTokens = $derived(
	recordsWithUsage.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0),
);
const knownTotalCount = $derived(
	recordsWithUsage.filter((record) => record.totalTokens !== null).length,
);
const knownInput = $derived(
	recordsWithUsage.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0),
);
const knownOutput = $derived(
	recordsWithUsage.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0),
);
const missingInput = $derived(
	recordsWithUsage.filter((record) => record.inputTokens === null).length,
);
const missingOutput = $derived(
	recordsWithUsage.filter((record) => record.outputTokens === null).length,
);
const missingTotal = $derived(
	recordsWithUsage.filter((record) => record.totalTokens === null).length,
);
const costMetadataCount = $derived(
	recordsWithUsage.filter((record) => record.costAmount !== null).length,
);
const noUsageCount = $derived(filteredRecords.length - recordsWithUsage.length);
const failedCount = $derived(
	filteredRecords.filter((record) => record.result === "failed").length,
);
const contextModelGroups = $derived.by(() => {
	const groups = new Map<string, ModelUsage>();
	for (const record of filteredRecords) {
		const providerId = record.providerId ?? "Provider not reported";
		const modelId = record.modelId ?? "Model not reported";
		const key = `${providerId}\u0000${modelId}`;
		const group = groups.get(key) ?? {
			key,
			providerId,
			modelId,
			records: [],
		};
		group.records.push(record);
		groups.set(key, group);
	}
	return [...groups.values()].sort(
		(a, b) => b.records.length - a.records.length,
	);
});
const providerGroups = $derived.by(() => {
	const groups = new Map<string, UsageRecord[]>();
	for (const record of filteredRecords) {
		const key = record.providerId ?? "Provider not reported";
		groups.set(key, [...(groups.get(key) ?? []), record]);
	}
	return [...groups.entries()]
		.map(([providerId, items]) => ({
			providerId,
			records: items.length,
			withUsage: items.filter(
				(item) =>
					item.totalTokens !== null ||
					item.inputTokens !== null ||
					item.outputTokens !== null ||
					item.costAmount !== null,
			).length,
			tokens: items.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
			missingTotal: items.filter((item) => item.totalTokens === null).length,
			costRecords: items.filter((item) => item.costAmount !== null).length,
			lastUsed: Math.max(...items.map((item) => item.createdAt)),
		}))
		.sort((a, b) => b.records - a.records);
});
const sortedActivity = $derived(
	[...filteredRecords].sort((a, b) => b.createdAt - a.createdAt),
);
const activityCount = $derived(
	Math.max(1, Math.ceil(sortedActivity.length / activityPageSize)),
);
const pagedActivity = $derived(
	sortedActivity.slice(
		activityPage * activityPageSize,
		(activityPage + 1) * activityPageSize,
	),
);
const trendBuckets = $derived.by(() =>
	buildTrendBuckets(
		filteredRecords,
		period,
		periodBounds.start,
		periodBounds.end,
	),
);
const maxBucketTokens = $derived(
	Math.max(0, ...trendBuckets.map((bucket) => bucket.knownTotal)),
);

function buildTrendBuckets(
	items: UsageRecord[],
	selectedPeriod: Period,
	start: number | null,
	end: number | null,
): TimeBucket[] {
	const now = new Date();
	const earliest = items.length
		? Math.min(...items.map((item) => localDateStart(new Date(item.createdAt))))
		: localDateStart(now);
	const actualStart = start ?? earliest;
	const actualEnd = end ?? localNextDateStart(now);
	const monthly =
		selectedPeriod === "all" ||
		actualEnd - actualStart > 100 * 24 * 60 * 60 * 1000;
	const labels = new Map<string, string>();
	if (monthly) {
		const date = new Date(actualStart);
		const month = new Date(date.getFullYear(), date.getMonth(), 1);
		const endDate = new Date(actualEnd);
		while (month < endDate) {
			const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
			labels.set(
				key,
				new Intl.DateTimeFormat(undefined, {
					month: "short",
					year: "2-digit",
				}).format(month),
			);
			month.setMonth(month.getMonth() + 1);
		}
	} else {
		const date = new Date(actualStart);
		while (date.getTime() < actualEnd) {
			const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "2")}`;
			labels.set(
				key,
				new Intl.DateTimeFormat(undefined, {
					month: "short",
					day: "numeric",
				}).format(date),
			);
			date.setDate(date.getDate() + 1);
		}
	}
	const values = new Map<
		string,
		{ total: number; withTotal: number; withoutTotal: number }
	>();
	for (const item of items) {
		const date = new Date(item.createdAt);
		const key = monthly
			? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
			: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		const value = values.get(key) ?? {
			total: 0,
			withTotal: 0,
			withoutTotal: 0,
		};
		if (item.totalTokens === null) value.withoutTotal += 1;
		else {
			value.total += item.totalTokens;
			value.withTotal += 1;
		}
		values.set(key, value);
	}
	return [...labels.entries()].map(([key, label]) => {
		const value = values.get(key) ?? {
			total: 0,
			withTotal: 0,
			withoutTotal: 0,
		};
		return {
			key,
			label,
			knownTotal: value.total,
			withTotal: value.withTotal,
			withoutTotal: value.withoutTotal,
		};
	});
}

function formatNumber(value: number) {
	return new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 0,
	}).format(value);
}
function formatTimestamp(value: number) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(value);
}
function formatPartial(value: number, missing: number) {
	if (!value && !missing) return "Unavailable";
	return `${missing ? "≥ " : ""}${formatNumber(value)}${missing ? " recorded" : ""}`;
}
function chooseProvider(value: string) {
	providerFilter = value;
	if (
		modelFilter !== "all" &&
		!scopedRecords.some(
			(record) =>
				record.modelId === modelFilter &&
				(value === "all" || record.providerId === value),
		)
	)
		modelFilter = "all";
	activityPage = 0;
}
function changePeriod(value: Period) {
	period = value;
	activityPage = 0;
}
function showActivity(record: UsageRecord) {
	selectedActivity = record;
	activityOpen = true;
}
function openChat(sessionId: string) {
	window.location.assign(`/?session=${encodeURIComponent(sessionId)}`);
}

const periodLabel = $derived(
	period === "today"
		? "Today"
		: period === "7d"
			? "7 days"
			: period === "30d"
				? "30 days"
				: period === "custom"
					? "Custom range"
					: "All time",
);
</script>

<svelte:head><title>Token usage · Settings · Loom</title></svelte:head>

<div class="min-h-svh w-full bg-[#090909] text-neutral-100">
	<div class="flex min-h-svh w-full flex-col md:flex-row">
		<SettingsSidebar active="token-usage" bind:search={settingsSearch} />
		<main class="min-w-0 flex-1 px-4 py-6 sm:px-7 lg:px-10 lg:py-8">
			<div class="mx-auto flex w-full max-w-[1320px] flex-col gap-6">
				<header class="flex flex-wrap items-start justify-between gap-4">
					<div class="flex items-start gap-3">
						<div
							class="mt-1 flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"
						>
							<WalletCards size={19} />
						</div>
						<div>
							<p
								class="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500"
							>
								Agents · Monitoring
							</p>
							<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">
								Token usage
							</h1>
							<p class="mt-1 max-w-2xl text-sm text-neutral-400">
								Observed usage from available chat metadata across your
								workspaces.
							</p>
						</div>
					</div>
					<div class="flex items-center gap-2">
						<span class="hidden text-xs text-neutral-500 sm:inline"
							>Updated {lastUpdated ? formatTimestamp(lastUpdated) : "—"}</span
						><Button
							variant="outline"
							size="sm"
							disabled={refreshing}
							onclick={() => void loadUsage()}
							><RefreshCw
								class={`size-4 ${refreshing ? "animate-spin" : ""}`}
							/>Refresh</Button
						>
					</div>
				</header>

				{#if error}
					<div
						class="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-4"
						role="alert"
					>
						<CircleAlert class="size-4 shrink-0 text-red-400" />
						<p class="min-w-0 flex-1 text-sm text-red-200">{error}</p>
						<Button variant="outline" size="sm" onclick={() => void loadUsage()}
							>Retry</Button
						>
					</div>
				{/if}

				<section
					class="rounded-2xl border border-white/10 bg-white/[0.025] p-3 sm:p-4"
					aria-label="Usage filters"
				>
					<div class="flex flex-wrap items-center gap-2">
						<div
							class="flex min-w-[180px] flex-1 flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500 sm:flex-none"
						>
							<span>Workspace</span><Select.Root
								type="single"
								value={projectFilter}
								onValueChange={(value) => {
									projectFilter = value;
									activityPage = 0;
								}}
								><Select.Trigger
									class="h-9 w-full normal-case tracking-normal text-neutral-200"
									><Select.Value /></Select.Trigger
								><Select.Content
									><Select.Item value="all">All workspaces</Select.Item
									>{#each projects as project}<Select.Item value={project.id}
											>{project.name}</Select.Item
										>{/each}</Select.Content
								></Select.Root
							>
						</div>
						<div
							class="flex min-w-[150px] flex-1 flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500 sm:flex-none"
						>
							<span>Reported provider</span><Select.Root
								type="single"
								value={providerFilter}
								onValueChange={chooseProvider}
								><Select.Trigger
									class="h-9 w-full normal-case tracking-normal text-neutral-200"
									><Select.Value /></Select.Trigger
								><Select.Content
									><Select.Item value="all">All providers</Select.Item
									>{#each providerOptions as provider}<Select.Item
											value={provider}>{provider}</Select.Item
										>{/each}</Select.Content
								></Select.Root
							>
						</div>
						<div
							class="flex min-w-[170px] flex-1 flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500 sm:flex-none"
						>
							<span>Model</span><Select.Root
								type="single"
								value={modelFilter}
								onValueChange={(value) => {
									modelFilter = value;
									activityPage = 0;
								}}
								><Select.Trigger
									class="h-9 w-full normal-case tracking-normal text-neutral-200"
									><Select.Value /></Select.Trigger
								><Select.Content
									><Select.Item value="all">All models</Select.Item
									>{#each modelOptions as modelId}<Select.Item value={modelId}
											>{modelId}</Select.Item
										>{/each}</Select.Content
								></Select.Root
							>
						</div>
						<div
							class="flex min-w-[150px] flex-1 flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500 sm:flex-none"
						>
							<span>Activity</span><Select.Root
								type="single"
								value={activityFilter}
								onValueChange={(value) => {
									activityFilter = value;
									activityPage = 0;
								}}
								><Select.Trigger
									class="h-9 w-full normal-case tracking-normal text-neutral-200"
									><Select.Value /></Select.Trigger
								><Select.Content
									><Select.Item value="all">All observed activity</Select.Item
									><Select.Item value="chat">Chat</Select.Item><Select.Item
										value="kanban"
										disabled>Kanban · telemetry unavailable</Select.Item
									><Select.Item value="reviews" disabled
										>Reviews · telemetry unavailable</Select.Item
									><Select.Item value="canvas" disabled
										>Canvas · telemetry unavailable</Select.Item
									><Select.Item value="walkthrough" disabled
										>Walkthrough · telemetry unavailable</Select.Item
									></Select.Content
								></Select.Root
							>
						</div>
						<div
							class="flex min-w-full flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500 sm:min-w-0 sm:flex-1"
						>
							<span>Date range · {timezone}</span>
							<div
								class="flex flex-wrap items-center gap-1 rounded-lg border border-white/10 bg-white/[0.025] p-1"
								role="group"
								aria-label="Usage date range"
							>
								{#each [{ id: "today", label: "Today" }, { id: "7d", label: "7 days" }, { id: "30d", label: "30 days" }, { id: "all", label: "All time" }, { id: "custom", label: "Custom" }] as item}
									<button
										type="button"
										class={`h-7 rounded-md px-2 text-xs normal-case tracking-normal transition ${period === item.id ? "bg-white/[0.12] text-white" : "text-neutral-400 hover:bg-white/[0.06] hover:text-white"}`}
										aria-pressed={period === item.id}
										onclick={() => changePeriod(item.id as Period)}
										>{item.label}</button
									>
								{/each}
							</div>
						</div>
						{#if period === "custom"}<label
								class="flex min-w-[130px] flex-1 flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500"
								><span>From</span><Input
									type="date"
									bind:value={customFrom}
									onchange={() => (activityPage = 0)}
									class="h-9 border-white/10 bg-white/[0.04] text-sm"
								/></label
							><label
								class="flex min-w-[130px] flex-1 flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500"
								><span>Through</span><Input
									type="date"
									bind:value={customTo}
									onchange={() => (activityPage = 0)}
									class="h-9 border-white/10 bg-white/[0.04] text-sm"
								/></label
							>{/if}
					</div>
				</section>
				{#if period === "custom" && (periodBounds.start === null || periodBounds.end === null || periodBounds.start >= periodBounds.end)}
					<p class="-mt-4 text-xs text-amber-200" role="alert">
						Choose a valid start and end date. The end date is included in your
						local timezone.
					</p>
				{/if}

				<div
					class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10"
				>
					<Tabs.Root bind:value={activeView}>
						<Tabs.List class="h-10 bg-transparent p-0">
							<Tabs.Trigger
								value="overview"
								class="rounded-t-lg border-b-2 border-transparent px-4 data-[state=active]:border-primary"
								>Overview</Tabs.Trigger
							>
							<Tabs.Trigger
								value="providers"
								class="rounded-t-lg border-b-2 border-transparent px-4 data-[state=active]:border-primary"
								>Providers</Tabs.Trigger
							>
						</Tabs.List>
					</Tabs.Root>
					<Badge
						variant="outline"
						class="gap-1.5 border-white/10 text-neutral-400"
						><MessageSquareText size={12} />Chat records only</Badge
					>
				</div>

				{#if partialFailures || cappedProjects.length}
					<div
						class="flex flex-col gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3 text-xs text-amber-100/80 sm:flex-row sm:items-start"
					>
						<CircleAlert class="mt-0.5 size-4 shrink-0 text-amber-300" />
						<div>
							<p class="font-medium">Partial chat history</p>
							<p class="mt-1 leading-5">
								{partialFailures
									? `${partialFailures} project/session request(s) could not be read. `
									: ""}{#if cappedProjects.length}Session listing is capped at
									200 per workspace: {cappedProjects.join(", ")}. Older history
									may be missing.{/if}
							</p>
						</div>
					</div>
				{/if}
				<div
					class="flex items-start gap-2 rounded-xl border border-sky-500/15 bg-sky-500/[0.035] p-3 text-xs leading-5 text-neutral-400"
				>
					<Sparkles class="mt-0.5 size-4 shrink-0 text-sky-300" />
					<p>
						This view reads existing chat responses only. It does not start AI
						runs. Loom does not yet have token telemetry for Kanban, reviews,
						integration fixes, Canvas, walkthroughs, or terminal work. Provider
						fields are reported model-provider IDs; the runtime provider and
						connection identity are not available in all saved messages.
					</p>
				</div>

				{#if loading}
					<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
						<div
							class="h-28 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]"
						></div>
						<div
							class="h-28 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]"
						></div>
						<div
							class="h-28 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]"
						></div>
						<div
							class="h-28 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]"
						></div>
					</div>
				{:else if error && !lastUpdated}
					<div
						class="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 px-6 text-center"
					>
						<CircleAlert size={22} class="text-red-300" />
						<h2 class="mt-3 text-sm font-medium">
							Usage history could not be loaded
						</h2>
						<p class="mt-1 max-w-md text-xs leading-5 text-neutral-500">
							No totals are shown because the source data could not be read.
							Retry after the server connection is available.
						</p>
						<Button
							variant="outline"
							size="sm"
							class="mt-4"
							disabled={refreshing}
							onclick={() => void loadUsage()}>Retry</Button
						>
					</div>
				{:else if activeView === "overview"}
					<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
						<article
							class="rounded-xl border border-white/10 bg-white/[0.03] p-4"
						>
							<div
								class="flex items-center justify-between text-xs text-neutral-400"
							>
								<span>Provider-reported total tokens</span><BarChart3
									size={15}
									class="text-primary"
								/>
							</div>
							<p
								class="mt-4 text-2xl font-semibold tabular-nums"
								title="Sum of message total-token fields; no input/output estimate is added"
							>
								{formatPartial(totalTokens, missingTotal)}
							</p>
							<p class="mt-1 text-[11px] text-neutral-500">
								{formatNumber(knownTotalCount)} of {formatNumber(
									recordsWithUsage.length,
								)} usage records include a total
							</p>
						</article>
						<article
							class="rounded-xl border border-white/10 bg-white/[0.03] p-4"
						>
							<div
								class="flex items-center justify-between text-xs text-neutral-400"
							>
								<span>Input and output counters</span><Activity
									size={15}
									class="text-sky-300"
								/>
							</div>
							<div class="mt-3 grid grid-cols-2 gap-3">
								<div>
									<span
										class="text-[10px] uppercase tracking-wide text-neutral-500"
										>Input</span
									>
									<p
										class="mt-1 text-lg font-semibold tabular-nums"
										title="Raw input counter reported on assistant messages"
									>
										{formatPartial(knownInput, missingInput)}
									</p>
								</div>
								<div>
									<span
										class="text-[10px] uppercase tracking-wide text-neutral-500"
										>Output</span
									>
									<p
										class="mt-1 text-lg font-semibold tabular-nums"
										title="Raw output counter reported on assistant messages"
									>
										{formatPartial(knownOutput, missingOutput)}
									</p>
								</div>
							</div>
							<p class="mt-1 text-[11px] text-neutral-500">
								Raw counters; cache/reasoning semantics may vary
							</p>
						</article>
						<article
							class="rounded-xl border border-white/10 bg-white/[0.03] p-4"
						>
							<div
								class="flex items-center justify-between text-xs text-neutral-400"
							>
								<span>Cost metadata</span><Coins
									size={15}
									class="text-amber-300"
								/>
							</div>
							<p class="mt-4 text-2xl font-semibold tabular-nums">
								{costMetadataCount
									? `${formatNumber(costMetadataCount)} records`
									: "Unavailable"}
							</p>
							<p class="mt-1 text-[11px] text-neutral-500">
								Currency and billing basis are not supplied; amounts are not
								totaled
							</p>
						</article>
						<article
							class="rounded-xl border border-white/10 bg-white/[0.03] p-4"
						>
							<div
								class="flex items-center justify-between text-xs text-neutral-400"
							>
								<span>Chat responses</span><MessageSquareText
									size={15}
									class="text-emerald-300"
								/>
							</div>
							<p class="mt-4 text-2xl font-semibold tabular-nums">
								{formatNumber(filteredRecords.length)}
							</p>
							<p class="mt-1 text-[11px] text-neutral-500">
								{formatNumber(noUsageCount)} with no usage metadata · {formatNumber(
									failedCount,
								)} marked failed
							</p>
						</article>
					</div>

					<div
						class="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]"
					>
						<section
							class="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:p-5"
						>
							<div class="flex flex-wrap items-start justify-between gap-3">
								<div>
									<h2 class="font-medium">Usage over time</h2>
									<p class="mt-1 text-xs text-neutral-500">
										{periodLabel} · local calendar buckets
									</p>
								</div>
								<div
									class="flex rounded-lg border border-white/10 p-1"
									role="group"
									aria-label="Trend metric"
								>
									<button
										type="button"
										class={`rounded-md px-2.5 py-1 text-xs ${chartMetric === "tokens" ? "bg-white/10 text-white" : "text-neutral-500"}`}
										aria-pressed={chartMetric === "tokens"}
										onclick={() => (chartMetric = "tokens")}>Tokens</button
									><button
										type="button"
										class={`rounded-md px-2.5 py-1 text-xs ${chartMetric === "cost" ? "bg-white/10 text-white" : "text-neutral-500"}`}
										aria-pressed={chartMetric === "cost"}
										onclick={() => (chartMetric = "cost")}>Cost</button
									>
								</div>
							</div>
							{#if chartMetric === "cost"}<div
									class="mt-5 flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed border-white/10 px-5 text-center"
								>
									<Coins size={20} class="text-amber-300" />
									<p class="mt-3 text-sm font-medium">Cost trend unavailable</p>
									<p class="mt-1 max-w-md text-xs leading-5 text-neutral-500">
										Saved cost values do not include currency or billing basis.
										Loom will not add or chart them as account spend.
									</p>
								</div>
							{:else if knownTotalCount === 0}<div
									class="mt-5 flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed border-white/10 px-5 text-center"
								>
									<BarChart3 size={20} class="text-neutral-500" />
									<p class="mt-3 text-sm font-medium">
										{filteredRecords.length
											? "Total tokens were not reported"
											: "No chat activity in this range"}
									</p>
									<p class="mt-1 text-xs text-neutral-500">
										{filteredRecords.length
											? "Responses exist, but none include a provider total-token field."
											: "No provider response records were found for the selected chat scope."}
									</p>
								</div>
							{:else}<div class="mt-5 overflow-x-auto pb-1">
									<div
										class="flex h-44 min-w-max items-end gap-1.5 border-b border-white/10 px-1"
										role="img"
										aria-label="Provider-reported total tokens by local calendar bucket; bucket details are listed below"
									>
										{#each trendBuckets as bucket (bucket.key)}{@const height =
												maxBucketTokens
													? Math.max(
															bucket.knownTotal ? 6 : 0,
															(bucket.knownTotal / maxBucketTokens) * 132,
														)
													: 0}
											<div
												class="group flex h-full w-6 flex-col justify-end sm:w-8"
												title={`${bucket.label}: ${bucket.withTotal ? formatNumber(bucket.knownTotal) + " reported tokens" : "total unavailable"}${bucket.withoutTotal ? ` · ${bucket.withoutTotal} record(s) missing total` : ""}`}
											>
												<div
													class={`w-full rounded-t-sm ${bucket.withoutTotal ? "bg-amber-400/60" : "bg-primary/75"}`}
													style={`height:${height}px`}
												></div>
												<span
													class="mt-2 origin-left -rotate-45 whitespace-nowrap text-[9px] text-neutral-500"
													>{bucket.label}</span
												>
											</div>{/each}
									</div>
								</div>
								<div class="mt-5 max-h-32 overflow-auto">
									<table class="w-full text-left text-[11px]">
										<caption class="sr-only"
											>Accessible usage trend values</caption
										><thead class="text-neutral-500"
											><tr
												><th class="py-1 font-normal"
													>Period ({trendBuckets.length > 12
														? "month"
														: "day"})</th
												><th class="py-1 text-right font-normal"
													>Reported total tokens</th
												><th class="py-1 text-right font-normal"
													>Missing totals</th
												></tr
											></thead
										><tbody
											>{#each trendBuckets as bucket (bucket.key)}<tr
													class="border-t border-white/5"
													><td class="py-1.5">{bucket.label}</td><td
														class="py-1.5 text-right tabular-nums"
														>{bucket.withTotal
															? (bucket.withoutTotal ? "≥ " : "") +
																formatNumber(bucket.knownTotal)
															: "Unavailable"}</td
													><td class="py-1.5 text-right tabular-nums"
														>{formatNumber(bucket.withoutTotal)}</td
													></tr
												>{/each}</tbody
										>
									</table>
								</div>{/if}
						</section>
						<section
							class="rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:p-5"
						>
							<div class="flex items-start justify-between gap-3">
								<div>
									<h2 class="font-medium">Coverage</h2>
									<p class="mt-1 text-xs text-neutral-500">
										Observed chat-response metadata
									</p>
								</div>
								<Badge
									variant="outline"
									class="border-white/10 text-neutral-400"
									>{filteredRecords.length
										? `${Math.round((recordsWithUsage.length / filteredRecords.length) * 100)}%`
										: "—"}</Badge
								>
							</div>
							<div class="mt-5 flex flex-col gap-4">
								<div>
									<div class="mb-1 flex justify-between text-xs">
										<span class="text-neutral-400">Responses with usage</span
										><span class="tabular-nums"
											>{formatNumber(recordsWithUsage.length)} / {formatNumber(
												filteredRecords.length,
											)}</span
										>
									</div>
									<div class="h-1.5 overflow-hidden rounded-full bg-white/10">
										<div
											class="h-full rounded-full bg-primary"
											style={`width:${filteredRecords.length ? (recordsWithUsage.length / filteredRecords.length) * 100 : 0}%`}
										></div>
									</div>
								</div>
								<div class="grid grid-cols-2 gap-2">
									<div
										class="rounded-lg border border-white/5 bg-white/[0.02] p-3"
									>
										<p
											class="text-[10px] uppercase tracking-wide text-neutral-500"
										>
											Token total unknown
										</p>
										<p class="mt-1 text-lg font-medium tabular-nums">
											{formatNumber(missingTotal)}
										</p>
									</div>
									<div
										class="rounded-lg border border-white/5 bg-white/[0.02] p-3"
									>
										<p
											class="text-[10px] uppercase tracking-wide text-neutral-500"
										>
											Cost amount known
										</p>
										<p class="mt-1 text-lg font-medium tabular-nums">
											{formatNumber(costMetadataCount)}
										</p>
									</div>
								</div>
								<p class="text-[11px] leading-5 text-neutral-500">
									A missing field means usage is unknown, not zero. This chat
									history does not expose a stable run ID or provider connection
									identity, so response counts are not labeled as runs.
								</p>
							</div>
						</section>
					</div>

					<section
						class="overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]"
					>
						<div
							class="flex flex-wrap items-end justify-between gap-3 border-b border-white/10 p-4 sm:p-5"
						>
							<div>
								<h2 class="font-medium">Model breakdown</h2>
								<p class="mt-1 text-xs text-neutral-500">
									Grouped by reported provider ID and exact model ID · select a
									model to filter activity
								</p>
							</div>
							<p class="text-xs text-neutral-500">
								{formatNumber(contextModelGroups.length)} model groups
							</p>
						</div>
						{#if !contextModelGroups.length}<div class="p-8 text-center">
								<p class="text-sm font-medium">
									No chat records for this scope
								</p>
								<p class="mt-1 text-xs text-neutral-500">
									Try a different date range or workspace.
								</p>
							</div>{:else}<div class="overflow-x-auto">
								<table class="w-full min-w-[920px] text-left text-xs">
									<thead
										class="border-b border-white/5 bg-white/[0.02] text-[10px] uppercase tracking-wide text-neutral-500"
										><tr
											><th class="px-4 py-3 font-medium">Model / alias</th><th
												class="px-4 py-3 font-medium">Reported provider</th
											><th class="px-4 py-3 text-right font-medium"
												>Responses</th
											><th class="px-4 py-3 text-right font-medium"
												>Total tokens</th
											><th class="px-4 py-3 text-right font-medium"
												>Input / output</th
											><th class="px-4 py-3 text-right font-medium"
												>Cache read / write</th
											><th class="px-4 py-3 text-right font-medium"
												>Cost metadata</th
											></tr
										></thead
									><tbody
										>{#each contextModelGroups as group (group.key)}{@const groupTotal =
												group.records.reduce(
													(sum, record) => sum + (record.totalTokens ?? 0),
													0,
												)}{@const groupUnknownTotal = group.records.filter(
												(record) => record.totalTokens === null,
											).length}{@const groupInput = group.records.reduce(
												(sum, record) => sum + (record.inputTokens ?? 0),
												0,
											)}{@const groupOutput = group.records.reduce(
												(sum, record) => sum + (record.outputTokens ?? 0),
												0,
											)}{@const groupMissingSplit = group.records.filter(
												(record) =>
													record.inputTokens === null ||
													record.outputTokens === null,
											).length}{@const cacheRead = group.records.reduce(
												(sum, record) => sum + (record.cacheReadTokens ?? 0),
												0,
											)}{@const cacheWrite = group.records.reduce(
												(sum, record) => sum + (record.cacheWriteTokens ?? 0),
												0,
											)}{@const cacheMissing = group.records.filter(
												(record) =>
													record.cacheReadTokens === null ||
													record.cacheWriteTokens === null,
											).length}<tr
												class="border-b border-white/5 transition hover:bg-white/[0.025]"
												><td class="max-w-[300px] px-4 py-3"
													><button
														type="button"
														class="max-w-full text-left font-mono text-neutral-100 underline-offset-4 hover:underline"
														title={group.modelId}
														onclick={() => {
															providerFilter =
																group.providerId === "Provider not reported"
																	? "all"
																	: group.providerId;
															modelFilter =
																group.modelId === "Model not reported"
																	? "all"
																	: group.modelId;
															activityPage = 0;
														}}
														><span class="break-all">{group.modelId}</span
														></button
													></td
												><td class="px-4 py-3 font-mono text-neutral-400"
													>{group.providerId}</td
												><td class="px-4 py-3 text-right tabular-nums"
													>{formatNumber(group.records.length)}</td
												><td class="px-4 py-3 text-right tabular-nums"
													>{formatPartial(groupTotal, groupUnknownTotal)}</td
												><td class="px-4 py-3 text-right tabular-nums"
													>{formatPartial(groupInput, groupMissingSplit)} / {formatPartial(
														groupOutput,
														groupMissingSplit,
													)}</td
												><td class="px-4 py-3 text-right tabular-nums"
													>{formatPartial(cacheRead, cacheMissing)} / {formatPartial(
														cacheWrite,
														cacheMissing,
													)}</td
												><td class="px-4 py-3 text-right"
													>{group.records.filter(
														(record) => record.costAmount !== null,
													).length} values · unclassified</td
												></tr
											>{/each}</tbody
									>
								</table>
							</div>{/if}
					</section>

					<section
						class="overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]"
					>
						<div
							class="flex flex-wrap items-end justify-between gap-3 border-b border-white/10 p-4 sm:p-5"
						>
							<div>
								<h2 class="font-medium">Recent chat activity</h2>
								<p class="mt-1 text-xs text-neutral-500">
									Individual assistant responses with safe metadata only
								</p>
							</div>
							<div class="flex items-center gap-2">
								<span class="text-xs text-neutral-500"
									>Page {activityPage + 1} of {activityCount}</span
								><Button
									variant="outline"
									size="sm"
									class="h-7 px-2"
									disabled={activityPage === 0}
									onclick={() => (activityPage -= 1)}>Previous</Button
								><Button
									variant="outline"
									size="sm"
									class="h-7 px-2"
									disabled={activityPage + 1 >= activityCount}
									onclick={() => (activityPage += 1)}>Next</Button
								>
							</div>
						</div>
						{#if !sortedActivity.length}<div class="p-8 text-center">
								<CalendarDays size={20} class="mx-auto text-neutral-500" />
								<p class="mt-3 text-sm font-medium">
									No chat activity in this range
								</p>
								<p class="mt-1 text-xs text-neutral-500">
									This is distinct from usage that exists but was not reported.
								</p>
							</div>{:else}<div class="overflow-x-auto">
								<table class="w-full min-w-[900px] text-left text-xs">
									<thead
										class="border-b border-white/5 bg-white/[0.02] text-[10px] uppercase tracking-wide text-neutral-500"
										><tr
											><th class="px-4 py-3 font-medium">Timestamp</th><th
												class="px-4 py-3 font-medium">Session / workspace</th
											><th class="px-4 py-3 font-medium">Provider · model</th
											><th class="px-4 py-3 text-right font-medium">Tokens</th
											><th class="px-4 py-3 text-right font-medium"
												>Cost field</th
											><th class="px-4 py-3 font-medium">Result</th></tr
										></thead
									><tbody
										>{#each pagedActivity as record (record.id)}<tr
												class="cursor-pointer border-b border-white/5 transition hover:bg-white/[0.035] focus-within:bg-white/[0.035]"
												tabindex="0"
												role="button"
												aria-label={`View chat response details for ${record.sessionTitle}`}
												onclick={() => showActivity(record)}
												onkeydown={(event) => {
													if (event.key === "Enter" || event.key === " ") {
														event.preventDefault();
														showActivity(record);
													}
												}}
												><td
													class="whitespace-nowrap px-4 py-3 text-neutral-400"
													>{formatTimestamp(record.createdAt)}</td
												><td class="max-w-[220px] px-4 py-3"
													><p
														class="truncate font-medium text-neutral-200"
														title={record.sessionTitle}
													>
														{record.sessionTitle}
													</p>
													<p class="mt-1 truncate text-[10px] text-neutral-500">
														{record.projectName}
													</p></td
												><td class="max-w-[280px] px-4 py-3"
													><p
														class="truncate font-mono text-neutral-300"
														title={record.providerId ?? "Provider not reported"}
													>
														{record.providerId ?? "Provider not reported"}
													</p>
													<p
														class="mt-1 break-all font-mono text-[10px] text-neutral-500"
														title={record.modelId ?? "Model not reported"}
													>
														{record.modelId ?? "Model not reported"}
													</p></td
												><td class="px-4 py-3 text-right tabular-nums"
													>{record.totalTokens === null
														? "Unavailable"
														: formatNumber(record.totalTokens)}</td
												><td class="px-4 py-3 text-right tabular-nums"
													>{record.costAmount === null
														? "Unavailable"
														: `${record.costAmount} · currency unknown`}</td
												><td class="px-4 py-3"
													><Badge
														variant="outline"
														class={record.result === "failed"
															? "border-red-500/25 text-red-300"
															: "border-white/10 text-neutral-400"}
														>{record.result}</Badge
													></td
												></tr
											>{/each}</tbody
									>
								</table>
							</div>{/if}
					</section>
				{:else}
					<section
						class="overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]"
					>
						<div
							class="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 p-4 sm:p-5"
						>
							<div>
								<h2 class="font-medium">Reported model providers</h2>
								<p class="mt-1 text-xs text-neutral-500">
									Historical provider IDs found in chat metadata; this is not a
									live connection or complete provider account view.
								</p>
							</div>
							<Button
								href={settingsHref(
									"/settings/providers",
									page.url.searchParams.get("returnTo"),
								)}
								variant="outline"
								size="sm">Provider settings</Button
							>
						</div>
						{#if !providerGroups.length}<div class="p-8 text-center">
								<Server size={20} class="mx-auto text-neutral-500" />
								<p class="mt-3 text-sm font-medium">
									No provider metadata in this scope
								</p>
								<p class="mt-1 text-xs text-neutral-500">
									Chat responses can exist without reporting a provider ID.
								</p>
							</div>{:else}<div class="overflow-x-auto">
								<table class="w-full min-w-[760px] text-left text-xs">
									<thead
										class="border-b border-white/5 bg-white/[0.02] text-[10px] uppercase tracking-wide text-neutral-500"
										><tr
											><th class="px-4 py-3 font-medium"
												>Reported model provider</th
											><th class="px-4 py-3 text-right font-medium"
												>Responses</th
											><th class="px-4 py-3 text-right font-medium"
												>With usage data</th
											><th class="px-4 py-3 text-right font-medium"
												>Reported total tokens</th
											><th class="px-4 py-3 text-right font-medium"
												>Cost values</th
											><th class="px-4 py-3 text-right font-medium"
												>Last observed</th
											></tr
										></thead
									><tbody
										>{#each providerGroups as provider}<tr
												class="border-b border-white/5"
												><td class="px-4 py-3 font-mono text-sm"
													>{provider.providerId}</td
												><td class="px-4 py-3 text-right tabular-nums"
													>{formatNumber(provider.records)}</td
												><td class="px-4 py-3 text-right tabular-nums"
													>{formatNumber(provider.withUsage)}</td
												><td class="px-4 py-3 text-right tabular-nums"
													>{formatPartial(
														provider.tokens,
														provider.missingTotal,
													)}</td
												><td class="px-4 py-3 text-right"
													>{formatNumber(provider.costRecords)} · unclassified</td
												><td class="px-4 py-3 text-right text-neutral-400"
													>{formatTimestamp(provider.lastUsed)}</td
												></tr
											>{/each}</tbody
									>
								</table>
							</div>{/if}
					</section>
				{/if}

				<footer
					class="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-4 text-[11px] text-neutral-500"
				>
					<span class="flex items-center gap-1.5"
						><Clock3 size={13} />Calendar dates use {timezone}; stored message
						times are interpreted as UTC instants.</span
					><span
						>{formatNumber(filteredRecords.length)} chat responses in selected scope</span
					>
				</footer>
			</div>
		</main>
	</div>
</div>

<Dialog.Root bind:open={activityOpen}>
	<Dialog.Content
		class="max-h-[85svh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-xl"
	>
		<Dialog.Header
			><Dialog.Title>Chat response details</Dialog.Title><Dialog.Description
				>Observed provider metadata only. This record does not expose the full
				prompt or transcript.</Dialog.Description
			></Dialog.Header
		>
		{#if selectedActivity}
			<div class="grid gap-2 sm:grid-cols-2">
				<div class="rounded-lg border border-white/10 bg-white/[0.025] p-3">
					<p class="text-[10px] uppercase tracking-wide text-neutral-500">
						Session
					</p>
					<p class="mt-1 text-sm font-medium">
						{selectedActivity.sessionTitle}
					</p>
					<p class="mt-1 text-xs text-neutral-500">
						{selectedActivity.projectName}
					</p>
				</div>
				<div class="rounded-lg border border-white/10 bg-white/[0.025] p-3">
					<p class="text-[10px] uppercase tracking-wide text-neutral-500">
						Timestamp
					</p>
					<p class="mt-1 text-sm">
						{formatTimestamp(selectedActivity.createdAt)}
					</p>
					<p class="mt-1 break-all font-mono text-[10px] text-neutral-500">
						{selectedActivity.messageId}
					</p>
				</div>
				<div class="rounded-lg border border-white/10 bg-white/[0.025] p-3">
					<p class="text-[10px] uppercase tracking-wide text-neutral-500">
						Reported provider / model
					</p>
					<p class="mt-1 break-all font-mono text-xs">
						{selectedActivity.providerId ?? "Unavailable"}
					</p>
					<p class="mt-1 break-all font-mono text-xs text-neutral-400">
						{selectedActivity.modelId ?? "Unavailable"}
					</p>
				</div>
				<div class="rounded-lg border border-white/10 bg-white/[0.025] p-3">
					<p class="text-[10px] uppercase tracking-wide text-neutral-500">
						Result
					</p>
					<p class="mt-1 text-sm capitalize">{selectedActivity.result}</p>
				</div>
			</div>
			<section class="mt-4 rounded-lg border border-white/10 p-3">
				<h3 class="text-xs font-medium">Token counters</h3>
				<dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
					<dt class="text-neutral-500">Provider total</dt>
					<dd class="text-right tabular-nums">
						{selectedActivity.totalTokens === null
							? "Unavailable"
							: formatNumber(selectedActivity.totalTokens)}
					</dd>
					<dt class="text-neutral-500">Input</dt>
					<dd class="text-right tabular-nums">
						{selectedActivity.inputTokens === null
							? "Unavailable"
							: formatNumber(selectedActivity.inputTokens)}
					</dd>
					<dt class="text-neutral-500">Output</dt>
					<dd class="text-right tabular-nums">
						{selectedActivity.outputTokens === null
							? "Unavailable"
							: formatNumber(selectedActivity.outputTokens)}
					</dd>
					<dt class="text-neutral-500">Reasoning</dt>
					<dd class="text-right tabular-nums">
						{selectedActivity.reasoningTokens === null
							? "Unavailable"
							: formatNumber(selectedActivity.reasoningTokens)}
					</dd>
					<dt class="text-neutral-500">Cache read / write</dt>
					<dd class="text-right tabular-nums">
						{selectedActivity.cacheReadTokens === null
							? "Unavailable"
							: formatNumber(selectedActivity.cacheReadTokens)} / {selectedActivity.cacheWriteTokens ===
						null
							? "Unavailable"
							: formatNumber(selectedActivity.cacheWriteTokens)}
					</dd>
				</dl>
			</section>
			<section class="mt-3 rounded-lg border border-white/10 p-3">
				<h3 class="text-xs font-medium">Cost field</h3>
				<p class="mt-2 text-sm tabular-nums">
					{selectedActivity.costAmount === null
						? "Unavailable"
						: `${selectedActivity.costAmount} · currency and billing basis not supplied`}
				</p>
			</section>
			<div class="mt-4 flex flex-wrap justify-end gap-2">
				<Button
					variant="outline"
					onclick={() => openChat(selectedActivity!.sessionId)}
					>Open chat</Button
				><Button onclick={() => (activityOpen = false)}>Close</Button>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
