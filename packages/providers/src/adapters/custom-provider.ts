import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
	access,
	mkdir,
	readdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	type AgentEvent,
	type AgentModel,
	type AgentRuntime,
	type AgentSession,
	type AuthResult,
	type AuthStatus,
	type CliProviderAdapter,
	type CreateSessionInput,
	connectionId,
	normalizeModel,
	type ProviderDefinition,
	type ProviderDetectionResult,
	type RuntimeOutput,
	type AgentRunStatus,
	type RuntimeModel,
	type RuntimeActivity,
	type RuntimeToolAuthorization,
	type SendMessageInput,
} from "../core";

export type ImportedCustomModel = {
	id: string;
	name: string;
	contextWindow?: number;
	outputLimit?: number;
};

export type CustomProviderConfig = {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	models: ImportedCustomModel[];
};

export async function discoverCustomModels(
	baseUrl: string,
	apiKey: string,
): Promise<ImportedCustomModel[]> {
	const url = new URL(baseUrl);
	const root = url.toString().replace(/\/+$/, "");
	const modelsUrl = /\/v1\/*$/i.test(url.pathname)
		? `${root}/models`
		: `${root}/v1/models`;
	const headers = new Headers({ accept: "application/json" });
	if (apiKey.trim()) headers.set("authorization", `Bearer ${apiKey.trim()}`);
	const response = await fetch(modelsUrl, {
		headers,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok)
		throw new Error(`Model endpoint returned HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!payload || typeof payload !== "object" || !("data" in payload))
		throw new Error(
			"The endpoint response must contain a data array of models",
		);
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data))
		throw new Error(
			"The endpoint response must contain a data array of models",
		);
	const models = data.flatMap((item): ImportedCustomModel[] => {
		if (!item || typeof item !== "object") return [];
		const model = item as {
			id?: unknown;
			name?: unknown;
			context_length?: unknown;
			max_output_tokens?: unknown;
			max_completion_tokens?: unknown;
			output_token_limit?: unknown;
		};
		if (typeof model.id !== "string" || !model.id.trim()) return [];
		const contextWindow = Number(model.context_length);
		const outputLimit = Number(
			model.max_output_tokens ??
				model.max_completion_tokens ??
				model.output_token_limit,
		);
		return [
			{
				id: model.id,
				name:
					typeof model.name === "string" && model.name.trim()
						? model.name.trim()
						: model.id,
				...(Number.isSafeInteger(contextWindow) && contextWindow > 0
					? { contextWindow }
					: {}),
				...(Number.isSafeInteger(outputLimit) && outputLimit > 0
					? { outputLimit }
					: {}),
			},
		];
	});
	if (!models.length)
		throw new Error("No usable models were returned by /v1/models");
	return models;
}

export async function testCustomModel(
	baseUrl: string,
	apiKey: string,
	modelId: string,
): Promise<void> {
	const url = new URL(baseUrl);
	const root = url.toString().replace(/\/+$/, "");
	const completionsUrl = /\/v1\/*$/i.test(url.pathname)
		? `${root}/chat/completions`
		: `${root}/v1/chat/completions`;
	const headers = new Headers({
		"content-type": "application/json",
		accept: "application/json",
	});
	if (apiKey.trim()) headers.set("authorization", `Bearer ${apiKey.trim()}`);
	const response = await fetch(completionsUrl, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: "Reply with exactly OK." }],
			max_tokens: 8,
			stream: false,
		}),
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
		throw new Error(
			`Model endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
		);
	}
	const payload: unknown = await response.json();
	if (
		!payload ||
		typeof payload !== "object" ||
		!("choices" in payload) ||
		!Array.isArray(payload.choices) ||
		!payload.choices.some(
			(choice) =>
				choice &&
				typeof choice === "object" &&
				"message" in choice &&
				choice.message &&
				typeof choice.message === "object" &&
				"content" in choice.message &&
				typeof choice.message.content === "string" &&
				choice.message.content.trim(),
		)
	)
		throw new Error("Model endpoint returned no text response");
}

export function ensureOpenAiSseTerminator(
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let tail = "";
	let hasDoneMarker = false;
	let hasFinishReason = false;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				const text = decoder.decode(chunk, { stream: true });
				tail = `${tail}${text}`.slice(-8192);
				if (tail.includes("[DONE]")) hasDoneMarker = true;
				if (
					/"finish_reason"\s*:\s*"(?:stop|length|tool_calls|function_call)"/.test(
						tail,
					)
				)
					hasFinishReason = true;
				controller.enqueue(chunk);
			},
			flush(controller) {
				const remaining = decoder.decode();
				if (remaining) controller.enqueue(encoder.encode(remaining));
				if (!hasFinishReason)
					controller.enqueue(
						encoder.encode(
							'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
						),
					);
				if (!hasDoneMarker)
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			},
		}),
	);
}

export function customProviderConfig(
	provider: CustomProviderConfig,
	overrides: { baseUrl?: string; apiKey?: string } = {},
) {
	const baseUrl = overrides.baseUrl ?? provider.baseUrl;
	return {
		provider: {
			[provider.id]: {
				npm: "@ai-sdk/openai-compatible",
				name: provider.name,
				options: {
					baseURL: /\/v1\/*$/i.test(baseUrl)
						? baseUrl
						: `${baseUrl.replace(/\/$/, "")}/v1`,
					apiKey: (overrides.apiKey ?? provider.apiKey) || undefined,
				},
				models: Object.fromEntries(
					provider.models.map((model) => [
						model.id,
						{
							name: model.name,
							...(model.contextWindow
								? {
										limit: {
											context: model.contextWindow,
											output: Math.max(
												1,
												Math.min(
													model.outputLimit ?? 8_192,
													model.contextWindow,
												),
											),
										},
									}
								: {}),
						},
					]),
				),
			},
		},
	};
}

const customRuntimeTools = [
	{
		type: "function",
		function: {
			name: "list_files",
			description:
				"List project files under a relative directory. Hidden and generated directories are omitted.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative directory; defaults to the project root.",
					},
					maxDepth: { type: "integer", minimum: 1, maximum: 5 },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "read_file",
			description:
				"Read a UTF-8 text file from the project. Use a path relative to the project root.",
			parameters: {
				type: "object",
				required: ["path"],
				properties: { path: { type: "string" } },
			},
		},
	},
	{
		type: "function",
		function: {
			name: "write_file",
			description:
				"Create or replace a UTF-8 text file inside the project. This changes project files and requires authorization.",
			parameters: {
				type: "object",
				required: ["path", "content"],
				properties: { path: { type: "string" }, content: { type: "string" } },
			},
		},
	},
	{
		type: "function",
		function: {
			name: "edit_file",
			description:
				"Replace one exact text occurrence in a UTF-8 project file. This changes project files and requires authorization.",
			parameters: {
				type: "object",
				required: ["path", "oldText", "newText"],
				properties: {
					path: { type: "string" },
					oldText: { type: "string" },
					newText: { type: "string" },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "run_command",
			description:
				"Run a shell command with the project root as its working directory. Commands can change files or have other side effects and always require authorization.",
			parameters: {
				type: "object",
				required: ["command"],
				properties: { command: { type: "string" } },
			},
		},
	},
];

const hiddenDirectories = new Set([
	".git",
	".hg",
	".svn",
	".ssh",
	".aws",
	"node_modules",
	".svelte-kit",
	".next",
	"dist",
	"build",
]);

function toolPath(root: string, value: unknown) {
	if (typeof value !== "string" || !value.trim())
		throw new Error("A relative project path is required");
	if (isAbsolute(value)) throw new Error("Absolute paths are not allowed");
	const normalized = value.replaceAll("\\", "/").trim();
	const segments =
		normalized === "." ? [] : normalized.split("/").filter(Boolean);
	if (segments.some((segment) => segment === ".." || segment === "."))
		throw new Error("Paths must stay inside the project");
	if (
		segments.some((segment) =>
			/^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|id_rsa|id_ed25519|.*\.pem)$/i.test(
				segment,
			),
		)
	)
		throw new Error(
			"Sensitive project paths are not available to provider tools",
		);
	const path = resolve(root, ...segments);
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("Paths must stay inside the project");
	return path;
}

async function ensureNoWorkspaceSymlinks(root: string, path: string) {
	let current = path;
	while (true) {
		try {
			await access(current, constants.F_OK);
			const actual = await realpath(current);
			if (actual !== current)
				throw new Error("Provider tools do not follow project symlinks");
			const rel = relative(root, actual);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
				throw new Error(
					"Provider tools cannot access paths outside the project",
				);
			return;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Provider tools"))
				throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

async function listProjectFiles(
	root: string,
	requestedPath: unknown,
	maxDepth: unknown,
) {
	const directory = toolPath(
		root,
		typeof requestedPath === "string" ? requestedPath : ".",
	);
	const rootReal = await realpath(root);
	await ensureNoWorkspaceSymlinks(rootReal, directory);
	const depthLimit =
		typeof maxDepth === "number"
			? Math.max(1, Math.min(5, Math.floor(maxDepth)))
			: 3;
	const files: string[] = [];
	async function walk(path: string, depth: number) {
		if (depth > depthLimit || files.length >= 250) return;
		const entries = await readdir(path, { withFileTypes: true });
		for (const entry of entries) {
			if (files.length >= 250) break;
			if (
				entry.isSymbolicLink() ||
				hiddenDirectories.has(entry.name) ||
				entry.name.startsWith(".")
			)
				continue;
			const child = resolve(path, entry.name);
			if (entry.isDirectory()) await walk(child, depth + 1);
			else if (entry.isFile())
				files.push(relative(rootReal, child).split(sep).join("/"));
		}
	}
	await walk(directory, 1);
	return files;
}

async function executeWorkspaceTool(
	name: string,
	args: Record<string, unknown>,
	root: string,
	permission: { mode: "auto" | "ask" | "read-only" } | undefined,
	authorizeTool: RuntimeToolAuthorization | undefined,
	abortSignal: AbortSignal,
) {
	if (name === "list_files")
		return JSON.stringify(
			await listProjectFiles(root, args.path, args.maxDepth),
		);
	if (name === "read_file") {
		const rootReal = await realpath(root);
		const path = toolPath(rootReal, args.path);
		await ensureNoWorkspaceSymlinks(rootReal, path);
		const info = await stat(path);
		if (!info.isFile()) throw new Error("The requested path is not a file");
		if (info.size > 256 * 1024)
			throw new Error("File exceeds the 256 KiB tool read limit");
		return await readFile(path, "utf8");
	}
	if (!["write_file", "edit_file", "run_command"].includes(name))
		throw new Error(`Unsupported provider tool: ${name}`);
	if (permission?.mode === "read-only")
		throw new Error("This run is read-only; Loom blocked the requested change");
	if (permission?.mode !== "auto") {
		const allowed = await authorizeTool?.({
			toolName: name,
			args,
			reason:
				name === "run_command"
					? "The provider wants to run a project command."
					: "The provider wants to change a project file.",
		});
		if (!allowed)
			throw new Error(
				"Loom denied this operation or no approval handler is available",
			);
	}
	if (name === "write_file") {
		if (typeof args.content !== "string")
			throw new Error("File content must be text");
		if (Buffer.byteLength(args.content, "utf8") > 512 * 1024)
			throw new Error("File exceeds the 512 KiB tool write limit");
		const rootReal = await realpath(root);
		const path = toolPath(rootReal, args.path);
		await ensureNoWorkspaceSymlinks(rootReal, dirname(path));
		await mkdir(dirname(path), { recursive: true });
		await ensureNoWorkspaceSymlinks(rootReal, path);
		let before = "";
		try {
			before = await readFile(path, "utf8");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
				throw error;
		}
		await writeFile(path, args.content, { encoding: "utf8", mode: 0o644 });
		const file = relative(rootReal, path).split(sep).join("/");
		return {
			output: `Wrote ${file}`,
			metadata: {
				filediff: { file, ...describeLineChanges(before, args.content) },
			},
		};
	}
	if (name === "edit_file") {
		if (typeof args.oldText !== "string" || typeof args.newText !== "string")
			throw new Error("oldText and newText must be strings");
		const rootReal = await realpath(root);
		const path = toolPath(rootReal, args.path);
		await ensureNoWorkspaceSymlinks(rootReal, path);
		const current = await readFile(path, "utf8");
		const first = current.indexOf(args.oldText);
		if (first < 0)
			throw new Error("The exact oldText was not found; reread the file first");
		if (current.indexOf(args.oldText, first + args.oldText.length) >= 0)
			throw new Error(
				"oldText matches more than once; provide a more specific excerpt",
			);
		const updated = `${current.slice(0, first)}${args.newText}${current.slice(first + args.oldText.length)}`;
		if (Buffer.byteLength(updated, "utf8") > 512 * 1024)
			throw new Error("File exceeds the 512 KiB tool write limit");
		await writeFile(path, updated, "utf8");
		const file = relative(rootReal, path).split(sep).join("/");
		return {
			output: `Updated ${file}`,
			metadata: {
				filediff: { file, ...describeLineChanges(current, updated) },
			},
		};
	}
	if (typeof args.command !== "string" || !args.command.trim())
		throw new Error("A shell command is required");
	return await new Promise<string>((resolveCommand, rejectCommand) => {
		const child =
			process.platform === "win32"
				? spawn("cmd.exe", ["/d", "/s", "/c", args.command as string], {
						cwd: root,
						windowsHide: true,
					})
				: spawn("/bin/sh", ["-lc", args.command as string], { cwd: root });
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
		const abort = () => child.kill("SIGTERM");
		if (abortSignal.aborted) abort();
		abortSignal.addEventListener("abort", abort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = `${stdout}${chunk}`.slice(-24_000);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk}`.slice(-12_000);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			abortSignal.removeEventListener("abort", abort);
			rejectCommand(error);
		});
		child.once("close", (code, childSignal) => {
			clearTimeout(timeout);
			abortSignal.removeEventListener("abort", abort);
			const output = `${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim();
			resolveCommand(
				`exit=${code ?? childSignal ?? "unknown"}\n${output || "(no output)"}`,
			);
		});
	});
}

/** Build the same file diff metadata consumed by CLI activities and chat previews. */
function describeLineChanges(before: string, after: string) {
	const lines = (value: string) => {
		const result = value.replace(/\r\n/g, "\n").split("\n");
		if (result.at(-1) === "") result.pop();
		return result;
	};
	const oldLines = lines(before);
	const newLines = lines(after);
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) prefix += 1;
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (
		oldEnd > prefix &&
		newEnd > prefix &&
		oldLines[oldEnd - 1] === newLines[newEnd - 1]
	) {
		oldEnd -= 1;
		newEnd -= 1;
	}
	const oldMiddle = oldLines.slice(prefix, oldEnd);
	const newMiddle = newLines.slice(prefix, newEnd);
	// Keep memory bounded for very large rewrites; prefix/suffix trimming above
	// still gives an accurate count for the common single-region edit case.
	const maxCells = 1_000_000;
	let unchanged = 0;
	let operations: string[] = [];
	if (oldMiddle.length * newMiddle.length <= maxCells) {
		const table = Array.from(
			{ length: oldMiddle.length + 1 },
			() => new Uint32Array(newMiddle.length + 1),
		);
		for (let i = oldMiddle.length - 1; i >= 0; i -= 1) {
			const row = table[i]!;
			const nextRow = table[i + 1]!;
			for (let j = newMiddle.length - 1; j >= 0; j -= 1) {
				row[j] =
					oldMiddle[i] === newMiddle[j]
						? nextRow[j + 1]! + 1
						: Math.max(nextRow[j]!, row[j + 1]!);
			}
		}
		unchanged = table[0]![0]!;
		let oldIndex = 0;
		let newIndex = 0;
		while (oldIndex < oldMiddle.length || newIndex < newMiddle.length) {
			if (
				oldIndex < oldMiddle.length &&
				newIndex < newMiddle.length &&
				oldMiddle[oldIndex] === newMiddle[newIndex]
			) {
				operations.push(` ${oldMiddle[oldIndex]}`);
				oldIndex += 1;
				newIndex += 1;
			} else if (
				oldIndex < oldMiddle.length &&
				(newIndex >= newMiddle.length ||
					table[oldIndex + 1]![newIndex]! >=
						table[oldIndex]![newIndex + 1]!)
			) {
				operations.push(`-${oldMiddle[oldIndex]}`);
				oldIndex += 1;
			} else {
				operations.push(`+${newMiddle[newIndex]}`);
				newIndex += 1;
			}
		}
	} else {
		operations = [
			...oldMiddle.map((line) => `-${line}`),
			...newMiddle.map((line) => `+${line}`),
		];
	}
	const additions = newMiddle.length - unchanged;
	const deletions = oldMiddle.length - unchanged;
	const oldStart = oldMiddle.length ? prefix + 1 : prefix;
	const newStart = newMiddle.length ? prefix + 1 : prefix;
	const header = `@@ -${oldStart},${oldMiddle.length} +${newStart},${newMiddle.length} @@`;
	let patch = additions || deletions ? `${header}\n${operations.join("\n")}` : "";
	if (Buffer.byteLength(patch, "utf8") > 120_000) {
		patch = `${patch.slice(0, 120_000)}\n[Diff preview truncated]`;
	}
	return {
		additions,
		deletions,
		...(patch ? { patch } : {}),
	};
}

