import type { createAuth } from "@loom/auth";
import type { Database } from "@loom/db";

export type Context = {
	auth: null;
	session: Awaited<
		ReturnType<ReturnType<typeof createAuth>["api"]["getSession"]>
	>;
	db: Database;
};
