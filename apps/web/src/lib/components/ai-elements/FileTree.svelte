<script lang="ts" module>
	export type FileNode = {
		type: "folder" | "file";
		name: string;
		path: string;
		children?: FileNode[];
	};
</script>

<script lang="ts">
	import { ChevronRight, File, Folder, FolderOpen } from "@lucide/svelte";
	// Recursive renderer; a self-import is the recommended pattern in Svelte 5.
	import FileTreeNode from "./FileTree.svelte";

	import * as Collapsible from "$lib/components/ui/collapsible";
	import { Button } from "$lib/components/ui/button";
	import { cn } from "$lib/utils.js";

	let {
		node,
		selected = "",
		depth = 0,
		onselect,
	}: {
		node: FileNode;
		selected?: string;
		depth?: number;
		onselect?: (path: string) => void;
	} = $props<{
		node: FileNode;
		selected?: string;
		depth?: number;
		onselect?: (path: string) => void;
	}>();
</script>

{#if node.type === "folder"}
	<Collapsible.Root open class="group/folder">
		<Collapsible.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="sm"
					class="w-full justify-start gap-1.5 font-normal"
				>
					<ChevronRight
						size={14}
						class="shrink-0 transition-transform group-data-[state=open]/folder:rotate-90"
					/>
					<Folder
						size={14}
						class="shrink-0 group-data-[state=open]/folder:hidden"
					/>
					<FolderOpen
						size={14}
						class="hidden shrink-0 group-data-[state=open]/folder:block"
					/>
					<span class="truncate">{node.name}</span>
				</Button>
			{/snippet}
		</Collapsible.Trigger>
		<Collapsible.Content>
			<div class="ml-4 flex flex-col">
				{#each node.children ?? [] as child (child.path)}
					<FileTreeNode node={child} {selected} depth={depth + 1} {onselect} />
				{/each}
			</div>
		</Collapsible.Content>
	</Collapsible.Root>
{:else}
	<Button
		variant="ghost"
		size="sm"
		class={cn(
			"w-full justify-start gap-1.5 font-normal",
			selected === node.path && "bg-accent/50",
		)}
		onclick={() => onselect?.(node.path)}
	>
		<File size={14} class="shrink-0" />
		<span class="truncate" title={node.path}>{node.name}</span>
	</Button>
{/if}
