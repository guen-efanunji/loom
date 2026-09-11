import { createAuth as createConfiguredAuth } from "@loom/auth";
import { createDb, type Database } from "@loom/db";

import { env } from "./env.server";

const db = createDb(env);

export function getDb(): Database {
	return db;
}

export async function checkDbHealth(database: Database = db): Promise<boolean> {
	try {
		await database.run("SELECT 1");
		return true;
	} catch {
		return false;
	}
}
export const auth = createConfiguredAuth(env, db);
