import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "@loom/worktree";
import {
	MergeConflictError,
	WorktreeError,
	WorktreeManager,
} from "@loom/worktree";
import { type ChatWorkspaceRecord, createChatRoutes } from "../src/chat";

type FakeSession = {
	id: string;
	directory: string;
	title: string;
	time: { updated: number };
};

/**
 * Exercises chat workspace isolation against a fake OpenCode gateway and a fake
 * worktree manager, so the conflict guarantees are tested without Git or models.
 */
async function harness(
	options: {
		/** A different session in the project checkout that is currently running. */
		busySessionInRoot?: boolean;
		workspaceClean?: boolean;
		conflictOnMerge?: boolean;
		dirtyOnRemove?: boolean;
		/** False while the branch head has not been integrated into the target. */
		integrated?: boolean;
	} = {},
) {
	const base = await mkdtemp(join(tmpdir(), "loom-chat-workspace-"));
	const projectPath = join(base, "repo");
	await mkdir(projectPath, { recursive: true });
	await writeFile(join(projectPath, "README.md"), "root\n");

	const sessions = new Map<string, FakeSession>();
	const statuses = new Map<string, { type: string }>();
	const bindings = new Map<string, ChatWorkspaceRecord>();
	const calls: string[] = [];
	let nextId = 0;
	if (options.busySessionInRoot) {
		sessions.set("ses_other", {
			id: "ses_other",
			directory: projectPath,
			title: "Backend chat",
			time: { updated: 1 },
		});
		statuses.set("ses_other", { type: "busy" });
	}

	const app = createChatRoutes({
		projects: {
			list: async () => [{ id: "p1", path: projectPath }],
			getById: async (id) => (id === "p1" ? { path: projectPath } : null),
		},
		request: async <T>(
			path: string,
			opts: { directory?: string; body?: unknown; method?: string } = {},
		): Promise<T> => {
			calls.push(`${opts.method ?? "GET"} ${path}`);
			const directory = opts.directory ?? "";
			if (path.startsWith("/session?limit")) {
				return [...sessions.values()].filter(
					(item) => item.directory === directory,
				) as T;
			}
			// Creating a session carries a body, so the gateway marks it POST.
			if (path === "/session") {
				nextId += 1;
				const created: FakeSession = {
					id: `ses_${nextId}`,
					directory,
					title: String((opts.body as { title?: string })?.title ?? "Chat"),
					time: { updated: Date.now() },
				};
				sessions.set(created.id, created);
				return created as T;
			}
			if (path === "/session/status") return Object.fromEntries(statuses) as T;
			const single = /^\/session\/(ses_[\w-]+)$/.exec(path);
			if (single) {
				const found = sessions.get(single[1]!);
				if (!found || found.directory !== directory)
					throw { details: { status: "404" }, message: "not found" };
				return found as T;
			}
			return true as T;
		},
		chatWorkspaces: {
			getBySessionId: async (sessionId) => bindings.get(sessionId),
			listByProject: async () =>
				[...bindings.values()].filter((item) => item.status === "active"),
			create: async (input) => {
				const record: ChatWorkspaceRecord = {
					sessionId: input.sessionId,
					projectId: input.projectId,
					taskId: input.taskId,
					path: input.path,
					branch: input.branch,
					baseCommit: input.baseCommit,
					status: "active",
				};
				bindings.set(record.sessionId, record);
				return record;
			},
			update: async (sessionId, input) => {
				const current = bindings.get(sessionId);
				if (current) bindings.set(sessionId, { ...current, ...input });
			},
			delete: async (sessionId) => {
				bindings.delete(sessionId);
			},
		},
		worktrees: {
			create: async (input): Promise<Workspace> => {
				calls.push(`worktree:create:${input.taskId}`);
				const path = join(base, "worktrees", input.taskId);
				await mkdir(path, { recursive: true });
				await writeFile(join(path, "README.md"), "branch copy\n");
				return {
					id: input.taskId,
					taskId: input.taskId,
					projectId: input.projectId,
					projectPath: input.projectPath,
					path,
					branch: `loom/${input.taskId}`,
					baseCommit: "base-sha",
					createdAt: new Date().toISOString(),
					owner: "loom",
				};
			},
			prepareDependencies: async (workspace) => {
				calls.push(`worktree:deps:${workspace.taskId}`);
				return [];
			},
			inspectHead: async () => ({
				head: "branch-head",
				clean: options.workspaceClean !== false,
			}),
			preflightMerge: async () => ({
				path: projectPath,
				defaultBranch: "main",
				head: "target-head",
				clean: true,
				branchExists: true,
			}),
			isCommitIntegrated: async () => options.integrated !== false,
			checkpoint: async (workspace) => {
				calls.push(`worktree:checkpoint:${workspace.taskId}`);
				return "checkpoint-sha";
			},
			merge: async (_workspace, _expected, mergeOptions) => {
				calls.push(
					`worktree:merge:keep=${mergeOptions?.keepWorkspace === true}`,
				);
				if (options.conflictOnMerge)
					throw new MergeConflictError(["src/a.ts", "src/b.ts"]);
				return "merge-sha";
			},
			sync: async (workspace) => {
				calls.push(`worktree:sync:${workspace.taskId}`);
				return { head: "sync-sha", conflicts: [] };
			},
			remove: async (workspace) => {
				calls.push(`worktree:remove:${workspace.taskId}`);
				if (options.dirtyOnRemove)
					throw new WorktreeError(
						"SAFETY_ERROR",
						"Workspace has uncheckpointed changes",
					);
			},
			discard: async (workspace, options) => {
				calls.push(
					`worktree:discard:${workspace.taskId}:branch=${options?.deleteBranch === true}`,
				);
				await rm(workspace.path, { recursive: true, force: true });
			},
		},
	});

	const send = (id: string, text = "work on it") =>
		app.request(`/sessions/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});

	const createShared = async (title: string) => {
		const response = await app.request("/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: "p1", title }),
		});
		expect(response.status).toBe(201);
		return (await response.json()) as FakeSession;
	};

	const createIsolated = async (title: string) => {
		const response = await app.request("/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: "p1", title, mode: "isolated" }),
		});
		expect(response.status).toBe(201);
		return (await response.json()) as FakeSession & {
			workspace?: { mode?: string; branch?: string; path?: string };
		};
	};

	return {
		app,
		base,
		projectPath,
		bindings,
		calls,
		sessions,
		statuses,
		send,
		createShared,
		createIsolated,
	};
}

describe("chat workspace isolation", () => {
	test("an isolated session runs in its own worktree, not the project folder", async () => {
		const h = await harness();
		try {
			const created = await h.createIsolated("Backend chat");
			expect(created.workspace?.mode).toBe("isolated");
			expect(created.directory).not.toBe(h.projectPath);
			expect(created.directory).toContain("worktrees");
			expect(
				h.calls.some((call) => call.startsWith("worktree:create:chat-")),
			).toBe(true);
			// Dependencies are linked so the agent can actually build in the new tree.
			expect(h.calls.some((call) => call.startsWith("worktree:deps:"))).toBe(
				true,
			);
			expect(h.bindings.get(created.id)?.path).toBe(created.directory);
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("two isolated sessions get separate worktrees and both can run", async () => {
		const h = await harness();
		try {
			const backend = await h.createIsolated("Backend");
			const frontend = await h.createIsolated("Frontend");
			expect(backend.directory).not.toBe(frontend.directory);
			expect(backend.workspace?.branch).not.toBe(frontend.workspace?.branch);
			// Neither run is gated: each owns its directory even while the other works.
			expect((await h.send(backend.id)).status).toBe(204);
			expect((await h.send(frontend.id)).status).toBe(204);
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("a second writer on the shared checkout is refused", async () => {
		const h = await harness({ busySessionInRoot: true });
		try {
			const session = await h.createShared("Frontend");
			expect(session.directory).toBe(h.projectPath);
			const response = await h.send(session.id);
			expect(response.status).toBe(409);
			const body = (await response.json()) as {
				error: { code?: string; message?: string };
			};
			expect(body.error.message).toContain("Another chat is already editing");
			// The busy chat is named so the user knows what to wait for.
			expect(body.error.message).toContain("Backend chat");
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("isolation bypasses the shared-checkout gate while another chat runs", async () => {
		const h = await harness({ busySessionInRoot: true });
		try {
			const isolated = await h.createIsolated("Parallel frontend");
			// The other chat is busy in the project folder; this one must still start.
			expect((await h.send(isolated.id)).status).toBe(204);
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("the conversation list spans the project folder and every worktree", async () => {
		const h = await harness();
		try {
			const shared = await h.createShared("Shared");
			const isolated = await h.createIsolated("Isolated");
			const list = await h.app.request("/sessions?projectId=p1");
			const sessions = (await list.json()) as Array<{
				id: string;
				workspace?: { mode: string };
			}>;
			expect(sessions.map((item) => item.id)).toContain(shared.id);
			expect(sessions.map((item) => item.id)).toContain(isolated.id);
			expect(
				sessions.find((item) => item.id === isolated.id)?.workspace?.mode,
			).toBe("isolated");
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("merging a dirty workspace is refused, a clean one keeps the workspace", async () => {
		const dirty = await harness({ workspaceClean: false });
		try {
			const isolated = await dirty.createIsolated("Backend");
			const response = await dirty.app.request(
				`/sessions/${isolated.id}/workspace/merge`,
				{ method: "POST", body: "{}" },
			);
			expect(response.status).toBe(409);
			const body = (await response.json()) as { error: { message?: string } };
			// Merging a dirty tree would silently drop the agent's output.
			expect(body.error.message).toContain("Checkpoint");
		} finally {
			await rm(dirty.base, { recursive: true, force: true });
		}
		const clean = await harness();
		try {
			const isolated = await clean.createIsolated("Frontend");
			const merged = await clean.app.request(
				`/sessions/${isolated.id}/workspace/merge`,
				{ method: "POST", body: "{}" },
			);
			expect(merged.status).toBe(200);
			// The conversation stays bound to its worktree after intake.
			expect(clean.calls).toContain("worktree:merge:keep=true");
		} finally {
			await rm(clean.base, { recursive: true, force: true });
		}
	});

	test("a conflicting merge reports the files instead of touching the project", async () => {
		const h = await harness({ conflictOnMerge: true });
		try {
			const isolated = await h.createIsolated("Backend");
			const response = await h.app.request(
				`/sessions/${isolated.id}/workspace/merge`,
				{ method: "POST", body: "{}" },
			);
			expect(response.status).toBe(409);
			const body = (await response.json()) as {
				error: { code: string; files: string[] };
			};
			expect(body.error.code).toBe("MERGE_CONFLICT");
			expect(body.error.files).toEqual(["src/a.ts", "src/b.ts"]);
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("sync pulls the target branch into the workspace", async () => {
		const h = await harness();
		try {
			const isolated = await h.createIsolated("Frontend");
			const response = await h.app.request(
				`/sessions/${isolated.id}/workspace/sync`,
				{ method: "POST", body: "{}" },
			);
			expect(response.status).toBe(200);
			expect(h.calls.some((call) => call.startsWith("worktree:sync:"))).toBe(
				true,
			);
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("deleting a session with uncheckpointed output is refused", async () => {
		const h = await harness({ dirtyOnRemove: true, workspaceClean: false });
		try {
			const isolated = await h.createIsolated("Backend");
			const response = await h.app.request(`/sessions/${isolated.id}`, {
				method: "DELETE",
			});
			expect(response.status).toBe(409);
			const body = (await response.json()) as { error: { code: string } };
			expect(body.error.code).toBe("WORKSPACE_DIRTY");
			expect(h.bindings.has(isolated.id)).toBe(true);
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("deleting a session whose output is not merged yet is refused", async () => {
		const h = await harness({ integrated: false });
		try {
			const isolated = await h.createIsolated("Backend");
			const response = await h.app.request(`/sessions/${isolated.id}`, {
				method: "DELETE",
			});
			expect(response.status).toBe(409);
			const body = (await response.json()) as { error: { code: string } };
			// Committed but unmerged output must not be stranded by a delete.
			expect(body.error.code).toBe("WORKSPACE_UNMERGED");
			expect(h.bindings.has(isolated.id)).toBe(true);
			expect(h.calls.some((call) => call.startsWith("worktree:remove:"))).toBe(
				false,
			);
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("deleting a clean isolated session removes its worktree and binding", async () => {
		const h = await harness();
		try {
			const isolated = await h.createIsolated("Backend");
			const response = await h.app.request(`/sessions/${isolated.id}`, {
				method: "DELETE",
			});
			expect(response.status).toBe(204);
			expect(h.calls.some((call) => call.startsWith("worktree:remove:"))).toBe(
				true,
			);
			expect(h.bindings.has(isolated.id)).toBe(false);
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("discarding a workspace destroys its checkout and its branch", async () => {
		const h = await harness();
		try {
			const isolated = await h.createIsolated("Backend");
			const response = await h.app.request(
				`/sessions/${isolated.id}/workspace/discard`,
				{ method: "POST", body: "{}" },
			);
			expect(response.status).toBe(200);
			// An abandoned tab must not leave an unreachable branch behind.
			expect(
				h.calls.some(
					(call) =>
						call.startsWith("worktree:discard:") &&
						call.endsWith("branch=true"),
				),
			).toBe(true);
			expect(h.bindings.has(isolated.id)).toBe(false);
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});

	test("a worktree deleted outside Loom prunes its stale binding", async () => {
		const h = await harness();
		try {
			const isolated = await h.createIsolated("Backend");
			await rm(isolated.directory, { recursive: true, force: true });
			await h.app.request(`/sessions/${isolated.id}/workspace`);
			// The dangling row is dropped so later requests are not aimed at a
			// directory that no longer exists.
			expect(h.bindings.has(isolated.id)).toBe(false);
		} finally {
			await rm(h.base, { recursive: true, force: true });
		}
	});
});

describe("chat workspace isolation on a real repository", () => {
	test("two chats get separate worktrees and merge without colliding", async () => {
		// Boot a genuine Git repository and the genuine WorktreeManager: this is the
		// guarantee that a backend tab and a frontend tab cannot edit one checkout.
		const base = await mkdtemp(join(tmpdir(), "loom-chat-git-"));
		const home = await mkdtemp(join(tmpdir(), "loom-chat-git-home-"));
		const projectPath = join(base, "repo");
		const git = async (args: string[], cwd = projectPath) => {
			const proc = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;
			expect(exitCode, `${args.join(" ")}: ${stderr}`).toBe(0);
		};
		try {
			await mkdir(projectPath, { recursive: true });
			await git(["init", "-b", "main"]);
			await git(["config", "user.name", "Loom Test"]);
			await git(["config", "user.email", "loom@example.test"]);
			await writeFile(join(projectPath, "package.json"), '{"name":"demo"}\n');
			await git(["add", "."]);
			await git(["commit", "-m", "initial"]);

			const bindings = new Map<string, ChatWorkspaceRecord>();
			const sessions = new Map<string, FakeSession>();
			const manager = new WorktreeManager({ home });
			let nextId = 0;
			const app = createChatRoutes({
				projects: {
					list: async () => [{ id: "git", path: projectPath }],
					getById: async (id) => (id === "git" ? { path: projectPath } : null),
				},
				request: async <T>(
					path: string,
					opts: { directory?: string; body?: unknown } = {},
				): Promise<T> => {
					if (path === "/session") {
						nextId += 1;
						const created: FakeSession = {
							id: `ses_git_${nextId}`,
							directory: opts.directory ?? "",
							title: String((opts.body as { title?: string })?.title ?? "Chat"),
							time: { updated: Date.now() },
						};
						sessions.set(created.id, created);
						return created as T;
					}
					if (path.startsWith("/session?limit"))
						return [...sessions.values()].filter(
							(item) => item.directory === opts.directory,
						) as T;
					if (path === "/session/status") return {} as T;
					const lookup = /^\/session\/(ses_[\w-]+)$/.exec(path);
					if (lookup) {
						const found = sessions.get(lookup[1]!);
						if (!found || found.directory !== opts.directory)
							throw { details: { status: "404" }, message: "not found" };
						return found as T;
					}
					return true as T;
				},
				chatWorkspaces: {
					getBySessionId: async (sessionId) => bindings.get(sessionId),
					listByProject: async () => [...bindings.values()],
					create: async (input) => {
						const record = { ...input, status: "active" };
						bindings.set(record.sessionId, record);
						return record;
					},
					update: async (sessionId, input) => {
						const current = bindings.get(sessionId);
						if (current) bindings.set(sessionId, { ...current, ...input });
					},
					delete: async (sessionId) => {
						bindings.delete(sessionId);
					},
				},
				worktrees: manager,
			});

			const create = async (title: string) => {
				const response = await app.request("/sessions", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ projectId: "git", title, mode: "isolated" }),
				});
				expect(response.status).toBe(201);
				return (await response.json()) as FakeSession & {
					workspace?: { branch?: string };
				};
			};

			const backend = await create("Backend");
			const frontend = await create("Frontend");
			// Separate directories and separate branches, both inside the project repo.
			expect(backend.directory).not.toBe(frontend.directory);
			expect(backend.workspace?.branch).not.toBe(frontend.workspace?.branch);
			await writeFile(
				join(backend.directory!, "api.ts"),
				"export const api = 1;\n",
			);
			await writeFile(
				join(frontend.directory!, "ui.ts"),
				"export const ui = 1;\n",
			);
			// Neither tab can see the other's files while they work.
			expect(existsSync(join(backend.directory!, "ui.ts"))).toBe(false);

			const merge = (id: string) =>
				app.request(`/sessions/${id}/workspace/merge`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({}),
				});
			// Output must be committed on the branch before it can integrate.
			const checkpoint = (id: string) =>
				app.request(`/sessions/${id}/workspace/checkpoint`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ message: `chore: ${id}` }),
				});
			expect((await checkpoint(backend.id)).status).toBe(200);
			expect((await checkpoint(frontend.id)).status).toBe(200);
			expect((await merge(backend.id)).status).toBe(200);
			expect((await merge(frontend.id)).status).toBe(200);
			// Both outputs landed in the project checkout, and the branches coexist.
			expect(existsSync(join(projectPath, "api.ts"))).toBe(true);
			expect(existsSync(join(projectPath, "ui.ts"))).toBe(true);
			const log = Bun.spawnSync(
				["git", "log", "--oneline", "--decorate", "main"],
				{
					cwd: projectPath,
				},
			);
			expect(log.stdout.toString()).toContain("Integrate task chat-");
		} finally {
			await rm(base, { recursive: true, force: true });
			await rm(home, { recursive: true, force: true });
		}
	});
});
