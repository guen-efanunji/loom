import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const suites = [
	"packages/automation/test",
	"packages/distribution/test",
	"packages/protocol/test",
	"packages/db/test",
	"packages/opencode/test",
	"packages/worktree/test",
	"packages/orchestrator/test",
	"apps/cli/test",
	"apps/server/test",
	"apps/web/test",
];

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

// Each suite gets its own Loom home. State.db is WAL-backed, so two suites
// sharing one directory can lock, delete or corrupt each other's database.
const failed: string[] = [];
for (const suite of suites) {
	const directory = await mkdtemp(join(tmpdir(), "loom-suite-"));
	try {
		const result = Bun.spawn(["bun", "test", suite], {
			stdio: ["inherit", "inherit", "inherit"],
			env: { ...process.env, LOOM_HOME: directory, LOOM_DAEMON: "false" },
		});
		if ((await result.exited) !== 0) failed.push(suite);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
if (failed.length) {
	console.error(`Suites with failures: ${failed.join(", ")}`);
	process.exitCode = 1;
}
