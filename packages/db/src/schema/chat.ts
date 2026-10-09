import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const providerChatHistory = sqliteTable("provider_chat_history", {
	sessionId: text("session_id").primaryKey(),
	messages: text("messages").notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
});
