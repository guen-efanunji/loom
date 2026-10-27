import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, repositories } from "@loom/db";
import type {
	AgentRunStatus,
	AgentRuntime,
	RuntimeOutput,
} from "@loom/opencode";
import type { DesignNode } from "@loom/protocol";
import type { RuntimePermission } from "@loom/providers/core";
import type { DaemonConfig } from "../src/config";
import { createApp } from "../src/index";

/**
 * Canvas lifecycle E2E: drives the real daemon API and the real DesignService
 * against a scripted agent runtime. It locks the three things that broke in
 * production: a first generation must reach `ready`, a refine must land on the
 * same node, and the design run must never be offered tools that headless Agy
 * would hold for an approval nobody is watching for.
 */

const config: DaemonConfig = {
	port: 4322,
	corsOrigin: "http://localhost:5173",
	token: "lifecycle-token",
};
const headers = {
	Authorization: "Bearer lifecycle-token",
	"Content-Type": "application/json",
};

type DesignRuntimeResult = Exclude<
	AgentRunStatus,
	"queued" | "running" | "waiting_permission"
>;

const PLAIN_DESIGN = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Studio</title>
<style>
body{margin:0;background:#14160f;color:#f1ecdd;font:14px system-ui}
h1{font-size:28px}
a{display:block;padding:12px;border:1px solid #d8eba3;border-radius:8px;color:inherit;text-decoration:none}
</style>
</head><body><h1>Suelen Bezerra</h1><a href="#">Agendamento</a><a href="#">Procedimentos</a></body></html>`;

const ANIMATED_DESIGN = PLAIN_DESIGN.replace(
	"<style>",
	`<style>
a{transition:transform .35s cubic-bezier(.2,.8,.2,1),background-color .3s}
a:hover{background:#d8eba312;transform:translateY(-2px)}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
h1{animation:rise .6s ease both}
`,
);

class ScriptedRuntime implements AgentRuntime {
	readonly prompts: string[] = [];
	readonly permissions: Array<RuntimePermission | undefined> = [];
	readonly sessions: Array<{ cwd: string; readOnly?: boolean }> = [];
	private readonly replies: string[] = [];

	queue(...outputs: string[]) {
		this.replies.push(...outputs);
	}

	async createSession(input: {
		cwd: string;
		title: string;
		readOnly?: boolean;
	}) {
		this.sessions.push({ cwd: input.cwd, readOnly: input.readOnly });
		return { id: `lifecycle-session-${this.sessions.length}` };
	}

	async prompt(input: {
		sessionId: string;
		prompt: string;
		permission?: RuntimePermission;
	}) {
		this.prompts.push(input.prompt);
		this.permissions.push(input.permission);
	}

	async status(): Promise<AgentRunStatus> {
		return "completed";
	}

	async readOutput(): Promise<RuntimeOutput> {
		return { output: this.replies.shift() ?? PLAIN_DESIGN };
	}

	async wait(): Promise<DesignRuntimeResult> {
		return "completed";
	}

	async abort(): Promise<void> {}

	async getDiff() {
		return [];
	}
}

async function waitForNode(
	app: Awaited<ReturnType<typeof createApp>>["app"],
	id: string,
): Promise<DesignNode> {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		const node = (await (
			await app.request(`/api/designs/${id}`, { headers })
		).json()) as DesignNode;
		if (node.status === "ready" || node.status === "failed") return node;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("The canvas node never finished");
}

async function withDaemon(
	run: (fixture: {
		app: Awaited<ReturnType<typeof createApp>>["app"];
		projectId: string;
		runtime: ScriptedRuntime;
	}) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), "loom-canvas-lifecycle-"));
	await writeFile(join(root, "package.json"), '{"name":"studio"}');
	const home = await mkdtemp(join(tmpdir(), "loom-canvas-home-"));
	const database = createDb({ DATABASE_URL: `file:${join(home, "state.db")}` });
	const repos = repositories(database);
	const project = await repos.projects.create({
		id: "lifecycle-project",
		name: "studio",
		path: root,
		defaultBranch: "main",
	});
	const runtime = new ScriptedRuntime();
	const daemon = await createApp({
		config,
		database,
		designRuntime: runtime,
		startOpenCode: false,
	});
	try {
		await run({ app: daemon.app, projectId: project.id, runtime });
	} finally {
		await daemon.close();
		await rm(root, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
}

async function createDesign(
	app: Awaited<ReturnType<typeof createApp>>["app"],
	projectId: string,
	brief: string,
) {
	const response = await app.request("/api/designs", {
		method: "POST",
		headers,
		body: JSON.stringify({ projectId, brief }),
	});
	expect(response.status).toBe(202);
	return (await response.json()) as { nodeId: string };
}

describe("canvas generate and refine lifecycle", () => {
	test("the first generation reaches ready without needing a tool approval", async () =>
		await withDaemon(async ({ app, projectId, runtime }) => {
			runtime.queue(PLAIN_DESIGN);
			const { nodeId } = await createDesign(
				app,
				projectId,
				"Buatkan halaman link studio nail art bergaya After Hours",
			);
			const node = await waitForNode(app, nodeId);

			expect(node.status).toBe("ready");
			expect(node.html).toContain("Suelen Bezerra");
			expect(node.errorMessage).toBeNull();

			// The run must be tool-free: an offered tool means headless Agy holds
			// it for an approval and the whole generation dies on a denial.
			expect(runtime.permissions[0]?.mode).toBe("read-only");

			// The coding-agent prompt invites shell exploration, so it must never
			// ride along with a canvas design.
			expect(runtime.prompts[0]).not.toContain("Coding Agent Instructions");
			expect(runtime.prompts[0]).toContain(
				"Do not call tools, run shell commands, read or write files",
			);
			expect(runtime.prompts[0]).toContain("Canvas:");
		}));

	test("a refine lands on the same node and keeps the hover animation", async () =>
		await withDaemon(async ({ app, projectId, runtime }) => {
			runtime.queue(PLAIN_DESIGN, ANIMATED_DESIGN);
			const { nodeId } = await createDesign(
				app,
				projectId,
				"Buatkan halaman link studio nail art",
			);
			expect((await waitForNode(app, nodeId)).status).toBe("ready");

			const refined = await app.request(`/api/designs/${nodeId}/refine`, {
				method: "POST",
				headers,
				body: JSON.stringify({ message: "kasih animasi ketika di hover ya" }),
			});
			expect(refined.status).toBe(202);
			const node = await waitForNode(app, nodeId);

			expect(node.status).toBe("ready");
			expect(node.errorMessage).toBeNull();
			// Animation survives the round trip into the canvas document.
			expect(node.html).toContain("transition:transform");
			expect(node.html).toContain("@keyframes rise");
			expect(node.html).toContain("a:hover");

			// Refine updates in place - it must not spawn a duplicate card.
			const thread = (await (
				await app.request(`/api/projects/${projectId}/designs`, { headers })
			).json()) as { nodes: DesignNode[] };
			expect(thread.nodes.map((item) => item.id)).toEqual([nodeId]);

			const prompt = runtime.prompts[1] ?? "";
			expect(prompt).toContain("kasih animasi ketika di hover ya");
			expect(prompt).toContain("<!DOCTYPE html>");
			expect(prompt).not.toContain("Coding Agent Instructions");
			expect(runtime.permissions[1]?.mode).toBe("read-only");
		}));

	test("a canvas size stated by the model reshapes the node", async () =>
		await withDaemon(async ({ app, projectId, runtime }) => {
			runtime.queue(
				`<!-- design: Nail studio story | 1080x1920 -->\n${PLAIN_DESIGN}`,
			);
			const { nodeId } = await createDesign(
				app,
				projectId,
				"Buatkan story promosi studio nail art 9:16",
			);
			const node = await waitForNode(app, nodeId);

			expect(node.status).toBe("ready");
			expect(node.title).toBe("Nail studio story");
			expect(node.frameWidth).toBe(1080);
			expect(node.frameHeight).toBe(1920);
			expect(node.viewport).toBe("mobile");
			// The card follows the canvas ratio instead of letterboxing it.
			expect(node.width / node.height).toBeCloseTo(1080 / 1920, 1);
		}));

	test("a size written in the brief is honoured even without a marker", async () =>
		await withDaemon(async ({ app, projectId, runtime }) => {
			runtime.queue(PLAIN_DESIGN);
			const { nodeId } = await createDesign(
				app,
				projectId,
				"Buatkan poster promo 1080x1350 untuk studio",
			);
			const node = await waitForNode(app, nodeId);

			expect(node.status).toBe("ready");
			expect(node.frameWidth).toBe(1080);
			expect(node.frameHeight).toBe(1350);
			expect(node.frameKind).toBe("poster");
		}));
});
