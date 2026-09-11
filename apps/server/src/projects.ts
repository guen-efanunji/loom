import { resolve } from "node:path";
import {
	type CommandRunner,
	type RepositoryInfo,
	validateRepository,
} from "@loom/worktree";

export class ProjectValidationError extends Error {
	readonly code = "INVALID_PROJECT" as const;
	readonly details: Record<string, string>;

	constructor(message: string, details: Record<string, string> = {}) {
		super(message);
		this.name = "ProjectValidationError";
		this.details = details;
	}
}

export type ProjectValidationService = {
	validate(path: string): Promise<RepositoryInfo>;
};

export function createProjectValidationService(
	runner?: CommandRunner,
): ProjectValidationService {
	return {
		async validate(path: string) {
			try {
				return await validateRepository(resolve(path), runner);
			} catch (error) {
				if (error instanceof ProjectValidationError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				throw new ProjectValidationError(message, { path: resolve(path) });
			}
		},
	};
}
