const passwordKey = "loom.ui.password";
const trustedKey = "loom.ui.trusted";

export const DEFAULT_UI_PASSWORD = "123456";

export function getUiPassword(): string {
	if (typeof localStorage === "undefined") return DEFAULT_UI_PASSWORD;
	return localStorage.getItem(passwordKey) ?? DEFAULT_UI_PASSWORD;
}

export function isTrustedDevice(): boolean {
	return (
		typeof localStorage !== "undefined" &&
		(localStorage.getItem(trustedKey) === "true" || sessionStorage.getItem("loom.ui.unlocked") === "true")
	);
}

export function setTrustedDevice(trusted: boolean): void {
	if (typeof localStorage === "undefined") return;
	if (trusted) localStorage.setItem(trustedKey, "true");
	else localStorage.removeItem(trustedKey);
}

export function setUiPassword(password: string): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(passwordKey, password);
}
