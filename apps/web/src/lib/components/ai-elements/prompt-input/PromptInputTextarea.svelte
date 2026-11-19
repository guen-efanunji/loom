<script lang="ts">
	import { cn } from "$lib/shared/utils/shadcn";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
	import { getAttachmentsContext } from "./attachments-context.svelte.js";
	import type { HTMLTextareaAttributes } from "svelte/elements";

	interface Props extends Omit<
		HTMLTextareaAttributes,
		"class" | "onchange" | "value"
	> {
		class?: string;
		value?: string;
		ref?: HTMLTextAreaElement | null;
		onchange?: (event: Event) => void;
		onpaste?: (event: ClipboardEvent) => void;
	}

	let {
		class: className,
		placeholder = "What would you like to know?",
		value = $bindable(""),
		ref = $bindable(null),
		onchange,
		onpaste,
		...props
	}: Props = $props();

	let attachments = (() => {
		try {
			return getAttachmentsContext();
		} catch {
			// The textarea can be composed with a host application's own attachment state.
			return null;
		}
	})();

	let handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			// Don't submit if IME composition is in progress
			if (e.isComposing) {
				return;
			}

			if (e.shiftKey) {
				// Allow newline
				return;
			}

			// Submit on Enter (without Shift)
			e.preventDefault();
			let form = (e.currentTarget as HTMLTextAreaElement).form;
			if (form) {
				form.requestSubmit();
			}
		}
	};

	let handlePaste = (e: ClipboardEvent) => {
		if (onpaste) {
			onpaste(e);
			return;
		}

		let items = e.clipboardData?.items;
		if (!items || !attachments) return;

		let files: File[] = [];
		for (let item of items) {
			if (item.kind === "file") {
				let file = item.getAsFile();
				if (file) files.push(file);
			}
		}

		if (files.length > 0) {
			e.preventDefault();
			attachments.add(files);
		}
	};
</script>

<Textarea
	bind:ref
	class={cn(
		"w-full resize-none rounded-none border-none p-3 shadow-none ring-0 outline-none",
		"field-sizing-content bg-transparent dark:bg-transparent",
		"max-h-48 min-h-16",
		"focus-visible:ring-0",
		className,
	)}
	onpaste={handlePaste}
	name="message"
	{onchange}
	onkeydown={handleKeyDown}
	{placeholder}
	bind:value
	{...props}
/>
