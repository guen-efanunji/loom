<script lang="ts">
import type { Question } from "$lib/chat";
import * as Questionnaire from "$lib/components/ui/questionnaire/index.js";

let {
	question,
	onanswer,
}: { question: Question; onanswer: (answers: string[][]) => Promise<void> } =
	$props();

// Each clarifying question becomes one wizard item. Prefer the gateway's
// option value so a GitHub-style form reply (value !== label) round-trips;
// fall back to the label for legacy /question payloads.
const items = $derived(
	question.questions.map((item, index) => ({
		name: `q${index}`,
		required: true,
		choices: item.options.map((option) => ({
			value: option.value ?? option.label,
		})),
	})),
);

function handleSubmit(event: SubmitEvent) {
	event.preventDefault();
	const form = new FormData(event.currentTarget as HTMLFormElement);
	const answers = question.questions.map((item, index) => {
		const key = `q${index}`;
		return item.multiple
			? form.getAll(key).map(String).filter(Boolean)
			: [form.get(key)]
					.map((v) => (v == null ? "" : String(v)))
					.filter(Boolean);
	});
	void onanswer(answers);
}
</script>

<Questionnaire.Root
	class="rounded-xl border bg-card p-4"
	defaultItem="q0"
	{items}
	shortcuts="numbers"
	onSubmit={handleSubmit}
>
	<Questionnaire.Progress />
	{#each question.questions as item, index (index)}
		<Questionnaire.Item name={`q${index}`} required>
			<Questionnaire.Title>{item.question}</Questionnaire.Title>
			{#if item.header}
				<Questionnaire.Description>{item.header}</Questionnaire.Description>
			{/if}
			<Questionnaire.Choices>
				{#each item.options as option (option.value ?? option.label)}
					<Questionnaire.Choice value={option.value ?? option.label}>
						<span class="font-medium">{option.label}</span>
						{#if option.description}
							<Questionnaire.ChoiceDescription>
								{option.description}
							</Questionnaire.ChoiceDescription>
						{/if}
					</Questionnaire.Choice>
				{/each}
				<Questionnaire.Input
					aria-label={`Custom answer: ${item.header || item.question}`}
					placeholder="Or type your answer…"
				/>
			</Questionnaire.Choices>
			<Questionnaire.Error />
		</Questionnaire.Item>
	{/each}
	<Questionnaire.Actions>
		<Questionnaire.Previous />
		<Questionnaire.Next>Next</Questionnaire.Next>
		<Questionnaire.Submit>Send answers</Questionnaire.Submit>
	</Questionnaire.Actions>
</Questionnaire.Root>
