import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

declare const LOOM_BUILD_VERSION: string;
declare const LOOM_EMBEDDED_PROMPTS: Record<string, string> | undefined;
export const VERSION =
	typeof LOOM_BUILD_VERSION === "undefined" ? "0.1.0" : LOOM_BUILD_VERSION;
export const PROTOCOL_VERSION = 1;
export const REPOSITORY = "guen-efanunji/loom";
export const releaseChannelSchema = z.enum(["stable", "beta"]);
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;
export const automationModeSchema = z.enum([
	"review",
	"auto-create",
	"auto-start",
]);
export type AutomationMode = z.infer<typeof automationModeSchema>;
export const settingsSchema = z.object({
	port: z.number().int().min(1024).max(65535).default(4317),
	token: z.string().min(32),
	releaseChannel: releaseChannelSchema.default("stable"),
	updateChecks: z.boolean().default(true),
	automationMode: automationModeSchema.default("review"),
});
export type Settings = z.infer<typeof settingsSchema>;
export function dataDirectory() {
	return process.env.LOOM_HOME || join(homedir(), ".loom");
}
/**
 * Prompt text is editable on disk and embedded in the release binary, because a
 * single-file executable has no repository next to it. Disk always wins.
 * @param name path under `prompts/`, for example `design/system.md`
 * @param origins extra directories to search, typically a module-relative one
 */
export function promptCandidates(
	name: string,
	origins: string[] = [],
): string[] {
	const configured = process.env.LOOM_PROMPTS_DIR?.trim();
	const directory = promptsDirectory();
	return [
		...(configured ? [join(configured, name)] : []),
		join(directory, name),
		join(process.cwd(), "prompts", name),
		...origins.map((origin) => join(origin, name)),
	];
}
export function promptsDirectory() {
	return join(dataDirectory(), "prompts");
}
export function embeddedPrompts(): Record<string, string> {
	return typeof LOOM_EMBEDDED_PROMPTS === "undefined"
		? {}
		: LOOM_EMBEDDED_PROMPTS;
}
export function embeddedPrompt(name: string): string | null {
	const value = embeddedPrompts()[name];
	return typeof value === "string" ? value : null;
}
/** Reads a prompt, preferring an editable copy on disk over the bundled text. */
export function loadPromptText(name: string, origins: string[] = []): string {
	for (const path of promptCandidates(name, origins)) {
		try {
			return readFileSync(path, "utf8");
		} catch {}
	}
	const embedded = embeddedPrompt(name);
	if (embedded !== null) return embedded;
	throw new Error(
		`Prompt file is missing: ${name}. Reinstall Loom or set LOOM_PROMPTS_DIR.`,
	);
}
/**
 * Returns a readable file path for a prompt. Provider CLIs that take a file
 * argument cannot accept inline text, so a bundled prompt is materialised into
 * the Loom directory on first use.
 */
export function loadPromptFile(name: string, origins: string[] = []): string {
	for (const path of promptCandidates(name, origins))
		if (existsSync(path)) return path;
	const embedded = embeddedPrompt(name);
	if (embedded === null)
		throw new Error(
			`Prompt file is missing: ${name}. Reinstall Loom or set LOOM_PROMPTS_DIR.`,
		);
	const path = join(promptsDirectory(), name);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	let current: string | null = null;
	try {
		current = readFileSync(path, "utf8");
	} catch {}
	if (current !== embedded) writeFileSync(path, embedded, { mode: 0o600 });
	return path;
}
export function platformKey(
	platform: string = process.platform,
	arch: string = process.arch,
) {
	const key = `${platform === "win32" ? "windows" : platform}-${arch}`;
	if (
		![
			"darwin-arm64",
			"darwin-x64",
			"linux-x64",
			"linux-arm64",
			"windows-x64",
		].includes(key)
	)
		throw new Error(
			`Unsupported platform: ${key}. See the installation documentation.`,
		);
	return key;
}
export async function atomicJson(path: string, value: unknown) {
	const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	await rename(temp, path);
}
export async function readSettings(
	directory = dataDirectory(),
): Promise<Settings> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "config.json");
	try {
		return settingsSchema.parse(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const settings = settingsSchema.parse({
			token: randomBytes(32).toString("hex"),
		});
		await atomicJson(path, settings);
		return settings;
	}
}
export async function saveSettings(
	settings: Settings,
	directory = dataDirectory(),
) {
	await atomicJson(
		join(directory, "config.json"),
		settingsSchema.parse(settings),
	);
}
export function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				/token|secret|password|authorization|cookie|api.?key/i.test(key)
					? "[REDACTED]"
					: redact(item),
			]),
		);
	if (typeof value === "string")
		return value
			.replace(/(Bearer\s+)[\w.-]+/gi, "$1[REDACTED]")
			.replace(
				/((?:token|secret|password|api[_-]?key)=)[^\s&]+/gi,
				"$1[REDACTED]",
			)
			.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[REDACTED]@");
	return value;
}
export function log(
	component: string,
	event: string,
	details: Record<string, unknown> = {},
	level = "info",
) {
	console.log(
		JSON.stringify({
			time: new Date().toISOString(),
			level,
			component,
			event,
			...(redact(details) as object),
		}),
	);
}
