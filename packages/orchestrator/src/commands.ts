import { spawn } from "node:child_process";
export type CommandResult = { exitCode: number; output: string };
/** Bound time and output, and terminate the entire command group on timeout. */
export function runCommand(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs = 120000,
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		let output = "";
		let timedOut = false;
		const append = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-64000);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (child.pid && process.platform !== "win32")
					process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {}
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: timedOut ? 124 : (code ?? 1),
				output: output + (timedOut ? "\nCommand timed out" : ""),
			});
		});
	});
}
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await runCommand(
		"git",
		["-c", "user.name=Loom", "-c", "user.email=loom@localhost", ...args],
		cwd,
	);
	if (result.exitCode)
		throw new Error(`Git ${args[0]} failed: ${result.output}`);
	return result.output.trim();
}
export async function snapshotWorkspace(cwd: string, message: string) {
	if (await git(cwd, "diff", "--name-only", "--diff-filter=U"))
		throw new Error("Unresolved merge conflicts remain in workspace");
	await git(
		cwd,
		"add",
		"-A",
		"--",
		".",
		":(exclude).loom-worktree.json",
		":(exclude).loom/artifacts.json",
	);
	const staged = await git(cwd, "diff", "--cached", "--name-only");
	// A conflict resolution can have an empty tree diff while still needing a merge commit.
	const merging = await runCommand(
		"git",
		["rev-parse", "--verify", "MERGE_HEAD"],
		cwd,
	);
	if (staged || merging.exitCode === 0) await git(cwd, "commit", "-m", message);
	return git(cwd, "rev-parse", "HEAD");
}
