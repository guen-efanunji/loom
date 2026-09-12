import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { bootstrapDatabase } from "./bootstrap";
import type { DatabaseConfig } from "./config";
import * as schema from "./schema";

function databaseUrl(config: DatabaseConfig): string {
	if (config.DATABASE_URL) {
		return config.DATABASE_URL;
	}

	const path = join(homedir(), ".loom", "state.db");
	mkdirSync(dirname(path), { recursive: true });
	return `file:${path}`;
}

export function createDb(env: DatabaseConfig = {}) {
	const url = databaseUrl(env);
	if (url.startsWith("file:")) bootstrapDatabase(url.slice("file:".length));
	const client = createClient({ url });

	return drizzle({ client, schema });
}

export type Database = ReturnType<typeof createDb>;

export * from "./bootstrap";
export * from "./repositories";
export * from "./schema";
export * from "./orchestration";
