import { execFile } from "node:child_process";
import { readdir, open, realpath, stat } from "node:fs/promises";
import { join, sep, relative, isAbsolute } from "node:path";

export type ProjectContext = {
	projectName: string;
	/** Absolute path to the opened project folder the agent is designing for. */
	projectPath?: string;
	stack: string[];
	packageManager?: string;
	files: string[];
	/** Project files actually opened to build this context (theme, config, docs). */
	readFiles?: string[];
	scripts: Record<string, string>;
	conventions?: string;
	currentBranch?: string;
	/** Design tokens (CSS variables / tailwind theme) scraped from the repo. */
	theme?: string;
};

const IGNORED = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".svelte-kit",
	"coverage",
	"vendor",
	".next",
	".turbo",
]);

const STACK_SIGNALS: Array<{ file: string; stack: string }> = [
	{ file: "package.json", stack: "node" },
	{ file: "svelte.config.js", stack: "sveltekit" },
	{ file: "next.config.js", stack: "nextjs" },
	{ file: "astro.config.mjs", stack: "astro" },
	{ file: "pyproject.toml", stack: "python" },
	{ file: "go.mod", stack: "go" },
	{ file: "Cargo.toml", stack: "rust" },
	{ file: "Gemfile", stack: "ruby" },
];

async function walk(
	root: string,
	dir: string,
	depth: number,
	out: string[],
	limit: number,
): Promise<void> {
	if (depth > 4 || out.length >= limit) return;
	let entries: import("node:fs").Dirent<string>[] = [];
	try {
		entries = await readdir(join(root, dir), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (out.length >= limit) return;
		if (IGNORED.has(entry.name)) continue;
		if (entry.isSymbolicLink() || entry.name.startsWith(".env")) continue;
		const rel = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			await walk(root, rel, depth + 1, out, limit);
		} else {
			out.push(rel.split(sep).join("/"));
			if (out.length >= limit) return;
		}
	}
}

async function readBounded(
	path: string,
	limit: number,
	root?: string,
): Promise<string | undefined> {
	try {
		if (root) {
			const rel = relative(await realpath(root), await realpath(path));
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
		}
		const info = await stat(path);
		if (!info.isFile()) return undefined;
		const file = await open(path, "r");
		try { const buffer = Buffer.alloc(limit); const { bytesRead } = await file.read(buffer, 0, limit, 0); return buffer.subarray(0, bytesRead).toString("utf8"); }
		finally { await file.close(); }
	} catch {
		return undefined;
	}
}

function git(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd }, (error, stdout) => {
			resolve(error ? "" : stdout.trim());
		});
	});
}

function detectPackageManager(
	pkg: Record<string, unknown>,
): string | undefined {
	const manager =
		typeof pkg.packageManager === "string"
			? pkg.packageManager.split("@")[0]
			: "";
	return manager || undefined;
}

const THEME_FILE = /\.(css)$|tailwind\.config\.(js|cjs|mjs|ts)$|components\.json$/i;

/** Keep only the lines that actually carry design tokens from a CSS file. */
function cssTokens(css: string): string {
	return css
		.split("\n")
		.filter((line) => {
			const t = line.trim();
			if (!t) return false;
			return (
				/--[\w-]+\s*:/.test(t) ||
				/(^|\s)(:root|\.dark|html|body)\b/.test(t) ||
				/@theme\b/.test(t) ||
				/font-family\s*:/i.test(t)
			);
		})
		.join("\n");
}

/**
 * Scrapes the project's real theme so design mockups match the product instead
 * of inventing a palette. Reads CSS files (shadcn-style `--token` variables),
 * the tailwind config, and components.json, bounded to a small budget.
 */
async function collectTheme(
	root: string,
	files: string[],
	read: Set<string>,
): Promise<string | undefined> {
	const candidates = files.filter(
		(file) => THEME_FILE.test(file) && !/\.min\.css$/i.test(file),
	);
	const parts: string[] = [];
	let budget = 6000;
	for (const rel of candidates) {
		if (budget <= 0) break;
		const raw = await readBounded(
			join(root, rel),
			Math.min(8000, budget + 2000),
			root,
		);
		if (!raw) continue;
		read.add(rel);
		const body = /\.css$/i.test(rel) ? cssTokens(raw) : raw;
		const trimmed = body.trim();
		if (trimmed.length < 20) continue;
		const slice = trimmed.slice(0, budget);
		parts.push(`### ${rel}\n${slice}`);
		budget -= slice.length;
	}
	if (!parts.length) return undefined;
	return parts.join("\n\n").slice(0, 6000);
}

export async function buildAutomationContext(
	projectPath: string,
	projectName: string,
): Promise<ProjectContext> {
	const readFiles = new Set<string>();
	const pkgRaw = await readBounded(join(projectPath, "package.json"), 32000, projectPath);
	if (pkgRaw) readFiles.add("package.json");
	let pkg: Record<string, unknown> = {};
	try {
		if (pkgRaw) pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
	} catch {}
	const stack = new Set<string>();
	for (const signal of STACK_SIGNALS) {
		try {
			await stat(join(projectPath, signal.file));
			stack.add(signal.stack);
			readFiles.add(signal.file);
		} catch {}
	}
	const deps = {
		...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
		...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
	};
	for (const name of Object.keys(deps)) {
		if (name.includes("react")) stack.add("react");
		if (name.includes("svelte")) stack.add("svelte");
		if (name.includes("vue")) stack.add("vue");
		if (name.includes("drizzle")) stack.add("drizzle-orm");
		if (name.includes("hono")) stack.add("hono");
	}
	const files: string[] = [];
	await walk(projectPath, "", 0, files, 200);
	const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
	const [conventions, currentBranch] = await Promise.all([
		Promise.all(["AGENTS.md", "README.md", ".loom/conventions.md"].map(async name => {
			const text = await readBounded(join(projectPath, name), 4000, projectPath);
			if (text) readFiles.add(name);
			return text ? `${name}:\n${text}` : "";
		})).then(parts => parts.filter(Boolean).join("\n\n")),
		git(["branch", "--show-current"], projectPath),
	]);
	const context: ProjectContext = {
		projectName,
		projectPath,
		stack: [...stack].sort(),
		files,
		readFiles: [...readFiles],
		scripts: Object.fromEntries(Object.entries(scripts).slice(0, 30)),
	};
	const packageManager = detectPackageManager(pkg);
	if (packageManager) context.packageManager = packageManager;
	if (conventions) context.conventions = conventions;
	if (currentBranch) context.currentBranch = currentBranch;
	const theme = await collectTheme(projectPath, files, readFiles);
	context.readFiles = [...readFiles];
	if (theme) context.theme = theme;
	return context;
}
