import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadPromptFile,
	loadPromptText,
	promptCandidates,
	promptsDirectory,
} from "../src/index";

// A single-file executable has no repository next to it, so prompt resolution is
// what keeps the daemon alive. Disk precedence and the error path live here.
function restore(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test("an editable prompt on disk wins over the bundled copy", async () => {
	const home = await mkdtemp(join(tmpdir(), "loom-prompts-"));
	const previousHome = process.env.LOOM_HOME;
	process.env.LOOM_HOME = home;
	try {
		const directory = promptsDirectory();
		await mkdir(join(directory, "design"), { recursive: true });
		await writeFile(join(directory, "design", "system.md"), "from disk");
		expect(join(directory, "design", "system.md")).toBe(
			join(home, "prompts", "design", "system.md"),
		);
		expect(loadPromptText("design/system.md", [])).toBe("from disk");
		expect(loadPromptFile("design/system.md", [])).toBe(
			join(directory, "design", "system.md"),
		);
	} finally {
		restore("LOOM_HOME", previousHome);
		await rm(home, { recursive: true, force: true });
	}
});

test("LOOM_PROMPTS_DIR is searched first and a missing prompt explains itself", () => {
	const previous = process.env.LOOM_PROMPTS_DIR;
	process.env.LOOM_PROMPTS_DIR = "/custom/prompts";
	try {
		expect(promptCandidates("coding.md")[0]).toBe(
			join("/custom/prompts", "coding.md"),
		);
		expect(() => loadPromptText("definitely-missing.md", [])).toThrow(
			/LOOM_PROMPTS_DIR/,
		);
		expect(() => loadPromptFile("definitely-missing.md", [])).toThrow(
			/definitely-missing\.md/,
		);
	} finally {
		restore("LOOM_PROMPTS_DIR", previous);
	}
});
