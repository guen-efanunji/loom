import {
	DESIGN_FRAME_PRESETS,
	type DesignFrame,
	frameForRatio,
} from "@loom/protocol";

/**
 * Frame helpers for the design canvas: how a frame maps to a card on the
 * canvas, and how a size can be inferred from what the user mentioned
 * (an attached screenshot, a theme stylesheet) instead of always defaulting
 * to a web page.
 */

/**
 * Card footprint for a frame. The card keeps the frame's own ratio so the
 * preview never gets letterboxed, at roughly the visual mass the canvas used
 * to reserve for a desktop node.
 */
export function designNodeSizeForFrame(frame: DesignFrame): {
	width: number;
	height: number;
} {
	const ratio = frame.width / frame.height;
	if (!Number.isFinite(ratio) || ratio <= 0) return { width: 420, height: 263 };
	if (ratio >= 1) {
		const width = 420;
		return { width, height: clamp(Math.round(width / ratio), 160, 620) };
	}
	const height = 476;
	return { width: clamp(Math.round(height * ratio), 160, 620), height };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** `1440x900` for prompt text and labels. */
export function frameLabel(frame: DesignFrame): string {
	return `${frame.width}x${frame.height}`;
}

export function frameOfKind(kind: DesignFrame["kind"]): DesignFrame {
	const preset = DESIGN_FRAME_PRESETS.find((item) => item.id === kind);
	return preset
		? { kind: preset.id, width: preset.width, height: preset.height }
		: { kind, width: 1440, height: 900 };
}

/**
 * A frame from an explicit size, keeping the requested pixels untouched and
 * only labelling it with the preset whose ratio it matches.
 */
export function frameFromSize(width: number, height: number): DesignFrame {
	const exact = DESIGN_FRAME_PRESETS.find(
		(item) => item.width === width && item.height === height,
	);
	if (exact) return { kind: exact.id, width, height };
	return { kind: frameForRatio(width, height).kind, width, height };
}

/**
 * Intrinsic size of a raster image, read straight from its header. Supports
 * PNG, JPEG, GIF and WebP; anything else returns null so the caller keeps the
 * frame the user picked.
 */
export function imageDimensions(buffer: Buffer): {
	width: number;
	height: number;
} | null {
	if (buffer.length < 12) return null;
	// PNG
	if (
		buffer.readUInt32BE(0) === 0x89504e47 &&
		buffer.subarray(12, 16).toString("latin1") === "IHDR"
	) {
		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);
		return width > 0 && height > 0 ? { width, height } : null;
	}
	// GIF
	if (buffer.subarray(0, 3).toString("latin1") === "GIF")
		return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
	// WebP: RIFF....WEBP
	if (
		buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
		buffer.subarray(8, 12).toString("latin1") === "WEBP"
	) {
		const chunk = buffer.subarray(12, 16).toString("latin1");
		if (chunk === "VP8X" && buffer.length >= 30) {
			return {
				width: 1 + buffer.readUIntLE(24, 3),
				height: 1 + buffer.readUIntLE(27, 3),
			};
		}
		if (chunk === "VP8L" && buffer.length >= 25) {
			const bits = buffer.readUInt32LE(21);
			return {
				width: (bits & 0x3fff) + 1,
				height: ((bits >> 14) & 0x3fff) + 1,
			};
		}
		if (chunk === "VP8 " && buffer.length >= 30) {
			return {
				width: buffer.readUInt16LE(26) & 0x3fff,
				height: buffer.readUInt16LE(28) & 0x3fff,
			};
		}
		return null;
	}
	// JPEG: walk the marker segments to a start-of-frame marker.
	if (buffer[0] === 0xff && buffer[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < buffer.length) {
			if (buffer[offset] !== 0xff) {
				offset += 1;
				continue;
			}
			const marker = buffer[offset + 1] ?? 0;
			if (
				(marker >= 0xc0 && marker <= 0xc3) ||
				(marker >= 0xc5 && marker <= 0xc7) ||
				(marker >= 0xc9 && marker <= 0xcb) ||
				(marker >= 0xcd && marker <= 0xcf)
			)
				return {
					width: buffer.readUInt16BE(offset + 7),
					height: buffer.readUInt16BE(offset + 5),
				};
			offset += 2 + buffer.readUInt16BE(offset + 2);
		}
	}
	return null;
}

