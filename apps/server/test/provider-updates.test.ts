import { afterEach, expect, mock, test } from "bun:test";
import { checkProviderUpdate } from "../src/provider-updates";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("checks Antigravity CLI version using its official release manifest", async () => {
	const fetchMock = mock(async () =>
		Response.json({ version: "1.5.1", url: "https://example.com/agy" }),
	);
	globalThis.fetch = fetchMock as unknown as typeof fetch;

	const result = await checkProviderUpdate({
		providerId: "agy",
		name: "Antigravity CLI",
		installed: true,
		currentVersion: "agy v1.4.12",
		executablePath: "/home/user/.local/bin/agy",
	});

	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(result.latestVersion).toBe("1.5.1");
	expect(result.updateAvailable).toBe(true);
	expect(result.updateSupported).toBe(false);
	expect(result.updateCommand).toBeNull();
});

test("does not offer updates when installed CLIs are newer than release latest", async () => {
	globalThis.fetch = mock(async (input: string | URL | Request) => {
		const url = String(input);
		const version = url.includes("anomalyco/opencode")
			? "v2.2.5"
			: "2.1.318";
		return url.includes("anomalyco/opencode")
			? Response.json({ tag_name: version })
			: Response.json({ "dist-tags": { latest: version } });
	}) as unknown as typeof fetch;

	for (const provider of [
		{
			providerId: "claude",
			name: "Claude Code CLI",
			currentVersion: "Claude Code 2.1.318",
		},
		{
			providerId: "opencode",
			name: "OpenCode CLI",
			currentVersion: "opencode v2.2.5",
		},
	]) {
		const result = await checkProviderUpdate({
			...provider,
			installed: true,
			executablePath: "/usr/local/bin/cli",
		});
		expect(result.latestVersion).toBe(
			provider.providerId === "opencode" ? "v2.2.5" : "2.1.318",
		);
		expect(result.updateAvailable).toBe(false);
		expect(result.updateSupported).toBe(false);
		expect(result.updateCommand).toBeNull();
	}
});
