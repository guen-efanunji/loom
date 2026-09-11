import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { discoverExecutable } from "@loom/opencode";

export const VERSION = "0.0.0";
export const HOST = "127.0.0.1";
export const PORT = 4317;
export const URL = `http://${HOST}:${PORT}`;
const root = join(import.meta.dir, "..", "..", "..");
const loomDir = join(homedir(), ".loom");
const dbPath = join(loomDir, "state.db");

async function commandExists(command: string): Promise<boolean> {
	const path = process.env.PATH?.split(delimiter) ?? [];
	for (const directory of path) {
		try {
			await access(join(directory, command));
			return true;
		} catch {}
	}
	return false;
}

async function checkPort(): Promise<boolean> {
	try {
		const response = await fetch(`${URL}/health`);
		return response.ok;
	} catch {
		return false;
	}
}

async function checkReadable(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function doctor(): Promise<number> {
	const checks = [
		["OpenCode", (await discoverExecutable()) !== null],
		["Git", await commandExists("git")],
		["Config directory", await checkReadable(loomDir)],
		["Database", await checkReadable(dbPath)],
		["Daemon port", await checkPort()],
		["Config permissions", await permissionsOk(loomDir)],
	];
	for (const [name, ok] of checks)
		console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
	return checks.every(([, ok]) => ok) ? 0 : 1;
}

async function permissionsOk(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return (info.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

function spawnProcess(
	command: string,
	args: string[],
	cwd: string,
): ChildProcess {
	return spawn(command, args, { cwd, stdio: "inherit", env: process.env });
}

async function waitForDaemon(timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await checkPort()) return true;
		await Bun.sleep(100);
	}
	return false;
}

async function openBrowser(): Promise<void> {
	if (process.env.LOOM_NO_BROWSER === "1") return;
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "start"
				: "xdg-open";
	try {
		const child = spawn(command, [URL], {
			detached: true,
			stdio: "ignore",
			shell: process.platform === "win32",
		});
		child.unref();
	} catch {}
}

async function start(): Promise<number> {
	if (await checkPort()) {
		await openBrowser();
		return 0;
	}
	await mkdir(loomDir, { recursive: true, mode: 0o700 });
	const server = spawnProcess(
		"bun",
		["run", "--cwd", "apps/server", "dev"],
		root,
	);
	const web = spawnProcess("bun", ["run", "--cwd", "apps/web", "dev"], root);
	const children = [server, web];
	const cleanup = () => {
		for (const child of children) if (!child.killed) child.kill("SIGTERM");
	};
	process.once("SIGINT", cleanup);
	process.once("SIGTERM", cleanup);
	const ready = await waitForDaemon();
	if (!ready) {
		cleanup();
		return 1;
	}
	await openBrowser();
	await new Promise<number>((resolve) => {
		for (const child of children)
			child.once("exit", (code) => resolve(code ?? 0));
	});
	cleanup();
	return 0;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let exitCode = 0;
	if (args[0] === "--version" || args[0] === "-v")
		console.log(`loom ${VERSION}`);
	else if (args[0] === "doctor") exitCode = await doctor();
	else if (args.length === 0) exitCode = await start();
	else {
		console.error("Usage: loom [--version|doctor]");
		exitCode = 1;
	}
	process.exitCode = exitCode;
}
