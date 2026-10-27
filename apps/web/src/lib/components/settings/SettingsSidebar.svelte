<script lang="ts">
import {
	ArrowLeft,
	Bot,
	CircleHelp,
	Globe,
	Keyboard,
	MessageSquareText,
	Palette,
	PanelLeft,
	Search,
	Settings2,
	Terminal,
	WalletCards,
} from "@lucide/svelte";
import { page } from "$app/state";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import { safeWorkspaceReturnTo, settingsHref } from "$lib/settings-navigation";

type ActiveSection =
	| "general"
	| "context"
	| "providers"
	| "agents"
	| "mcp"
	| "token-usage";
type Props = {
	active: ActiveSection;
	search?: string;
};

let { active, search = $bindable("") }: Props = $props();

const returnTo = $derived(
	safeWorkspaceReturnTo(page.url.searchParams.get("returnTo")),
);

function sectionHref(item: { href: string; key?: string }) {
	return item.key === "mcp" ? item.href : settingsHref(item.href, returnTo);
}

const sections = [
	{
		label: "Workspace",
		items: [
			{
				label: "General",
				href: "/settings",
				icon: Settings2,
				key: "general",
			},
			{
				label: "Context",
				href: "/settings/context",
				icon: CircleHelp,
				key: "context",
			},
		],
	},
	{
		label: "Agents",
		items: [
			{ label: "Agents", href: "/settings/agents", icon: Bot, key: "agents" },
			{
				label: "Providers",
				href: "/settings/providers",
				icon: Terminal,
				key: "providers",
			},
			{
				label: "MCP",
				href: "/settings/mcp",
				icon: MessageSquareText,
				key: "mcp",
			},
			{
				label: "Token Usage",
				href: "/settings/token-usage",
				icon: WalletCards,
				key: "token-usage",
			},
		],
	},
	{
		label: "Application",
		items: [
			{ label: "Appearance", href: "/settings#appearance", icon: Palette },
			{ label: "Keyboard", href: "/settings#keyboard", icon: Keyboard },
			{ label: "Browser", href: "/settings#browser", icon: Globe },
			{ label: "Sites", href: "/settings#sites", icon: PanelLeft },
		],
	},
];
</script>

<div
	class="sticky top-0 z-20 border-b border-white/10 bg-[#090909]/95 px-3 py-2 backdrop-blur md:hidden"
>
	<div class="flex items-center justify-between gap-3">
		<Button
			href={returnTo}
			variant="ghost"
			size="sm"
			class="shrink-0 gap-2 px-2 text-neutral-300"
		>
			<ArrowLeft data-icon="inline-start" />Workspace
		</Button>
		<span class="flex min-w-0 items-center gap-2 text-sm font-semibold">
			<img
				src="/loom-mark.webp"
				alt=""
				class="size-6 shrink-0 object-contain"
			/>
			loom · Settings
		</span>
	</div>
	<nav
		class="mt-2 flex gap-1 overflow-x-auto pb-1"
		aria-label="Settings sections"
	>
		{#each sections as section}
			{#each section.items as item}
				{@const Icon = item.icon}
				<Button
					href={sectionHref(item)}
					variant="ghost"
					size="sm"
					aria-current={"key" in item && item.key === active
						? "page"
						: undefined}
					class={`shrink-0 gap-2 ${"key" in item && item.key === active ? "bg-white/[0.14] text-white" : "text-neutral-400"}`}
				>
					<Icon data-icon="inline-start" />{item.label}
				</Button>
			{/each}
		{/each}
	</nav>
</div>

<aside
	class="sticky top-0 hidden h-svh w-64 shrink-0 overflow-y-auto border-r border-white/10 px-3 py-4 md:block"
>
	<div class="mb-5">
		<Button
			href={returnTo}
			variant="ghost"
			class="w-full justify-start gap-2 px-2 text-sm font-semibold text-neutral-100"
		>
			<ArrowLeft class="size-4" />
			Back to workspace
		</Button>
	</div>
	<div class="flex items-center gap-2 px-2 text-sm font-semibold">
		<span
			class="flex size-6 items-center justify-center rounded-md bg-white text-black"
			>L</span
		>
		loom
	</div>
	<label class="relative mt-5 hidden md:block">
		<Search class="absolute left-3 top-2.5 size-4 text-neutral-500" />
		<Input
			bind:value={search}
			placeholder="Search settings…"
			class="h-9 border-white/10 bg-white/[0.04] pl-9 text-xs"
		/>
	</label>
	<nav class="mt-6 space-y-6" aria-label="Settings sections">
		{#each sections as section}
			<div>
				<p
					class="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-500"
				>
					{section.label}
				</p>
				<div class="space-y-1">
					{#each section.items as item}
						{@const Icon = item.icon}
						<Button
							href={sectionHref(item)}
							variant="ghost"
							class={`w-full justify-start gap-2 ${"key" in item && item.key === active ? "bg-white/[0.14] text-white" : "text-neutral-400"}`}
						>
							<Icon class="size-4" />
							{item.label}
						</Button>
					{/each}
				</div>
			</div>
		{/each}
	</nav>
</aside>
