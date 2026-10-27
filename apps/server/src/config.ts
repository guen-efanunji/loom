import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type DaemonConfig = {
	port: number;
	corsOrigin: string;
	token: string;
	/** Server-side UI lock password hash (`scrypt$salt$hash`); absent = no lock. */
	uiLockHash?: string | null;
};

export function getLoomDirectory(home = homedir()): string {
	return process.env.LOOM_HOME && home === homedir()
		? process.env.LOOM_HOME
		: join(home, ".loom");
}

export function getLoomConfigPath(home = homedir()): string {
	return join(getLoomDirectory(home), "config.json");
}

export async function loadDaemonConfig(
	options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<DaemonConfig> {
	const home = options.home ?? homedir();
	const environment = options.env ?? process.env;
	const path = getLoomConfigPath(home);
	await mkdir(getLoomDirectory(home), { recursive: true, mode: 0o700 });
	let stored: Partial<DaemonConfig> = {};
	try {
		stored = JSON.parse(await readFile(path, "utf8")) as Partial<DaemonConfig>;
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ENOENT"
		)
			throw error;
	}
	const token =
		stored.token ?? environment.LOOM_TOKEN ?? randomBytes(32).toString("hex");
	const config: DaemonConfig = {
		port: Number(environment.LOOM_PORT || stored.port || 4317),
		// Vite serves the development client on localhost:5173 by default. Keep
		// the daemon origin available as well for the bundled UI and 127.0.0.1.
		corsOrigin: [
			environment.CORS_ORIGIN,
			"http://localhost:5173",
			"http://127.0.0.1:5173",
			`http://127.0.0.1:${environment.LOOM_PORT || stored.port || 4317}`,
		]
			.filter(Boolean)
			.join(","),
		token,
		uiLockHash: stored.uiLockHash ?? null,
	};
	if (stored.token !== token || stored.uiLockHash !== config.uiLockHash) {
		await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
			mode: 0o600,
		});
	}
	return config;
}

/** Merge a partial update into the persisted daemon config on disk. */
export async function updateDaemonConfig(
	patch: Partial<Pick<DaemonConfig, "uiLockHash">>,
	options: { home?: string } = {},
): Promise<void> {
	const home = options.home ?? homedir();
	const directory = getLoomDirectory(home);
	const path = getLoomConfigPath(home);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let stored: Partial<DaemonConfig> = {};
	try {
		stored = JSON.parse(await readFile(path, "utf8")) as Partial<DaemonConfig>;
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ENOENT"
		)
			throw error;
	}
	const merged: Partial<DaemonConfig> = { ...stored, ...patch };
	if (patch.uiLockHash === null) delete merged.uiLockHash;
	await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, {
		mode: 0o600,
	});
}
