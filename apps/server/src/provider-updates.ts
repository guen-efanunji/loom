import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { runCli } from "@loom/providers";

export type ProviderUpdateCheck = {
	providerId: string;
	name: string;
	installed: boolean;
	currentVersion: string | null;
	latestVersion: string | null;
	updateAvailable: boolean;
	updateSupported: boolean;
	updateCommand: string | null;
	error: string | null;
};

type UpdateDefinition = {
	packageName?: string;
	latestVersion?: () => Promise<string | null>;
	command: (
		version: string,
		executablePath: string | null,
	) => { executable: string; args: string[] };
	updateCommand: (executablePath: string | null) => string | null;
	availableFor: (executablePath: string | null) => Promise<boolean>;
};

const npmGlobalPath = async (executablePath: string | null) => {
	if (!executablePath) return false;
	const result = await runCli("npm", ["root", "-g"], { timeoutMs: 5_000 });
	const root = result?.exitCode === 0 ? result.stdout.trim() : "";
	if (!root) return false;
	const actualPath = await realpath(executablePath).catch(() => executablePath);
	const pathFromRoot = relative(root, actualPath);
	return (
		pathFromRoot !== ".." &&
		!pathFromRoot.startsWith(`..${sep}`) &&
		!pathFromRoot.startsWith(sep)
	);
};

function agyManifestPlatform() {
	const architecture =
		process.arch === "x64"
			? "amd64"
			: process.arch === "arm64"
				? "arm64"
				: null;
	if (!architecture)
		throw new Error("Unsupported Antigravity CLI architecture");
	if (process.platform === "darwin") return `darwin_${architecture}`;
	if (process.platform === "win32") return `windows_${architecture}`;
	if (process.platform === "linux") return `linux_${architecture}`;
	throw new Error("Unsupported Antigravity CLI platform");
}

const homebrewManagedPath = async (executablePath: string | null) => {
	if (!executablePath) return false;
	const actualPath = await realpath(executablePath).catch(() => executablePath);
	const normalized = actualPath.toLowerCase();
	if (!normalized.includes("/cellar/") && !normalized.includes("\\homebrew\\"))
		return false;
	const result = await runCli("brew", ["--version"], { timeoutMs: 5_000 });
	return result?.exitCode === 0;
};

const definitions: Record<string, UpdateDefinition> = {
	agy: {
		latestVersion: async () => {
			const response = await fetch(
				`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${agyManifestPlatform()}.json`,
				{ signal: AbortSignal.timeout(12_000) },
			);
			if (!response.ok)
				throw new Error(`Antigravity update server returned ${response.status}`);
			const manifest = (await response.json()) as { version?: unknown };
			return typeof manifest.version === "string" ? manifest.version : null;
		},
		command: () => ({ executable: "agy", args: [] }),
		updateCommand: () => null,
		availableFor: async () => false,
	},
	claude: {
		packageName: "@anthropic-ai/claude-code",
		command: () => ({ executable: "claude", args: ["update"] }),
		updateCommand: () => "claude update",
		availableFor: async () => true,
	},
	codex: {
		packageName: "@openai/codex",
		command: (version, executablePath) =>
			executablePath?.toLowerCase().includes("brew")
				? { executable: "brew", args: ["upgrade", "--cask", "codex"] }
				: {
						executable: "npm",
						args: ["install", "--global", `@openai/codex@${version}`],
					},
		updateCommand: (executablePath) =>
			executablePath?.toLowerCase().includes("brew")
				? "brew upgrade --cask codex"
				: "npm install -g @openai/codex@latest",
		availableFor: async (executablePath) =>
			(await npmGlobalPath(executablePath)) ||
			(await homebrewManagedPath(executablePath)),
	},
	opencode: {
		latestVersion: async () => {
			const response = await fetch(
				"https://api.github.com/repos/anomalyco/opencode/releases/latest",
				{
					headers: { Accept: "application/vnd.github+json" },
					signal: AbortSignal.timeout(12_000),
				},
			);
			if (!response.ok)
				throw new Error(`OpenCode release API returned ${response.status}`);
			const release = (await response.json()) as { tag_name?: unknown };
			return typeof release.tag_name === "string"
				? release.tag_name
				: null;
		},
		command: (version) => ({
			executable: "opencode",
			args: ["upgrade", version],
		}),
		updateCommand: () => "opencode upgrade",
		availableFor: async () => true,
	},
};

