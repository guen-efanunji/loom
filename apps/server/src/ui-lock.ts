import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

/** How long a successful unlock stays valid before the daemon asks again. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Guard against local brute-force of the optional UI password. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 60_000;

export const UI_LOCK_COOKIE = "loom.ui.session";
export const UI_LOCK_HEADER = "x-loom-ui-session";

function hash(password: string, salt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, 32, (error, derived) => {
			if (error) reject(error);
			else resolve(derived.toString("hex"));
		});
	});
}

/** Encode as `scrypt$<salt-hex>$<hash-hex>` for storage in the daemon config. */
export async function hashUiPassword(password: string): Promise<string> {
	const salt = randomBytes(16).toString("hex");
	return `scrypt$${salt}$${await hash(password, salt)}`;
}

export async function verifyUiPassword(
	password: string,
	encoded: string,
): Promise<boolean> {
	const [scheme, salt, expected] = encoded.split("$");
	if (scheme !== "scrypt" || !salt || !expected) return false;
	const actual = await hash(password, salt);
	const a = Buffer.from(actual, "hex");
	const b = Buffer.from(expected, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}

export interface UiLockStore {
	/** True when a UI password has been configured by the user. */
	configured(): boolean;
	/** True when no password exists, so the interface runs unlocked. */
	notInUse(): boolean;
	unlocked(request: {
		cookieHeader?: string | null;
		sessionHeader?: string | null;
	}): boolean;
	/** Throws 429 while too many failed unlocks happened recently. */
	assertNotThrottled(): void;
	recordFailure(): void;
	/** Returns the new session token when the password matches. */
	startSession(password: string): Promise<string | null>;
	/** Legacy support: verify a password without consuming the throttle. */
	checkPassword(password: string): Promise<boolean>;
	setPassword(password: string): Promise<void>;
	clearPassword(): Promise<void>;
	revokeSessions(): void;
}

export type UiLockSecrets = {
	/** Persist the encoded password (or null to clear it). */
	persist: (encoded: string | null) => Promise<void>;
};

export function createUiLockStore(
	secrets: UiLockSecrets & {
		initialEncoded?: string | null;
	},
): UiLockStore {
	let encoded = secrets.initialEncoded ?? null;
	const sessions = new Map<string, number>();
	let failures: number[] = [];
	const now = () => Date.now();
	return {
		configured: () => encoded !== null,
		notInUse: () => encoded === null,
		unlocked(request) {
			if (encoded === null) return true;
			const candidates: string[] = [];
			if (request.sessionHeader) candidates.push(request.sessionHeader);
			const cookie = request.cookieHeader ?? null;
			if (cookie) {
				for (const piece of cookie.split(";")) {
					const [name, ...rest] = piece.trim().split("=");
					if (name === UI_LOCK_COOKIE) candidates.push(rest.join("="));
				}
			}
			for (const value of candidates) {
				const expiry = sessions.get(value);
				if (expiry === undefined) continue;
				if (expiry < now()) {
					sessions.delete(value);
					continue;
				}
				return true;
			}
			return false;
		},
		assertNotThrottled() {
			failures = failures.filter((at) => now() - at < LOCKOUT_MS);
			if (failures.length >= MAX_FAILED_ATTEMPTS)
				throw new HTTPException(429, {
					message:
						"Too many failed unlock attempts. Wait a minute and try again.",
				});
		},
		recordFailure() {
			failures.push(now());
		},
		async startSession(password) {
			const target = encoded;
			if (!target) return null;
			if (!(await verifyUiPassword(password, target))) return null;
			failures = [];
			const token = randomBytes(32).toString("hex");
			sessions.set(token, now() + SESSION_TTL_MS);
			return token;
		},
		async checkPassword(password) {
			const target = encoded;
			return target ? verifyUiPassword(password, target) : false;
		},
		async setPassword(password) {
			const next = await hashUiPassword(password);
			await secrets.persist(next);
			encoded = next;
			// Force every surface to re-authenticate with the new password.
			sessions.clear();
		},
		async clearPassword() {
			encoded = null;
			await secrets.persist(null);
			sessions.clear();
		},
		revokeSessions() {
			sessions.clear();
		},
	};
}

const passwordSchema = z
	.string()
	.min(6, "Password must be at least 6 characters")
	.max(200);

function requestSession(store: UiLockStore, c: UiLockRequestContext) {
	return store.unlocked({
		cookieHeader: c.req.header("cookie") ?? null,
		sessionHeader: c.req.header(UI_LOCK_HEADER) ?? null,
	});
}

type UiLockRequestContext = {
	req: { header: (name: string) => string | undefined };
};

/**
 * Server-authoritative UI lock. The password lives only in the daemon config
 * (scrypt hash) and unlock state is an HttpOnly session cookie issued here,
 * so clearing browser storage can no longer bypass the gate.
 */
export function createUiLockRoutes(options: {
	store: UiLockStore;
	/** Overrides the origin guard for tests and embedded use. */
	checkOrigin?: boolean;
	allowedOrigins?: Set<string>;
}) {
	const app = new Hono();
	const store = options.store;
	app.use("*", async (c, next) => {
		if (options.checkOrigin !== false) {
			const origin = c.req.header("Origin");
			if (
				origin &&
				options.allowedOrigins &&
				!options.allowedOrigins.has(origin)
			)
				throw new HTTPException(403, { message: "Origin is not allowed" });
		}
		await next();
	});
	app.get("/state", (c) =>
		c.json({
			configured: store.configured(),
			notInUse: store.notInUse(),
			unlocked: requestSession(store, c),
		}),
	);
	app.post("/unlock", async (c) => {
		store.assertNotThrottled();
		const input = z
			.object({
				password: z.string().max(400),
				remember: z.boolean().optional(),
			})
			.parse(await c.req.json());
		if (store.notInUse()) return c.json({ ok: true, unlocked: true });
		const token = await store.startSession(input.password);
		if (!token) {
			store.recordFailure();
			throw new HTTPException(401, { message: "Incorrect password" });
		}
		setCookie(c, UI_LOCK_COOKIE, token, {
			httpOnly: true,
			sameSite: "Lax",
			path: "/",
			maxAge: Math.floor(SESSION_TTL_MS / 1000),
		});
		return c.json({ ok: true, unlocked: true });
	});
	app.post("/password", async (c) => {
		const input = z
			.object({
				password: passwordSchema,
				currentPassword: z.string().max(400).optional(),
			})
			.parse(await c.req.json());
		// Changing an existing password proves knowledge; setting the first one
		// requires an unlocked surface (or a server with no password yet).
		if (store.configured()) {
			const current = input.currentPassword ?? "";
			if (!(await store.checkPassword(current)))
				throw new HTTPException(403, {
					message: "Current password is incorrect",
				});
		} else if (!requestSession(store, c)) {
			throw new HTTPException(403, { message: "This surface is not unlocked" });
		}
		await store.setPassword(input.password);
		return c.json({ ok: true, configured: true });
	});
	app.post("/clear", async (c) => {
		const body: unknown = await c.req.json().catch(() => ({}));
		const input = z
			.object({ currentPassword: z.string().max(400).optional() })
			.parse(body ?? {});
		if (
			input.currentPassword &&
			(await store.checkPassword(input.currentPassword))
		) {
			await store.clearPassword();
			return c.json({ ok: true, configured: false });
		}
		if (!requestSession(store, c))
			throw new HTTPException(403, { message: "This surface is not unlocked" });
		await store.clearPassword();
		return c.json({ ok: true, configured: false });
	});
	app.post("/lock", (c) => {
		if (!requestSession(store, c) && !store.configured())
			throw new HTTPException(400, {
				message: "No UI password is configured, so there is nothing to lock",
			});
		store.revokeSessions();
		return c.json({ ok: true, locked: store.configured() });
	});
	/** Legacy migration: verify an old client-side password once, server-side. */
	app.post("/verify-legacy", async (c) => {
		const input = z
			.object({ password: z.string().max(400) })
			.parse(await c.req.json());
		const matched = await store.checkPassword(input.password);
		return c.json({
			matched,
			migratable: matched && !store.configured(),
		});
	});
	app.onError((error, c) => {
		const status =
			error instanceof HTTPException
				? error.status
				: error instanceof z.ZodError
					? 400
					: 500;
		return c.json(
			{ error: { message: error.message || "UI lock request failed" } },
			status,
		);
	});
	return app;
}
