import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Database } from "@loom/db";
import {
	and,
	contextEntries,
	contextMemoryDecisions,
	contextMemoryEvidence,
	contextVersions,
	desc,
	eq,
	isNull,
	or,
} from "@loom/db";
import { Hono } from "hono";
import { z } from "zod";

type Project = { id: string; name: string; path: string };
type Options = {
	db: Database;
	projects: { getById(id: string): Promise<Project | undefined> };
};

const contentLimit = 256_000;
const skillLimit = 64_000;
const skillDirectoriesPerRoot = 100;
const discoveredSkillsLimit = 250;
const surfaces = ["chat", "kanban", "canvas", "review", "walkthrough"] as const;
const kinds = ["knowledge", "rule", "skill", "memory"] as const;

const entryInput = z.object({
	kind: z.enum(kinds),
	projectId: z.string().nullable().optional(),
	scope: z.enum(["global", "project"]),
	title: z.string().trim().min(1).max(160),
	description: z.string().max(2_000).default(""),
	content: z.string().max(contentLimit),
	sourceRef: z
		.string()
		.trim()
		.max(1_000)
		.refine(
			(value) => !/^(?:[a-z][a-z\d+.-]*:\/\/|\/|\\\\|[a-z]:[\\/])/i.test(value),
			"Use a relative file path or non-URL source identifier",
		)
		.refine(
			(value) =>
				!/[\r\n]|\b(?:bearer\s+|(?:api[_-]?key|token|password|secret)=)/i.test(
					value,
				),
			"Source references cannot contain credentials or line breaks",
		)
		.nullable()
		.optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
	surfaces: z.array(z.enum(surfaces)).max(surfaces.length).default([]),
	pathGlobs: z.array(z.string().trim().min(1).max(240)).max(40).default([]),
	status: z
		.enum([
			"active",
			"disabled",
			"proposed",
			"approved",
			"stale",
			"archived",
			"rejected",
		])
		.optional(),
	enabledInLoom: z.boolean().optional(),
});

