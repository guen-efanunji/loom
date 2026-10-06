import type { ProjectContext } from "@loom/automation";

const OUTPUT_RULES = [
	"You may open with a SHORT plain-text design note (max 2 sentences) that tells the user which theme and key components you matched - this note is shown in the chat panel. Never paste HTML into the note.",
	"After the note, reply with one or more complete, self-contained HTML documents.",
	'Put a title marker on its own line immediately before EACH document: <!-- design: SHORT_TITLE -->. SHORT_TITLE names the artifact in 2-5 words (for example "Login page", "Footer", "Onboarding 01") - never the user\'s whole request.',
	"If the brief asks for one screen, return exactly one marked document. If it asks for several screens or pages, return one marked document per screen, numbered in order (Onboarding 01, Onboarding 02, ...).",
	"Each document must start with <!DOCTYPE html> and end with </html>.",
	"Put every style inside a single <style> block in the <head>.",
	"Make every document fully responsive so it looks correct and unbroken from 390px to 1440px wide: use fluid layouts, relative units, flex/grid that wraps, and media queries for narrow screens. Never overflow horizontally - avoid fixed widths larger than the viewport, cap images and media with max-width:100%, and set body{overflow-x:hidden}.",
	"Do not load external resources: no CDN, remote fonts, remote images, no network calls. Use the system font stack, inline SVG and CSS gradients for imagery.",
	"Keep each document under roughly 600 lines.",
].join("\n");

export const DESIGN_OUTPUT_RULES = OUTPUT_RULES;

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

function contextLines(context?: ProjectContext): string[] {
	if (!context) return [];
	const lines: string[] = [];
	if (context.stack.length) lines.push(`Stack: ${context.stack.join(", ")}`);
	if (context.packageManager)
		lines.push(`Package manager: ${context.packageManager}`);
	if (context.currentBranch)
		lines.push(`Current branch: ${context.currentBranch}`);
	if (context.conventions)
		lines.push("", "Project conventions:", context.conventions);
	if (context.theme)
		lines.push(
			"",
			"Project theme tokens - reuse these EXACT colors, fonts, radius and dark/light values so the mockup matches the real product:",
			context.theme,
		);
	return lines;
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
		"You are a senior product designer and front-end engineer. Design the screen (or the set of screens) the brief below asks for.",
		"",
		`Primary viewport: ${input.viewport} (${canvas}). The design is shown in a fixed ${canvas} frame, but it must also stay fully responsive and unbroken from 390px to 1440px wide.`,
		"",
		"Brief:",
		input.brief.trim(),
	];
	const context = contextLines(input.context);
	if (context.length) lines.push("", "Project context:", ...context);
	lines.push(
		"",
		"Theme fidelity: when Project theme tokens are provided above, style the design with those exact tokens - do not invent a new palette, font or radius. Only fall back to your own taste when no tokens are given.",
		"Craft requirements:",
		OUTPUT_RULES,
	);
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
		"You are revising an existing UI design. Keep everything that still works and change only what the request below asks for.",
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
		OUTPUT_RULES,
	].join("\n");
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
			const title = (mark[1] ?? "")
				.trim()
				.replace(/^["'`]+|["'`]+$/g, "");
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
