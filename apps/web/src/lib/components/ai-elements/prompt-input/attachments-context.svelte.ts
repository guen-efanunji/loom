import { setContext, getContext } from "svelte";

export interface FileUIPart {
	type: "file";
	url?: string;
	mediaType?: string;
	filename?: string;
}

export interface FileWithId extends FileUIPart {
	id: string;
	sourceFile?: File;
}

export interface PromptInputMessage {
	text?: string;
	files?: FileUIPart[];
}

export type ChatStatus = "submitted" | "streaming" | "error" | "idle";

export class AttachmentsContext {
	files = $state<FileWithId[]>([]);
	fileInputRef = $state<HTMLInputElement | null>(null);

	constructor(
		public accept?: string,
		_multiple?: boolean,
		private maxFiles?: number,
		private maxFileSize?: number,
		private onError?: (err: {
			code: "max_files" | "max_file_size" | "accept";
			message: string;
		}) => void,
	) {}

	openFileDialog = () => {
		this.fileInputRef?.click();
	};

	matchesAccept = (file: File): boolean => {
		if (!this.accept || this.accept.trim() === "") return true;

		return this.accept.split(",").some((entry) => {
			const rule = entry.trim().toLowerCase();
			if (!rule) return false;
			if (rule.startsWith(".")) return file.name.toLowerCase().endsWith(rule);
			if (rule.endsWith("/*")) return file.type.startsWith(rule.slice(0, -1));
			return file.type.toLowerCase() === rule;
		});
	};

	add = (files: File[] | FileList): FileWithId[] => {
		let incoming = Array.from(files);
		let accepted = incoming.filter((f) => this.matchesAccept(f));

		if (accepted.length === 0) {
			this.onError?.({
				code: "accept",
				message: "No files match the accepted types.",
			});
			return [];
		}

		let withinSize = (f: File) =>
			this.maxFileSize ? f.size <= this.maxFileSize : true;
		let sized = accepted.filter(withinSize);

		if (sized.length === 0 && accepted.length > 0) {
			this.onError?.({
				code: "max_file_size",
				message: "All files exceed the maximum size.",
			});
			return [];
		}

		let capacity =
			typeof this.maxFiles === "number"
				? Math.max(0, this.maxFiles - this.files.length)
				: undefined;
		let capped =
			typeof capacity === "number" ? sized.slice(0, capacity) : sized;

		if (typeof capacity === "number" && sized.length > capacity) {
			this.onError?.({
				code: "max_files",
				message: "Too many files. Some were not added.",
			});
		}

		let next: FileWithId[] = [];
		for (let file of capped) {
			next.push({
				id: crypto.randomUUID(),
				type: "file",
				url: URL.createObjectURL(file),
				mediaType: file.type,
				filename: file.name,
				sourceFile: file,
			});
		}

		this.files = [...this.files, ...next];
		return next;
	};

	remove = (id: string) => {
		let found = this.files.find((file) => file.id === id);
		if (found?.url) {
			URL.revokeObjectURL(found.url);
		}
		this.files = this.files.filter((file) => file.id !== id);
	};

	clear = () => {
		for (let file of this.files) {
			if (file.url) {
				URL.revokeObjectURL(file.url);
			}
		}
		this.files = [];
	};
}

// ============================================================================
// Provider Context for Global State Management
// ============================================================================

export class TextInputController {
	value = $state("");

	setInput = (newValue: string) => {
		this.value = newValue;
	};

	clear = () => {
		this.value = "";
	};
}

export class PromptInputController {
	textInput: TextInputController;
	attachments: AttachmentsContext;

	constructor(initialInput = "", accept?: string, multiple?: boolean) {
		this.textInput = new TextInputController();
		this.textInput.value = initialInput;
		this.attachments = new AttachmentsContext(accept, multiple);
	}
}

const ATTACHMENTS_CONTEXT_KEY = Symbol("attachments");
const PROVIDER_CONTEXT_KEY = Symbol("prompt-input-provider");

export function setAttachmentsContext(context: AttachmentsContext) {
	setContext(ATTACHMENTS_CONTEXT_KEY, context);
}

export function getAttachmentsContext(): AttachmentsContext {
	let context = getContext<AttachmentsContext>(ATTACHMENTS_CONTEXT_KEY);
	if (!context) {
		throw new Error(
			"usePromptInputAttachments must be used within a PromptInput",
		);
	}
	return context;
}

// Provider context (optional, for external state management)
export function setPromptInputProvider(controller: PromptInputController) {
	setContext(PROVIDER_CONTEXT_KEY, controller);
}

export function getPromptInputProvider(): PromptInputController | null {
	return getContext<PromptInputController>(PROVIDER_CONTEXT_KEY) || null;
}

export function getPromptInputController(): PromptInputController {
	let context = getContext<PromptInputController>(PROVIDER_CONTEXT_KEY);
	if (!context) {
		throw new Error(
			"getPromptInputController must be used within a PromptInputProvider",
		);
	}
	return context;
}
