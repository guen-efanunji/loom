/**
 * Referenced-URL snapshots for the design agent.
 *
 * Design briefs often point at a real page ("clone this site", "match the
 * https://navbar.example.com look"). Models try to satisfy that by shelling
 * out (curl/RunCommand), which read-only runtimes deny and the denial kills
 * the whole run. Fetching is the user's expectation, not the problem - so the
 * orchestrator fetches server-side (bounded: few URLs, byte cap, timeout,
 * HTML reduced to text) and hands the snapshot to the prompt. The agent never
 * needs a shell to honour a URL.
 */

const MAX_URLS = 3;
const MAX_BYTES = 400_000;
const MAX_SNAPSHOT_CHARS = 15_000;
const FETCH_TIMEOUT_MS = 8_000;
const USER_AGENT = "Mozilla/5.0 (compatible; LoomDesignAgent/1.0)";

/** Unique http(s) URLs mentioned anywhere in a brief, capped. */
export function extractUrls(text: string): string[] {
	const unique = new Set<string>();
	const pattern = /https?:\/\/[^\s<>()"'`\\]+/gi;
	for (const match of text.matchAll(pattern)) {
		// Punctuation at the end of a sentence is not part of the URL.
		const url = match[0].replace(/[.,;:!?)\]]+$/, "");
		if (unique.has(url)) continue;
		unique.add(url);
		if (unique.size >= MAX_URLS) break;
	}
	return [...unique];
}

/** Reduce an HTML payload to readable text for a design reference. */
export function htmlToText(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(
			/<(script|style|noscript|template|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi,
			" ",
		)
		.replace(/<\/(p|div|section|header|footer|nav|h[1-6]|li|tr)>/gi, "\n")
		.replace(/<(br|hr)[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*/g, "\n")
		.trim();
}

function clamp(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… (truncated)`;
}

export type UrlSnapshot = { url: string; note: string };

/**
 * Fetch every URL the brief mentions and render one prompt block. When the
 * brief has no URLs the block is empty - callers append it unconditionally.
 */
export async function snapshotsFor(text: string, count = 2): Promise<string> {
	const refs = [];
	let missing = 0;
	const urls = extractUrls(text).slice(0, count);
	for (const url of urls) {
		const note = await snapshotFor(url, ++missing, urls.length);
		refs.push(note);
	}
	return refs.join("\n");
}

async function snapshotFor(
	url: string,
	index: number,
	total: number,
): Promise<string> {
	const snap = await fetchSnapshot(url).catch(() => null);
	const heading = `Reference ${index} of ${total}: ${url}`;
	if (!snap)
		return `${heading}\n(could not be fetched; design from the description instead)`;
	if (snap.kind === "binary")
		return `${heading}\n(${snap.mime} resource; not text - design from the description instead)`;
	return `${heading}\n${clamp(snap.text, MAX_SNAPSHOT_CHARS)}`;
}

type Snapshot =
	| { kind: "text"; mime: string; text: string }
	| { kind: "binary"; mime: string };

async function fetchSnapshot(url: string): Promise<Snapshot> {
	const response = await fetch(url, {
		headers: {
			"user-agent": USER_AGENT,
			accept: "text/*,application/xhtml+xml",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		redirect: "follow",
	});
	if (!response.ok)
		throw new Error(`HTTP ${response.status} for referenced page`);
	const mime =
		response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
		"application/octet-stream";
	const reader = response.body?.getReader();
	if (!reader) return { kind: "binary", mime };
	const chunks: string[] = [];
	let received = 0;
	const decoder = new TextDecoder("utf-8", { fatal: false });
	for (;;) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		received += value.byteLength;
		chunks.push(decoder.decode(value, { stream: true }));
		if (received >= MAX_BYTES) break;
	}
	await reader.cancel().catch(() => undefined);
	if (mime === "text/html" || mime.endsWith("+xml")) {
		return { kind: "text", mime, text: htmlToText(chunks.join("")) };
	}
	if (mime.startsWith("text/") || mime === "application/json")
		return { kind: "text", mime, text: chunks.join("") };
	return { kind: "binary", mime };
}

/**
 * The instruction block the prompts append: tells the model the fetching is
 * already done and forbids tool use, so "clone" requests stay shell-free.
 */
export function referencedUrlBlock(snapshots: string): string {
	if (!snapshots.trim()) return "";
	return `\n\n## Referenced URLs (already fetched for you)\n${snapshots}\nUse these snapshots as the visual/content reference and never try to fetch, open, or inspect them yourself: tool use is unavailable and will be denied.`;
}
