<script lang="ts">
	import { CircleCheck, CircleAlert, LoaderCircle } from "@lucide/svelte";
	import { Badge } from "$lib/components/ui/badge";
	import * as CodeBlock from "$lib/components/ui/code-block";
	import * as Trace from "$lib/components/ui/trace";

	type Test = {
		name: string;
		status: "passed" | "failed" | "skipped";
		error?: string;
	};
	type Suite = { name: string; tests: Test[] };

	type Step = {
		/** Title in the matching tense, e.g. "Read the build log for …". */
		title: string;
		status?: "running" | "error";
		/** Detail the step expands to. Optional; plain steps stay folded. */
		detail?: {
			/** Multi-line output rendered as a code block. */
			code?: string;
			codeVariant?: "default" | "destructive";
			/** Web results rendered as one trace link per page. */
			results?: Array<{ title: string; url: string }>;
			/** Short tags rendered as badges, e.g. matched file paths. */
			badges?: string[];
		};
	};

	let {
		running = false,
		steps = [],
		summary,
		open,
		onopenchange,
	}: {
		/** Streams: the summary runs until the answer arrives. */
		running?: boolean;
		steps?: Step[];
		/** Fallback summary label, used when not running and not derivable. */
		summary?: string;
		open?: boolean;
		onopenchange?: (open: boolean) => void;
	} = $props<{
		running?: boolean;
		steps?: Step[];
		summary?: string;
		open?: boolean;
		onopenchange?: (open: boolean) => void;
	}>();

	const failed = $derived(
		steps.filter((step) => step.status === "error").length,
	);
	const label = $derived(
		running
			? (summary ?? "Working")
			: (summary ??
					`Took ${steps.length} step${steps.length === 1 ? "" : "s"}${
						failed > 0 ? `, ${failed} failed` : ""
					}`),
	);
	const status = $derived(
		running
			? ("running" as const)
			: failed > 0
				? ("error" as const)
				: undefined,
	);
</script>

{#snippet statusIcon(stepStatus: "running" | "error" | undefined)}
	{#if stepStatus === "running"}
		<LoaderCircle class="animate-spin" size={14} />
	{:else if stepStatus === "error"}
		<CircleAlert size={14} />
	{:else}
		<CircleCheck size={14} />
	{/if}
{/snippet}

{#snippet stepDetail(detail: NonNullable<Step["detail"]>)}
	{#if detail.results?.length}
		<Trace.Root>
			{#each detail.results as result (result.url)}
				<a href={result.url} target="_blank" rel="noreferrer">
					<Trace.Line>
						<Trace.Title>
							{result.title}
							<span class="sr-only"> (opens in a new tab)</span>
						</Trace.Title>
					</Trace.Line>
				</a>
			{/each}
		</Trace.Root>
	{:else if detail.badges?.length}
		<div class="flex flex-wrap gap-1.5">
			{#each detail.badges as badge (badge)}
				<Badge variant="secondary" class="max-w-full font-mono"
					><span class="truncate">{badge}</span></Badge
				>
			{/each}
		</div>
	{:else if detail.code}
		<CodeBlock.Root size="sm" variant={detail.codeVariant ?? "default"}>
			<CodeBlock.Content wrap class="max-h-64" code={detail.code} />
		</CodeBlock.Root>
	{/if}
{/snippet}

<Trace.Root>
	<Trace.Collapsible {open} onOpenChange={(value) => onopenchange?.(value)}>
		<Trace.CollapsibleTrigger class="w-full text-left">
			<Trace.Line {status}>
				<Trace.Icon>{@render statusIcon(status)}</Trace.Icon>
				<Trace.Title class="min-w-0 flex-1 truncate">{label}</Trace.Title>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="pt-1">
			<Trace.Root>
				{#each steps as step, index (`${index}-${step.title}`)}
					{#if step.detail}
						<Trace.Collapsible open={step.status === "error"}>
							<Trace.CollapsibleTrigger>
								<Trace.Line status={step.status}>
									<Trace.Icon>{@render statusIcon(step.status)}</Trace.Icon>
									<Trace.Title>{step.title}</Trace.Title>
								</Trace.Line>
							</Trace.CollapsibleTrigger>
							<Trace.CollapsibleContent class="pt-1 pl-6">
								{@render stepDetail(step.detail!)}
							</Trace.CollapsibleContent>
						</Trace.Collapsible>
					{:else}
						<Trace.Line status={step.status}>
							<Trace.Icon>{@render statusIcon(step.status)}</Trace.Icon>
							<Trace.Title>{step.title}</Trace.Title>
						</Trace.Line>
					{/if}
				{/each}
			</Trace.Root>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
