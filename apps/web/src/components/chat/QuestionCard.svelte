<script lang="ts">
import type { Question } from "$lib/chat";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";

let {
	question,
	onanswer,
}: { question: Question; onanswer: (answers: string[][]) => Promise<void> } =
	$props();
let answers = $state<Record<number, string[]>>({});
let custom = $state<Record<number, string>>({});
let sending = $state(false);
async function submit() {
	sending = true;
	try {
		await onanswer(
			question.questions.map((_, i) =>
				custom[i]?.trim() ? [custom[i].trim()] : (answers[i] ?? []),
			),
		);
	} finally {
		sending = false;
	}
}
</script>
<form class="space-y-4 rounded-xl border bg-card p-4" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
  {#each question.questions as item, i}<fieldset class="space-y-2"><legend class="mb-2 text-sm font-medium">{item.question}</legend><div class="flex flex-wrap gap-2">{#each item.options as option}<Button type="button" variant={answers[i]?.includes(option.label) ? "secondary" : "outline"} title={option.description} aria-pressed={answers[i]?.includes(option.label) ?? false} onclick={() => { custom[i] = ""; answers[i] = item.multiple ? (answers[i]?.includes(option.label) ? answers[i].filter((v) => v !== option.label) : [...(answers[i] ?? []), option.label]) : [option.label]; }}>{option.label}</Button>{/each}</div><Input aria-label={`Custom answer: ${item.header}`} placeholder="Or type your answer…" bind:value={custom[i]} /></fieldset>{/each}
  <Button type="submit" disabled={sending || question.questions.some((_, i) => !custom[i]?.trim() && !answers[i]?.length)}>{sending ? "Sending…" : "Submit answers"}</Button>
</form>
