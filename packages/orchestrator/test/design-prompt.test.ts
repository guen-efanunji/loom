import { describe, expect, test } from "bun:test";
import {
	buildDesignPrompt,
	buildRefinePrompt,
	DesignOutputError,
	deriveDesignTitle,
	extractDesignHtml,
} from "../src/design-prompt";

const DOCUMENT =
	'<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Demo</title></head>\n<body><h1>Demo</h1></body>\n</html>';

describe("design prompts", () => {
	test("titles come from the brief, not the command verb", () => {
		expect(deriveDesignTitle("Buatkan landing page kedai kopi")).toBe(
			"landing page kedai kopi",
		);
		expect(deriveDesignTitle("# Design a checkout flow")).toBe(
			"a checkout flow",
		);
		expect(deriveDesignTitle("   ")).toBe("Untitled design");
		expect(deriveDesignTitle("x".repeat(120))).toBe(`${"x".repeat(57)}…`);
	});

	test("generation prompt pins the viewport and the output contract", () => {
		const prompt = buildDesignPrompt({
			brief: "Dashboard logistik",
			viewport: "mobile",
			context: {
				projectName: "demo",
				stack: ["Svelte"],
				packageManager: "bun",
				files: ["package.json"],
				scripts: { dev: "vite" },
				conventions: "Use tabs.",
				currentBranch: "main",
			},
		});
		expect(prompt).toContain("390x844");
		expect(prompt).toContain("Dashboard logistik");
		expect(prompt).toContain("Stack: Svelte");
		expect(prompt).toContain("Use tabs.");
		expect(prompt).toContain(
			"Reply with ONE complete, self-contained HTML document",
		);
		expect(prompt).toContain("no CDN");
	});

	test("refine prompt carries the previous document and the change request", () => {
		const prompt = buildRefinePrompt({
			brief: "Dashboard logistik",
			message: "Tambahkan grafik pengiriman",
			viewport: "desktop",
			previousHtml: DOCUMENT,
		});
		expect(prompt).toContain("Tambahkan grafik pengiriman");
		expect(prompt).toContain("Dashboard logistik");
		expect(prompt).toContain("<!DOCTYPE html>");
		expect(prompt).toContain("1440x900");
	});
});

describe("extractDesignHtml", () => {
	test("accepts a clean document", () => {
		expect(extractDesignHtml(DOCUMENT)).toBe(DOCUMENT);
	});

	test("unwraps fences and surrounding commentary", () => {
		const raw = `Berikut desainnya:\n\n\`\`\`html\n${DOCUMENT}\n\`\`\`\n\nSemoga membantu.`;
		expect(extractDesignHtml(raw)).toBe(DOCUMENT);
	});

	test("trims trailing prose after the closing tag", () => {
		expect(extractDesignHtml(`${DOCUMENT}\n\nDocument finished.`)).toBe(
			DOCUMENT,
		);
	});

	test("wraps a bare fragment in a document", () => {
		const html = extractDesignHtml('<main class="hero"><h1>Halo</h1></main>');
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain('<main class="hero"><h1>Halo</h1></main>');
	});

	test("rejects output with no design in it", () => {
		expect(() => extractDesignHtml("")).toThrow(DesignOutputError);
		expect(() => extractDesignHtml("I cannot design that.")).toThrow(
			DesignOutputError,
		);
	});
});
