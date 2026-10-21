<script lang="ts">
	import {
		AlertCircle,
		Check,
		CheckCircle2,
		ChevronDown,
		ChevronLeft,
		Copy,
		Download,
		ExternalLink,
		Eye,
		EyeOff,
		Pencil,
		Plus,
		RefreshCw,
		Search,
		Terminal,
		Trash2,
		X,
	} from "@lucide/svelte";
	import { onMount, tick } from "svelte";
	import { page } from "$app/state";
	import { toast } from "svelte-sonner";
	import SettingsSidebar from "$lib/components/settings/SettingsSidebar.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import * as AlertDialog from "$lib/components/ui/alert-dialog";
	import { daemon } from "$lib/daemon";
	import { settingsHref } from "$lib/settings-navigation";

	type Provider = Awaited<ReturnType<typeof daemon.listProviders>>[number];
	let providers = $state<Provider[]>([]);
	type CustomProvider = Awaited<
		ReturnType<typeof daemon.listCustomProviders>
	>[number];
	let customProviders = $state<CustomProvider[]>([]);
	type ProviderModel = { id: string; name: string; contextWindow?: number };
	let providerModelCatalog = $state<
		Awaited<ReturnType<typeof daemon.listAvailableProviderModels>>
	>([]);
	let loading = $state(true);
	let checking = $state(false);
	let customSaving = $state(false);
	let customTesting = $state(false);
	const customBusy = $derived(customSaving || customTesting);
	let customDialogOpen = $state(false);
	let customEditingId = $state<string | null>(null);
	let customName = $state("");
	let customBaseUrl = $state("");
	let customApiKey = $state("");
	let showApiKey = $state(false);
	let testStatus = $state<"idle" | "testing" | "success" | "error">("idle");
	let testErrorMessage = $state("");
	let modelSearchQuery = $state("");
	let discoveredModels = $state<
		Array<{ id: string; name: string; contextWindow?: number }>
	>([]);
	let expandedModelsProviderId = $state("");
	let providerModelQuery = $state("");
	let providerModelChecks = $state<
		Record<
			string,
			{ status: "testing" | "success" | "error"; message?: string }
		>
	>({});
	let deleteFirstOpen = $state(false);
	let deleteSecondOpen = $state(false);
	let providerPendingDelete = $state<CustomProvider | null>(null);
	let deletingProvider = $state(false);
	let autoCheck = $state(false);
	let lastChecked = $state<string | null>(null);
	let search = $state("");
	let providerSearch = $state("");
	let updateChecks = $state<
		Awaited<ReturnType<typeof daemon.checkProviderUpdates>>["updates"]
	>([]);
	let updateDialogOpen = $state(false);
	let selectedUpdate = $state<(typeof updateChecks)[number] | null>(null);
	let updateState = $state<"idle" | "updating" | "success" | "error">("idle");
	let updateMessage = $state("");
	let updatingProviderId = $state<string | null>(null);
	const filtered = $derived(
		providers.filter(
			(provider) =>
				!provider.providerId.startsWith("loom_custom_") &&
				provider.name.toLowerCase().includes(providerSearch.toLowerCase()),
		),
	);
	const lastCheckedLabel = $derived(
		checking
			? "checking\u2026"
			: lastChecked
				? new Date(lastChecked).toLocaleTimeString()
				: "never",
	);

	onMount(() => void loadProviders());

	async function loadProviders() {
		loading = true;
		try {
			const [listed, custom, models] = await Promise.all([
				daemon.listProviders(),
				daemon.listCustomProviders(),
				daemon.listAvailableProviderModels(),
			]);
			providers = listed;
			customProviders = custom;
			providerModelCatalog = models;
		} catch (reason) {
			toast.error(
				reason instanceof Error ? reason.message : "Unable to load providers",
			);
		} finally {
			loading = false;
		}
	}

	const URL_PRESETS = [
		{ label: "Ollama", name: "Ollama", url: "http://localhost:11434/v1" },
		{ label: "LM Studio", name: "LM Studio", url: "http://localhost:1234/v1" },
		{
			label: "OpenRouter",
			name: "OpenRouter",
			url: "https://openrouter.ai/api/v1",
		},
		{ label: "LocalAI", name: "LocalAI", url: "http://localhost:8080/v1" },
		{ label: "vLLM", name: "Local vLLM", url: "http://localhost:8000/v1" },
	];

	function applyPreset(preset: (typeof URL_PRESETS)[number]) {
		customBaseUrl = preset.url;
		if (!customName.trim()) {
			customName = preset.name;
		}
		testStatus = "idle";
		testErrorMessage = "";
	}

	const filteredDiscoveredModels = $derived(
		discoveredModels.filter(
			(model) =>
				model.id.toLowerCase().includes(modelSearchQuery.toLowerCase()) ||
				model.name.toLowerCase().includes(modelSearchQuery.toLowerCase()),
		),
	);

	function formatContextWindow(ctx?: number) {
		if (!ctx) return null;
		if (ctx >= 1_000_000) return `${Math.round(ctx / 100_000) / 10}M ctx`;
		if (ctx >= 1_000) return `${Math.round(ctx / 1000)}k ctx`;
		return `${ctx} ctx`;
	}

	function toggleProviderModels(providerId: string) {
		expandedModelsProviderId =
			expandedModelsProviderId === providerId ? "" : providerId;
		providerModelQuery = "";
	}

	function providerModelCheckKey(providerId: string, modelId: string) {
		return `${providerId}:${modelId}`;
	}

	function modelsForProvider(
		providerId: string,
		fallback: ProviderModel[] = [],
	): ProviderModel[] {
		const models = providerModelCatalog
			.filter((model) => model.providerID === providerId)
			.map((model) => ({
				id: model.modelID,
				name: model.name || model.modelID,
				...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
			}));
		return models.length ? models : fallback;
	}

	function clearProviderModelChecks(providerId: string) {
		providerModelChecks = Object.fromEntries(
			Object.entries(providerModelChecks).filter(
				([key]) => !key.startsWith(`${providerId}:`),
			),
		);
	}

	async function testProviderModel(providerId: string, model: ProviderModel) {
		const key = providerModelCheckKey(providerId, model.id);
		providerModelChecks = {
			...providerModelChecks,
			[key]: { status: "testing" },
		};
		try {
			await daemon.testProviderModel(providerId, model.id);
			providerModelChecks = {
				...providerModelChecks,
				[key]: { status: "success", message: "Model responded successfully" },
			};
		} catch (reason) {
			providerModelChecks = {
				...providerModelChecks,
				[key]: {
					status: "error",
					message:
						reason instanceof Error
							? reason.message
							: "Model connection failed",
				},
			};
		}
	}

	function customProviderInput() {
		return {
			name: customName.trim(),
			baseUrl: customBaseUrl.trim(),
			apiKey: customApiKey,
			...(customEditingId ? { providerId: customEditingId } : {}),
		};
	}

	function resetCustomProviderForm() {
		customEditingId = null;
		customName = "";
		customBaseUrl = "";
		customApiKey = "";
		discoveredModels = [];
		showApiKey = false;
		testStatus = "idle";
		testErrorMessage = "";
		modelSearchQuery = "";
	}

	function openAddCustomProvider() {
		resetCustomProviderForm();
		customDialogOpen = true;
	}

	function openEditCustomProvider(provider: CustomProvider) {
		clearProviderModelChecks(provider.id);
		customEditingId = provider.id;
		customName = provider.name;
		customBaseUrl = provider.baseUrl;
		customApiKey = "";
		discoveredModels = provider.models;
		showApiKey = false;
		testStatus = "idle";
		testErrorMessage = "";
		modelSearchQuery = "";
		customDialogOpen = true;
	}

	function handleCustomDialogKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			if (customBusy) return;
			const canSave =
				customName.trim() &&
				customBaseUrl.trim() &&
				(customEditingId || discoveredModels.length > 0);
			if (canSave) {
				void importCustomProvider();
			} else if (customName.trim() && customBaseUrl.trim()) {
				void testCustomProvider();
			}
		}
	}

	async function testCustomProvider() {
		customTesting = true;
		testStatus = "testing";
		testErrorMessage = "";
		try {
			const result = await daemon.testCustomProvider(customProviderInput());
			discoveredModels = result.models;
			testStatus = "success";
			toast.success(
				`Connection successful · ${result.models.length} models found`,
			);
		} catch (reason) {
			testStatus = "error";
			testErrorMessage =
				reason instanceof Error
					? reason.message
					: "Unable to test custom provider";
			toast.error(testErrorMessage);
		} finally {
			customTesting = false;
		}
	}

	async function importCustomProvider() {
		customSaving = true;
		const wasEditing = customEditingId !== null;
		try {
			const input = customProviderInput();
			const result = customEditingId
				? await daemon.updateCustomProvider(customEditingId, {
						name: input.name,
						baseUrl: input.baseUrl,
						apiKey: input.apiKey,
					})
				: await daemon.createCustomProvider(input);
			clearProviderModelChecks(result.provider.id);
			await loadProviders();
			window.dispatchEvent(new CustomEvent("loom:providers-changed"));
			customDialogOpen = false;
			resetCustomProviderForm();
			toast.success(
				`${result.provider.name} ${wasEditing ? "updated" : "added"} · ${result.models.length} models imported`,
			);
		} catch (reason) {
			toast.error(
				reason instanceof Error
					? reason.message
					: "Unable to import custom provider",
			);
		} finally {
			customSaving = false;
		}
	}

	function requestDeleteProvider(provider: CustomProvider) {
		providerPendingDelete = provider;
		deleteFirstOpen = true;
	}

	async function continueDeleteProvider(event: MouseEvent) {
		event.preventDefault();
		deleteFirstOpen = false;
		await tick();
		deleteSecondOpen = true;
	}

	async function deleteProviderNow(event: MouseEvent) {
		event.preventDefault();
		if (!providerPendingDelete) return;
		deletingProvider = true;
		try {
			await daemon.deleteCustomProvider(providerPendingDelete.id);
			await loadProviders();
			window.dispatchEvent(new CustomEvent("loom:providers-changed"));
			toast.success(`${providerPendingDelete.name} deleted`);
			deleteSecondOpen = false;
			providerPendingDelete = null;
		} catch (reason) {
			toast.error(
				reason instanceof Error ? reason.message : "Unable to delete provider",
			);
		} finally {
			deletingProvider = false;
		}
	}

	async function checkProviders() {
		checking = true;
		try {
			providers = await daemon.refreshProviders();
			const result = await daemon.checkProviderUpdates();
			updateChecks = result.updates;
			lastChecked = result.checkedAt;
			const available = result.updates.filter(
				(item) => item.updateAvailable,
			).length;
			const failed = result.updates.filter((item) => item.error).length;
			if (failed)
				toast.error(
					`Checked ${result.updates.length - failed} providers; ${failed} update checks failed`,
				);
			else
				toast.success(
					available
						? `${available} provider update${available === 1 ? "" : "s"} available`
						: "Provider CLIs are up to date",
				);
		} catch (reason) {
			toast.error(
				reason instanceof Error
					? reason.message
					: "Unable to detect provider CLIs",
			);
		} finally {
			loading = false;
			checking = false;
		}
	}

	function openUpdateDialog(update: (typeof updateChecks)[number]) {
		selectedUpdate = update;
		updateState = "idle";
		updateMessage = "";
		updateDialogOpen = true;
	}

	async function runProviderUpdate() {
		if (!selectedUpdate || updatingProviderId) return;
		const update = selectedUpdate;
		if (!update.latestVersion) {
			updateState = "error";
			updateMessage =
				"The latest version is unavailable. Check for updates again before continuing.";
			return;
		}
		updatingProviderId = update.providerId;
		updateState = "updating";
		updateMessage = `Updating ${update.name} to ${update.latestVersion}. This may take a few minutes.`;
		try {
			const result = await daemon.updateProvider(update.providerId);
			providers = await daemon.refreshProviders();
			const refreshedChecks = await daemon.checkProviderUpdates();
			updateChecks = refreshedChecks.updates;
			lastChecked = refreshedChecks.checkedAt;
			if (
				!result.version ||
				result.version.replace(/^v/, "") !==
					update.latestVersion.replace(/^v/, "")
			) {
				updateState = "error";
				updateMessage = result.version
					? `Updater finished, but Loom detects ${result.version} instead of ${update.latestVersion}. Restart Loom or check the installation method.`
					: "Updater finished, but Loom could not verify the installed version. Restart Loom and check the provider again.";
				return;
			}
			updateState = "success";
			updateMessage = `${update.name} updated to ${result.version ?? result.latestVersion}.`;
		} catch (reason) {
			updateState = "error";
			updateMessage =
				reason instanceof Error
					? reason.message
					: `Unable to update ${update.name}`;
		} finally {
			updatingProviderId = null;
		}
	}

	async function connect(provider: Provider) {
		try {
			const result = await daemon.connectProvider(provider.id);
			await loadProviders();
			if (result.connected) {
				toast.success(
					result.configured === false
						? `${provider.name} connected; add a model provider to continue`
						: `${provider.name} is connected`,
				);
				return;
			}
			if (result.launched) {
				toast.success(`${provider.name} connection started`);
				return;
			}
			if (result.command) {
				const command = Array.isArray(result.command)
					? result.command.join(" ")
					: result.command;
				await copyCommand(command);
				toast.info(`Run ${command} in a terminal`);
				return;
			}
			toast.info(
				provider.installed
					? `${provider.name} is installed but not connected`
					: `Install ${provider.name}, then return here and re-check`,
			);
		} catch (reason) {
			toast.error(
				reason instanceof Error
					? reason.message
					: `Unable to connect ${provider.name}`,
			);
		}
	}

	async function disconnect(provider: Provider) {
		try {
			await daemon.disconnectProvider(provider.id);
			await loadProviders();
			toast.success(`${provider.name} disconnected`);
		} catch (reason) {
			toast.error(
				reason instanceof Error
					? reason.message
					: "Unable to disconnect provider",
			);
		}
	}

	async function copyCommand(command: string) {
		await navigator.clipboard.writeText(command);
		toast.success("Command copied");
	}