export class CustomProviderAdapter implements CliProviderAdapter {
	readonly definition: ProviderDefinition;
	private readonly runs = new Map<
		string,
		{
			status: "queued" | "running" | "completed" | "failed" | "cancelled";
			cwd: string;
			readOnly: boolean;
			output: string;
			activities: RuntimeActivity[];
			parts: NonNullable<RuntimeOutput["parts"]>;
			tokens?: { total?: number; input?: number; output?: number };
			error?: string;
			controller?: AbortController;
		}
	>();

	constructor(readonly config: CustomProviderConfig) {
		this.definition = {
			id: config.id,
			name: config.name,
			executable: "OpenAI-compatible API",
			capabilities: [
				"chat",
				"coding",
				"streaming",
				"models",
				"sessions",
				"system-prompt",
				"custom-model",
			],
			install: { supported: false },
			authStrategy: "api-key",
		};
	}

	async detect(): Promise<ProviderDetectionResult> {
		try {
			await discoverCustomModels(this.config.baseUrl, this.config.apiKey);
			return { installed: true };
		} catch {
			return { installed: false };
		}
	}

	async getVersion(): Promise<string | null> {
		return null;
	}

	async getAuthStatus(): Promise<AuthStatus> {
		try {
			await discoverCustomModels(this.config.baseUrl, this.config.apiKey);
			return { authenticated: true, strategy: "api-key" };
		} catch (error) {
			return {
				authenticated: false,
				strategy: "api-key",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async authenticate(): Promise<AuthResult> {
		const status = await this.getAuthStatus();
		return { status, launched: false };
	}

	async disconnect(): Promise<void> {}

	async listModels(): Promise<AgentModel[]> {
		const connection = connectionId(this.definition.id);
		const models = await discoverCustomModels(
			this.config.baseUrl,
			this.config.apiKey,
		);
		return models.map((model) =>
			normalizeModel({
				providerId: this.definition.id,
				connectionId: connection,
				modelId: model.id,
				name: model.name,
				displayName: model.name,
				...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
				capabilities: ["text", "coding", "tools"],
				isAvailable: true,
				metadata: { modelId: model.id, providerName: this.definition.name },
			}),
		);
	}

	async createSession(input: CreateSessionInput): Promise<AgentSession> {
		const id = randomUUID();
		this.runs.set(id, {
			status: "queued",
			cwd: input.cwd,
			readOnly: input.readOnly === true,
			output: "",
			activities: [],
			parts: [],
		});
		return {
			id,
			providerId: this.definition.id,
			connectionId: connectionId(this.definition.id),
			providerSessionId: id,
			createdAt: new Date().toISOString(),
		};
	}

	async prompt(input: {
		sessionId: string;
		prompt: string;
		system?: string;
		model?: RuntimeModel;
		thinkingMode?: string;
		permission?: {
			mode: "auto" | "ask" | "read-only";
			env?: Record<string, string>;
		};
		authorizeTool?: RuntimeToolAuthorization;
		images?: Array<{ mime: string; data: string }>;
	}): Promise<void> {
		const run = this.runs.get(input.sessionId);
		if (!run) throw new Error("Custom provider session was not found");
		if (run.status === "running") throw new Error("Session is already running");
		const controller = new AbortController();
		run.controller = controller;
		run.status = "running";
		run.output = "";
		run.activities = [];
		run.parts = [];
		run.tokens = undefined;
		run.error = undefined;
		const timeout = setTimeout(
			() => controller.abort("Provider request timed out"),
			120_000,
		);
		void this.runPrompt(input, run, controller)
			.catch((error) => {
				run.error = controller.signal.aborted
					? "Provider request timed out or was cancelled"
					: error instanceof Error
						? error.message
						: String(error);
				run.status = controller.signal.aborted ? "cancelled" : "failed";
			})
			.finally(() => {
				clearTimeout(timeout);
				run.controller = undefined;
			});
	}

	private async runPrompt(
		input: {
			sessionId: string;
			prompt: string;
			system?: string;
			model?: RuntimeModel;
			thinkingMode?: string;
			permission?: {
				mode: "auto" | "ask" | "read-only";
				env?: Record<string, string>;
			};
			authorizeTool?: RuntimeToolAuthorization;
			images?: Array<{ mime: string; data: string }>;
		},
		run: NonNullable<ReturnType<typeof this.runs.get>>,
		controller: AbortController,
	) {
		const root = this.config.baseUrl.replace(/\/+$/, "");
		const endpoint = /\/v1$/i.test(root)
			? `${root}/chat/completions`
			: `${root}/v1/chat/completions`;
		const headers = new Headers({
			"content-type": "application/json",
			accept: "application/json",
		});
		if (this.config.apiKey.trim())
			headers.set("authorization", `Bearer ${this.config.apiKey.trim()}`);
		const userContent = input.images?.length
			? [
					{ type: "text", text: input.prompt },
					...input.images.map((image) => ({
						type: "image_url",
						image_url: { url: `data:${image.mime};base64,${image.data}` },
					})),
				]
			: input.prompt;
		const system = [
			input.system ?? "",
			"You can inspect this project's files with list_files and read_file. Use these tools instead of asking the user to paste project files. Make requested edits with write_file or edit_file, and run checks or project commands with run_command. Loom confines file tools to this project and asks before changing files or running commands unless the user enabled auto-accept.",
		]
			.filter(Boolean)
			.join("\n\n");
		const messages: Array<Record<string, unknown>> = [
			{ role: "system", content: system },
			{ role: "user", content: userContent },
		];
		const totals = { total: 0, input: 0, output: 0 };
		let hasUsage = false;
		for (let step = 0; step < 16; step += 1) {
			if (controller.signal.aborted)
				throw new Error("Provider request was cancelled");
			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				signal: controller.signal,
				body: JSON.stringify({
					model: input.model?.modelID ?? this.config.models[0]?.id,
					messages,
					tools: customRuntimeTools,
					tool_choice: "auto",
					stream: false,
				}),
			});
			if (!response.ok) {
				const detail = (await response.text())
					.replace(/\s+/g, " ")
					.slice(0, 400);
				throw new Error(
					`Provider request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
				);
			}
			const payload = (await response.json()) as {
				choices?: Array<{
					message?: {
						content?: unknown;
						tool_calls?: Array<{
							id?: string;
							type?: string;
							function?: { name?: string; arguments?: string };
						}>;
					};
				}>;
				usage?: {
					total_tokens?: number;
					prompt_tokens?: number;
					completion_tokens?: number;
				};
			};
			if (payload.usage) {
				hasUsage = true;
				totals.total += payload.usage.total_tokens ?? 0;
				totals.input += payload.usage.prompt_tokens ?? 0;
				totals.output += payload.usage.completion_tokens ?? 0;
				run.tokens = { ...totals };
			}
			const message = payload.choices?.[0]?.message;
			if (!message)
				throw new Error("Provider returned an invalid chat completion");
			const text =
				typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content
								.flatMap((part) =>
									part &&
									typeof part === "object" &&
									"text" in part &&
									typeof part.text === "string"
										? [part.text]
										: [],
								)
								.join("")
						: "";
			if (text.trim()) {
				run.output = `${run.output}${run.output ? "\n\n" : ""}${text}`;
				run.parts.push({ type: "text", id: randomUUID(), text });
			}
			const calls = message.tool_calls ?? [];
			if (!calls.length) {
				if (!run.output.trim())
					throw new Error("Provider returned no text response");
				run.status = "completed";
				if (!hasUsage) run.tokens = undefined;
				return;
			}
			const normalizedCalls = calls.map((call) => ({
				...call,
				id: call.id || `call_${randomUUID().replaceAll("-", "")}`,
			}));
			messages.push({
				role: "assistant",
				content: message.content ?? null,
				tool_calls: normalizedCalls,
			});
			for (const call of normalizedCalls) {
				const name = call.function?.name ?? "unknown";
				let args: Record<string, unknown> = {};
				try {
					const parsed: unknown = JSON.parse(call.function?.arguments ?? "{}");
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
						args = parsed as Record<string, unknown>;
				} catch {
					messages.push({
						role: "tool",
						tool_call_id: call.id,
						content: "Invalid JSON tool arguments",
					});
					continue;
				}
				const activity: RuntimeActivity = {
					id: call.id || randomUUID(),
					tool: name,
					status: "running",
					input: args,
				};
				run.activities.push(activity);
				run.parts.push({ type: "activity", id: activity.id });
				let result: string;
				try {
					const toolResult = await executeWorkspaceTool(
						name,
						args,
						run.cwd,
						input.permission ??
							(run.readOnly ? { mode: "read-only" } : undefined),
						input.authorizeTool
							? (request) =>
									input.authorizeTool?.({
										...request,
										sessionId: input.sessionId,
										cwd: run.cwd,
									}) ?? Promise.resolve(false)
							: undefined,
						controller.signal,
					);
					if (typeof toolResult === "string") {
						result = toolResult;
					} else {
						result = toolResult.output;
						activity.metadata = toolResult.metadata;
					}
					activity.status = "completed";
					activity.output = result.slice(-12_000);
				} catch (error) {
					activity.status = "error";
					activity.error =
						error instanceof Error ? error.message : String(error);
					result = `ERROR: ${activity.error}`;
				}
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: result.slice(-12_000),
				});
			}
		}
		throw new Error("Provider tool loop exceeded the 16-step limit");
	}

	async status(sessionId: string): Promise<AgentRunStatus> {
		return this.runs.get(sessionId)?.status ?? "failed";
	}

	async lastError(sessionId: string) {
		return this.runs.get(sessionId)?.error ?? null;
	}

	async readOutput(sessionId: string): Promise<RuntimeOutput | null> {
		const run = this.runs.get(sessionId);
		return run
			? {
					output: run.output,
					activities: run.activities,
					parts: run.parts,
					...(run.tokens ? { tokens: run.tokens } : {}),
				}
			: null;
	}

	async wait(
		sessionId: string,
		options: {
			timeoutMs?: number;
			pollIntervalMs?: number;
			onStatus?: (status: AgentRunStatus) => void | Promise<void>;
		} = {},
	): Promise<
		Exclude<AgentRunStatus, "queued" | "running" | "waiting_permission">
	> {
		const deadline = Date.now() + (options.timeoutMs ?? 120_000);
		while (Date.now() < deadline) {
			const status = await this.status(sessionId);
			await options.onStatus?.(status);
			if (
				status === "completed" ||
				status === "failed" ||
				status === "cancelled"
			)
				return status;
			await new Promise((resolve) =>
				setTimeout(resolve, options.pollIntervalMs ?? 100),
			);
		}
		return "interrupted";
	}

	async abort(sessionId: string): Promise<void> {
		const run = this.runs.get(sessionId);
		if (!run) return;
		run.status = "cancelled";
		run.controller?.abort();
	}

	async deleteSession(sessionId: string): Promise<void> {
		this.runs.get(sessionId)?.controller?.abort();
		this.runs.delete(sessionId);
	}

	async getDiff(): Promise<unknown> {
		return [];
	}

	async *sendMessage(input: SendMessageInput): AsyncIterable<AgentEvent> {
		yield { type: "session.started", providerSessionId: input.sessionId };
		try {
			await this.prompt({
				sessionId: input.sessionId,
				prompt: input.message,
				model: { providerID: this.definition.id, modelID: input.model.modelId },
			});
			yield { type: "session.completed" };
		} catch (error) {
			yield {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async cancelSession(sessionId: string): Promise<void> {
		await this.abort(sessionId);
	}

	getRuntime(): AgentRuntime {
		return this;
	}
}
