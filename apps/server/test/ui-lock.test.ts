import { describe, expect, test } from "bun:test";
import {
	createUiLockRoutes,
	createUiLockStore,
	hashUiPassword,
	verifyUiPassword,
} from "../src/ui-lock";

function setup(initial: string | null = null) {
	let stored = initial;
	const store = createUiLockStore({
		initialEncoded: initial,
		persist: async (encoded) => {
			stored = encoded;
		},
	});
	const app = createUiLockRoutes({ store, checkOrigin: false });
	return {
		app,
		store,
		get stored() {
			return stored;
		},
	};
}

describe("ui-lock password hashing", () => {
	test("verifies a matching password and rejects a wrong one", async () => {
		const encoded = await hashUiPassword("sup3r-secret");
		expect(encoded.startsWith("scrypt$")).toBe(true);
		expect(await verifyUiPassword("sup3r-secret", encoded)).toBe(true);
		expect(await verifyUiPassword("wrong", encoded)).toBe(false);
	});
});

describe("ui-lock routes", () => {
	test("reports an unlocked not-in-use interface", async () => {
		const { app } = setup(null);
		const state = (await (await app.request("/state")).json()) as Record<
			string,
			boolean
		>;
		expect(state).toMatchObject({ configured: false, notInUse: true });
	});

	test("sets a first password then requires the correct unlock", async () => {
		const { app } = setup(null);
		const set = await app.request("/password", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "correct horse" }),
		});
		expect(set.status).toBe(200);

		const bad = await app.request("/unlock", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "nope" }),
		});
		expect(bad.status).toBe(401);

		const good = await app.request("/unlock", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "correct horse" }),
		});
		expect(good.status).toBe(200);
		const cookie = good.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("loom.ui.session=");
		expect(cookie).toContain("HttpOnly");

		const state = (await (
			await app.request("/state", { headers: { cookie } })
		).json()) as { unlocked: boolean };
		expect(state.unlocked).toBe(true);
	});

	test("throttles after repeated failed unlocks", async () => {
		const { app } = setup(await hashUiPassword("letmein123"));
		let last = 0;
		for (let i = 0; i < 8; i++) {
			last = (
				await app.request("/unlock", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password: "bad" }),
				})
			).status;
		}
		expect(last).toBe(401);
		const blocked = await app.request("/unlock", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "letmein123" }),
		});
		expect(blocked.status).toBe(429);
	});

	test("locks the interface again by revoking sessions", async () => {
		const { app, store } = setup(await hashUiPassword("passw0rd!"));
		const unlock = await app.request("/unlock", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "passw0rd!" }),
		});
		const cookie = unlock.headers.get("set-cookie") ?? "";
		expect(store.unlocked({ cookieHeader: cookie })).toBe(true);
		const locked = await app.request("/lock", {
			method: "POST",
			headers: { cookie },
		});
		expect(locked.status).toBe(200);
		expect(store.unlocked({ cookieHeader: cookie })).toBe(false);
	});
});
