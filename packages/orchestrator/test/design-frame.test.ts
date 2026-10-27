import { describe, expect, test } from "bun:test";
import { extractDesignScreens, parseScreenMark } from "../src/design-prompt";
import {
	designNodeSizeForFrame,
	designSpaceWidth,
	frameFromMention,
	frameFromSize,
	imageDimensions,
	mentionsCanvasSize,
	usesDesignSpaceUnit,
} from "../src/design-frame";

function png(width: number, height: number): Buffer {
	const buffer = Buffer.alloc(33);
	buffer.writeUInt32BE(0x89504e47, 0);
	buffer.writeUInt32BE(0x0d0a1a0a, 4);
	buffer.writeUInt32BE(13, 8);
	buffer.write("IHDR", 12, "latin1");
	buffer.writeUInt32BE(width, 16);
	buffer.writeUInt32BE(height, 20);
	return buffer;
}

function gif(width: number, height: number): Buffer {
	const buffer = Buffer.alloc(13);
	buffer.write("GIF89a", 0, "latin1");
	buffer.writeUInt16LE(width, 6);
	buffer.writeUInt16LE(height, 8);
	return buffer;
}

function jpeg(width: number, height: number): Buffer {
	const buffer = Buffer.alloc(20);
	buffer[0] = 0xff;
	buffer[1] = 0xd8;
	buffer[2] = 0xff;
	buffer[3] = 0xc0; // SOF0
	buffer.writeUInt16BE(15, 4); // segment length
	buffer[6] = 8; // precision
	buffer.writeUInt16BE(height, 7);
	buffer.writeUInt16BE(width, 9);
	return buffer;
}

const DOCUMENT =
	'<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>D</title></head>\n<body><h1>D</h1></body>\n</html>';

describe("canvas frames", () => {
	test("a screen marker can declare the canvas it was drawn on", () => {
		expect(parseScreenMark(" Link card | 480x640 ")).toEqual({
			title: "Link card",
			frame: { kind: "card", width: 480, height: 640 },
		});
		expect(parseScreenMark("Story | 1080x1920").frame).toEqual({
			kind: "story",
			width: 1080,
			height: 1920,
		});
		expect(parseScreenMark("Poster | poster").frame).toEqual({
			kind: "poster",
			width: 1080,
			height: 1350,
		});
	});

	test("titles without a size, or with a nonsense size, keep the caller's frame", () => {
		expect(parseScreenMark("Login page")).toEqual({ title: "Login page" });
		expect(parseScreenMark("Login page | 9x9")).toEqual({
			title: "Login page",
		});
		expect(parseScreenMark("Login page | someday")).toEqual({
			title: "Login page",
		});
	});

	test("extracted screens carry their frames", () => {
		const screens = extractDesignScreens(
			`<!-- design: Checkout | 390x844 -->\n${DOCUMENT}\n<!-- design: Overview -->\n${DOCUMENT}`,
		);
		expect(screens).toHaveLength(2);
		expect(screens[0]?.frame).toEqual({
			kind: "mobile",
			width: 390,
			height: 844,
		});
		expect(screens[1]?.frame).toBeUndefined();
	});

	test("an explicit size in the user's own words is honoured", () => {
		expect(frameFromMention("buatkan story 1080x1920 untuk promo")).toEqual({
			kind: "story",
			width: 1080,
			height: 1920,
		});
		expect(frameFromMention("make a 600 x 900 email")).toEqual({
			kind: "email",
			width: 600,
			height: 900,
		});
		expect(frameFromMention("dashboard analytics")).toBeNull();
	});

	test("resize intent needs a size word, not any mention of a screen", () => {
		expect(mentionsCanvasSize("ganti ukurannya jadi 800x600")).toBe(true);
		expect(mentionsCanvasSize("ubah warna tombolnya")).toBe(false);
		expect(mentionsCanvasSize("jadikan poster 1080x1350")).toBe(true);
	});

	test("image dimensions come from the file header", () => {
		expect(imageDimensions(png(1080, 1920))).toEqual({
			width: 1080,
			height: 1920,
		});
		expect(imageDimensions(gif(320, 480))).toEqual({ width: 320, height: 480 });
		expect(imageDimensions(jpeg(1440, 900))).toEqual({
			width: 1440,
			height: 900,
		});
		expect(imageDimensions(Buffer.from("not an image"))).toBeNull();
	});

	test("a theme's design space is read from its container unit", () => {
		const css = `
.lib-col { container-type: inline-size; width: min(100%, 480px); }
.lib-u { --u: calc(100cqi / 390); }
.ah-title { font-size: calc(var(--u) * 90.75); }`;
		expect(designSpaceWidth(css)).toBe(390);
		expect(usesDesignSpaceUnit(css)).toBe(true);
		expect(designSpaceWidth(".a { color: red }")).toBeNull();
		expect(usesDesignSpaceUnit(".a { max-width: 100% }")).toBe(false);
	});

	test("cards take the frame ratio so nothing is letterboxed", () => {
		expect(
			designNodeSizeForFrame({ kind: "desktop", width: 1440, height: 900 }),
		).toEqual({ width: 420, height: 263 });
		expect(
			designNodeSizeForFrame({ kind: "mobile", width: 390, height: 844 }),
		).toEqual({ width: 220, height: 476 });
		const square = designNodeSizeForFrame({
			kind: "square",
			width: 1080,
			height: 1080,
		});
		expect(square.width).toBe(square.height);
	});

	test("a named preset size keeps its own kind label", () => {
		expect(frameFromSize(1280, 720).kind).toBe("slide");
		expect(frameFromSize(1000, 700).kind).not.toBe("slide");
	});
});
