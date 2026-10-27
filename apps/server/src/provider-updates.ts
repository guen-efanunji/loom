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
	packageName: string;
	command: (
		version: string,
		executablePath: string | null,
	) => { executable: string; args: string[] };
	updateCommand: (executablePath: string | null) => string;
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
		packageName: "opencode-ai",
		command: (version) => ({
			executable: "opencode",
			args: ["upgrade", version],
		}),
		updateCommand: () => "opencode upgrade",
		availableFor: async () => true,
	},
};

function compareVersions(left: string, right: string): number {
	const a = left.replace(/^v/, "").split(/[.+-]/).map(Number);
	const b = right.replace(/^v/, "").split(/[.+-]/).map(Number);
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const delta = (a[index] || 0) - (b[index] || 0);
		if (delta) return delta;
	}
	return 0;
}

async function getLatestVersion(packageName: string, currentVersion: string) {
	const response = await fetch(
		`https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
		{ signal: AbortSignal.timeout(12_000) },
	);
	if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
	const metadata = (await response.json()) as {
		"dist-tags"?: Record<string, string>;
		versions?: Record<string, unknown>;
	};
	const currentMajor = Number(currentVersion.replace(/^v/, "").split(".")[0]);
	const versions = Object.keys(metadata.versions ?? {}).filter((version) =>
		/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version),
	);
	// OpenCode keeps ordinary updates on the same major line. Other CLIs use npm's latest tag.
	if (packageName === "opencode-ai" && Number.isFinite(currentMajor)) {
		const compatible = versions.filter(
			(version) => Number(version.split(".")[0]) === currentMajor,
		);
		return compatible.sort(compareVersions).at(-1) ?? null;
	}
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
		const latestVersion = await getLatestVersion(
			definition.packageName,
			input.currentVersion,
		);
		if (!latestVersion)
			return {
				...base,
				error: "The package registry did not return a release version.",
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
						: definition.updateCommand(input.executablePath)
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
	if (!check.updateSupported)
		throw new Error(
			`Update this installation from its package manager: ${check.updateCommand ?? ""}`,
		);
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
