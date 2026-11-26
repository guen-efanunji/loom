import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerRuntime } from "../src/adapters/codex-app-server";

const tempDirs: string[] = [];
const runtimes: CodexAppServerRuntime[] = [];

afterEach(async () => {
	while (runtimes.length) {
		await runtimes.pop()!.dispose();
	}
	while (tempDirs.length) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

function createFakeAppServer(scriptBody: string): CodexAppServerRuntime {
	const dir = mkdtempSync(join(tmpdir(), "loom-codex-app-server-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, "server.mjs");
	writeFileSync(scriptPath, scriptBody, "utf8");
	const runtime = new CodexAppServerRuntime({
		command: process.execPath,
		args: [scriptPath],
	});
	runtimes.push(runtime);
	return runtime;
}

describe("CodexAppServerRuntime", () => {
	test("streams incremental output, activities, diffs, tokens, and reuses threadId across turns", async () => {
		const runtime = createFakeAppServer(`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let threadSeq = 0;
let turnSeq = 0;
const state = { threadStarts: [], turnStarts: [] };
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }

rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "codex-fake" } });
		return;
	}
	if (msg.method === "initialized") return;
	if (msg.method === "thread/start") {
		state.threadStarts.push(msg.params);
		const threadId = "thr-" + (++threadSeq);
		send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId } } });
		return;
	}
	if (msg.method === "turn/start") {
		state.turnStarts.push(msg.params);
		const threadId = msg.params.threadId;
		const turnId = "turn-" + (++turnSeq);
		send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
		if (turnSeq === 1) {
			send({
				jsonrpc: "2.0",
				method: "item/started",
				params: { threadId, turnId, item: { type: "agentMessage", id: "msg-1", text: "" } },
			});
			send({
				jsonrpc: "2.0",
				method: "item/agentMessage/delta",
				params: { threadId, turnId, itemId: "msg-1", delta: "Checking " },
			});
			send({
				jsonrpc: "2.0",
				method: "item/started",
				params: {
					threadId,
					turnId,
					item: { type: "commandExecution", id: "cmd-1", command: "ls -la", cwd: "/tmp", status: "inProgress" },
				},
			});
			send({
				jsonrpc: "2.0",
				method: "item/commandExecution/outputDelta",
				params: { threadId, turnId, itemId: "cmd-1", delta: "file.txt\\n" },
			});
			setTimeout(() => {
				send({
					jsonrpc: "2.0",
					method: "item/completed",
					params: {
						threadId,
						turnId,
						item: { type: "commandExecution", id: "cmd-1", command: "ls -la", cwd: "/tmp", status: "completed", aggregatedOutput: "file.txt\\n", exitCode: 0 },
					},
				});
				send({
					jsonrpc: "2.0",
					method: "item/completed",
					params: {
						threadId,
						turnId,
						item: {
							type: "fileChange",
							id: "fc-1",
							status: "completed",
							changes: [{ path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\\n-old\\n+new" }],
						},
					},
				});
				send({
					jsonrpc: "2.0",
					method: "item/completed",
					params: { threadId, turnId, item: { type: "agentMessage", id: "msg-1", text: "Checking done" } },
				});
				send({
					jsonrpc: "2.0",
					method: "thread/tokenUsage/updated",
					params: {
						threadId,
						turnId,
						tokenUsage: {
							last: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5 },
							total: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5 },
						},
					},
				});
				send({
					jsonrpc: "2.0",
					method: "turn/completed",
					params: { threadId, turn: { id: turnId, status: "completed" } },
				});
			}, 40);
		} else {
			send({
				jsonrpc: "2.0",
				method: "item/completed",
				params: {
					threadId,
					turnId,
					item: { type: "agentMessage", id: "msg-2", text: JSON.stringify(state) },
				},
			});
			send({
				jsonrpc: "2.0",
				method: "turn/completed",
				params: { threadId, turn: { id: turnId, status: "completed" } },
			});
		}
	}
});
`);

		const session = await runtime.createSession({
			cwd: "/tmp",
			title: "Test",
		});

		// prompt() returns before turn/completed so live output can be read mid-turn.
		await runtime.prompt({
			sessionId: session.id,
			prompt: "Turn 1",
			system: "Follow instructions",
			thinkingMode: "high",
			images: [{ mime: "image/png", data: "YWJj" }],
		});

		expect(await runtime.status(session.id)).toBe("running");
		let liveOutput = await runtime.readOutput(session.id);
		const deadline = Date.now() + 2_000;
		while (!liveOutput?.output && Date.now() < deadline) {
			await Bun.sleep(5);
			liveOutput = await runtime.readOutput(session.id);
		}
		expect(liveOutput?.output).toContain("Checking");

		expect(await runtime.wait(session.id, { timeoutMs: 3_000 })).toBe(
			"completed",
		);
		const output1 = await runtime.readOutput(session.id);
		expect(output1?.output).toBe("Checking done");
		expect(output1?.activities).toHaveLength(2);
		expect(output1?.activities?.[0]).toMatchObject({
			tool: "command_execution",
			status: "completed",
			output: "file.txt\n",
		});
		expect(output1?.activities?.[1]).toMatchObject({
			tool: "file_change",
			status: "completed",
			metadata: {
				filediff: { file: "src/app.ts", additions: 1, deletions: 1 },
			},
		});
		expect(output1?.parts?.map((p) => p.type)).toEqual([
			"text",
			"activity",
			"activity",
		]);
		expect(output1?.tokens).toEqual({
			total: 150,
			input: 100,
			output: 30,
			reasoning: 5,
			cache: { read: 20, write: 0 },
		});

		// Second prompt on the same session reuses the existing threadId.
		await runtime.prompt({
			sessionId: session.id,
			prompt: "Turn 2",
			model: { providerID: "codex", modelID: "GPT 5.6 Sol" },
		});
		expect(await runtime.wait(session.id, { timeoutMs: 3_000 })).toBe(
			"completed",
		);
		const output2 = await runtime.readOutput(session.id);
		const recorded = JSON.parse(output2?.output ?? "{}") as {
			threadStarts: Array<Record<string, unknown>>;
			turnStarts: Array<Record<string, unknown>>;
		};
		expect(recorded.threadStarts).toHaveLength(1);
		expect(recorded.threadStarts[0]?.model).toBeUndefined();
		expect(recorded.threadStarts[0]?.developerInstructions).toBe(
			"Follow instructions",
		);
		expect(recorded.turnStarts).toHaveLength(2);
		expect(recorded.turnStarts[0]?.threadId).toBe("thr-1");
		expect(recorded.turnStarts[0]?.effort).toBe("high");
		expect(recorded.turnStarts[0]?.input).toEqual([
			{ type: "text", text: "Turn 1", text_elements: [] },
			{ type: "image", url: "data:image/png;base64,YWJj" },
		]);
		expect(recorded.turnStarts[1]?.threadId).toBe("thr-1");
		expect(recorded.turnStarts[1]?.model).toBe("gpt-5.6-sol");
	});

	test("runs multiple sessions concurrently without blocking on a global lock", async () => {
		const runtime = createFakeAppServer(`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let seq = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }

rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
	if (msg.method === "initialized") return;
	if (msg.method === "thread/start") {
		return send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thr-" + (++seq) } } });
	}
	if (msg.method === "turn/start") {
		const { threadId, input } = msg.params;
		const turnId = "turn-" + threadId;
		send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
		const text = input[0].text;
		const delay = text === "slow" ? 120 : 10;
		setTimeout(() => {
			send({
				jsonrpc: "2.0",
				method: "item/completed",
				params: { threadId, turnId, item: { type: "agentMessage", id: "m-" + threadId, text } },
			});
			send({
				jsonrpc: "2.0",
				method: "turn/completed",
				params: { threadId, turn: { id: turnId, status: "completed" } },
			});
		}, delay);
	}
});
`);

		const slow = await runtime.createSession({ cwd: "/tmp", title: "Slow" });
		const fast = await runtime.createSession({ cwd: "/tmp", title: "Fast" });

		await runtime.prompt({ sessionId: slow.id, prompt: "slow" });
		await runtime.prompt({ sessionId: fast.id, prompt: "fast" });

		// Fast must finish while slow is still running.
		expect(await runtime.wait(fast.id, { timeoutMs: 2_000 })).toBe("completed");
		expect(await runtime.status(slow.id)).toBe("running");
		expect(await runtime.wait(slow.id, { timeoutMs: 2_000 })).toBe("completed");
		expect((await runtime.readOutput(fast.id))?.output).toBe("fast");
		expect((await runtime.readOutput(slow.id))?.output).toBe("slow");
	});

	test("routes server approval requests through authorizeTool and sends turn/interrupt on abort", async () => {
		const runtime = createFakeAppServer(`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const interrupts = [];
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }

rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
	if (msg.method === "initialized") return;
	if (msg.method === "thread/start") {
		return send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thr-1" } } });
	}
	if (msg.method === "turn/start") {
		const turnId = "turn-1";
		send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
		if (msg.params.input[0].text === "approve") {
			send({
				jsonrpc: "2.0",
				id: "srv-req-1",
				method: "item/commandExecution/requestApproval",
				params: { threadId: "thr-1", turnId, itemId: "cmd-1", command: "rm -rf /tmp/x", reason: "Clean temp" },
			});
		}
		return;
	}
	if (msg.id === "srv-req-1") {
		send({
			jsonrpc: "2.0",
			method: "item/completed",
			params: {
				threadId: "thr-1",
				turnId: "turn-1",
				item: { type: "agentMessage", id: "m-1", text: "decision=" + msg.result.decision },
			},
		});
		send({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } },
		});
		return;
	}
	if (msg.method === "turn/interrupt") {
		interrupts.push(msg.params);
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
		send({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: { threadId: msg.params.threadId, turn: { id: msg.params.turnId, status: "interrupted" } },
		});
	}
});
`);

		const session = await runtime.createSession({ cwd: "/tmp", title: "Auth" });
		const observedStatuses: string[] = [];
		let seenTool = "";
		await runtime.prompt({
			sessionId: session.id,
			prompt: "approve",
			permission: { mode: "ask" },
			authorizeTool: async (req) => {
				seenTool = req.toolName;
				await Bun.sleep(15);
				return true;
			},
		});
		const status1 = await runtime.wait(session.id, {
			timeoutMs: 2_000,
			onStatus: (s) => {
				observedStatuses.push(s);
			},
		});
		expect(status1).toBe("completed");
		expect(seenTool).toBe("command_execution");
		expect(observedStatuses).toContain("waiting_permission");
		expect((await runtime.readOutput(session.id))?.output).toBe(
			"decision=accept",
		);

		// Abort sends turn/interrupt and transitions cleanly to cancelled.
		await runtime.prompt({
			sessionId: session.id,
			prompt: "hang",
		});
		await runtime.abort(session.id);
		expect(await runtime.status(session.id)).toBe("cancelled");
	});

	test("fails active sessions and restarts cleanly if app-server process exits unexpectedly", async () => {
		const runtime = createFakeAppServer(`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }

rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
	if (msg.method === "initialized") return;
	if (msg.method === "thread/start") {
		return send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thr-crash" } } });
	}
	if (msg.method === "turn/start") {
		send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-crash", status: "inProgress" } } });
		if (msg.params.input[0].text === "crash") {
			process.stderr.write("fatal crash");
			process.exit(1);
		} else {
			send({
				jsonrpc: "2.0",
				method: "item/completed",
				params: { threadId: "thr-crash", turnId: "turn-crash", item: { type: "agentMessage", id: "m-ok", text: "recovered" } },
			});
			send({
				jsonrpc: "2.0",
				method: "turn/completed",
				params: { threadId: "thr-crash", turn: { id: "turn-crash", status: "completed" } },
			});
		}
	}
});
`);

		const session = await runtime.createSession({
			cwd: "/tmp",
			title: "Crash",
		});
		await runtime.prompt({ sessionId: session.id, prompt: "crash" });
		expect(await runtime.wait(session.id, { timeoutMs: 2_000 })).toBe("failed");
		expect(await runtime.lastError(session.id)).toContain("fatal crash");

		// A fresh session after crash spawns a new app-server process and succeeds.
		const session2 = await runtime.createSession({
			cwd: "/tmp",
			title: "Recover",
		});
		await runtime.prompt({ sessionId: session2.id, prompt: "recover" });
		expect(await runtime.wait(session2.id, { timeoutMs: 2_000 })).toBe(
			"completed",
		);
		expect((await runtime.readOutput(session2.id))?.output).toBe("recovered");
	});

	test("abort() during in-flight turn/start still sends turn/interrupt and deleteSession cleans up", async () => {
		const runtime = createFakeAppServer(`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const interrupted = [];
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }

rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
	if (msg.method === "initialized") return;
	if (msg.method === "thread/start") {
		return send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thr-race" } } });
	}
	if (msg.method === "turn/start") {
		const text = msg.params.input[0].text;
		if (text === "warmup") {
			send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-warm", status: "inProgress" } } });
			send({
				jsonrpc: "2.0",
				method: "item/completed",
				params: { threadId: "thr-race", turnId: "turn-warm", item: { type: "agentMessage", id: "m-warm", text: "warm" } },
			});
			send({
				jsonrpc: "2.0",
				method: "turn/completed",
				params: { threadId: "thr-race", turn: { id: "turn-warm", status: "completed" } },
			});
			return;
		}
		setTimeout(() => {
			send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-race", status: "inProgress" } } });
		}, 80);
		return;
	}
	if (msg.method === "turn/interrupt") {
		interrupted.push(msg.params);
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
		send({
			jsonrpc: "2.0",
			method: "item/completed",
			params: { threadId: msg.params.threadId, turnId: msg.params.turnId, item: { type: "agentMessage", id: "m-int", text: "interrupted=" + msg.params.turnId } },
		});
		send({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: { threadId: msg.params.threadId, turn: { id: msg.params.turnId, status: "interrupted" } },
		});
	}
});
`);

		const session = await runtime.createSession({
			cwd: "/tmp",
			title: "Abort Race",
		});
		// Ensure process and thread are initialized before testing in-flight turn/start abort.
		await runtime.prompt({ sessionId: session.id, prompt: "warmup" });
		expect(await runtime.wait(session.id, { timeoutMs: 2_000 })).toBe(
			"completed",
		);

		const promptPromise = runtime.prompt({
			sessionId: session.id,
			prompt: "slow start",
		});
		await Bun.sleep(20);
		await runtime.abort(session.id);
		await promptPromise;
		expect(await runtime.status(session.id)).toBe("cancelled");
		expect((await runtime.readOutput(session.id))?.output).toBe(
			"interrupted=turn-race",
		);
		await runtime.deleteSession(session.id);
		expect(await runtime.readOutput(session.id)).toBeNull();
	});
});