function hash(content: string) {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function versionMetadata(input: z.infer<typeof entryInput>, status: string) {
	return JSON.stringify({
		kind: input.kind,
		title: input.title,
		description: input.description,
		scope: input.scope,
		projectId: input.projectId ?? null,
		sourceRef: input.sourceRef ?? null,
		surfaces: input.surfaces,
		pathGlobs: input.pathGlobs,
		tags: input.tags,
		status,
	});
}

function parseJsonArray(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function publicEntry(entry: typeof contextEntries.$inferSelect) {
	return {
		...entry,
		tags: parseJsonArray(entry.tags),
		surfaces: parseJsonArray(entry.surfaces),
		pathGlobs: parseJsonArray(entry.pathGlobs),
	};
}

function safeRelativePath(root: string, candidate: string) {
	const path = relative(root, candidate);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

function frontmatterScalar(header: string, key: string) {
	const raw =
		header.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
	if (
		raw.length >= 2 &&
		raw[0] === raw.at(-1) &&
		(raw[0] === "'" || raw[0] === '"')
	) {
		if (raw[0] === '"') {
			try {
				return JSON.parse(raw) as string;
			} catch {
				return raw.slice(1, -1);
			}
		}
		return raw.slice(1, -1).replace(/''/g, "'");
	}
	return raw.replace(/\s+#.*$/, "").trim();
}

type SkillRoot = {
	path: string;
	label: string;
	runtimeId: "claude" | "codex" | "opencode";
	scope: "global" | "project";
};

function skillRoots(project: Project | undefined): SkillRoot[] {
	const home = homedir();
	const roots: SkillRoot[] = [
		{
			path: join(home, ".claude", "skills"),
			label: "~/.claude/skills",
			runtimeId: "claude",
			scope: "global",
		},
		{
			path: join(home, ".agents", "skills"),
			label: "~/.agents/skills",
			runtimeId: "codex",
			scope: "global",
		},
		{
			path: join(
				process.env.XDG_CONFIG_HOME || join(home, ".config"),
				"opencode",
				"skills",
			),
			label: "OpenCode user skills",
			runtimeId: "opencode",
			scope: "global",
		},
	];
	if (project) {
		roots.push(
			{
				path: join(project.path, ".claude", "skills"),
				label: "<project>/.claude/skills",
				runtimeId: "claude",
				scope: "project",
			},
			{
				path: join(project.path, ".agents", "skills"),
				label: "<project>/.agents/skills",
				runtimeId: "codex",
				scope: "project",
			},
			{
				path: join(project.path, ".opencode", "skills"),
				label: "<project>/.opencode/skills",
				runtimeId: "opencode",
				scope: "project",
			},
			{
				path: join(project.path, ".claude", "skills"),
				label: "OpenCode-compatible <project>/.claude/skills",
				runtimeId: "opencode",
				scope: "project",
			},
			{
				path: join(project.path, ".agents", "skills"),
				label: "OpenCode-compatible <project>/.agents/skills",
				runtimeId: "opencode",
				scope: "project",
			},
		);
	}
	return roots;
}

async function discoverSkills(project: Project | undefined) {
	const sources: Array<{
		id: string;
		label: string;
		runtimeId: string;
		scope: string;
		status: string;
		issue?: string;
		truncated?: boolean;
	}> = [];
	const skills = new Map<
		string,
		{
			id: string;
			name: string;
			description: string;
			content: string;
			valid: boolean;
			issues: string[];
			compatibility: string[];
			origins: Array<{ source: string; runtimeId: string; scope: string }>;
		}
	>();
	for (const root of skillRoots(project)) {
		const sourceId = `${root.runtimeId}:${root.scope}:${root.label}`;
		let canonicalRoot: string;
		let dirs: Array<{
			name: string;
			isDirectory(): boolean;
			isSymbolicLink(): boolean;
		}>;
		let source: (typeof sources)[number];
		try {
			const rootStat = await lstat(root.path);
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
				throw new Error("Skill directory is not a regular directory");
			canonicalRoot = await realpath(root.path);
			const allDirs = await readdir(root.path, { withFileTypes: true });
			dirs = allDirs.slice(0, skillDirectoriesPerRoot);
			source = {
				id: sourceId,
				label: root.label,
				runtimeId: root.runtimeId,
				scope: root.scope,
				status: "available",
				truncated: allDirs.length > dirs.length,
			};
			sources.push(source);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			sources.push({
				id: sourceId,
				label: root.label,
				runtimeId: root.runtimeId,
				scope: root.scope,
				status: code === "ENOENT" ? "not-found" : "unavailable",
				...(code && code !== "ENOENT"
					? { issue: "Unable to read this configured skill source" }
					: {}),
			});
			continue;
		}
		for (const dir of dirs) {
			if (skills.size >= discoveredSkillsLimit) {
				source.truncated = true;
				break;
			}
			if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
			const directory = join(root.path, dir.name);
			const file = join(directory, "SKILL.md");
			try {
				const [directoryPath, fileStat] = await Promise.all([
					realpath(directory),
					lstat(file),
				]);
				if (
					!safeRelativePath(canonicalRoot, directoryPath) ||
					!fileStat.isFile() ||
					fileStat.isSymbolicLink() ||
					fileStat.size > skillLimit
				)
					continue;
				const canonicalFile = await realpath(file);
				if (!safeRelativePath(canonicalRoot, canonicalFile)) continue;
				const content = await readFile(file, "utf8");
				const frontmatter = content.match(
					/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
				);
				const header = frontmatter?.[1] ?? "";
				const name = frontmatterScalar(header, "name");
				const description = frontmatterScalar(header, "description");
				const issues = [
					!frontmatter ? "Missing or malformed YAML frontmatter" : "",
					!name ? "Missing skill name" : "",
					name.length > 64 ? "Skill name exceeds 64 characters" : "",
					!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name
						? "Skill name must use lowercase letters, numbers, and single hyphens"
						: "",
					!description ? "Missing skill description" : "",
					description.length > 1024
						? "Skill description exceeds 1024 characters"
						: "",
				].filter(Boolean);
				const current = skills.get(canonicalFile);
				const origin = {
					source: root.label,
					runtimeId: root.runtimeId,
					scope: root.scope,
				};
				if (current) {
					current.origins.push(origin);
					current.compatibility.push(root.runtimeId);
				} else {
					skills.set(canonicalFile, {
						id: hash(canonicalFile).slice(0, 24),
						name: name || dir.name,
						description,
						content,
						valid: issues.length === 0,
						issues,
						compatibility: [root.runtimeId],
						origins: [origin],
					});
				}
			} catch {
				// Missing, inaccessible, unsafe, and oversized skill files are skipped without failing the other roots.
			}
		}
	}
	return {
		projectId: project?.id ?? null,
		coverage: {
			maxDirectoriesPerSource: skillDirectoriesPerRoot,
			maxDiscoveredSkills: discoveredSkillsLimit,
			maxSkillBytes: skillLimit,
			truncatedSources: sources.filter((source) => source.truncated).length,
		},
		sources,
		skills: [...skills.values()]
			.map((skill) => ({
				...skill,
				compatibility: [...new Set(skill.compatibility)],
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

export function createContextHubRoutes(options: Options) {
	const app = new Hono();
	const db = options.db;

	app.get("/entries", async (c) => {
		const projectId = c.req.query("projectId");
		if (projectId && !(await options.projects.getById(projectId)))
			return c.json({ error: { message: "Project not found" } }, 404);
		const rows = await db
			.select()
			.from(contextEntries)
			.where(
				and(
					eq(contextEntries.userId, "local"),
					projectId
						? or(
								isNull(contextEntries.projectId),
								eq(contextEntries.projectId, projectId),
							)
						: isNull(contextEntries.projectId),
				),
			)
			.orderBy(desc(contextEntries.updatedAt));
		return c.json(rows.map(publicEntry));
	});

	app.get("/discover", async (c) => {
		const projectId = c.req.query("projectId");
		let project: Project | undefined;
		if (projectId) {
			project = await options.projects.getById(projectId);
			if (!project)
				return c.json({ error: { message: "Project not found" } }, 404);
		}
		return c.json(await discoverSkills(project));
	});

	app.get("/entries/:id/versions", async (c) => {
		const entry = await db.query.contextEntries.findFirst({
			where: and(
				eq(contextEntries.id, c.req.param("id")),
				eq(contextEntries.userId, "local"),
			),
		});
		if (!entry)
			return c.json({ error: { message: "Context entry not found" } }, 404);
		const versions = await db
			.select()
			.from(contextVersions)
			.where(eq(contextVersions.entryId, entry.id))
			.orderBy(desc(contextVersions.version));
		return c.json(versions);
	});

	app.get("/entries/:id/memory-history", async (c) => {
		const entry = await db.query.contextEntries.findFirst({
			where: and(
				eq(contextEntries.id, c.req.param("id")),
				eq(contextEntries.userId, "local"),
				eq(contextEntries.kind, "memory"),
			),
		});
		if (!entry)
			return c.json({ error: { message: "Memory entry not found" } }, 404);
		const [decisions, evidence] = await Promise.all([
			db
				.select()
				.from(contextMemoryDecisions)
				.where(eq(contextMemoryDecisions.entryId, entry.id))
				.orderBy(desc(contextMemoryDecisions.createdAt)),
			db
				.select()
				.from(contextMemoryEvidence)
				.where(eq(contextMemoryEvidence.entryId, entry.id))
				.orderBy(desc(contextMemoryEvidence.createdAt)),
		]);
		return c.json({ decisions, evidence });
	});

	app.post("/entries", async (c) => {
		const parsed = entryInput.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success)
			return c.json(
				{
					error: {
						message: "Invalid context entry",
						issues: parsed.error.issues,
					},
				},
				400,
			);
		const input = parsed.data;
		if ((input.scope === "project") !== !!input.projectId)
			return c.json(
				{
					error: {
						message:
							"Project scope requires a project; global scope cannot target one",
					},
				},
				400,
			);
		if (
			input.kind === "memory" &&
			input.status &&
			!["proposed", "approved", "stale", "archived", "rejected"].includes(
				input.status,
			)
		)
			return c.json({ error: { message: "Invalid memory status" } }, 400);
		if (input.projectId && !(await options.projects.getById(input.projectId)))
			return c.json({ error: { message: "Project not found" } }, 404);
		const status =
			input.kind === "memory"
				? (input.status ?? "proposed")
				: input.status === "disabled"
					? "disabled"
					: "active";
		const id = randomUUID();
		const contentHash = hash(input.content);
		const now = new Date();
		await db.transaction(async (tx) => {
			await tx.insert(contextEntries).values({
				id,
				userId: "local",
				projectId: input.projectId ?? null,
				kind: input.kind,
				title: input.title,
				description: input.description,
				content: input.content,
				scope: input.scope,
				sourceKind: "authored",
				sourceRef: input.sourceRef || null,
				compatibility: input.kind === "skill" ? "untested" : "not-applicable",
				status,
				enabledInLoom:
					input.kind === "memory"
						? status === "approved" && input.enabledInLoom === true
						: (input.enabledInLoom ?? true),
				surfaces: JSON.stringify(input.surfaces),
				pathGlobs: JSON.stringify(input.pathGlobs),
				tags: JSON.stringify(input.tags),
				contentHash,
				currentVersion: 1,
				createdAt: now,
				updatedAt: now,
			});
			await tx.insert(contextVersions).values({
				id: randomUUID(),
				entryId: id,
				version: 1,
				content: input.content,
				contentHash,
				metadata: versionMetadata(input, status),
				createdAt: now,
			});
			if (input.kind === "memory")
				await tx.insert(contextMemoryDecisions).values({
					id: randomUUID(),
					entryId: id,
					version: 1,
					proposedBy: "local",
					decidedBy: status === "proposed" ? null : "local",
					decision: status,
				});
			if (input.kind === "memory" && input.sourceRef)
				await tx.insert(contextMemoryEvidence).values({
					id: randomUUID(),
					entryId: id,
					sourceType: "user_supplied_reference",
					sourceId: input.sourceRef,
					verificationStatus: "unverified",
				});
		});
		const row = await db.query.contextEntries.findFirst({
			where: eq(contextEntries.id, id),
		});
		return c.json(row ? publicEntry(row) : null, 201);
	});

	app.put("/entries/:id", async (c) => {
		const body = (await c.req.json().catch(() => null)) as {
			expectedVersion?: unknown;
		} | null;
		if (
			!body ||
			!Number.isInteger(body.expectedVersion) ||
			Number(body.expectedVersion) < 1
		)
			return c.json(
				{ error: { message: "A valid expectedVersion is required" } },
				400,
			);
		const parsed = entryInput.safeParse(body);
		if (!parsed.success)
			return c.json(
				{
					error: {
						message: "Invalid context entry",
						issues: parsed.error.issues,
					},
				},
				400,
			);
		const input = parsed.data;
		if ((input.scope === "project") !== !!input.projectId)
			return c.json(
				{
					error: {
						message:
							"Project scope requires a project; global scope cannot target one",
					},
				},
				400,
			);
		if (
			input.kind === "memory" &&
			input.status &&
			!["proposed", "approved", "stale", "archived", "rejected"].includes(
				input.status,
			)
		)
			return c.json({ error: { message: "Invalid memory status" } }, 400);
		if (input.projectId && !(await options.projects.getById(input.projectId)))
			return c.json({ error: { message: "Project not found" } }, 404);
		const id = c.req.param("id");
		let conflict = false;
		await db.transaction(async (tx) => {
			const current = await tx.query.contextEntries.findFirst({
				where: and(
					eq(contextEntries.id, id),
					eq(contextEntries.userId, "local"),
				),
			});
			if (!current) return;
			if (current.currentVersion !== Number(body.expectedVersion)) {
				conflict = true;
				return;
			}
			const contentHash = hash(input.content);
			const contentChanged = contentHash !== current.contentHash;
			const status =
				input.kind === "memory"
					? (input.status ?? current.status)
					: input.status === "disabled"
						? "disabled"
						: "active";
			const metadata = versionMetadata(input, status);
			const previousMetadata = versionMetadata(
				{
					kind: current.kind as (typeof kinds)[number],
					title: current.title,
					description: current.description,
					content: current.content,
					scope: current.scope as "global" | "project",
					projectId: current.projectId,
					sourceRef: current.sourceRef,
					surfaces: parseJsonArray(
						current.surfaces,
					) as (typeof surfaces)[number][],
					pathGlobs: parseJsonArray(current.pathGlobs),
					tags: parseJsonArray(current.tags),
				},
				current.status,
			);
			const versionChanged = contentChanged || metadata !== previousMetadata;
			const version = current.currentVersion + (versionChanged ? 1 : 0);
			const now = new Date();
			await tx
				.update(contextEntries)
				.set({
					projectId: input.projectId ?? null,
					kind: input.kind,
					title: input.title,
					description: input.description,
					content: input.content,
					scope: input.scope,
					sourceRef: input.sourceRef || null,
					compatibility: input.kind === "skill" ? "untested" : "not-applicable",
					status,
					enabledInLoom:
						input.kind === "memory"
							? status === "approved" && input.enabledInLoom === true
							: (input.enabledInLoom ?? current.enabledInLoom),
					surfaces: JSON.stringify(input.surfaces),
					pathGlobs: JSON.stringify(input.pathGlobs),
					tags: JSON.stringify(input.tags),
					contentHash,
					currentVersion: version,
					updatedAt: now,
				})
				.where(
					and(
						eq(contextEntries.id, id),
						eq(contextEntries.currentVersion, Number(body.expectedVersion)),
					),
				);
			if (versionChanged)
				await tx.insert(contextVersions).values({
					id: randomUUID(),
					entryId: id,
					version,
					content: input.content,
					contentHash,
					metadata,
					createdAt: now,
				});
			if (current.kind === "memory" && status !== current.status)
				await tx.insert(contextMemoryDecisions).values({
					id: randomUUID(),
					entryId: id,
					version,
					proposedBy: "local",
					decidedBy: "local",
					decision: status,
				});
			if (input.kind === "memory") {
				await tx
					.delete(contextMemoryEvidence)
					.where(eq(contextMemoryEvidence.entryId, id));
				if (input.sourceRef)
					await tx.insert(contextMemoryEvidence).values({
						id: randomUUID(),
						entryId: id,
						sourceType: "user_supplied_reference",
						sourceId: input.sourceRef,
						verificationStatus: "unverified",
					});
			}
		});
		if (conflict)
			return c.json(
				{
					error: {
						message:
							"Context entry changed since it was opened; refresh before saving",
					},
				},
				409,
			);
		const row = await db.query.contextEntries.findFirst({
			where: and(eq(contextEntries.id, id), eq(contextEntries.userId, "local")),
		});
		return row
			? c.json(publicEntry(row))
			: c.json({ error: { message: "Context entry not found" } }, 404);
	});

	app.delete("/entries/:id", async (c) => {
		const existing = await db.query.contextEntries.findFirst({
			where: and(
				eq(contextEntries.id, c.req.param("id")),
				eq(contextEntries.userId, "local"),
				eq(contextEntries.sourceKind, "authored"),
			),
		});
		if (!existing)
			return c.json(
				{ error: { message: "Authored context entry not found" } },
				404,
			);
		await db.delete(contextEntries).where(eq(contextEntries.id, existing.id));
		return c.body(null, 204);
	});

	return app;
}
