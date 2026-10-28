import { describe, expect, onTestFinished, test } from "bun:test";
import { serve } from "bun";
import {
	extractUrls,
	htmlToText,
	referencedUrlBlock,
	snapshotsFor,
} from "../src/design-refs";

/* A tiny local HTTP server so fetch behaviour is exercised against a real
 * socket - statuses, mimes, and truncation all depend on a response. */
let requests = 0;
function snapServer() {
	requests = 0;
	const server = serve({
		port: 0,
		fetch: (request) => {
			requests += 1;
			const { pathname } = new URL(request.url);
			if (pathname === "/status/500") {
				return new Response("boom", { status: 500 });
			}
			if (pathname === "/page") {
				return new Response(
					"<!doctype html><html><head><style>body{color:red}</style><script>track()</script></head><body><h1>Acme&nbsp;Store</h1><p>&amp; shipping &lt;free&gt;</p></body></html>",
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				);
			}
			if (pathname === "/notes.txt") {
				return new Response("just plain notes", {
					headers: { "content-type": "text/plain" },
				});
			}
			if (pathname === "/hero.png") {
				return new Response(new Uint8Array([137, 80, 78, 71]), {
					headers: { "content-type": "image/png" },
				});
			}
			if (pathname === "/slow") return new Promise(() => undefined);
			return new Response("missing", { status: 404 });
		},
	});
	onTestFinished(() => server.stop(true));
	return `http://localhost:${server.port}`;
}

describe("extractUrls", () => {
	test("pulls unique urls and drops sentence punctuation", () => {
		expect(
			extractUrls(
				"Clone https://example.com. Then mirror http://foo.bar/baz, ok? See https://example.com again.",
			),
		).toEqual(["https://example.com", "http://foo.bar/baz"]);
	});

	test("respects the three-url cap", () => {
		const text = Array.from(
			{ length: 6 },
			(_, index) => `https://site-${index}.dev/x`,
		).join(" ");
		expect(extractUrls(text)).toHaveLength(3);
	});

	test("ignores text without urls", () => {
		expect(extractUrls("make the navbar prettier")).toEqual([]);
	});
});

describe("htmlToText", () => {
	test("drops scripts, styles, and tags; keeps inline text and entities", () => {
		expect(
			htmlToText(
				"<style>body{}</style><script>x()</script><h1>Acme&nbsp;Store</h1><p>&amp; shipping &lt;free&gt;</p><br><footer>hi</footer>",
			),
		).toBe("Acme Store\n & shipping <free>\nhi");
	});
});

describe("referencedUrlBlock", () => {
	test("is empty when there is nothing fetched", () => {
		expect(referencedUrlBlock("")).toBe("");
		expect(referencedUrlBlock("   ")).toBe("");
	});

	test("wraps snapshots with the tool-free directive", () => {
		const block = referencedUrlBlock("Reference 1 of 1: https://a.dev\nhello");
		expect(block).toContain("## Referenced URLs (already fetched for you)");
		expect(block).toContain("never try to fetch");
	});
});

describe("snapshotsFor", () => {
	test("fetches text pages, plain text, and marks binaries", async () => {
		const base = snapServer();
		const requestCountBefore = requests;
		const block = await snapshotsFor(
			`Study ${base}/page, then ${base}/notes.txt and ${base}/hero.png`,
			3,
		);
		expect(requests - requestCountBefore).toBe(3);
		expect(block).toContain("Reference 1 of 3");
		expect(block).toContain("Reference 2 of 3");
		expect(block).toContain("Reference 3 of 3");
		expect(block).not.toContain("track()");
		expect(block).not.toContain("color:red");
		expect(block).toContain("Acme Store");
		expect(block).toContain("just plain notes");
		expect(block).toContain("(image/png resource");
		// The default bound fetches at most two pages per brief.
		expect(
			await snapshotsFor(`Check ${base}/page and ${base}/notes.txt`),
		).toContain("Reference 1 of 2");
	});

	test("notes unreachable pages instead of failing", async () => {
		const base = snapServer();
		const block = await snapshotsFor(
			`Check ${base}/status/500 and ${base}/missing please`,
		);
		expect(block).toContain("(could not be fetched");
	});

	test("returns an empty block when the brief has no urls", async () => {
		expect(await snapshotsFor("make everything prettier")).toBe("");
	});
});
