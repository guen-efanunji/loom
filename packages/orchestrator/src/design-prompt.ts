import type { ProjectContext } from "@loom/automation";

const OUTPUT_RULES = `Reply with ONE complete, self-contained HTML document and nothing else.
- The response must start with <!DOCTYPE html> and end with </html>.
- No markdown fences, no commentary, no explanation before or after the document.
- Put every style inside a single <style> block in the <head>.
- Do not load external resources: no CDN, no remote fonts, no remote images, no network calls. Use the system font stack, inline SVG and CSS gradients for imagery.
- Keep the document under roughly 600 lines.`;

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
		"You are a senior product designer and front-end engineer. Design one screen (or a tightly related set of screens) for the brief below.",
		"",
		`Target viewport: ${input.viewport} (${canvas}). The design is rendered in a fixed ${canvas} frame, so it must look complete at that size.`,
		"",
		"Brief:",
		input.brief.trim(),
	];
	const context = contextLines(input.context);
	if (context.length) lines.push("", "Project context:", ...context);
	lines.push("", "Craft requirements:", OUTPUT_RULES);
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
		`Target viewport stays ${input.viewport} (${canvas}); the revised design is rendered in the same fixed ${canvas} frame.`,
		"",
		"Current design:",
		input.previousHtml.trim(),
		"",
		OUTPUT_RULES,
	].join("\n");
}

const FRAGMENT_PATTERN =
	/<(div|section|main|article|header|nav|form|h1|ul|table|style)\b/i;

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
