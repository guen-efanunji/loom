import { expect, test } from "bun:test";
import { VERSION } from "./index";

test("exposes the CLI version", () => {
	expect(VERSION).toBe("0.0.0");
});
