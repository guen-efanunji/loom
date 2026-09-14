import { createAuth as createConfiguredAuth } from "@loom/auth";
import { createDb, type Database } from "@loom/db";

import { readSettings, dataDirectory } from "@loom/distribution";
import { join } from "node:path";

const settings = await readSettings();
const env = {
	DATABASE_URL: process.env.DATABASE_URL || `file:${join(dataDirectory(), "state.db")}`,
	BETTER_AUTH_SECRET: settings.token,
	BETTER_AUTH_URL: `http://127.0.0.1:${settings.port}`,
	CORS_ORIGIN: process.env.CORS_ORIGIN || `http://127.0.0.1:${settings.port}`,
};

let db: Database | undefined;

export function getDb(): Database {
	return db ??= createDb(env);
}

export async function checkDbHealth(database: Database = getDb()): Promise<boolean> {
	try {
		await database.run("SELECT 1");
		return true;
	} catch {
		return false;
	}
}
let configuredAuth: ReturnType<typeof createConfiguredAuth> | undefined;
function getAuth() { return configuredAuth ??= createConfiguredAuth(env, getDb()); }
export const auth = {
	handler: (request: Request) => getAuth().handler(request),
	api: { getSession: (options: { headers: Headers }) => getAuth().api.getSession(options) },
};