function versionParts(value: string): number[] {
	const version = value.match(/(?:^|[^\d])v?(\d+(?:\.\d+){1,3})\b/)?.[1];
	return version ? version.split(".").map(Number) : [];
}

function compareVersions(left: string, right: string): number {
	const a = versionParts(left);
	const b = versionParts(right);
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const delta = (a[index] || 0) - (b[index] || 0);
		if (delta) return delta;
	}
	return 0;
}

async function getLatestVersion(packageName: string) {
	const response = await fetch(
		`https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
		{ signal: AbortSignal.timeout(12_000) },
	);
	if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
	const metadata = (await response.json()) as {
		"dist-tags"?: Record<string, string>;
		versions?: Record<string, unknown>;
	};
	return metadata["dist-tags"]?.latest ?? null;
}

export async function checkProviderUpdate(input: {
	providerId: string;
	name: string;
	installed: boolean;
	currentVersion: string | null;
	executablePath: string | null;
}): Promise<ProviderUpdateCheck> {
	const definition = definitions[input.providerId];
	const base = {
		providerId: input.providerId,
		name: input.name,
		installed: input.installed,
		currentVersion: input.currentVersion,
		latestVersion: null as string | null,
		updateAvailable: false,
		updateSupported: false,
		updateCommand: null as string | null,
		error: null as string | null,
	};
	if (!input.installed) return base;
	if (!input.currentVersion)
		return { ...base, error: "The installed CLI did not report a version." };
	if (!definition)
		return {
			...base,
			error: "Update checks are not configured for this CLI yet.",
		};
	try {
		const latestVersion = definition.latestVersion
			? await definition.latestVersion()
			: definition.packageName
				? await getLatestVersion(definition.packageName)
				: null;
		if (!latestVersion)
			return {
				...base,
				error: "The release source did not return a version.",
			};
		const updateAvailable =
			!!latestVersion &&
			compareVersions(latestVersion, input.currentVersion) > 0;
		const updateSupported = await definition.availableFor(input.executablePath);
		return {
			...base,
			latestVersion,
			updateAvailable,
			updateSupported: updateAvailable && updateSupported,
			updateCommand:
				updateAvailable && !updateSupported
					? input.providerId === "opencode"
						? `opencode upgrade ${latestVersion}`
						: definition.updateCommand(input.executablePath) || null
					: null,
		};
	} catch (error) {
		return {
			...base,
			error:
				error instanceof Error
					? error.message
					: "Unable to check latest version",
		};
	}
}

export async function updateProviderCli(input: {
	providerId: string;
	name: string;
	installed: boolean;
	currentVersion: string | null;
	executablePath: string | null;
}) {
	const check = await checkProviderUpdate(input);
	if (!check.installed) throw new Error(`${check.name} is not installed`);
	if (check.error)
		throw new Error(`Could not verify latest version: ${check.error}`);
	if (!check.latestVersion || !check.updateAvailable)
		throw new Error(`${check.name} has no newer version available`);
	if (!check.updateSupported) {
		if (!check.updateCommand)
			throw new Error(
				`${check.name} updates itself in the background; relaunch it to apply the update.`,
			);
		throw new Error(
			`Update this installation from its package manager: ${check.updateCommand}`,
		);
	}
	const definition = definitions[input.providerId];
	if (!definition)
		throw new Error(`In-app updates are not supported for ${check.name}`);
	const command = definition.command(check.latestVersion, input.executablePath);
	const result = await runCli(command.executable, command.args, {
		timeoutMs: 10 * 60_000,
	});
	if (!result)
		throw new Error(
			`Could not start ${command.executable}; make sure it is installed and on PATH`,
		);
	if (result.exitCode !== 0) {
		const detail = (result.stderr || result.stdout).trim().slice(-1200);
		throw new Error(
			detail || `Updater exited with code ${result.exitCode ?? "unknown"}`,
		);
	}
	return {
		providerId: input.providerId,
		name: input.name,
		previousVersion: input.currentVersion,
		latestVersion: check.latestVersion,
		output: (result.stdout || result.stderr).trim().slice(-1600),
	};
}
