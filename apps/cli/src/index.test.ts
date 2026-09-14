import { expect, test } from "bun:test";
import { VERSION } from "./index";

test("exposes the CLI version", () => {
	expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
