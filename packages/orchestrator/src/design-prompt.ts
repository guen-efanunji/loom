import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectContext } from "@loom/automation";
import { type DesignQuestion, designQuestionSchema } from "@loom/protocol";

function promptFile(name: string): string {
	const paths = [
		join(process.cwd(), "prompts", "design", name),
		resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../../prompts/design",
			name,
		),
	];
	for (const path of paths) {
		try {
			return readFileSync(path, "utf8").trim();
		} catch {}
	}
	throw new Error(`Prompt file is missing: ${name}`);
}

const DESIGN_SYSTEM_PROMPT = promptFile("system.md");
const DESIGN_CRAFT_PROMPT = promptFile("craft.md");
const DESIGN_REFINE_PROMPT = promptFile("refine.md");
const DESIGN_CLASSIFY_PROMPT = promptFile("classify.md");

export const DESIGN_OUTPUT_RULES = DESIGN_CRAFT_PROMPT;

export function deriveDesignTitle(brief: string): string {
	const firstLine = brief
		.split("\n")
		.map((line) => line.replace(/^#+\s*/, "").trim())
		.find(Boolean);
	if (!firstLine) return "Untitled design";
	const cleaned = firstLine
		.replace(/^(buatkan|buat|design|build|create|make)\s+/i, "")
		.trim();
	const title = cleaned || firstLine;
	return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}

function canvasOf(viewport: "desktop" | "mobile"): string {
	return viewport === "mobile" ? "390x844" : "1440x900";
}

export function buildDesignPrompt(input: {
	brief: string;
	viewport: "desktop" | "mobile";
	context?: ProjectContext;
}): string {
	const canvas = canvasOf(input.viewport);
	const lines = [
		input.brief.trim(),
		"",
		DESIGN_SYSTEM_PROMPT,
		"",
		`Return a single complete, self-contained HTML document for a ${input.viewport} screen (${canvas}). Put all CSS in one <style> block, use no external resources, and do not create or edit any files.`,
		"Do not call tools, run shell commands, read or write files, or inspect the project. Loom already supplied the relevant project context and references; produce the visual design directly from those inputs and return the HTML document.",
		DESIGN_CRAFT_PROMPT,
	];
	if (input.context?.theme)
		lines.push("", "Match these existing theme tokens:", input.context.theme);
	return lines.join("\n");
}

export function buildRefinePrompt(input: {
	brief: string;
	message: string;
	viewport: "desktop" | "mobile";
	previousHtml: string;
}): string {
	const canvas = canvasOf(input.viewport);
	return [
		DESIGN_REFINE_PROMPT,
		"",
		"Original brief:",
		input.brief.trim(),
		"",
		"Change request:",
		input.message.trim(),
		"",
		`Primary viewport stays ${input.viewport} (${canvas}); keep the revised document responsive from 390px to 1440px wide.`,
		"",
		"Current design:",
		input.previousHtml.trim(),
		"",
		"Do not call tools, run shell commands, read or write files, or inspect the project. Revise the supplied HTML directly and return the complete document.",
		DESIGN_CRAFT_PROMPT,
	].join("\n");
}

const FILE_TREE_LIMIT = 160;

export function buildDesignAssistantPrompt(input: {
	context?: ProjectContext;
	projectName?: string;
	projectPath?: string;
}): string {
	const context = input.context;
	const name = input.projectName ?? context?.projectName;
	const path = input.projectPath ?? context?.projectPath;
	const identity: string[] = [];
	if (name) identity.push(`Project name: ${name}`);
	if (path) identity.push(`Project folder: ${path}`);
	if (context?.stack.length)
		identity.push(`Stack: ${context.stack.join(", ")}`);
	if (context?.packageManager)
		identity.push(`Package manager: ${context.packageManager}`);
	if (context?.currentBranch)
		identity.push(`Current branch: ${context.currentBranch}`);
	const tree = context?.files ?? [];
	if (tree.length) {
		const shown = tree.slice(0, FILE_TREE_LIMIT);
		identity.push(
			"",
			"Project files (paths relative to the folder) - use this to answer what the project contains:",
			...shown.map((file) => `- ${file}`),
		);
		if (tree.length > shown.length)
			identity.push(`- ...and ${tree.length - shown.length} more files`);
	}
	if (context?.theme)
		identity.push(
			"",
			"Project theme tokens - reuse these EXACT colors, fonts, radius and dark/light values so designs match the real product:",
			context.theme,
		);

	const lines = [
		DESIGN_SYSTEM_PROMPT,
		"",
		`You are a UI/UX design agent helping the user design screens for their project${name ? ` "${name}"` : ""}${path ? ` at ${path}` : ""}. Every design you produce appears as a card on the canvas to the right.`,
		"",
		`IMPORTANT: the project you are working on is${name ? ` named "${name}"` : " the user's own project"} - it is NOT "Loom". Loom is only the tool hosting this chat. Always refer to the project by its real name and folder. You run inside an isolated scratch directory, so your shell cannot list the project directly - rely on the Project files listing below and any file the user @mentions.`,
		"",
		"Read the user's latest message and pick exactly ONE response mode:",
		"1. CHAT - a greeting, question or anything that is not a request to create or change a screen: reply in short plain text (max ~3 sentences). Never output HTML for these.",
		"2. CLARIFY - they clearly want a UI but the request is too vague to start (missing which screen, the theme, or the style). Do NOT generate. Reply with one short friendly line, then a fenced block exactly like the example below asking at most 3 questions. Only use this when genuinely blocked.",
		"```loom-questions",
		'{ "id": "q1", "questions": [ { "header": "Screen", "question": "Which screen should I design?", "multiple": false, "options": [ { "label": "Landing page", "description": "Marketing homepage" }, { "label": "Dashboard", "description": "App home with stats" } ] } ] }',
		"```",
		"3. DESIGN - a clear request to build or change a screen: you may open with a short plain-text design note, then output one or more complete, self-contained HTML documents following the Craft requirements below.",
		"",
		"Theme fidelity: when Project theme tokens are provided, style designs with those exact tokens - never invent a new palette, font or radius.",
	];
	if (identity.length) lines.push("", "Project context:", ...identity);
	lines.push(
		"",
		"Craft requirements (apply only to DESIGN replies):",
		DESIGN_CRAFT_PROMPT,
	);
	return lines.join("\n");
}

export function buildIntentClassifierPrompt(
	message: string,
	opts: { hasSelectedNode: boolean },
): string {
	return [
		DESIGN_CLASSIFY_PROMPT,
		"Decide what the user's message below asks for right now.",
		opts.hasSelectedNode
			? "A design is already selected on the canvas, so a request to change or adjust it counts as DESIGN."
			: "No design is selected yet, so only a request to create a new design counts as DESIGN.",
		"Reply with exactly one word, DESIGN or CHAT. No punctuation, no explanation.",
		"",
		"User message:",
		'"""',
		message.trim(),
		'"""',
	].join("\n");
}

const DESIGN_INTENT_PATTERN =
	/\b(buatkan|buat|design|re-?design|build|make|create|generate|ubah|ganti|halaman|screen|landing|dashboard|mockup|wireframe|ui\/ux|uiux|\bui\b|\bux\b|component|komponen|form|login|signup|tampilan|layout)\b/i;

/** Cheap fallback when the model's intent answer is unusable. */
export function looksLikeDesignRequest(text: string): boolean {
	return DESIGN_INTENT_PATTERN.test(text);
}

const EXPLICIT_NEW_DESIGN_PATTERN =
	/\b(buatkan|rancang|desainkan|design|redesign|re-design|create|generate|build|draw|gambarkan|buat)\b/i;
const DESIGN_SCREEN_PATTERN =
	/\b(halaman|page|screen|layar|landing|dashboard|mockup|wireframe|ui\s*\/?\s*ux|uiux|tampilan|layout|form|login|register|signup|checkout|komponen|component)\b/i;

/** Avoid a slow model-based intent pass when the user clearly asks for a new screen. */
export function isExplicitNewDesignRequest(text: string): boolean {
	return (
		EXPLICIT_NEW_DESIGN_PATTERN.test(text) && DESIGN_SCREEN_PATTERN.test(text)
	);
}

/**
 * Detects a request that should apply to every canvas at once ("pada keduanya",
 * "ubah warna di semua canvas", "both", "all of them", "masing-masing"). Used to
 * fan a single refine out to all ready nodes instead of only the selected one.
 */
const ALL_NODES_PATTERN =
	/\b(keduanya|kedua|ketiganya|ketiga|keempatnya|keempat|kelimanya|kelima|keenam|ketujuh|kelima\b|semuanya|semua|seluruhnya|seluruh|masing-masing|tiap|se-?kanvas|both|all|every|each|entire|across)\b|\bke[- ]?\d+\b|\b\d+\s*(canvas|kanvas|layar|halaman|design|desain|screenshot)\b/i;

export function wantsAllNodes(text: string): boolean {
	return ALL_NODES_PATTERN.test(text);
}

/** Pulls the `loom-questions` block out of a reply, if the agent asked any. */
export function parseDesignQuestions(reply: string): DesignQuestion | null {
	const match = /```loom-questions\s*\n([\s\S]*?)```/i.exec(reply);
	if (!match) return null;
	try {
		const parsed = JSON.parse((match[1] ?? "").trim());
		const result = designQuestionSchema.safeParse(parsed);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

/** True when a reply carries a real design document (marker or full doc). */
export function hasDesignDoc(reply: string): boolean {
	return (
		SCREEN_MARKER.test(reply) || /<!doctype html[\s\S]*<\/html>/i.test(reply)
	);
}

/**
 * The plain-text chat line for a conversational reply: drop any question block
 * and stray HTML documents so raw code never reaches the chat panel.
 */
export function chatReplyText(reply: string): string {
	return reply
		.replace(/```loom-questions[\s\S]*?```/gi, " ")
		.replace(/<!--\s*design\s*:[^\n]*?-->/gi, " ")
		.replace(/<!doctype html[\s\S]*?<\/html>/gi, " ")
		.replace(/<html[\s\S]*?<\/html>/gi, " ")
		.trim();
}

const FRAGMENT_PATTERN =
	/<(div|section|main|article|header|nav|form|h1|ul|table|style)\b/i;
const SCREEN_MARKER = /<!--\s*design\s*:([^\n]*?)-->/gi;

export class DesignOutputError extends Error {}

/**
 * Pulls a single HTML document out of an agent reply. Agents wrap documents in
 * fences, prefix them with commentary, or occasionally return a bare fragment.
 */
export function extractDesignHtml(raw: string): string {
	const text = raw.trim();
	if (!text) throw new DesignOutputError("Design agent returned no output");
	const fenced = [...text.matchAll(/```(?:html)?\s*\n([\s\S]*?)```/gi)].map(
		(match) => match[1] ?? "",
	);
	for (const candidate of [text, ...fenced]) {
		const start = candidate.search(/<!doctype html|<html[\s>]/i);
		if (start === -1) continue;
		const end = candidate.toLowerCase().lastIndexOf("</html>");
		const document =
			end === -1
				? candidate.slice(start)
				: candidate.slice(start, end + "</html>".length);
		if (document.trim().length > 40) return document.trim();
	}
	if (FRAGMENT_PATTERN.test(text)) {
		const body = text
			.replace(/^```(?:html)?\s*/i, "")
			.replace(/\s*```$/, "")
			.trim();
		return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n</head>\n<body>\n${body}\n</body>\n</html>`;
	}
	throw new DesignOutputError(
		"Design agent did not return an HTML document. Try a more specific brief.",
	);
}

export type DesignScreen = { title: string; html: string };

/**
 * Splits an agent reply into one or more screens. Each `<!-- design: TITLE -->`
 * marker names the following document; a reply without markers is treated as a
 * single screen with an empty title so the caller keeps its provisional name.
 */
export function extractDesignScreens(raw: string): DesignScreen[] {
	const text = raw.trim();
	if (!text) throw new DesignOutputError("Design agent returned no output");
	const marks = [...text.matchAll(SCREEN_MARKER)];
	if (marks.length) {
		const screens: DesignScreen[] = [];
		for (let index = 0; index < marks.length; index += 1) {
			const mark = marks[index];
			if (!mark) continue;
			const title = (mark[1] ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
			const from = (mark.index ?? 0) + mark[0].length;
			const next = marks[index + 1];
			const to = next?.index ?? text.length;
			let html = "";
			try {
				html = extractDesignHtml(text.slice(from, to));
			} catch {
				continue;
			}
			screens.push({ title, html });
		}
		if (screens.length) return screens;
	}
	return [{ title: "", html: extractDesignHtml(text) }];
}

/**
 * Turns the raw agent reply into a short chat line: keep any real commentary
 * the model wrote, otherwise summarise the screens it produced. The HTML itself
 * never belongs in the conversation panel.
 */
export function designChatSummary(
	reply: string,
	screens: DesignScreen[],
): string {
	const commentary = reply
		.replace(/<!--\s*design\s*:[^\n]*?-->/gi, " ")
		.replace(/<!doctype html[\s\S]*?<\/html>/gi, " ")
		.replace(/<html[\s\S]*?<\/html>/gi, " ")
		.trim();
	if (commentary.length >= 12) return commentary.slice(0, 4000);
	const names = screens.map((screen) => screen.title).filter(Boolean);
	if (names.length > 1)
		return `Generated ${names.length} designs: ${names.join(", ")}.`;
	if (names.length === 1) return `${names[0]} is ready on the canvas.`;
	return "Design is ready on the canvas.";
}
