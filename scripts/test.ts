import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "loom-suite-"));
try {
	const build = Bun.spawn(
		[
			process.execPath,
			"x",
			"tsc",
			"-b",
			"--force",
			"packages/distribution",
			"packages/automation",
			"packages/db",
			"packages/orchestrator",
			"packages/api",
		],
		{ stdio: ["inherit", "inherit", "inherit"] },
	);
	if ((await build.exited) !== 0)
		throw new Error("TypeScript package build failed before tests");
	const result = Bun.spawn(
		[
			process.execPath,
			"test",
			"packages/automation/test",
			"packages/distribution/test",
			"packages/protocol/test",
			"packages/db/test",
			"packages/opencode/test",
			"packages/worktree/test",
			"packages/orchestrator/test",
			"apps/cli/test",
			"apps/server/test",
		],
		{
			stdio: ["inherit", "inherit", "inherit"],
			env: { ...process.env, LOOM_HOME: directory, LOOM_DAEMON: "false" },
		},
	);
	process.exitCode = await result.exited;
} finally {
	await rm(directory, { recursive: true, force: true });
}
