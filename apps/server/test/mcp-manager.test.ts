import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@loom/db";
import { createMcpManagerRoutes } from "../src/mcp-manager";

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "loom-mcp-"));
	const databasePath = join(directory, "state.db");
	const db = createDb({ DATABASE_URL: `file:${databasePath}` });
	for (const column of [
		"auto_reconnect integer NOT NULL DEFAULT 0",
		"allow_private_network integer NOT NULL DEFAULT 0",
	]) {
		try {
			db.$client.exec(`ALTER TABLE managed_mcp_connections ADD COLUMN ${column}`);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("duplicate column"))
				throw error;
		}
	}
	const createApp = () =>
		createMcpManagerRoutes({
			db,
			projects: { getById: async () => undefined },
		});
	return { db, createApp };
}

async function insertConnection(
	db: Awaited<ReturnType<typeof createDb>>,
	status = "disconnected",
) {
	db.$client
		.query(
			"INSERT INTO managed_mcp_connections (id, label, transport, config_json, status) VALUES (?, ?, ?, ?, ?)",
		)
		.run(
			"mcp_test",
			"Test server",
			"streamable-http",
			JSON.stringify({
				endpoint: "https://example.com/mcp",
				args: [],
				envRefs: {},
				headerEnvRefs: {},
			}),
			status,
		);
}

describe("MCP manager startup recovery", () => {
	test("marks stale sessions interrupted without enabling reconnect", async () => {
		const { db, createApp } = await fixture();
		await insertConnection(db, "connected");

		const app = createApp();
		const response = await app.request("/connections");
		const body = (await response.json()) as {
			connections: Array<{
				status: string;
				autoReconnect: boolean;
				allowPrivateNetwork: boolean;
			}>;
		};

		expect(response.status).toBe(200);
		expect(body.connections[0]).toMatchObject({
			status: "interrupted",
			autoReconnect: false,
			allowPrivateNetwork: false,
		});
		db.$client.close();
	});

	test("persists explicit automatic reconnect approval", async () => {
		const { db, createApp } = await fixture();
		await insertConnection(db);

		const app = createApp();
		const response = await app.request(
			"/connections/mcp_test/auto-reconnect",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled: true }),
			},
		);
		const body = (await response.json()) as {
			connection: { autoReconnect: boolean };
		};

		expect(response.status).toBe(200);
		expect(body.connection.autoReconnect).toBe(true);
		db.$client.close();
	});
});
