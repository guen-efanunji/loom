import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database as SQLite } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { bootstrapDatabase } from "./bootstrap";
import type { DatabaseConfig } from "./config";
import * as schema from "./schema";

function databaseUrl(config: DatabaseConfig): string {
	if (config.DATABASE_URL) {
		return config.DATABASE_URL;
	}

	const path = join(process.env.LOOM_HOME || join(homedir(), ".loom"), "state.db");
	mkdirSync(dirname(path), { recursive: true });
	return `file:${path}`;
}

export function createDb(env: DatabaseConfig = {}) {
	const url = databaseUrl(env);
	if (!url.startsWith("file:") && url !== ":memory:")
		throw new Error("Loom stores its database locally; use a file: URL");
	const path = url.startsWith("file:") ? url.slice(5) : url;
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		bootstrapDatabase(path);
	}
	const client = new SQLite(path);
	// Keep local databases forward compatible when the daemon is upgraded from
	// an older schema. The bootstrap path normally applies these migrations,
	// but running them here as well covers callers that open a database through
	// a cached package build during development.
	for (const column of [
		"source_message text NOT NULL DEFAULT ''",
		"source_session_id text",
		"automation_mode text NOT NULL DEFAULT 'review'",
		"started_at integer",
		"cancelled_at integer",
	]) {
		try {
			client.exec(`ALTER TABLE plans ADD COLUMN ${column}`);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("duplicate column"))
				throw error;
		}
	}
	client.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");

	return drizzle({ client, schema });
}

export type Database = ReturnType<typeof createDb>;

export * from "./automation";
export * from "./bootstrap";
export * from "./design";
export * from "./repositories";
export * from "./schema";