</script>

<svelte:head><title>Providers · Loom</title></svelte:head>
{#snippet modelList(
	providerId: string,
	providerName: string,
	models: ProviderModel[],
)}
	{@const visibleModels = models.filter((model) =>
		`${model.name} ${model.id}`
			.toLowerCase()
			.includes(providerModelQuery.toLowerCase()),
	)}
	<div
		id={`provider-models-${providerId}`}
		class="border-t border-white/[0.08] bg-black/10 px-4 pb-4 pt-3"
	>
		<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
			<div>
				<h3 class="text-xs font-semibold text-neutral-200">
					Models from {providerName}
				</h3>
				<p class="mt-1 text-xs text-neutral-500">
					Each test sends a short prompt directly to the selected model.
				</p>
			</div>
			{#if models.length > 6}
				<Input
					bind:value={providerModelQuery}
					class="h-8 w-full sm:max-w-64"
					placeholder="Filter models…"
					aria-label={`Filter ${providerName} models`}
				/>
			{/if}
		</div>
		{#if !visibleModels.length}
			<p
				class="rounded-lg border border-dashed border-white/10 p-5 text-center text-xs text-neutral-500"
			>
				{models.length
					? "No models match this filter."
					: "No models are currently available for this provider. Connect it and refresh the model list."}
			</p>
		{:else}
			<div
				class="max-h-[28rem] overflow-y-auto rounded-xl border border-white/10"
			>
				{#each visibleModels as model (model.id)}
					{@const check =
						providerModelChecks[providerModelCheckKey(providerId, model.id)]}
					<div
						class="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-3 py-2.5 last:border-0"
					>
						<div class="min-w-0 flex-1">
							<p
								class="truncate font-mono text-xs font-medium text-neutral-200"
								title={model.id}
							>
								{model.name || model.id}
							</p>
							{#if model.name && model.name !== model.id}<p
									class="mt-0.5 truncate font-mono text-[10px] text-neutral-500"
									title={model.id}
								>
									{model.id}
								</p>{/if}
						</div>
						{#if model.contextWindow}<Badge
								variant="outline"
								class="border-white/10 text-[10px] text-neutral-400"
								>{formatContextWindow(model.contextWindow)}</Badge
							>{/if}
						{#if check?.status === "success"}<span
								class="flex items-center gap-1 text-[11px] text-emerald-400"
								title={check.message}
								><CheckCircle2 class="size-3.5" />Passed</span
							>{:else if check?.status === "error"}<span
								class="max-w-48 truncate text-[11px] text-rose-400"
								title={check.message}>Failed</span
							>{/if}
						<Button
							variant="outline"
							size="sm"
							disabled={check?.status === "testing"}
							title={`Test ${model.name || model.id}`}
							onclick={() => void testProviderModel(providerId, model)}
						>
							{#if check?.status === "testing"}<RefreshCw
									class="size-3.5 animate-spin"
								/>Testing…{:else}<RefreshCw class="size-3.5" />Test model{/if}
						</Button>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}
<div class="min-h-svh bg-[#090909] text-neutral-100">
	<div class="flex min-h-svh w-full flex-col md:flex-row">
		<SettingsSidebar active="providers" bind:search />
		<main class="min-w-0 flex-1 px-4 py-6 sm:px-7 lg:px-10 lg:py-8">
			<div class="mx-auto w-full max-w-[1320px]">
				<div class="mb-8 flex flex-wrap items-start justify-between gap-4">
					<div>
						<p
							class="mb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500"
						>
							Agents
						</p>
						<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">
							Providers
						</h1>
						<p class="mt-2 text-sm text-neutral-500">
							Manage local coding CLIs or connect any OpenAI-compatible API.
						</p>
					</div>
					<Button
						href={settingsHref(
							"/settings",
							page.url.searchParams.get("returnTo"),
						)}
						variant="outline"
						size="sm"><ChevronLeft class="size-4" />Settings</Button
					>
				</div>
				<section class="mb-8">
					<p
						class="mb-3 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500"
					>
						Automatic CLI checks
					</p>
					<div
						class="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.035] p-5"
					>
						<div>
							<h2 class="text-sm font-semibold">
								Check for CLI updates automatically
							</h2>
							<p class="mt-1 text-sm text-neutral-500">
								Last checked: {lastCheckedLabel}
							</p>
						</div>
						<div class="flex items-center gap-3">
							<Button
								variant="outline"
								size="sm"
								disabled={checking}
								onclick={() => void checkProviders()}
								><RefreshCw
									class={`size-4 ${checking ? "animate-spin" : ""}`}
								/>Check now</Button
							><button
								type="button"
								role="switch"
								aria-checked={autoCheck}
								class={`relative h-6 w-11 rounded-full ${autoCheck ? "bg-emerald-500" : "bg-white/15"}`}
								onclick={() => (autoCheck = !autoCheck)}
								><span
									class={`absolute top-1 size-4 rounded-full bg-white transition ${autoCheck ? "left-6" : "left-1"}`}
								></span><span class="sr-only">Toggle automatic CLI checks</span
								></button
							>
						</div>
					</div>
				</section>
				<section class="mb-8">
					<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
						<p
							class="text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500"
						>
							Provider updates{#if updateChecks.some((item) => item.updateAvailable)}
								— {updateChecks.filter((item) => item.updateAvailable).length} available{/if}
						</p>
						<Input
							class="w-full sm:max-w-56"
							placeholder="Filter providers…"
							bind:value={providerSearch}
						/>
					</div>
					{#if !lastChecked}<div
							class="rounded-2xl border border-dashed border-white/10 p-5 text-sm text-neutral-500"
						>
							Select <span class="text-neutral-300">Check now</span> to compare installed
							CLI versions with their latest releases.
						</div>{:else}<div
							class="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035]"
						>
							{#each updateChecks.filter((item) => item.name
									.toLowerCase()
									.includes(providerSearch.toLowerCase())) as update}<div
									class="flex flex-wrap items-center gap-4 border-b border-white/[0.08] p-4 last:border-0"
								>
									<div class="min-w-0 flex-1">
										<p class="font-medium">{update.name}</p>
										{#if update.error}<p class="mt-1 text-xs text-amber-300">
												Could not check latest version: {update.error}
											</p>{:else if !update.installed}<p
												class="mt-1 text-xs text-neutral-500"
											>
												Not installed
											</p>{:else if update.updateAvailable}<p
												class="mt-1 font-mono text-xs text-neutral-400"
											>
												{update.currentVersion} → {update.latestVersion}
											</p>{:else}<p class="mt-1 text-xs text-neutral-500">
												{update.currentVersion ?? "Version unknown"} · Up to date
											</p>{/if}
									</div>
									{#if update.updateAvailable && update.updateSupported}<Button
											variant="outline"
											size="sm"
											disabled={updatingProviderId !== null}
											onclick={() => openUpdateDialog(update)}
											><Download class="size-4" />Update</Button
										>{:else if update.updateAvailable && update.updateCommand}<div
											class="flex max-w-full items-center gap-2"
										>
											<code
												class="max-w-[min(24rem,60vw)] truncate rounded border border-white/10 px-2 py-1 text-xs text-neutral-400"
												>{update.updateCommand}</code
											><Button
												variant="ghost"
												size="icon-sm"
												aria-label={`Copy ${update.name} update command`}
												onclick={() => void copyCommand(update.updateCommand!)}
												><Copy class="size-4" /></Button
											>
										</div>{:else if update.installed && !update.error}<span
											class="text-xs text-neutral-500">No update available</span
										>{/if}
								</div>{/each}
						</div>{/if}
				</section>
				<section class="mb-8">
					<p
						class="mb-3 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500"
					>
						Local CLI
					</p>
					<div
						class="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035]"
					>
						{#if loading && !providers.length}
							<div class="p-5 text-sm text-neutral-500">Loading providers…</div>
						{:else}
							{#each filtered as provider (provider.id)}
								{@const availableModels = modelsForProvider(
									provider.providerId,
								)}
								<div class="border-b border-white/[0.08] last:border-0">
									<div class="flex flex-wrap items-center gap-3 p-5">
										<div class="flex min-w-0 flex-1 items-center gap-3">
											<div
												class="flex size-9 items-center justify-center rounded-lg bg-white/[0.08] text-neutral-300"
											>
												<Terminal class="size-5" />
											</div>
											<div class="min-w-0">
												<p class="font-medium">
													{provider.name}
													<span class="ml-1 font-mono text-xs text-neutral-500"
														>{provider.version ?? provider.command}</span
													>
												</p>
												<p
													class={`mt-1 flex items-center gap-1 text-xs ${provider.installed ? "text-emerald-400" : "text-neutral-500"}`}
												>
													{#if provider.installed}<Check
															class="size-3"
														/>Available{:else}<X class="size-3" />Not installed{/if}
												</p>
											</div>
										</div>
										<Button
											variant="outline"
											size="sm"
											aria-expanded={expandedModelsProviderId === provider.id}
											aria-controls={`provider-models-${provider.id}`}
											onclick={() => toggleProviderModels(provider.id)}
										>
											<Search class="size-3.5" />{expandedModelsProviderId ===
											provider.id
												? "Hide models"
												: "View models"}<span class="text-neutral-400"
												>{availableModels.length}</span
											><ChevronDown
												class={`size-3.5 transition-transform ${expandedModelsProviderId === provider.id ? "rotate-180" : ""}`}
											/>
										</Button>
										{#if provider.status === "connected" || provider.authenticated}<Button
												variant="outline"
												size="sm"
												onclick={() => void disconnect(provider)}
												>Disconnect</Button
											>{:else if provider.installed}<Button
												variant="outline"
												size="sm"
												onclick={() => void connect(provider)}>Connect</Button
											>{:else}<Button
												variant="outline"
												size="sm"
												onclick={() => void connect(provider)}
												><ExternalLink class="size-4" />Install</Button
											>{/if}
									</div>
									{#if expandedModelsProviderId === provider.id}
										{@render modelList(
											provider.providerId,
											provider.name,
											availableModels,
										)}
									{/if}
								</div>
							{/each}
						{/if}
					</div>
				</section>
				<section class="mb-8">
					<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
						<div>
							<p
								class="text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500"
							>
								Custom providers
							</p>
							<p class="mt-1 text-sm text-neutral-500">
								Connect an OpenAI-compatible endpoint and import its models into
								Loom. Imported models appear in Chat, Kanban, Canvas, and
								Walkthrough; the API key is stored in Loom local data.
							</p>
						</div>
						<Button size="sm" onclick={openAddCustomProvider}
							><Plus class="size-4" />Add provider</Button
						>
					</div>
					{#if customProviders.length}
						<div
							class="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035]"
						>
							{#each customProviders as provider (provider.id)}
								{@const availableModels = modelsForProvider(
									provider.id,
									provider.models,
								)}
								<div class="border-b border-white/[0.08] last:border-0">
									<div class="flex flex-wrap items-center gap-3 p-4">
										<div class="min-w-0 flex-1">
											<div class="flex items-center gap-2">
												<p class="truncate text-sm font-medium">
													{provider.name}
												</p>
												<span
													class={`text-xs ${provider.status === "connected" ? "text-emerald-400" : "text-amber-300"}`}
													>{provider.status}</span
												>
											</div>
											<p class="truncate font-mono text-xs text-neutral-500">
												{provider.baseUrl}
											</p>
											<p class="mt-1 text-xs text-neutral-500">
												{availableModels.length} models imported
											</p>
										</div>
										<Button
											variant="outline"
											size="sm"
											aria-expanded={expandedModelsProviderId === provider.id}
											aria-controls={`provider-models-${provider.id}`}
											onclick={() => toggleProviderModels(provider.id)}
										>
											<Search class="size-3.5" />
											{expandedModelsProviderId === provider.id
												? "Hide models"
												: "View models"}
											<span class="text-neutral-400"
												>{availableModels.length}</span
											>
											<ChevronDown
												class={`size-3.5 transition-transform ${expandedModelsProviderId === provider.id ? "rotate-180" : ""}`}
											/>
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`Edit ${provider.name}`}
											title="Edit provider"
											onclick={() => openEditCustomProvider(provider)}
											><Pencil class="size-4" /></Button
										>
										<Button
											variant="ghost"
											size="icon-sm"
											class="text-red-300 hover:text-red-200"
											aria-label={`Delete ${provider.name}`}
											title="Delete provider"
											onclick={() => requestDeleteProvider(provider)}
											><Trash2 class="size-4" /></Button
										>
									</div>
									{#if expandedModelsProviderId === provider.id}
										{@render modelList(
											provider.id,
											provider.name,
											availableModels,
										)}
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						<div
							class="rounded-2xl border border-dashed border-white/10 p-5 text-sm text-neutral-500"
						>
							No custom providers added yet.
						</div>
					{/if}
				</section>
			</div>
		</main>
	</div>
</div>
<AlertDialog.Root bind:open={customDialogOpen}>
	<AlertDialog.Content
		class="flex h-fit max-h-[calc(100dvh-2.5rem)] w-[calc(100vw-2rem)] max-w-2xl sm:max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl border border-white/10 bg-[#121212] p-0 text-neutral-100 shadow-2xl"
	>
		<AlertDialog.Header
			class="relative shrink-0 border-b border-white/10 px-4 py-3.5 sm:px-6 sm:py-4.5 pr-12 sm:pr-14 text-left"
		>
			<div class="flex items-center gap-3">
				<div
					class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-neutral-300"
				>
					{#if customEditingId}
						<Pencil class="size-4" />
					{:else}
						<Plus class="size-4" />
					{/if}
				</div>
				<div class="min-w-0">
					<AlertDialog.Title
						class="text-base font-semibold text-neutral-100 sm:text-lg"
					>
						{customEditingId ? "Edit custom provider" : "Add custom provider"}
					</AlertDialog.Title>
					<AlertDialog.Description class="mt-0.5 text-xs text-neutral-400">
						Connect an OpenAI-compatible API endpoint to import models into
						Loom.
					</AlertDialog.Description>
				</div>
			</div>
			<Button
				variant="ghost"
				size="icon"
				class="absolute right-3 top-3 sm:right-4 sm:top-4 size-8 shrink-0 rounded-md border border-transparent text-neutral-400 transition-colors hover:border-white/10 hover:bg-white/10 hover:text-white"
				aria-label="Close dialog"
				onclick={() => (customDialogOpen = false)}
				disabled={customBusy}
			>
				<X class="size-4" />
			</Button>
		</AlertDialog.Header>

		<div
			class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5"
		>
			<div class="flex flex-col gap-5">
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="flex flex-col gap-1.5">
						<label
							for="custom-provider-name"
							class="text-xs font-medium text-neutral-300"
						>
							Provider label <span class="text-rose-400">*</span>
						</label>
						<Input
							id="custom-provider-name"
							bind:value={customName}
							placeholder="e.g. Local Ollama, OpenRouter"
							class="h-9 border-white/10 bg-white/[0.03] text-sm text-neutral-100 placeholder:text-neutral-500 focus-visible:border-white/20"
							autocomplete="off"
							onkeydown={handleCustomDialogKeydown}
						/>
					</div>

					<div class="flex flex-col gap-1.5">
						<label
							for="custom-provider-url"
							class="text-xs font-medium text-neutral-300"
						>
							Base URL <span class="text-rose-400">*</span>
						</label>
						<Input
							id="custom-provider-url"
							bind:value={customBaseUrl}
							placeholder="http://localhost:11434/v1"
							class="h-9 font-mono text-sm border-white/10 bg-white/[0.03] text-neutral-100 placeholder:text-neutral-500 focus-visible:border-white/20"
							inputmode="url"
							autocomplete="url"
							onkeydown={handleCustomDialogKeydown}
						/>
					</div>
				</div>

				<div class="flex flex-wrap items-center gap-1.5">
					<span class="text-[11px] font-medium text-neutral-500 mr-1"
						>Quick presets:</span
					>
					{#each URL_PRESETS as preset}
						{@const isSelected = customBaseUrl.trim() === preset.url}
						<button
							type="button"
							class={`inline-flex items-center rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
								isSelected
									? "border-emerald-500/40 bg-emerald-500/10 font-medium text-emerald-300 shadow-sm shadow-emerald-500/10"
									: "border-white/10 bg-white/[0.03] text-neutral-300 hover:border-white/20 hover:bg-white/[0.08]"
							}`}
							onclick={() => applyPreset(preset)}
						>
							{#if isSelected}
								<Check class="mr-1 size-3 text-emerald-400" />
							{/if}
							{preset.label}
						</button>
					{/each}
				</div>

				<div class="flex flex-col gap-1.5">
					<div class="flex items-center justify-between">
						<label
							for="custom-provider-key"
							class="text-xs font-medium text-neutral-300"
						>
							API Key
						</label>
						<span class="text-[11px] text-neutral-500">
							{customEditingId
								? "Leave blank to keep current key"
								: "Optional for local endpoints (Ollama, LM Studio)"}
						</span>
					</div>
					<div class="relative">
						<Input
							id="custom-provider-key"
							type={showApiKey ? "text" : "password"}
							bind:value={customApiKey}
							placeholder={customEditingId
								? "•••••••••••• (leave blank to keep current key)"
								: "Enter API key"}
							class="h-9 pr-10 font-mono text-sm border-white/10 bg-white/[0.03] text-neutral-100 placeholder:text-neutral-500 focus-visible:border-white/20"
							autocomplete="new-password"
							onkeydown={handleCustomDialogKeydown}
						/>
						<button
							type="button"
							class="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-200 transition-colors p-1"
							onclick={() => (showApiKey = !showApiKey)}
							aria-label={showApiKey ? "Hide API key" : "Show API key"}
						>
							{#if showApiKey}
								<EyeOff class="size-4" />
							{:else}
								<Eye class="size-4" />
							{/if}
						</button>
					</div>
				</div>

				<div
					class="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-3"
				>
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div class="flex items-center gap-3">
							<Button
								variant="outline"
								size="sm"
								class="border-white/10 bg-white/[0.04] hover:bg-white/[0.08]"
								disabled={customBusy ||
									!customName.trim() ||
									!customBaseUrl.trim()}
								onclick={() => void testCustomProvider()}
							>
								{#if customTesting}
									<RefreshCw class="size-3.5 animate-spin mr-1.5" />
									Testing connection…
								{:else}
									<RefreshCw class="size-3.5 mr-1.5" />
									Test connection
								{/if}
							</Button>
							{#if testStatus === "success"}
								<span
									class="flex items-center gap-1.5 text-xs font-medium text-emerald-400"
								>
									<CheckCircle2 class="size-4" />
									Connection successful
								</span>
							{:else if testStatus === "error"}
								<span
									class="flex items-center gap-1.5 text-xs font-medium text-rose-400"
								>
									<AlertCircle class="size-4" />
									Connection failed
								</span>
							{/if}
						</div>
						{#if discoveredModels.length}
							<Badge
								variant="secondary"
								class="border-white/10 bg-white/10 text-neutral-300"
							>
								{discoveredModels.length}
								{discoveredModels.length === 1 ? "model" : "models"} available
							</Badge>
						{/if}
					</div>

					{#if testStatus === "error" && testErrorMessage}
						<div
							class="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-300 flex items-start gap-2.5"
						>
							<AlertCircle class="size-4 shrink-0 mt-0.5 text-rose-400" />
							<div class="min-w-0 flex-1">
								<p class="font-medium text-rose-200">
									Could not connect to provider
								</p>
								<p class="mt-0.5 text-rose-300/80 break-words leading-relaxed">
									{testErrorMessage}
								</p>
							</div>
						</div>
					{:else if !discoveredModels.length && !customEditingId}
						<p class="text-xs text-neutral-500">
							Click “Test connection” to verify endpoint connectivity and
							retrieve available models before saving.
						</p>
					{/if}
				</div>

				{#if discoveredModels.length > 0}
					<div class="flex flex-col gap-2.5">
						<div class="flex items-center justify-between gap-2">
							<div class="flex items-center gap-2">
								<p
									class="text-xs font-semibold uppercase tracking-wider text-neutral-400"
								>
									Available Models
								</p>
								<span class="text-xs text-neutral-500"
									>({filteredDiscoveredModels.length} of {discoveredModels.length})</span
								>
							</div>
							{#if discoveredModels.length > 3}
								<div class="relative w-48">
									<Search
										class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-neutral-500"
									/>
									<Input
										bind:value={modelSearchQuery}
										placeholder="Filter models…"
										class="h-7 pl-7 pr-6 text-xs border-white/10 bg-white/[0.03] placeholder:text-neutral-500"
									/>
									{#if modelSearchQuery}
										<button
											type="button"
											class="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-200"
											onclick={() => (modelSearchQuery = "")}
											aria-label="Clear filter"
										>
											<X class="size-3" />
										</button>
									{/if}
								</div>
							{/if}
						</div>

						<div
							class="max-h-52 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.02] divide-y divide-white/[0.06]"
						>
							{#if filteredDiscoveredModels.length === 0}
								<div
									class="p-6 text-center text-xs text-neutral-500 flex flex-col items-center gap-1.5"
								>
									<span>No models matching “{modelSearchQuery}”</span>
									<button
										type="button"
										class="text-xs text-neutral-400 hover:text-white underline underline-offset-2"
										onclick={() => (modelSearchQuery = "")}
									>
										Clear filter
									</button>
								</div>
							{:else}
								{#each filteredDiscoveredModels as model (model.id)}
									<div
										class="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs transition-colors hover:bg-white/[0.03]"
									>
										<div class="min-w-0 flex-1">
											<div class="flex items-center gap-2">
												<span
													class="truncate font-mono font-medium text-neutral-200"
													>{model.id}</span
												>
											</div>
											{#if model.name && model.name !== model.id}
												<p class="truncate text-[11px] text-neutral-400 mt-0.5">
													{model.name}
												</p>
											{/if}
										</div>
										{#if model.contextWindow}
											<span
												class="shrink-0 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
											>
												{formatContextWindow(model.contextWindow)}
											</span>
										{/if}
									</div>
								{/each}
							{/if}
						</div>
					</div>
				{/if}
			</div>
		</div>

		<AlertDialog.Footer
			class="shrink-0 border-t border-white/10 bg-white/[0.02] px-4 py-3 sm:px-6 sm:py-4 flex flex-wrap items-center justify-between gap-3"
		>
			<div class="text-xs text-neutral-400">
				{#if discoveredModels.length > 0}
					<span class="text-neutral-400">
						<span class="font-semibold text-emerald-400"
							>{discoveredModels.length}</span
						>
						{discoveredModels.length === 1 ? "model" : "models"} ready
					</span>
				{:else if customEditingId}
					<span class="text-neutral-500">Using existing models</span>
				{:else}
					<span class="text-neutral-500">Test connection to continue</span>
				{/if}
			</div>

			<div class="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={customBusy}
					onclick={() => (customDialogOpen = false)}
				>
					Cancel
				</Button>
				<Button
					size="sm"
					disabled={customBusy ||
						!customName.trim() ||
						!customBaseUrl.trim() ||
						(!customEditingId && !discoveredModels.length)}
					onclick={() => void importCustomProvider()}
				>
					{#if customSaving}
						<RefreshCw class="size-3.5 animate-spin mr-1.5" />
						Saving…
					{:else if customEditingId}
						<Check class="size-3.5 mr-1.5" />
						Save changes
					{:else}
						<Plus class="size-3.5 mr-1.5" />
						Import {discoveredModels.length}
						{discoveredModels.length === 1 ? "model" : "models"}
					{/if}
				</Button>
			</div>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={deleteFirstOpen}>
	<AlertDialog.Content
		class="max-w-md rounded-2xl border border-white/10 bg-[#121212] p-6 text-neutral-100 shadow-2xl"
	>
		<AlertDialog.Header>
			<AlertDialog.Title class="text-base font-semibold text-white"
				>Delete {providerPendingDelete?.name ?? "provider"}?</AlertDialog.Title
			>
			<AlertDialog.Description class="mt-1 text-sm text-neutral-400"
				>This removes the provider configuration and its imported models from
				Loom.</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer class="mt-6 flex items-center justify-end gap-2">
			<AlertDialog.Cancel
				class="border-white/10 bg-transparent text-neutral-300 hover:bg-white/10 hover:text-white"
				>Cancel</AlertDialog.Cancel
			>
			<AlertDialog.Action
				onclick={(event) => void continueDeleteProvider(event)}
				>Continue</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={deleteSecondOpen}>
	<AlertDialog.Content
		class="max-w-md rounded-2xl border border-white/10 bg-[#121212] p-6 text-neutral-100 shadow-2xl"
	>
		<AlertDialog.Header>
			<AlertDialog.Title class="text-base font-semibold text-white"
				>Confirm permanent deletion</AlertDialog.Title
			>
			<AlertDialog.Description class="mt-1 text-sm text-neutral-400"
				>Delete {providerPendingDelete?.name ?? "this provider"}, its saved API
				key, and all {providerPendingDelete?.models.length ?? 0} imported models?
				This cannot be undone.</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer class="mt-6 flex items-center justify-end gap-2">
			<AlertDialog.Cancel
				disabled={deletingProvider}
				class="border-white/10 bg-transparent text-neutral-300 hover:bg-white/10 hover:text-white"
				>Keep provider</AlertDialog.Cancel
			>
			<AlertDialog.Action
				variant="destructive"
				disabled={deletingProvider}
				onclick={(event) => void deleteProviderNow(event)}
				>{deletingProvider
					? "Deleting…"
					: "Delete permanently"}</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={updateDialogOpen}>
	<AlertDialog.Content
		class="max-w-md rounded-2xl border border-white/10 bg-[#121212] p-6 text-neutral-100 shadow-2xl"
	>
		<AlertDialog.Header>
			<AlertDialog.Title class="text-base font-semibold text-white"
				>{updateState === "success"
					? "Update complete"
					: updateState === "error"
						? "Update needs attention"
						: updateState === "updating"
							? "Updating provider"
							: `Update ${selectedUpdate?.name ?? "provider"}?`}</AlertDialog.Title
			>
			<AlertDialog.Description class="mt-1 text-sm text-neutral-400">
				{#if updateState === "idle"}{selectedUpdate?.name} will be updated from {selectedUpdate?.currentVersion}
					to {selectedUpdate?.latestVersion}. Loom runs the provider's official
					updater and refreshes the detected version afterward.{:else}{updateMessage}{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if updateState === "updating"}<div
				class="mt-4 flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-3 text-sm text-neutral-300"
			>
				<RefreshCw class="size-4 animate-spin" />{updateMessage}
			</div>{/if}
		<AlertDialog.Footer class="mt-6 flex items-center justify-end gap-2">
			{#if updateState === "idle"}<Button
					variant="outline"
					onclick={() => (updateDialogOpen = false)}>Cancel</Button
				><Button onclick={() => void runProviderUpdate()}
					><Download class="size-4 mr-1.5" />Update now</Button
				>
			{:else if updateState === "updating"}<Button variant="outline" disabled
					>Updating…</Button
				>
			{:else}<Button
					variant="outline"
					onclick={() => (updateDialogOpen = false)}>Close</Button
				>{/if}
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
