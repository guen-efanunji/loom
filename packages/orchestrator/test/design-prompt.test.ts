import { describe, expect, test } from "bun:test";
import {
	buildDesignAssistantPrompt,
	buildDesignPrompt,
	buildIntentClassifierPrompt,
	buildRefinePrompt,
	chatReplyText,
	DesignOutputError,
	deriveDesignTitle,
	extractDesignHtml,
	hasDesignDoc,
	looksLikeDesignRequest,
	parseDesignQuestions,
	wantsAllNodes,
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

	test("generation prompt stays lean and pins the HTML contract", () => {
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
		// The brief leads and only the minimal canvas contract is appended.
		expect(prompt.startsWith("Dashboard logistik")).toBe(true);
		expect(prompt).toContain("390x844");
		expect(prompt).toContain("self-contained HTML document");
		expect(prompt).toContain("do not create or edit any files");
		// No heavy context/lecture is injected anymore.
		expect(prompt).not.toContain("Stack: Svelte");
		expect(prompt).not.toContain("Use tabs.");
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

describe("design agent chat helpers", () => {
	test("intent classifier asks for a single word and echoes the message", () => {
		const prompt = buildIntentClassifierPrompt("buatkan landing page", {
			hasSelectedNode: false,
		});
		expect(prompt).toContain("DESIGN or CHAT");
		expect(prompt).toContain("buatkan landing page");
		expect(prompt).toContain("No design is selected");
		expect(
			buildIntentClassifierPrompt("x", { hasSelectedNode: true }),
		).toContain("already selected");
	});

	test("heuristic flags build requests but not greetings", () => {
		expect(looksLikeDesignRequest("buatkan halaman login")).toBe(true);
		expect(looksLikeDesignRequest("design a dashboard")).toBe(true);
		expect(looksLikeDesignRequest("halo")).toBe(false);
		expect(looksLikeDesignRequest("apa itu svelte?")).toBe(false);
	});

	test("parses a loom-questions block into a questionnaire", () => {
		const reply =
			'Tentu, beberapa hal:\n```loom-questions\n{"id":"q1","questions":[{"header":"Theme","question":"Terang atau gelap?","options":[{"label":"Terang","description":"light"},{"label":"Gelap","description":"dark"}]}]}\n```';
		const parsed = parseDesignQuestions(reply);
		expect(parsed?.questions[0]?.header).toBe("Theme");
		expect(parsed?.questions[0]?.options.length).toBe(2);
	});

	test("returns null when there is no valid question block", () => {
		expect(parseDesignQuestions("just chatting")).toBeNull();
		expect(parseDesignQuestions("```loom-questions\nnot json\n```")).toBeNull();
	});

	test("chat text strips question blocks and stray html", () => {
		const text = chatReplyText(
			`Halo \`\`\`loom-questions\n{"id":"q","questions":[]}\n\`\`\` ${DOCUMENT}`,
		);
		expect(text).toBe("Halo");
	});

	test("hasDesignDoc detects a marked design", () => {
		expect(hasDesignDoc(`<!-- design: Login -->\n${DOCUMENT}`)).toBe(true);
		expect(hasDesignDoc("no design here")).toBe(false);
	});

	test("wantsAllNodes flags whole-set change requests only", () => {
		expect(wantsAllNodes("pada keduanya bisa tambahkan animasi ga?")).toBe(true);
		expect(wantsAllNodes("ubah warna di semua canvas")).toBe(true);
		expect(wantsAllNodes("make both pages darker")).toBe(true);
		expect(wantsAllNodes("apply this to all 5 designs")).toBe(true);
		expect(wantsAllNodes("ganti warna tombol login saja")).toBe(false);
		expect(wantsAllNodes("buatkan landing page")).toBe(false);
	});

	test("assistant prompt offers chat, clarify and design modes", () => {
		const prompt = buildDesignAssistantPrompt({
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
		expect(prompt).toContain("UI/UX design agent");
		expect(prompt).toContain("loom-questions");
		expect(prompt).toContain("Stack: Svelte");
	});

	test("assistant prompt grounds the agent in the real project, not Loom", () => {
		const prompt = buildDesignAssistantPrompt({
			context: {
				projectName: "test",
				projectPath: "/PROJECT/test",
				stack: ["node"],
				files: ["package.json", "src/main.ts"],
				scripts: {},
			},
			projectName: "test",
			projectPath: "/PROJECT/test",
		});
		expect(prompt).toContain('named "test"');
		expect(prompt).toContain("/PROJECT/test");
		expect(prompt).toContain("- src/main.ts");
		expect(prompt).toContain('it is NOT "Loom"');
	});
});
