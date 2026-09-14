import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type DaemonConfig = {
	port: number;
	corsOrigin: string;
	token: string;
};

export function getLoomDirectory(home = homedir()): string {
	return process.env.LOOM_HOME && home === homedir() ? process.env.LOOM_HOME : join(home, ".loom");
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
		corsOrigin: environment.CORS_ORIGIN || `http://127.0.0.1:${environment.LOOM_PORT || stored.port || 4317}`,
		token,
	};
	if (stored.token !== token) {
		await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
			mode: 0o600,
		});
	}
	return config;
}
