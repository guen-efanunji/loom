import { describe, expect, test } from "bun:test";
import { createChatRoutes } from "../src/chat";

type Message = {
	info: {
		id: string;
		role: string;
		time: { created: number; completed?: number };
	};
	parts: Array<{ id: string; type: string; text?: string }>;
};

function harness(
	options: {
		status?: Record<string, { type: string }>;
		pendingPermissions?: Array<{ id: string; sessionID: string }>;
	} = {},
) {
	const history = new Map<string, Message[]>();
	const calls: string[] = [];
	const messages: Message[] = [
		{
			info: { id: "msg_u", role: "user", time: { created: 1 } },
			parts: [{ id: "p1", type: "text", text: "hello" }],
		},
		{
			info: {
				id: "msg_a",
				role: "assistant",
				time: { created: 2, completed: 3 },
			},
			parts: [{ id: "p2", type: "text", text: "hi there" }],
		},
	];
	const app = createChatRoutes({
		projects: {
			list: async () => [{ id: "project", path: "/tmp" }],
			getById: async (id: string) =>
				id === "project" ? { path: "/tmp" } : null,
		},
		request: async <T>(
			path: string,
			opts: { method?: string; body?: unknown } = {},
		): Promise<T> => {
			calls.push(`${opts.method ?? "GET"} ${path}`);
			if (path === "/session/ses_x")
				return {
					id: "ses_x",
					directory: "/tmp",
					title: "Chat",
					time: { updated: 1 },
				} as T;
			if (path === "/session/ses_x/message") return messages as T;
			if (path === "/session/status") return (options.status ?? {}) as T;
			if (path === "/permission")
				return (options.pendingPermissions ?? []) as T;
			if (path === "/question") return [] as T;
			if (path.startsWith("/permission/") && path.endsWith("/reply"))
				return { replied: true } as T;
			if (path.startsWith("/question/") && path.endsWith("/reply"))
				return { answered: true } as T;
			return true as T;
		},
		providerHistory: {
			get: async <T>(sessionId: string) =>
				history.get(sessionId) as T | undefined,
			save: async (sessionId: string, messages) => {
				history.set(sessionId, messages as Message[]);
			},
			delete: async (sessionId: string) => {
				history.delete(sessionId);
			},
		},
	});
	return { app, history, calls };
}

describe("chat regenerate/edit supersede", () => {
	test("hides superseded turns from the conversation state", async () => {
		const { app } = harness();
		const before = await app.request("/sessions/ses_x");
		expect(before.status).toBe(200);
		const beforeBody = (await before.json()) as {
			messages: Array<{ info: { id: string } }>;
		};
		expect(beforeBody.messages.map((m) => m.info.id)).toEqual([
			"msg_u",
			"msg_a",
		]);

		const supersede = await app.request("/sessions/ses_x/supersede", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messageIds: ["msg_a"] }),
		});
		expect(supersede.status).toBe(200);

		const after = await app.request("/sessions/ses_x");
		const afterBody = (await after.json()) as {
			messages: Array<{ info: { id: string } }>;
		};
		expect(afterBody.messages.map((m) => m.info.id)).toEqual(["msg_u"]);
	});

	test("reports a reduced count through the cheap status endpoint", async () => {
		const { app } = harness();
		await app.request("/sessions/ses_x/supersede", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messageIds: ["msg_a"] }),
		});
		const response = await app.request("/sessions/ses_x/status");
		expect(response.status).toBe(200);
		const status = (await response.json()) as {
			count: number;
			lastMessageId: string;
		};
		expect(status.count).toBe(1);
		expect(status.lastMessageId).toBe("msg_u");
	});

	test("downgrades a stale busy status when nothing is running (P2-11)", async () => {
		const { app } = harness({ status: { ses_x: { type: "busy" } } });
		const response = await app.request("/sessions/ses_x");
		const body = (await response.json()) as { status: { type: string } };
		expect(body.status.type).toBe("idle");
	});
});

describe("chat reply routing", () => {
	test("replies to a pending permission and proxies the reply", async () => {
		const { app, calls } = harness({
			pendingPermissions: [{ id: "per_1", sessionID: "ses_x" }],
		});
		const response = await app.request("/sessions/ses_x/permission/per_1", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reply: "once" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ replied: true });
		// The id segment is re-encoded on the way to the provider gateway.
		expect(calls).toContain("POST /permission/per_1/reply");
	});

	test("rejects a reply for a request that is no longer pending", async () => {
		const { app } = harness();
		const response = await app.request("/sessions/ses_x/permission/missing", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reply: "once" }),
		});
		expect(response.status).toBe(404);
	});
});
