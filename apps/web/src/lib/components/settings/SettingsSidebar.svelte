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
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";

type ActiveSection = "general" | "providers" | "agents";
type Props = {
	active: ActiveSection;
	search?: string;
};

let { active, search = $bindable("") }: Props = $props();

const sections = [
	{
		label: "Workspace",
		items: [
			{ label: "General", href: "/settings", icon: Settings2, key: "general" },
			{ label: "Context", href: "/settings#context", icon: CircleHelp },
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
			{ label: "MCP", href: "/settings#mcp", icon: MessageSquareText },
			{
				label: "Token Usage",
				href: "/settings#token-usage",
				icon: WalletCards,
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

<aside class="sticky top-0 hidden h-svh w-64 shrink-0 overflow-y-auto border-r border-white/10 px-3 py-4 md:block">
	<div class="mb-5">
		<Button href="/" variant="ghost" class="w-full justify-start gap-2 px-2 text-sm font-semibold text-neutral-100">
			<ArrowLeft class="size-4" />
			Back to workspace
		</Button>
	</div>
	<div class="flex items-center gap-2 px-2 text-sm font-semibold">
		<span class="flex size-6 items-center justify-center rounded-md bg-white text-black">L</span>
		loom
	</div>
	<label class="relative mt-5 block">
		<Search class="absolute left-3 top-2.5 size-4 text-neutral-500" />
		<Input bind:value={search} placeholder="Search settings…" class="h-9 border-white/10 bg-white/[0.04] pl-9 text-xs" />
	</label>
	<nav class="mt-6 space-y-6" aria-label="Settings sections">
		{#each sections as section}
			<div>
				<p class="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-500">{section.label}</p>
				<div class="space-y-1">
					{#each section.items as item}
						{@const Icon = item.icon}
						<Button
							href={item.href}
							variant="ghost"
							class={`w-full justify-start gap-2 ${item.key === active ? "bg-white/[0.14] text-white" : "text-neutral-400"}`}
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
