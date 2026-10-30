import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const created = () =>
	integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`);

export const sshConnections = sqliteTable("ssh_connections", {
	id: text("id").primaryKey(),
	label: text("label").notNull(),
	host: text("host").notNull(),
	port: integer("port").notNull().default(22),
	username: text("username").notNull(),
	/** How the local ssh client should authenticate: agent | key | password. */
	auth: text("auth").notNull().default("agent"),
	notes: text("notes").notNull().default(""),
	createdAt: created(),
	updatedAt: created(),
});
