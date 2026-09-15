import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "loom-suite-"));
try {
  const result = Bun.spawn([process.execPath, "test", "packages/automation/src", "packages/distribution/src", "packages/protocol/src", "packages/db/src", "packages/opencode/test", "packages/worktree/test", "packages/orchestrator/src", "apps/cli/src", "apps/server/src"], { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, LOOM_HOME: directory, LOOM_DAEMON: "false" } });
  process.exitCode = await result.exited;
} finally { await rm(directory, { recursive: true, force: true }); }
