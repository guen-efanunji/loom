<script lang="ts">
	import { CircleX, FileCode, Layers } from "@lucide/svelte";
	import * as Trace from "$lib/components/ui/trace";

	type Frame = {
		line: string;
		name?: string;
		file?: string;
		lineNumber?: string;
		internal: boolean;
	};

	let {
		error = "",
		/** Full stack text including the error line and `at …` frames. Render
		 * nothing without frames; a bare message is shown by the Tool line. */
		stack = "",
	}: {
		error?: string;
		stack?: string;
	} = $props<{ error?: string; stack?: string }>();

	function parseFrame(line: string): Frame {
		const match = line.match(/^at (.+) \((.+):(\d+):(\d+)\)$/);
		return {
			line,
			name: match?.[1],
			file: match?.[2],
			lineNumber: match?.[3],
			internal: line.includes("node_modules") || line.includes("node:"),
		};
	}

	const parsed = $derived.by(() => {
		if (!stack.trim()) return null;
		const [firstLine, ...lines] = stack
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (!lines.length) return null;
		const frames = lines.map(parseFrame);
		return {
			error: error || firstLine,
			appFrames: frames.filter((frame) => !frame.internal),
			internalFrames: frames.filter((frame) => frame.internal),
		};
	});
</script>

{#if parsed}
	<Trace.Root>
		<Trace.Collapsible open>
			<Trace.CollapsibleTrigger class="w-full text-left">
				<Trace.Line status="error">
					<Trace.Icon><CircleX size={14} /></Trace.Icon>
					<Trace.Title class="min-w-0 flex-1 truncate"
						>Failed: {parsed.error}</Trace.Title
					>
				</Trace.Line>
			</Trace.CollapsibleTrigger>
			<Trace.CollapsibleContent class="flex flex-col gap-2 pt-1">
				<p class="font-mono text-xs break-words text-destructive">
					{parsed.error}
				</p>
				<Trace.Root>
					{#each parsed.appFrames as frame (frame.line)}
						<Trace.Line>
							<Trace.Icon><FileCode size={14} /></Trace.Icon>
							<Trace.Title class="min-w-0 truncate"
								>{frame.name} in {frame.file}:{frame.lineNumber}</Trace.Title
							>
						</Trace.Line>
					{/each}
					{#if parsed.internalFrames.length}
						<Trace.Collapsible>
							<Trace.CollapsibleTrigger class="w-full text-left">
								<Trace.Line>
									<Trace.Icon><Layers size={14} /></Trace.Icon>
									<Trace.Title
										>{parsed.internalFrames.length} framework frame{parsed
											.internalFrames.length === 1
											? ""
											: "s"}</Trace.Title
									>
								</Trace.Line>
							</Trace.CollapsibleTrigger>
							<Trace.CollapsibleContent class="pt-1">
								<ol
									class="flex flex-col gap-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs"
								>
									{#each parsed.internalFrames as frame (frame.line)}
										<li class="whitespace-nowrap">{frame.line}</li>
									{/each}
								</ol>
							</Trace.CollapsibleContent>
						</Trace.Collapsible>
					{/if}
				</Trace.Root>
			</Trace.CollapsibleContent>
		</Trace.Collapsible>
	</Trace.Root>
{/if}