/**
 * The design space a stylesheet is authored for. malink-style themes write
 * everything as `calc(var(--u) * N)` with `--u: calc(100cqi / 390)`, which is
 * the real "this is a 390-wide screen" signal - far more reliable than a
 * generic max-width.
 */
export function designSpaceWidth(css: string): number | null {
	const container = /--u\s*:\s*calc\(\s*100cqi\s*\/\s*([\d.]+)/i.exec(css);
	const parsed = Number(container?.[1]);
	if (Number.isFinite(parsed) && parsed >= 120) return Math.round(parsed);
	const column = /(?:max-width|width)\s*:\s*([\d.]+)px/i.exec(css);
	const width = Number(column?.[1]);
	if (Number.isFinite(width) && width >= 120) return Math.round(width);
	return null;
}

/** True when the stylesheet scales with a design-space unit instead of breakpoints. */
export function usesDesignSpaceUnit(css: string): boolean {
	return (
		/--u\s*:\s*calc\(\s*100cqi/i.test(css) && /calc\(\s*var\(--u\)/i.test(css)
	);
}

/**
 * Prompt lines describing the canvas a set of references implies. Empty when
 * nothing was readable, so the caller falls back to the requested frame.
 */
export function frameReferenceHints(input: {
	images: Array<{ filename: string; width: number; height: number }>;
	cssWidths: Array<{ file: string; width: number }>;
	designSpaceFiles: string[];
}): string[] {
	const lines: string[] = [];
	for (const image of input.images) {
		const frame = frameForRatio(image.width, image.height);
		lines.push(
			`Reference image ${image.filename} is ${image.width}x${image.height} (ratio ${(
				image.width / image.height
			).toFixed(3)}). Draw this design on a ${frameLabel(
				frame,
			)} canvas so it matches the reference exactly, unless the user asked for another size.`,
		);
	}
	for (const entry of input.cssWidths)
		lines.push(
			`Reference stylesheet ${entry.file} is authored for a ${entry.width}px design space. Match that width for the canvas and keep the column proportions it declares.`,
		);
	if (input.designSpaceFiles.length)
		lines.push(
			"These references scale with a design-space unit (--u: calc(100cqi / BASE)) rather than breakpoints. Prefer the same technique: author in one unit system so the design stays pixel-faithful at any canvas size, and do not hard-code the old frame.",
		);
	return lines;
}

/** Same block, formatted for appending to an already-built prompt. */
export function frameHintBlock(hints: string[]): string {
	if (!hints.length) return "";
	return `\n\nCanvas size implied by the user's references:\n${hints
		.map((hint) => `- ${hint}`)
		.join("\n")}`;
}

const EXPLICIT_SIZE = /\b(\d{2,5})\s*(?:x|\u00d7|\*)\s*(\d{2,5})\b/i;
const SIZE_WORD =
	/\b(ukuaran|ukuran|dimensi|dimension|resize|aspect|rasio|ratio|poster|story|reel|banner|slide|email|tablet|laptop|desktop|mobile|portrait|landscape|lebar|tinggi|width|height)\b/i;
const CHANGE_WORD =
	/\b(ubah|ganti|jadikan|jadi|buat|rancang|resize|make|change|set|switch|convert|scale)\b/i;

/** An explicit `1080x1920` written anywhere in the user's own words. */
export function frameFromMention(text: string): DesignFrame | null {
	const match = EXPLICIT_SIZE.exec(text);
	if (!match) return null;
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width < 120 ||
		height < 120 ||
		width > 8192 ||
		height > 8192
	)
		return null;
	return frameFromSize(width, height);
}

/** True when the user is talking about the canvas size itself. */
export function mentionsCanvasSize(text: string): boolean {
	return (
		EXPLICIT_SIZE.test(text) || (SIZE_WORD.test(text) && CHANGE_WORD.test(text))
	);
}

/**
 * A frame read straight off the references when the user did not name one:
 * the first mentioned screenshot, else the design space of a stylesheet.
 */
export function frameFromReferences(input: {
	imageSizes: Array<{ width: number; height: number }>;
	cssWidths: number[];
}): DesignFrame | null {
	const image = input.imageSizes[0];
	if (image) {
		const frame = frameForRatio(image.width, image.height);
		return { ...frame, kind: "custom" as const };
	}
	const width = input.cssWidths[0];
	if (width) return frameFromSize(width, Math.round(width * 1.6));
	return null;
}
