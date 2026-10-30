import { expect, test } from "bun:test";
import { VERSION, main } from "../src/index";

test("exposes the CLI version", () => {
	expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
});

test("update command rejects a missing channel before starting the update", async () => {
	await expect(main(["update", "--channel"])).rejects.toThrow(
		"--channel requires stable or beta",
	);
});
