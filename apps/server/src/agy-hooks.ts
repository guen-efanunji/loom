import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Tools that mutate state or run arbitrary commands and therefore must be gated
// when a project's auto-accept is off. Mirrors Agy's PreToolUse matcher list.
const GATED_TOOLS =
	"run_command|write_to_file|replace_file_content|multi_replace_file_content";
const HOOK_NAME = "loom";
// Match the daemon-side timeout (1_800_000ms) so the hook never expires before
// the pending request is denied, keeping the two layers in agreement.
const HOOK_TIMEOUT_SECONDS = 1800;

export type AgyHookRegistration = {
	changed: boolean;
	settingsPath: string;
	command?: string;
	reason?: string;
};

// Derive the command that runs `loom agy-hook`. Installed builds expose a bin
// launcher under the data directory; a source checkout runs the CLI entry via
// `bun` so development daemons register an equally valid hook.
function resolveHookCommand(
	env: NodeJS.ProcessEnv,
	loomHome: string,
): { command: string } | { reason: string } {
	const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
	const launcher = join(loomHome, "bin", "loom");
	if (env.LOOM_CLI_ENTRY) {
		if (!existsSync(env.LOOM_CLI_ENTRY))
			return { reason: "Configured Loom CLI hook entry was not found" };
		return { command: `bun ${quote(env.LOOM_CLI_ENTRY)} agy-hook` };
	}
	if (existsSync(launcher))
		return { command: `${quote(launcher)} agy-hook` };
	const sourceEntry = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
	if (existsSync(sourceEntry))
		return { command: `bun ${quote(sourceEntry)} agy-hook` };
	return { reason: "Loom CLI hook executable was not found" };
}

function hasLoomHook(settings: Record<string, unknown>, command: string): boolean {
	const hooks = settings.hooks as
		| Record<
				string,
				{
					enabled?: boolean;
					PreToolUse?: Array<{
						matcher?: string;
						hooks?: Array<{ command?: string }>;
					}>;
				}
		  >
		| undefined;
	const matchers = hooks?.[HOOK_NAME]?.PreToolUse ?? [];
	return (
		hooks?.[HOOK_NAME]?.enabled !== false &&
		matchers.some(
			(matcher) =>
				matcher.matcher === GATED_TOOLS &&
				(matcher.hooks ?? []).some((hook) => hook.command === command),
		)
	);
}

/**
 * Idempotently registers a blocking PreToolUse hook in Agy's global
 * settings.json so tool calls from Loom-driven runs can be gated until the user
 * decides in the web UI. The hook is inert outside Loom because the `agy-hook`
 * CLI prints an immediate allow when the per-run permission env is absent. A
 * backup is written before a mutation.
 */
export async function registerAgyPermissionHook(
	options: { home?: string; env?: NodeJS.ProcessEnv; loomHome?: string } = {},
): Promise<AgyHookRegistration> {
	const home = options.home ?? homedir();
	const environment = options.env ?? process.env;
	const loomHome =
		options.loomHome ?? environment.LOOM_HOME ?? join(home, ".loom");
	const settingsPath = join(
		home,
		".gemini",
		"antigravity-cli",
		"settings.json",
	);
	const resolved = resolveHookCommand(environment, loomHome);
	if ("reason" in resolved)
		return { changed: false, settingsPath, reason: resolved.reason };

	let settings: Record<string, unknown> = {};
	let existed = true;
	try {
		settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
			string,
			unknown
		>;
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ENOENT"
		)
			throw error;
		existed = false;
	}

	if (hasLoomHook(settings, resolved.command))
		return { changed: false, settingsPath, command: resolved.command };

	if (existed) {
		await copyFile(settingsPath, `${settingsPath}.loom-backup`);
	} else {
		await mkdir(dirname(settingsPath), { recursive: true });
	}

	const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
	const existingLoom = hooks[HOOK_NAME] as
		| { PreToolUse?: unknown[] }
		| undefined;
	hooks[HOOK_NAME] = {
		...(existingLoom ?? {}),
		enabled: true,
		PreToolUse: [
			...((existingLoom?.PreToolUse as Array<{ hooks?: Array<{ command?: string }> }> | undefined) ?? []).filter(
				(matcher) => !(matcher.hooks ?? []).some((hook) => hook.command?.includes("agy-hook")),
			),
			{
				matcher: GATED_TOOLS,
				hooks: [
					{
						type: "command",
						command: resolved.command,
						timeout: HOOK_TIMEOUT_SECONDS,
					},
				],
			},
		],
	};
	settings.hooks = hooks;

	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
		mode: 0o600,
	});
	return { changed: true, settingsPath, command: resolved.command };
}
