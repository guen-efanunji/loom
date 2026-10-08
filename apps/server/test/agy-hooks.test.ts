import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgyPermissionHook } from "../src/agy-hooks";

const cliEntry = join(import.meta.dir, "../../cli/src/index.ts");

async function tempHome() {
	return mkdtemp(join(tmpdir(), "loom-agy-hooks-"));
}

async function seedSettings(home: string, contents: unknown) {
	const directory = join(home, ".gemini", "antigravity-cli");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "settings.json"),
		typeof contents === "string" ? contents : JSON.stringify(contents),
		"utf8",
	);
}

describe("agy hook registration", () => {
	test("uses the source CLI when the installed launcher is absent", async () => {
		const home = await tempHome();
		const result = await registerAgyPermissionHook({ home, env: {} });
		expect(result.command).toContain("apps/cli/src/index.ts");
		expect(result.reason).toBeUndefined();
	});

	test("creates settings.json with the PreToolUse loom hook", async () => {
		const home = await tempHome();
		const result = await registerAgyPermissionHook({
			home,
			env: { LOOM_CLI_ENTRY: cliEntry },
		});
		expect(result.changed).toBe(true);
		const settings = JSON.parse(
			await readFile(
				join(home, ".gemini", "antigravity-cli", "settings.json"),
				"utf8",
			),
		) as {
			hooks: {
				loom: {
					PreToolUse: Array<{
						matcher: string;
						hooks: Array<{ type: string; command: string; timeout: number }>;
					}>;
				};
			};
		};
		const matcher = settings.hooks.loom.PreToolUse[0];
		expect(matcher?.matcher).toContain("run_command");
		expect(matcher?.hooks[0]?.type).toBe("command");
		expect(matcher?.hooks[0]?.command).toContain("agy-hook");
		expect(matcher?.hooks[0]?.timeout).toBe(1800);
	});

	test("is idempotent and preserves unrelated settings keys", async () => {
		const home = await tempHome();
		const path = join(home, ".gemini", "antigravity-cli", "settings.json");
		await seedSettings(home, {
			theme: "dark",
			permissions: { allow: ["read_file"] },
		});
		const env = { LOOM_CLI_ENTRY: cliEntry };
		const first = await registerAgyPermissionHook({ home, env });
		expect(first.changed).toBe(true);
		const second = await registerAgyPermissionHook({ home, env });
		expect(second.changed).toBe(false);

		const settings = JSON.parse(await readFile(path, "utf8")) as Record<
			string,
			unknown
		>;
		expect(settings.theme).toBe("dark");
		expect(settings.permissions).toEqual({ allow: ["read_file"] });
		// Only one loom matcher accumulates across repeated registrations.
		const loom = (settings.hooks as Record<string, { PreToolUse: unknown[] }>)
			.loom;
		expect(loom?.PreToolUse).toHaveLength(1);
	});

	test("replaces an obsolete Loom hook command", async () => {
		const home = await tempHome();
		await seedSettings(home, {
			hooks: {
				loom: {
					PreToolUse: [{ matcher: "run_command", hooks: [{ command: '"/missing/loom" agy-hook' }] }],
				},
			},
		});
		const result = await registerAgyPermissionHook({ home, env: { LOOM_CLI_ENTRY: cliEntry } });
		expect(result.changed).toBe(true);
		const settings = JSON.parse(await readFile(result.settingsPath, "utf8"));
		expect(settings.hooks.loom.PreToolUse).toHaveLength(1);
		expect(settings.hooks.loom.PreToolUse[0].hooks[0].command).toBe(result.command);
	});

	test("writes a backup before mutating an existing file", async () => {
		const home = await tempHome();
		const path = join(home, ".gemini", "antigravity-cli", "settings.json");
		const original = JSON.stringify({ keep: true });
		await seedSettings(home, original);
		await registerAgyPermissionHook({
			home,
			env: { LOOM_CLI_ENTRY: cliEntry },
		});
		expect(await readFile(`${path}.loom-backup`, "utf8")).toBe(original);
	});
});
