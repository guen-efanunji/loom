<script lang="ts">
	import {
		ArrowRight,
		Bot,
		CircleAlert,
		Eye,
		EyeOff,
		GitBranch,
		LoaderCircle,
		ShieldCheck,
		Terminal,
	} from "@lucide/svelte";
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { Button } from "$lib/components/ui/button";
	import { Checkbox } from "$lib/components/ui/checkbox";
	import { Input } from "$lib/components/ui/input";
	import {
		DEFAULT_UI_PASSWORD,
		getUiPassword,
		isTrustedDevice,
		setTrustedDevice,
	} from "$lib/ui-access";

	let password = $state("");
	let remember = $state(false);
	let error = $state("");
	let showPassword = $state(false);
	let isSubmitting = $state(false);
	let isMounted = $state(false);

	onMount(() => {
		if (isTrustedDevice()) {
			const next = page.url.searchParams.get("next") || "/";
			window.location.assign(
				next.startsWith("/") && !next.startsWith("//") ? next : "/",
			);
			return;
		}
		requestAnimationFrame(() => {
			isMounted = true;
		});
	});

	async function unlock() {
		if (!password) {
			error = "Please enter your password";
			return;
		}

		isSubmitting = true;
		error = "";

		await new Promise((resolve) => setTimeout(resolve, 150));

		if (password !== getUiPassword()) {
			error = "Incorrect password";
			isSubmitting = false;
			return;
		}

		setTrustedDevice(remember);
		sessionStorage.setItem("loom.ui.unlocked", "true");
		const next = page.url.searchParams.get("next") || "/";
		window.location.assign(
			next.startsWith("/") && !next.startsWith("//") ? next : "/",
		);
	}

	const features = [
		{
			icon: Bot,
			title: "Multi-Agent Swarms",
			desc: "Coordinate autonomous task runners, councils, and specialized agents.",
		},
		{
			icon: GitBranch,
			title: "Worktree Isolation",
			desc: "Execute changes safely across isolated branches with live diff inspections.",
		},
		{
			icon: Terminal,
			title: "Real-time Telemetry",
			desc: "Inspect live command execution, agent reasoning traces, and diagnostics.",
		},
	];
</script>

<svelte:head>
	<title>Sign in — Loom</title>
</svelte:head>

<div
	class="flex min-h-svh w-full flex-col bg-background text-foreground antialiased"
