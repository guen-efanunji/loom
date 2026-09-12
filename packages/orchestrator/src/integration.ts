import type { AgentRuntime } from "@loom/opencode";
import type {
	IntegrationCheck,
	ProjectContext,
	TaskArtifact,
} from "@loom/protocol";
import type { Workspace, WorktreeManager } from "@loom/worktree";
import { git, runCommand, snapshotWorkspace } from "./commands";
import { readProjectFile } from "./context";

export type IntegrationResult = {
	workspace: Workspace;
	status: "merging" | "checking" | "resolving" | "review" | "failed";
	head: string;
	diff: string;
	checks: IntegrationCheck[];
	errorMessage: string | null;
	sessionId: string | null;
};
export type IntegrationInput = {
	id: string;
	title: string;
	project: { id: string; path: string };
	branches: string[];
	context: ProjectContext;
	artifacts: TaskArtifact[];
	onUpdate?: (result: IntegrationResult) => Promise<void>;
};

/** Commands are explicitly reviewed with the plan; execute them in its isolated workspace. */
export async function runChecks(
	cwd: string,
	context: ProjectContext,
	onCheck?: (checks: IntegrationCheck[]) => Promise<void>,
) {
	const checks: IntegrationCheck[] = [];
	for (const name of ["install", "lint", "test", "build"] as const) {
		const command = context.commands[name]?.trim();
		if (!command) continue;
		const result = await runCommand("/bin/sh", ["-c", command], cwd, 600000);
		checks.push({ name, command, ...result });
		await onCheck?.(checks);
		if (name === "install" && result.exitCode !== 0) break;
	}
	return checks;
}

export class IntegrationCoordinator {
	constructor(
		private worktree: WorktreeManager,
		private runtime: AgentRuntime,
	) {}

	async integrate(input: IntegrationInput): Promise<IntegrationResult> {
		const workspace = await this.worktree.create({
			projectPath: input.project.path,
			projectId: input.project.id,
			taskId: `integration-${input.id}`,
		});
		const result: IntegrationResult = {
			workspace,
			status: "merging",
			head: workspace.baseCommit,
			diff: "",
			checks: [],
			errorMessage: null,
			sessionId: null,
		};
		const update = async () => {
			await input.onUpdate?.(result);
		};
		await update();
		try {
			if (!workspace.baseCommit)
				throw new Error("Project needs an initial commit before integration");
			for (const branch of input.branches) {
				try {
					await git(
						workspace.path,
						"merge",
						"--no-edit",
						"--no-ff",
						"--",
						branch,
					);
				} catch (error) {
					const files = await git(
						workspace.path,
						"diff",
						"--name-only",
						"--diff-filter=U",
					);
					if (!files) throw error;
					result.status = "resolving";
					await update();
					await this.agent(
						result,
						`Resolve ONLY merge conflicts in: ${files}. Preserve both task intents. Do not redesign the feature. Stage resolved files, but do not commit or merge into the project branch.`,
						input,
						update,
					);
					// Git still reports a resolved file as unmerged until the index is updated.
					for (const file of files.split("\n")) {
						try {
							const content = await readProjectFile(
								workspace.path,
								file,
								1000000,
							);
							if (/^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(content))
								throw new Error(`Conflict markers remain in ${file}`);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT")
								throw error;
						}
						await git(workspace.path, "add", "--", file);
					}
					await snapshotWorkspace(
						workspace.path,
						`Resolve integration conflicts: ${input.title}`,
					);
					result.status = "merging";
					await update();
				}
			}
			result.status = "checking";
			await update();
			result.checks = await runChecks(
				workspace.path,
				input.context,
				async (checks) => {
					result.checks = checks;
					await update();
				},
			);
			if (result.checks.some((c) => c.exitCode !== 0)) {
				result.status = "resolving";
				await update();
				await this.agent(
					result,
					`Fix only integration failures. Do not redesign or expand scope. Failure logs:\n${JSON.stringify(result.checks).slice(-28000)}`,
					input,
					update,
				);
				await snapshotWorkspace(
					workspace.path,
					`Repair integration: ${input.title}`,
				);
				result.status = "checking";
				await update();
				const second = await runChecks(workspace.path, input.context);
				// Preserve the original failure logs as well as the verification after repair.
				result.checks = [
					...result.checks.map((c) => ({ ...c, name: `initial ${c.name}` })),
					...second,
				];
				if (second.some((c) => c.exitCode !== 0))
					throw new Error(
						"Integration checks still fail after repair; workspace and logs preserved",
					);
			}
			const dirty = await git(workspace.path, "diff", "--name-only", "HEAD");
			if (dirty)
				throw new Error(
					"Checks changed tracked files. Review changes and retry integration before approval.",
				);
			result.head = await git(workspace.path, "rev-parse", "HEAD");
			result.diff = await git(
				workspace.path,
				"diff",
				`${workspace.baseCommit}...HEAD`,
			);
			result.status = "review";
			await update();
		} catch (error) {
			result.errorMessage =
				error instanceof Error ? error.message : String(error);
			result.status = "failed";
			result.head = await git(workspace.path, "rev-parse", "HEAD").catch(
				() => workspace.baseCommit,
			);
			result.diff = await git(
				workspace.path,
				"diff",
				workspace.baseCommit,
			).catch(() => "");
			await update();
		}
		return result;
	}

	private async agent(
		result: IntegrationResult,
		instruction: string,
		input: IntegrationInput,
		update: () => Promise<void>,
	) {
		const cwd = result.workspace.path;
		const session = await this.runtime.createSession({
			cwd,
			title: `Integration proposal: ${input.title}`,
		});
		result.sessionId = session.id;
		await update();
		const diff = await git(cwd, "diff", result.workspace.baseCommit).catch(
			() => "",
		);
		try {
			await this.runtime.prompt({
				sessionId: session.id,
				prompt: `${instruction}\nWork only in ${cwd}. Never change other worktrees or the project branch. Every proposal needs user review before merge. Do not edit validation commands or disable tests to make checks pass.\nMerged diff:\n${diff.slice(0, 16000)}\nArtifacts/decisions:\n${JSON.stringify(input.artifacts).slice(0, 12000)}`,
			});
			if (
				(await this.runtime.wait(session.id, { timeoutMs: 600000 })) !==
				"completed"
			)
				throw new Error("Integration agent did not complete");
		} catch (error) {
			await this.runtime.abort(session.id).catch(() => {});
			throw error;
		}
	}
}

/** Approval is bound to the exact reviewed commit, target base and clean workspaces. */
export async function approveIntegration(
	worktree: WorktreeManager,
	workspace: Workspace,
	head: string,
) {
	if ((await git(workspace.path, "rev-parse", "HEAD")) !== head)
		throw new Error("Reviewed integration HEAD changed; run integration again");
	const dirty = (
		await git(workspace.path, "status", "--porcelain", "--untracked-files=all")
	)
		.split("\n")
		.filter(
			(line) =>
				line &&
				line !== "?? .loom-worktree.json" &&
				line !== "?? .loom/artifacts.json",
		);
	if (dirty.length)
		throw new Error("Integration workspace has unreviewed changes");
	if (
		(await git(workspace.projectPath, "rev-parse", "HEAD")) !==
		workspace.baseCommit
	)
		throw new Error("Project HEAD changed; integrate again before approval");
	await worktree.merge(workspace, workspace.baseCommit);
}
