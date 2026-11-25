<script lang="ts">
import { FileCode, Wrench } from "@lucide/svelte";
import { Button } from "$lib/components/ui/button";
import * as CodeBlock from "$lib/components/ui/code-block";
import * as Trace from "$lib/components/ui/trace";

type DiffLine = {
	code: string;
	variant: CodeBlock.CodeBlockLineVariant;
};

let {
	name = "Tool activity",
	status = "completed",
	input,
	output = "",
	error = "",
	diff = "",
	diffFile = "",
	additions,
	deletions,
	loading = false,
	open,
	onopenchange,
	onopenfile,
	openFile = "",
} = $props<{
	name?: string;
	status?: "running" | "completed" | "error";
	input?: Record<string, unknown>;
	output?: string;
	error?: string;
	diff?: string;
	diffFile?: string;
	additions?: number;
	deletions?: number;
	loading?: boolean;
	open?: boolean;
	onopenchange?: (open: boolean) => void;
	onopenfile?: (path: string) => void;
	openFile?: string;
}>();

const hasDiffStats = $derived(
	additions !== undefined || deletions !== undefined,
);

const parsedDiff = $derived.by(() => {
	const raw = (diff ?? "").trimEnd() as string;
	if (!raw) return { startLine: 1, lines: [] as DiffLine[] };
	const rawLines = raw.split("\n");
	const hasHeaders = rawLines.some(
		(line: string) =>
			line.startsWith("@@") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("diff --git "),
	);
	let startLine = 1;
	let foundStart = false;
	const lines: DiffLine[] = [];
	for (const line of rawLines) {
		if (
			hasHeaders &&
			(line.startsWith("diff --git ") ||
				line.startsWith("index ") ||
				line.startsWith("--- ") ||
				line.startsWith("+++ "))
		) {
			continue;
		}
		if (line.startsWith("@@")) {
			if (!foundStart) {
				const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
				if (match?.[1]) {
					const parsed = Number.parseInt(match[1], 10);
					if (Number.isFinite(parsed) && parsed > 0) startLine = parsed;
				}
				foundStart = true;
			}
			lines.push({ code: line, variant: "highlighted" });
			continue;
		}
		if (line.startsWith("+")) {
			lines.push({ code: line.slice(1), variant: "added" });
		} else if (line.startsWith("-")) {
			lines.push({ code: line.slice(1), variant: "removed" });
		} else if (hasHeaders && line.startsWith(" ")) {
			lines.push({ code: line.slice(1), variant: "default" });
		} else {
			lines.push({ code: line, variant: "default" });
		}
	}
	return { startLine, lines };
});

const editorTarget = $derived(diffFile || openFile);
</script>

<Trace.Root class="gap-0">
	<Trace.Collapsible
		open={open ?? (status === "running" || status === "error")}
		onOpenChange={(value) => onopenchange?.(value)}
	>
		<Trace.CollapsibleTrigger class="w-full text-left">
			<Trace.Line
				status={status === "running"
					? "running"
					: status === "error"
						? "error"
						: undefined}
				class="w-full"
			>
				<Trace.Icon><Wrench size={14} /></Trace.Icon>
				<Trace.Title class="min-w-0 flex-1 truncate">{name}</Trace.Title>
				{#if hasDiffStats}
					<Trace.Description class="shrink-0 font-mono text-[11px]">
						<span class="text-emerald-600 dark:text-emerald-400"
							>+{additions ?? 0}</span
						>
						<span class="text-red-600 dark:text-red-400"
							>−{deletions ?? 0}</span
						>
					</Trace.Description>
				{/if}
				{#if !hasDiffStats || status !== "completed"}
					<Trace.Description class="shrink-0">
						{status === "running"
							? "Running"
							: status === "error"
								? "Failed"
								: "Done"}
					</Trace.Description>
				{/if}
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="space-y-2 pt-2">
			{#if input && !diff}<CodeBlock.Root size="sm">
					<CodeBlock.Content
						wrap
						class="max-h-60"
						code={JSON.stringify(input, null, 2)}
					/>
				</CodeBlock.Root>{/if}
			{#if output && !diff}<CodeBlock.Root size="sm">
					<CodeBlock.Content wrap class="max-h-64" code={output} />
				</CodeBlock.Root>{/if}
			{#if loading}<p class="text-xs text-muted-foreground">
					Loading file changes…
				</p>{/if}
			{#if diff && parsedDiff.lines.length}
				<CodeBlock.Root size="sm">
					<CodeBlock.Header>
						<CodeBlock.Title class="flex items-center gap-2">
							<span class="truncate">{diffFile || "Changes"}</span>
							{#if hasDiffStats}
								<span class="shrink-0 font-mono text-[11px] font-normal">
									<span class="text-emerald-600 dark:text-emerald-400"
										>+{additions ?? 0}</span
									>
									<span class="text-red-600 dark:text-red-400"
										>−{deletions ?? 0}</span
									>
								</span>
							{/if}
						</CodeBlock.Title>
						<CodeBlock.Actions>
							{#if editorTarget && onopenfile}
								<Button
									variant="ghost"
									size="sm"
									class="h-6 gap-1 px-2 text-xs text-muted-foreground"
									onclick={() => onopenfile?.(editorTarget)}
									><FileCode size={12} />Open in editor</Button
								>
							{/if}
							<CodeBlock.CopyButton value={diff} />
						</CodeBlock.Actions>
					</CodeBlock.Header>
					<CodeBlock.Content
						lineNumbers
						startLine={parsedDiff.startLine}
						wrap
						class="max-h-80"
					>
						{#each parsedDiff.lines as line, index (index)}
							<CodeBlock.Line
								variant={line.variant}
								code={line.code}
								class={line.variant === "highlighted"
									? "[counter-increment:none] before:invisible"
									: undefined}
							/>
						{/each}
					</CodeBlock.Content>
				</CodeBlock.Root>
			{:else if editorTarget && onopenfile}
				<Button
					variant="ghost"
					size="sm"
					class="h-7 px-2 text-xs text-muted-foreground"
					onclick={() => onopenfile?.(editorTarget)}
					><FileCode size={13} />Open in editor</Button
				>
			{/if}
			{#if error}<p class="text-sm text-destructive" role="alert">
					{error}
				</p>{/if}
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
