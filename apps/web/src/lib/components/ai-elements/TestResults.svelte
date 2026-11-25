<script lang="ts">
	import {
		Check,
		CircleDashed,
		FileCode,
		FlaskConical,
		X,
	} from "@lucide/svelte";
	import * as CodeBlock from "$lib/components/ui/code-block";
	import * as Trace from "$lib/components/ui/trace";

	type Test = {
		name: string;
		status: "passed" | "failed" | "skipped";
		error?: string;
	};
	type Suite = { name: string; tests: Test[] };

	let {
		suites = [],
		running = false,
		runningLabel = "",
		open,
		onopenchange,
	}: {
		/** Structured test results; render nothing without them. */
		suites?: Suite[];
		/** The test command is still executing; no structured result yet. */
		running?: boolean;
		runningLabel?: string;
		open?: boolean;
		onopenchange?: (open: boolean) => void;
	} = $props<{
		suites?: Suite[];
		running?: boolean;
		runningLabel?: string;
		open?: boolean;
		onopenchange?: (open: boolean) => void;
	}>();

	function countTests(tests: Test[]) {
		return {
			total: tests.length,
			failed: tests.filter((test) => test.status === "failed").length,
			skipped: tests.filter((test) => test.status === "skipped").length,
		};
	}
	function formatCounts({
		total,
		failed,
		skipped,
	}: ReturnType<typeof countTests>) {
		return [
			`${total} test${total === 1 ? "" : "s"}`,
			failed > 0 && `${failed} failed`,
			skipped > 0 && `${skipped} skipped`,
		]
			.filter(Boolean)
			.join(", ");
	}

	const flatTests = $derived(suites.flatMap((suite) => suite.tests));
	const summary = $derived(countTests(flatTests));
</script>

{#if running}
	<Trace.Root>
		<Trace.Line status="running">
			<Trace.Icon><FlaskConical size={14} /></Trace.Icon>
			<Trace.Title class="min-w-0 flex-1 truncate"
				>{runningLabel || "Running tests"}</Trace.Title
			>
		</Trace.Line>
	</Trace.Root>
{:else if flatTests.length > 0}
	<Trace.Root>
		<Trace.Collapsible {open} onOpenChange={(value) => onopenchange?.(value)}>
			<Trace.CollapsibleTrigger class="w-full text-left">
				<Trace.Line status={summary.failed > 0 ? "error" : undefined}>
					<Trace.Icon><FlaskConical size={14} /></Trace.Icon>
					<Trace.Title class="min-w-0 flex-1 truncate"
						>Ran {formatCounts(summary)}</Trace.Title
					>
				</Trace.Line>
			</Trace.CollapsibleTrigger>
			<Trace.CollapsibleContent class="pt-1">
				<Trace.Root>
					{#each suites as suite, suiteIndex (suiteIndex)}
						{@const counts = countTests(suite.tests)}
						<Trace.Collapsible>
							<Trace.CollapsibleTrigger class="w-full text-left">
								<Trace.Line status={counts.failed > 0 ? "error" : undefined}>
									<Trace.Icon><FileCode size={14} /></Trace.Icon>
									<Trace.Title class="min-w-0 flex-1 truncate"
										>{suite.name}, {formatCounts(counts)}</Trace.Title
									>
								</Trace.Line>
							</Trace.CollapsibleTrigger>
							<Trace.CollapsibleContent class="pt-1 pl-6">
								<Trace.Root>
									{#each suite.tests as test, testIndex (testIndex)}
										{#if test.status === "failed"}
											<Trace.Collapsible open>
												<Trace.CollapsibleTrigger class="w-full text-left">
													<Trace.Line status="error">
														<Trace.Icon><X size={14} /></Trace.Icon>
														<Trace.Title class="min-w-0 flex-1 truncate"
															>{test.name}</Trace.Title
														>
													</Trace.Line>
												</Trace.CollapsibleTrigger>
												<Trace.CollapsibleContent class="pt-1 pl-6">
													<CodeBlock.Root size="sm">
														<CodeBlock.Content
															wrap
															class="max-h-64"
															code={test.error ?? ""}
														/>
													</CodeBlock.Root>
												</Trace.CollapsibleContent>
											</Trace.Collapsible>
										{:else}
											<Trace.Line>
												<Trace.Icon>
													{#if test.status === "skipped"}
														<CircleDashed size={14} />
													{:else}
														<Check size={14} />
													{/if}
												</Trace.Icon>
												<Trace.Title class="min-w-0 flex-1 truncate"
													>{test.status === "skipped"
														? `Skipped ${test.name}`
														: test.name}</Trace.Title
												>
											</Trace.Line>
										{/if}
									{/each}
								</Trace.Root>
							</Trace.CollapsibleContent>
						</Trace.Collapsible>
					{/each}
				</Trace.Root>
			</Trace.CollapsibleContent>
		</Trace.Collapsible>
	</Trace.Root>
{/if}