>
	<div class="flex flex-1">
		<!-- Left / Main Auth Section -->
		<div class="flex flex-1 items-center justify-center p-6 sm:p-10 lg:p-16">
			<div
				class="w-full max-w-sm transition-all duration-700 ease-out {isMounted
					? 'translate-y-0 opacity-100'
					: 'translate-y-4 opacity-0'}"
			>
				<!-- App Branding -->
				<div class="mb-8">
					<div class="mb-6 flex items-center gap-3">
						<div
							class="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"
						>
							<svg class="size-5.5" viewBox="0 0 64 64" fill="none">
								<path
									d="M18 14v29a8 8 0 008 8h23M32 14v29a8 8 0 008 8h9M18 28h31M18 40h31"
									stroke="currentColor"
									stroke-width="5"
									stroke-linecap="round"
								/>
							</svg>
						</div>
						<span class="font-semibold text-xl tracking-tight text-foreground"
							>Loom</span
						>
					</div>

					<h1
						class="font-bold text-2xl tracking-tight text-foreground sm:text-3xl"
					>
						Sign in
					</h1>
					<p class="mt-1.5 text-muted-foreground text-sm leading-relaxed">
						Enter your password to continue to your workspace
					</p>
				</div>

				<!-- Auth Form -->
				<form
					class="w-full space-y-5"
					onsubmit={(event) => {
						event.preventDefault();
						unlock();
					}}
				>
					<div class="space-y-2">
						<label
							for="password-input"
							class="font-medium text-foreground text-sm"
						>
							Password
						</label>

						<div class="relative">
							<Input
								id="password-input"
								type={showPassword ? "text" : "password"}
								placeholder="Enter password"
								bind:value={password}
								class="h-11 w-full rounded-lg border-input bg-background pr-10 text-sm focus-visible:ring-ring"
								autofocus
								disabled={isSubmitting}
							/>
							<button
								type="button"
								onclick={() => (showPassword = !showPassword)}
								class="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
								tabindex={-1}
								aria-label={showPassword ? "Hide password" : "Show password"}
							>
								{#if showPassword}
									<EyeOff class="size-4" />
								{:else}
									<Eye class="size-4" />
								{/if}
							</button>
						</div>

						{#if error}
							<div
								class="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-destructive text-sm"
								role="alert"
							>
								<CircleAlert class="size-4 shrink-0" />
								<span>{error}</span>
							</div>
						{/if}

						<p class="pt-0.5 text-muted-foreground text-xs leading-relaxed">
							Default password:
							<code
								class="rounded bg-muted px-1.5 py-0.5 font-medium font-mono text-[11px] text-foreground"
							>
								{DEFAULT_UI_PASSWORD}
							</code>
							(unless configured otherwise)
						</p>
					</div>

					<div class="pt-1">
						<label
							class="flex cursor-pointer select-none items-center gap-2.5 text-muted-foreground text-sm transition-colors hover:text-foreground"
						>
							<Checkbox bind:checked={remember} disabled={isSubmitting} />
							<span>Trust this device</span>
						</label>
					</div>

					<Button
						type="submit"
						class="h-11 w-full gap-2 rounded-lg font-medium text-sm shadow-xs transition-all"
						disabled={isSubmitting}
					>
						{#if isSubmitting}
							<LoaderCircle class="size-4 animate-spin" />
							<span>Unlocking...</span>
						{:else}
							<span>Continue</span>
							<ArrowRight class="size-4" />
						{/if}
					</Button>
				</form>

				<!-- Footer note -->
				<div
					class="mt-8 flex items-center justify-between border-border/40 border-t pt-6 text-muted-foreground/60 text-xs"
				>
					<span>Loom Workspace</span>
					<span class="flex items-center gap-1.5">
						<span class="size-1.5 rounded-full bg-emerald-500"></span>
						Protected session
					</span>
				</div>
			</div>
		</div>

		<!-- Right / Showcase Section (Visible on Large Screens) -->
		<div
			class="relative hidden flex-1 items-center justify-center overflow-hidden border-border/40 border-l bg-gradient-to-br from-primary/5 via-muted/20 to-transparent p-12 lg:flex"
		>
			<!-- Ambient lighting circles -->
			<div
				class="pointer-events-none absolute -top-32 -right-32 size-96 rounded-full bg-primary/10 blur-3xl"
			></div>
			<div
				class="pointer-events-none absolute -bottom-32 -left-32 size-96 rounded-full bg-primary/5 blur-3xl"
			></div>

			<div
				class="relative z-10 w-full max-w-md space-y-8 transition-all delay-200 duration-700 ease-out {isMounted
					? 'translate-y-0 opacity-100'
					: 'translate-y-4 opacity-0'}"
			>
				<div>
					<h2 class="mb-3 font-bold text-2xl text-foreground tracking-tight">
						AI Agent Workspace
					</h2>
					<p class="text-muted-foreground text-sm leading-relaxed">
						Orchestrate autonomous agent swarms, manage isolated git worktrees,
						and turn complex ideas into shipped code.
					</p>
				</div>

				<div class="space-y-4">
					{#each features as feature}
						<div
							class="flex items-start gap-4 rounded-xl border border-border/80 bg-card/60 p-4 shadow-xs backdrop-blur-sm transition-all hover:border-border hover:bg-card"
						>
							<div
								class="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-foreground"
							>
								<feature.icon class="size-5 text-foreground" />
							</div>
							<div>
								<h3 class="font-medium text-foreground text-sm">
									{feature.title}
								</h3>
								<p class="mt-1 text-muted-foreground text-xs leading-relaxed">
									{feature.desc}
								</p>
							</div>
						</div>
					{/each}
				</div>

				<div
					class="flex items-center gap-2 pt-2 text-muted-foreground/70 text-xs"
				>
					<ShieldCheck class="size-4 shrink-0 text-emerald-500" />
					<span>End-to-end local session authorization active</span>
				</div>
			</div>
		</div>
	</div>
</div>
