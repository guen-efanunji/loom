import { request } from "$lib/daemon";

export type UiLockState = {
	/** A UI password is configured on the daemon. */
	configured: boolean;
	/** No password exists, so the interface runs unlocked. */
	notInUse: boolean;
	/** This browser surface already holds a server-issued unlock session. */
	unlocked: boolean;
};

export type UiLockMutation = {
	ok: boolean;
	configured: boolean;
};

/** Server-authoritative UI lock client. Passwords never live in the browser. */
export const uiLock = {
	state: () => request<UiLockState>("/api/ui-lock/state"),
	unlock: (password: string) =>
		request<{ ok: boolean; unlocked: boolean }>("/api/ui-lock/unlock", {
			method: "POST",
			body: JSON.stringify({ password }),
		}),
	setPassword: (password: string, currentPassword?: string) =>
		request<UiLockMutation>("/api/ui-lock/password", {
			method: "POST",
			body: JSON.stringify({ password, currentPassword }),
		}),
	clearPassword: (currentPassword?: string) =>
		request<UiLockMutation>("/api/ui-lock/clear", {
			method: "POST",
			body: JSON.stringify({ currentPassword }),
		}),
	lock: () =>
		request<{ ok: boolean; locked: boolean }>("/api/ui-lock/lock", {
			method: "POST",
			body: "{}",
		}),
	/** One-time migration check for passwords that used to live in localStorage. */
	verifyLegacy: (password: string) =>
		request<{ matched: boolean; migratable: boolean }>(
			"/api/ui-lock/verify-legacy",
			{ method: "POST", body: JSON.stringify({ password }) },
		),
};

const legacyPasswordKey = "loom.ui.password";

/** Read the pre-server UI password without clearing it yet. */
export function peekLegacyUiPassword(): string | null {
	if (typeof localStorage === "undefined") return null;
	return localStorage.getItem(legacyPasswordKey);
}

/** Drop client-side lock state after a successful server migration. */
export function clearLegacyUiPassword(): void {
	if (typeof localStorage === "undefined") return;
	localStorage.removeItem(legacyPasswordKey);
	localStorage.removeItem("loom.ui.trusted");
	if (typeof sessionStorage !== "undefined")
		sessionStorage.removeItem("loom.ui.unlocked");
}
